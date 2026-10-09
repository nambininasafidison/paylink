// SPDX-License-Identifier: MIT
/**
 * The ledger key (ADR 0016): the PRF output of the device's PayLink key for the books namespace, `paylink.books.v1`
 * (`accounts/namespaces.ts`). One assertion pinned to the credential the device recorded for the signed-in account
 * (one fingerprint), through Mera's `getPasskeyPrfOutput` with the namespace's salt (`mera.ts` `namespaceOutput`, the
 * same lazy chunk the passkey layer loads). No account key is derived, and the output is handed to `envelope.ts`, which
 * wipes it once WebCrypto holds it.
 *
 * This lives with the books code rather than in the passkey layer so that the pay route, which every payer loads,
 * never carries it (PAYLINK-V2-SPEC §4.4 budget).
 */
import { getAddress } from "viem";
import type { Address } from "viem";
import { BOOKS_NAMESPACE, namespaceSalt } from "../accounts/namespaces.ts";
import type { PasskeyLayer } from "../accounts/passkey.ts";
import { PasskeyUseError } from "../accounts/passkey-error.ts";
import type { PasskeyFailure } from "../accounts/passkey-error.ts";

/** What the books code needs from the Mera chunk (tests inject a fake authenticator through it). */
export interface NamespaceModule {
  namespaceOutput(options: { readonly rpId: string; readonly credential: { readonly credentialId: string; readonly transports?: readonly string[] }; readonly prfSalt: Uint8Array }): Promise<Uint8Array>;
}

export type LoadNamespaceModule = () => Promise<NamespaceModule>;

const loadMera: LoadNamespaceModule = async () => await import("../accounts/mera.ts");

const KNOWN: readonly PasskeyFailure[] = ["cancelled", "prf-unavailable", "other-key", "failed"];

/**
 * The 32-byte ledger-key PRF output of the key this device knows for `expected` (the caller wipes it).
 * @throws PasskeyUseError `unsupported` (no passkeys here), `failed` (no key on this device), `other-key` (the device's
 *   key is another account's, or another credential answered), `cancelled`, `prf-unavailable`.
 */
export async function ledgerKeyOutput(layer: Pick<PasskeyLayer, "support" | "stored">, expected: Address, load: LoadNamespaceModule = loadMera): Promise<Uint8Array> {
  const support = layer.support();
  if (!support.ok) {
    throw new PasskeyUseError("unsupported", support.reason);
  }
  const record = layer.stored();
  if (record === null) {
    throw new PasskeyUseError("failed", "no PayLink key on this device");
  }
  if (record.address !== getAddress(expected)) {
    throw new PasskeyUseError("other-key", "the device's key belongs to another account");
  }
  const prfSalt = await namespaceSalt(BOOKS_NAMESPACE);
  let mera: NamespaceModule;
  try {
    mera = await load();
  } catch (error) {
    throw new PasskeyUseError("failed", "the passkey module did not load", { cause: error });
  }
  try {
    return await mera.namespaceOutput({ rpId: support.rpId, credential: { credentialId: record.credentialId, ...(record.transports === undefined ? {} : { transports: record.transports }) }, prfSalt });
  } catch (error) {
    const failure = (error as { failure?: unknown } | null)?.failure;
    throw new PasskeyUseError(KNOWN.find((f) => f === failure) ?? "failed", error instanceof Error ? error.message : "passkey failure", { cause: error });
  }
}
