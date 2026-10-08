// SPDX-License-Identifier: MIT
/**
 * Mera passkey ceremonies and key derivation (`@category-labs/mera` 0.2.0, preview). Loaded on demand by
 * `passkey.ts` (a separate chunk, never on the pay route's first load: PAYLINK-V2-SPEC §4.4).
 *
 * Derivation follows Mera's documented recipe ("Create passkey accounts", mera.category.xyz), so the account is the
 * standard EVM account of the passkey on this relying party, reproducible on any device the passkey syncs to:
 *
 *   PRF output (32 bytes, Mera's default salt sha256("mera.prf.salt.v1"), user verification required)
 *     → BIP-39 entropy → mnemonic → seed (PBKDF2-HMAC-SHA512, no passphrase)
 *     → BIP-32 / BIP-44 path m/44'/60'/0'/0/0 → secp256k1 private key
 *     → Mera signing session → viem local account (`toViemAccount`)
 *
 * Nothing is stored: the key exists only for the duration of one signature. Each signature runs one passkey assertion,
 * derives the key, checks that it is the account the device expects, signs, ends the session (Mera zeroes its copy)
 * and wipes the intermediate buffers this module owns. The mnemonic is a JavaScript string and cannot be wiped; it is
 * never shown, stored or logged, and goes out of scope immediately.
 */
import { createPasskeyWithPrfOutput, createSecp256k1SigningSession, getPasskeyPrfOutput, isMeraError } from "@category-labs/mera";
import type { PasskeyCredentialMetadata, WebAuthnClient } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeed } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { getAddress } from "viem";
import type { Address, LocalAccount } from "viem";
import type { PasskeyFailure } from "./passkey-error.ts";

/** BIP-44 path of the first Ethereum account (Mera's recipe, index 0). */
export const EVM_ACCOUNT_PATH = "m/44'/60'/0'/0/0";

export class PasskeyError extends Error {
  readonly failure: PasskeyFailure;

  constructor(failure: PasskeyFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PasskeyError";
    this.failure = failure;
  }
}

/** Maps Mera's stable error codes to the app's failures. */
export function passkeyFailure(error: unknown): PasskeyError {
  if (error instanceof PasskeyError) {
    return error;
  }
  if (isMeraError(error)) {
    switch (error.code) {
      case "PASSKEY_OPERATION_FAILED":
        return new PasskeyError("cancelled", error.message, { cause: error });
      case "PRF_UNAVAILABLE":
        return new PasskeyError("prf-unavailable", error.message, { cause: error });
      default:
        return new PasskeyError("failed", error.message, { cause: error });
    }
  }
  return new PasskeyError("failed", error instanceof Error ? error.message : "passkey failure", { cause: error });
}

/** Derives the BIP-44 private key from a PRF output; the caller wipes the returned bytes. */
async function derivePrivateKey(prfOutput: Uint8Array): Promise<Uint8Array> {
  const seed = await mnemonicToSeed(entropyToMnemonic(prfOutput, wordlist));
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(EVM_ACCOUNT_PATH);
  try {
    if (node.privateKey === null) {
      throw new PasskeyError("failed", "the derivation produced no key");
    }
    return Uint8Array.from(node.privateKey);
  } finally {
    seed.fill(0);
    node.wipePrivateData();
    root.wipePrivateData();
  }
}

/**
 * Runs `use` with a viem local account backed by a Mera signing session over the key derived from `prfOutput`, then
 * ends the session and wipes every buffer this module holds (the PRF output included).
 */
export async function withDerivedAccount<T>(prfOutput: Uint8Array, use: (account: LocalAccount) => Promise<T>): Promise<T> {
  let privateKey: Uint8Array | null = null;
  try {
    privateKey = await derivePrivateKey(prfOutput);
    const session = createSecp256k1SigningSession({ privateKey });
    try {
      return await use(toViemAccount(session));
    } finally {
      session.end();
    }
  } finally {
    privateKey?.fill(0);
    prfOutput.fill(0);
  }
}

/** The address of the account a PRF output derives (the key is derived, read and wiped). */
export async function addressOf(prfOutput: Uint8Array): Promise<Address> {
  return await withDerivedAccount(prfOutput, (account) => Promise.resolve(getAddress(account.address)));
}

export interface CreatedKey {
  readonly credential: PasskeyCredentialMetadata;
  readonly address: Address;
}

export interface CeremonyOptions {
  readonly rpId: string;
  /** Tests and the virtual-authenticator path inject a client; the browser's `navigator.credentials` otherwise. */
  readonly webAuthnClient?: WebAuthnClient;
  readonly timeoutMs?: number;
}

/**
 * Creates a discoverable passkey on this relying party with PRF, and derives its account (one ceremony; a second when
 * the authenticator evaluates PRF only on assertion). `label` is what the passkey manager shows next to "PayLink".
 */
export async function createKey(options: CeremonyOptions & { readonly label: string }): Promise<CreatedKey> {
  try {
    const created = await createPasskeyWithPrfOutput({
      rp: { id: options.rpId, name: "PayLink" },
      user: { name: options.label, displayName: options.label },
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options.webAuthnClient === undefined ? {} : { webAuthnClient: options.webAuthnClient }),
    });
    const credential: PasskeyCredentialMetadata = { credentialId: created.credentialId, ...(created.transports === undefined ? {} : { transports: [...created.transports] }) };
    return { credential, address: await addressOf(created.prfOutput) };
  } catch (error) {
    throw passkeyFailure(error);
  }
}

/** Asks for a passkey (pinned to `credential` when the device knows it), and derives its account. */
export async function signIn(options: CeremonyOptions & { readonly credential?: PasskeyCredentialMetadata }): Promise<CreatedKey> {
  try {
    const asserted = await getPasskeyPrfOutput({
      rpId: options.rpId,
      ...(options.credential === undefined ? {} : { credential: options.credential }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options.webAuthnClient === undefined ? {} : { webAuthnClient: options.webAuthnClient }),
    });
    const credential: PasskeyCredentialMetadata =
      options.credential?.credentialId === asserted.credentialId ? options.credential : { credentialId: asserted.credentialId };
    return { credential, address: await addressOf(asserted.prfOutput) };
  } catch (error) {
    throw passkeyFailure(error);
  }
}

/**
 * One signature: asserts the passkey (one fingerprint), derives the key, refuses it unless it is `expected`, runs `use`
 * and wipes everything.
 */
export async function withPasskeySigner<T>(
  options: CeremonyOptions & { readonly credential: PasskeyCredentialMetadata; readonly expected: Address },
  use: (account: LocalAccount) => Promise<T>,
): Promise<T> {
  let prfOutput: Uint8Array;
  try {
    prfOutput = (
      await getPasskeyPrfOutput({
        rpId: options.rpId,
        credential: options.credential,
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.webAuthnClient === undefined ? {} : { webAuthnClient: options.webAuthnClient }),
      })
    ).prfOutput;
  } catch (error) {
    throw passkeyFailure(error);
  }
  return await withDerivedAccount(prfOutput, async (account) => {
    if (getAddress(account.address) !== getAddress(options.expected)) {
      throw new PasskeyError("other-key", "this passkey belongs to another PayLink account");
    }
    return await use(account);
  });
}

