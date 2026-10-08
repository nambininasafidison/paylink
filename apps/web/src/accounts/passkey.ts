// SPDX-License-Identifier: MIT
/**
 * The passkey account layer (Monad edition, PAYLINK-V2-SPEC §2.1 T1 "Mera passkeys as the only account layer"): a
 * PayLink key is a discoverable WebAuthn passkey with the PRF extension, bound to the origin's relying party, from
 * which `@category-labs/mera` derives a secp256k1 account (`mera.ts`, a chunk loaded on demand).
 *
 * The device remembers only public facts (`PasskeyRecord`: the credential ID and transports, the derived address, a
 * label), never key material. So every page knows who is signed in without a prompt (`connect` with `silent`), and
 * each signature costs exactly one fingerprint: assert, derive, check the address, sign, wipe. There is no wallet popup
 * to say what is signed, so every page that signs shows a signing display first (spec §3.6).
 *
 * The relying party ID is fixed at build time for production (`paylink-mg.pages.dev`, FACTS 2026-10-07): ceremonies
 * run only on that exact host, so a preview deployment (`<branch>.paylink-mg.pages.dev`, which WebAuthn would let
 * assert the same rpId) never offers or uses a PayLink key from this code. Local and end-to-end builds use the page's
 * own host.
 *
 * A passkey account normally holds no gas coin: it pays and cancels through the relayer. When it does hold gas, it can
 * send its own transactions: signed here (EIP-1559, explicit gas limit) and broadcast through the registry RPC.
 */
import type { ChainDefinition } from "@paylink/chains";
import { getAddress, isAddress } from "viem";
import type { Address, Hex } from "viem";
import { PasskeyUseError } from "./passkey-error.ts";
import type { PasskeyFailure } from "./passkey-error.ts";
import type { CreatedKey } from "./mera.ts";
import type { AccountDeps, AccountEvent, AccountLayer, AccountProvider, ConnectOptions, Connector, TransactionRequest } from "./types.ts";

export const PASSKEY_LAYER = "passkey";
/** Connector IDs: create a new key, use an existing one (the platform offers the passkeys of this site). */
export const CREATE_ID = "passkey.create";
export const SIGN_IN_ID = "passkey.signin";
const STORAGE_KEY = "paylink.passkey";

/** The device's record of its PayLink key: public facts only. */
export interface PasskeyRecord {
  readonly version: 1;
  readonly rpId: string;
  /** Canonical unpadded base64url (WebAuthn credential ID). */
  readonly credentialId: string;
  readonly transports?: readonly string[];
  /** EIP-55: the account the passkey derives (m/44'/60'/0'/0/0). */
  readonly address: Address;
  readonly label: string;
  readonly createdAt: number;
}

/** Why passkeys cannot be used here, if they cannot. */
export type PasskeySupport = { readonly ok: true; readonly rpId: string } | { readonly ok: false; readonly reason: "no-webauthn" | "insecure" | "wrong-host"; readonly rpId: string };

/** The functions of `mera.ts` the layer uses (injected in tests). */
export interface MeraModule {
  createKey(options: { readonly rpId: string; readonly label: string }): Promise<CreatedKey>;
  signIn(options: { readonly rpId: string; readonly credential?: { readonly credentialId: string; readonly transports?: readonly string[] } }): Promise<CreatedKey>;
  withPasskeySigner<T>(
    options: { readonly rpId: string; readonly credential: { readonly credentialId: string; readonly transports?: readonly string[] }; readonly expected: Address },
    use: (account: {
      readonly address: Address;
      signTypedData(typed: never): Promise<Hex>;
      signTransaction(transaction: never): Promise<Hex>;
    }) => Promise<T>,
  ): Promise<T>;
}

export { PasskeyUseError } from "./passkey-error.ts";

export interface PasskeyLayerOptions {
  /** Production rpId (exact host required), or `null` for the page's own host (local and e2e builds). */
  readonly rpId: string | null;
  /** The chain the account reports before any page picks one (the edition's first chain). */
  readonly defaultChainId: number;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly location?: Pick<Location, "hostname" | "protocol">;
  /** How the ceremonies are loaded: the `mera.ts` chunk by default. */
  readonly load?: () => Promise<MeraModule>;
  readonly webAuthnAvailable?: () => boolean;
}

const B64URL = /^[A-Za-z0-9_-]{1,1366}$/;
const TRANSPORT = /^[a-z-]{1,32}$/;

/** Parses the stored record (storage is input: anything malformed is ignored). */
export function parsePasskeyRecord(raw: string | null): PasskeyRecord | null {
  if (raw === null || raw.length > 4096) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const r = value as Record<string, unknown>;
  const transports = r["transports"];
  if (
    r["version"] !== 1 ||
    typeof r["rpId"] !== "string" ||
    r["rpId"].length > 253 ||
    typeof r["credentialId"] !== "string" ||
    !B64URL.test(r["credentialId"]) ||
    typeof r["address"] !== "string" ||
    !isAddress(r["address"], { strict: false }) ||
    typeof r["label"] !== "string" ||
    r["label"].length > 64 ||
    typeof r["createdAt"] !== "number" ||
    !Number.isFinite(r["createdAt"]) ||
    (transports !== undefined && (!Array.isArray(transports) || transports.length > 8 || !transports.every((t) => typeof t === "string" && TRANSPORT.test(t))))
  ) {
    return null;
  }
  return {
    version: 1,
    rpId: r["rpId"],
    credentialId: r["credentialId"],
    ...(transports === undefined ? {} : { transports: transports as string[] }),
    address: getAddress(r["address"]),
    label: r["label"],
    createdAt: r["createdAt"],
  };
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

class PasskeyAccount implements AccountProvider {
  readonly kind = "passkey" as const;
  readonly connector: Connector;
  readonly address: Address;
  private current: number;
  private readonly listeners = new Set<(event: AccountEvent) => void>();
  private readonly record: PasskeyRecord;
  private readonly layer: { readonly mera: () => Promise<MeraModule>; readonly deps: () => AccountDeps | null; readonly rpId: () => string };

  constructor(record: PasskeyRecord, layer: PasskeyAccount["layer"], chainId: number) {
    this.record = record;
    this.layer = layer;
    this.address = record.address;
    this.current = chainId;
    this.connector = { id: PASSKEY_LAYER, name: record.label, icon: null, layer: PASSKEY_LAYER };
  }

  chainId(): Promise<number> {
    return Promise.resolve(this.current);
  }

  /** A passkey account signs for any chain: switching is local and silent. */
  switchChain(chain: ChainDefinition): Promise<void> {
    if (this.current !== chain.chainId) {
      this.current = chain.chainId;
      for (const listener of this.listeners) {
        listener("chain");
      }
    }
    return Promise.resolve();
  }

  private async signer<T>(use: Parameters<MeraModule["withPasskeySigner"]>[1]): Promise<T> {
    const mera = await this.layer.mera();
    const credential = { credentialId: this.record.credentialId, ...(this.record.transports === undefined ? {} : { transports: this.record.transports }) };
    try {
      return (await mera.withPasskeySigner({ rpId: this.layer.rpId(), credential, expected: this.address }, use)) as T;
    } catch (error) {
      throw toUseError(error);
    }
  }

  async signTypedData(typedData: Parameters<AccountProvider["signTypedData"]>[0]): Promise<Hex> {
    return await this.signer<Hex>(async (account) => await account.signTypedData(typedData as never));
  }

  async sendTransaction(request: TransactionRequest): Promise<Hex> {
    const deps = this.layer.deps();
    const chain = deps?.registry.get(request.chainId);
    if (deps === null || chain === undefined) {
      throw new PasskeyUseError("failed", `no chain ${String(request.chainId)} to send on`);
    }
    const client = deps.client(chain);
    const [nonce, fees] = await Promise.all([client.getTransactionCount(this.address), client.estimateFees()]);
    const transaction = {
      type: "eip1559",
      chainId: request.chainId,
      nonce,
      to: request.to,
      data: request.data,
      value: request.value,
      gas: request.gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    } as const;
    const serialized = await this.signer<Hex>(async (account) => await account.signTransaction(transaction as never));
    return await client.sendRawTransaction(serialized);
  }

  onChange(listener: (event: AccountEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Called by the layer when the key is forgotten on this device. */
  disconnected(): void {
    for (const listener of this.listeners) {
      listener("disconnect");
    }
  }
}

function toUseError(error: unknown): PasskeyUseError {
  if (error instanceof PasskeyUseError) {
    return error;
  }
  const failure = (error as { failure?: unknown } | null)?.failure;
  const known: readonly PasskeyFailure[] = ["cancelled", "prf-unavailable", "other-key", "failed"];
  const kind = known.find((f) => f === failure) ?? "failed";
  return new PasskeyUseError(kind, error instanceof Error ? error.message : "passkey failure", { cause: error });
}

export interface PasskeyLayer extends AccountLayer {
  readonly kind: "passkey";
  /** Whether PayLink keys work on this page, and the relying party ID in use. */
  support(): PasskeySupport;
  /** The key this device knows, if any (public facts only). */
  stored(): PasskeyRecord | null;
  /** Forgets the key on this device (the passkey itself stays in the passkey manager; signing in finds it again). */
  forget(): void;
}

export function passkeyLayer(options: PasskeyLayerOptions): PasskeyLayer {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const place = options.location ?? globalThis.location;
  const listeners = new Set<(connectors: readonly Connector[]) => void>();
  const accounts = new Set<PasskeyAccount>();
  let deps: AccountDeps | null = null;
  let module: Promise<MeraModule> | null = null;
  const webAuthn = options.webAuthnAvailable ?? ((): boolean => typeof globalThis.PublicKeyCredential === "function" && "credentials" in navigator && typeof navigator.credentials.get === "function");

  const rpId = (): string => options.rpId ?? place.hostname;
  const support = (): PasskeySupport => {
    const id = rpId();
    if (options.rpId !== null && place.hostname !== options.rpId) {
      return { ok: false, reason: "wrong-host", rpId: id };
    }
    if (place.protocol !== "https:" && place.hostname !== "localhost" && place.hostname !== "127.0.0.1") {
      return { ok: false, reason: "insecure", rpId: id };
    }
    return webAuthn() ? { ok: true, rpId: id } : { ok: false, reason: "no-webauthn", rpId: id };
  };
  const read = (): PasskeyRecord | null => {
    try {
      const record = parsePasskeyRecord(storage?.getItem(STORAGE_KEY) ?? null);
      return record !== null && record.rpId === rpId() ? record : null;
    } catch {
      return null;
    }
  };
  const write = (record: PasskeyRecord | null): void => {
    try {
      if (record === null) {
        storage?.removeItem(STORAGE_KEY);
      } else {
        storage?.setItem(STORAGE_KEY, JSON.stringify(record));
      }
    } catch {
      // Storage refused: the key works for this page only; signing in again finds it.
    }
  };
  const connectors = (): readonly Connector[] => {
    const record = read();
    return [
      ...(record === null ? [] : [{ id: PASSKEY_LAYER, name: record.label, icon: null, layer: PASSKEY_LAYER }]),
      { id: CREATE_ID, name: "Create a PayLink key", icon: null, layer: PASSKEY_LAYER },
      { id: SIGN_IN_ID, name: "Use my PayLink key", icon: null, layer: PASSKEY_LAYER },
    ];
  };
  const publish = (): void => {
    const list = connectors();
    for (const listener of listeners) {
      listener(list);
    }
  };
  const mera = async (): Promise<MeraModule> => {
    module ??= (options.load ?? (async (): Promise<MeraModule> => await import("./mera.ts")))();
    try {
      return await module;
    } catch (error) {
      module = null;
      throw new PasskeyUseError("failed", "the passkey module did not load", { cause: error });
    }
  };
  const account = (record: PasskeyRecord): PasskeyAccount => {
    const made = new PasskeyAccount(record, { mera, deps: () => deps, rpId }, options.defaultChainId);
    accounts.add(made);
    return made;
  };
  const requireSupport = (): string => {
    const s = support();
    if (!s.ok) {
      throw new PasskeyUseError("unsupported", s.reason);
    }
    return s.rpId;
  };

  return {
    id: PASSKEY_LAYER,
    kind: "passkey",
    bind(next) {
      deps = next;
    },
    watch(listener) {
      listeners.add(listener);
      listener(connectors());
      return () => {
        listeners.delete(listener);
      };
    },
    async connect(connectorId: string, connect: ConnectOptions) {
      if (connect.silent) {
        const record = read();
        return record === null || !connectorId.startsWith(PASSKEY_LAYER) ? null : account(record);
      }
      const id = requireSupport();
      const loaded = await mera();
      let made: CreatedKey;
      let label: string;
      try {
        if (connectorId === CREATE_ID) {
          label = (connect.label?.trim() ?? "").slice(0, 64) || `PayLink ${new Date().toISOString().slice(0, 10)}`;
          made = await loaded.createKey({ rpId: id, label });
        } else if (connectorId === SIGN_IN_ID || connectorId === PASSKEY_LAYER) {
          const known = read();
          made = await loaded.signIn({ rpId: id, ...(known === null ? {} : { credential: { credentialId: known.credentialId, ...(known.transports === undefined ? {} : { transports: known.transports }) } }) });
          label = known !== null && known.credentialId === made.credential.credentialId ? known.label : "PayLink key";
        } else {
          return null;
        }
      } catch (error) {
        throw toUseError(error);
      }
      const record: PasskeyRecord = {
        version: 1,
        rpId: id,
        credentialId: made.credential.credentialId,
        ...(made.credential.transports === undefined ? {} : { transports: [...made.credential.transports] }),
        address: getAddress(made.address),
        label,
        createdAt: Date.now(),
      };
      write(record);
      publish();
      return account(record);
    },
    support,
    stored: read,
    forget() {
      write(null);
      for (const made of accounts) {
        made.disconnected();
      }
      accounts.clear();
      publish();
    },
  };
}
