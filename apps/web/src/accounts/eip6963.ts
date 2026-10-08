// SPDX-License-Identifier: MIT
/**
 * Injected wallets through EIP-6963 (multi-injected provider discovery), with EIP-3326 / EIP-3085 to switch and add
 * chains from the registry. A legacy `window.ethereum` with no EIP-6963 announcement is offered as "Browser wallet"
 * (some in-app browsers still inject only that). The provider is called directly over EIP-1193; typed data is
 * serialised exactly as viem's wallet client does it, and every signature is verified by the SDK before use.
 *
 * EIP-5792 (wallet call API): `wallet_getCapabilities` tells whether the account executes atomic batches on a chain
 * (a smart account such as Base Account reports `atomic: supported`), and `wallet_sendCalls` with `atomicRequired`
 * plus `wallet_getCallsStatus` carry the Base edition's "Pay with Base" batch. Both the final 2.0.0 shapes and the
 * earlier ones some wallets still answer with (`atomicBatch`, string statuses) are understood.
 */
import type { ChainDefinition } from "@paylink/chains";
import { getAddress, getTypesForEIP712Domain, isAddress, numberToHex, serializeTypedData, validateTypedData } from "viem";
import type { Address, Hex, TypedDataDefinition } from "viem";
import type { AccountEvent, AccountLayer, AccountProvider, AtomicCapability, BatchCall, BatchOutcome, Connector, TransactionRequest } from "./types.ts";
import { WalletError } from "./types.ts";

/** The EIP-1193 surface PayLink uses. */
export interface Eip1193Provider {
  request(arguments_: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

interface Discovered {
  readonly connector: Connector;
  readonly provider: Eip1193Provider;
}

const LAYER = "eip6963";
export const LEGACY_ID = "injected";

/**
 * EIP-6963 `rdns` of the wallets that are Base Account: the Coinbase Wallet extension and the Base app (formerly
 * Coinbase Wallet) announce `com.coinbase.wallet`. Only their users are told "Pay with Base"; any other wallet with
 * EIP-5792 atomic batches (MetaMask with an EIP-7702 smart account, for one) hears the neutral "one approval in your
 * wallet" (ADR 0015, option 2B: no Base Account SDK on this origin).
 */
export const BASE_WALLET_RDNS: readonly string[] = ["com.coinbase.wallet"];

/** Whether the connected wallet is the Base app or Coinbase Wallet (by its EIP-6963 rdns). */
export function isBaseWallet(connector: Connector): boolean {
  return connector.layer === LAYER && BASE_WALLET_RDNS.includes(connector.id.toLowerCase());
}

const isProvider = (value: unknown): value is Eip1193Provider =>
  typeof value === "object" && value !== null && typeof (value as { request?: unknown }).request === "function";

/** EIP-6963 `info`, validated: strings within bounds, the icon a data URI (§5 of the EIP), rdns in reverse-DNS form. */
export function parseProviderInfo(value: unknown): { uuid: string; name: string; icon: string | null; rdns: string } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { uuid, name, icon, rdns } = value as Record<string, unknown>;
  if (typeof uuid !== "string" || typeof name !== "string" || typeof rdns !== "string") {
    return null;
  }
  if (uuid.length > 64 || name.trim() === "" || name.length > 64 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(rdns) || rdns.length > 128) {
    return null;
  }
  const iconOk = typeof icon === "string" && icon.length <= 200_000 && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/i.test(icon);
  return { uuid, name: name.trim(), icon: iconOk ? icon : null, rdns: rdns.toLowerCase() };
}

/** Wraps an EIP-1193 error into a `WalletError` that keeps its numeric code. */
export function walletError(error: unknown): unknown {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "number") {
    const e = error as { code: number; message?: unknown };
    return new WalletError(e.code, typeof e.message === "string" ? e.message : "wallet error");
  }
  return error;
}

async function call(provider: Eip1193Provider, method: string, params?: readonly unknown[]): Promise<unknown> {
  try {
    return await provider.request(params === undefined ? { method } : { method, params });
  } catch (error) {
    throw walletError(error);
  }
}

function firstAccount(value: unknown): Address | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const first: unknown = value[0];
  return typeof first === "string" && isAddress(first, { strict: false }) ? getAddress(first) : null;
}

/** EIP-3085 parameters from the registry entry (never from a link or the URL). */
export function addChainParameters(chain: ChainDefinition): Record<string, unknown> {
  return {
    chainId: numberToHex(chain.chainId),
    chainName: chain.name,
    nativeCurrency: { ...chain.nativeCurrency },
    rpcUrls: chain.rpc.map((rpc) => rpc.url),
    ...(chain.explorers.length > 0 ? { blockExplorerUrls: chain.explorers.map((explorer) => explorer.url) } : {}),
  };
}

/** Reads EIP-5792 capabilities for one chain: the 2.0.0 `atomic.status`, or the earlier `atomicBatch.supported`. */
export function parseAtomicCapability(value: unknown, chainId: number): AtomicCapability {
  if (typeof value !== "object" || value === null) {
    return "unsupported";
  }
  const all = value as Record<string, unknown>;
  const forChain = all[numberToHex(chainId)] ?? all["0x0"];
  if (typeof forChain !== "object" || forChain === null) {
    return "unsupported";
  }
  const caps = forChain as Record<string, unknown>;
  const atomic = caps["atomic"];
  if (typeof atomic === "object" && atomic !== null) {
    const status = (atomic as { status?: unknown }).status;
    return status === "supported" || status === "ready" ? status : "unsupported";
  }
  const legacy = caps["atomicBatch"];
  return typeof legacy === "object" && legacy !== null && (legacy as { supported?: unknown }).supported === true ? "supported" : "unsupported";
}

/** Reads `wallet_getCallsStatus`: `null` while pending, else the final outcome with the receipts' transaction hashes. */
export function parseCallsStatus(value: unknown): BatchOutcome | null {
  if (typeof value !== "object" || value === null) {
    throw new WalletError(-32603, "the wallet returned no call status");
  }
  const body = value as { status?: unknown; receipts?: unknown };
  const status = body.status;
  const receipts = Array.isArray(body.receipts) ? body.receipts : [];
  const hashes = receipts
    .map((r: unknown) => (typeof r === "object" && r !== null ? (r as { transactionHash?: unknown }).transactionHash : null))
    .filter((h): h is string => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h))
    .map((h) => h.toLowerCase() as Hex);
  if (status === 100 || status === "PENDING" || status === "pending") {
    return null;
  }
  if (status === 200 || status === "CONFIRMED" || status === "confirmed") {
    return { status: "confirmed", txHashes: hashes };
  }
  if (status === 500 || status === 600) {
    return { status: "reverted", txHashes: hashes };
  }
  return { status: "failed", txHashes: hashes };
}

class InjectedAccount implements AccountProvider {
  readonly kind = "injected" as const;
  readonly connector: Connector;
  readonly address: Address;
  private readonly provider: Eip1193Provider;

  constructor(connector: Connector, address: Address, provider: Eip1193Provider) {
    this.connector = connector;
    this.address = address;
    this.provider = provider;
  }

  async chainId(): Promise<number> {
    const value = await call(this.provider, "eth_chainId");
    const id = typeof value === "string" ? Number.parseInt(value, 16) : Number.NaN;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new WalletError(-32603, "the wallet returned an invalid chain ID");
    }
    return id;
  }

  async switchChain(chain: ChainDefinition): Promise<void> {
    if ((await this.chainId()) === chain.chainId) {
      return;
    }
    try {
      await call(this.provider, "wallet_switchEthereumChain", [{ chainId: numberToHex(chain.chainId) }]);
    } catch (error) {
      // 4902: the wallet does not know the chain (EIP-3326). Some wallets report it as -32603 with data.originalError.code 4902.
      const code = error instanceof WalletError ? error.code : null;
      if (code !== 4902 && code !== -32603) {
        throw error;
      }
      await call(this.provider, "wallet_addEthereumChain", [addChainParameters(chain)]);
    }
    if ((await this.chainId()) !== chain.chainId) {
      throw new WalletError(4901, "the wallet did not switch network");
    }
  }

  async signTypedData(typedData: Parameters<AccountProvider["signTypedData"]>[0]): Promise<Hex> {
    const definition = {
      domain: typedData.domain,
      types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }), ...typedData.types },
      primaryType: typedData.primaryType,
      message: typedData.message,
    } as unknown as TypedDataDefinition;
    validateTypedData(definition);
    const signature = await call(this.provider, "eth_signTypedData_v4", [this.address, serializeTypedData(definition)]);
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new WalletError(-32603, "the wallet returned no signature");
    }
    return signature.toLowerCase() as Hex;
  }

  async sendTransaction(request: TransactionRequest): Promise<Hex> {
    if ((await this.chainId()) !== request.chainId) {
      throw new WalletError(4901, "the wallet is on another network");
    }
    const hash = await call(this.provider, "eth_sendTransaction", [
      {
        from: this.address,
        to: request.to,
        data: request.data,
        value: numberToHex(request.value),
        gas: numberToHex(request.gas),
      },
    ]);
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new WalletError(-32603, "the wallet returned no transaction hash");
    }
    return hash.toLowerCase() as Hex;
  }

  async atomicCapability(chainId: number): Promise<AtomicCapability> {
    try {
      return parseAtomicCapability(await call(this.provider, "wallet_getCapabilities", [this.address, [numberToHex(chainId)]]), chainId);
    } catch {
      return "unsupported";
    }
  }

  async sendCalls(request: { readonly chainId: number; readonly calls: readonly BatchCall[] }): Promise<BatchOutcome> {
    if ((await this.chainId()) !== request.chainId) {
      throw new WalletError(4901, "the wallet is on another network");
    }
    const calls = request.calls.map((c) => ({ to: c.to, data: c.data, value: numberToHex(c.value) }));
    const params = (version: string): unknown[] => [{ version, from: this.address, chainId: numberToHex(request.chainId), atomicRequired: true, calls, capabilities: {} }];
    let answer: unknown;
    try {
      answer = await call(this.provider, "wallet_sendCalls", params("2.0.0"));
    } catch (error) {
      // Wallets that implement the earlier draft refuse the 2.0.0 shape as invalid parameters.
      if (!(error instanceof WalletError) || error.code !== -32602) {
        throw error;
      }
      answer = await call(this.provider, "wallet_sendCalls", params("1.0"));
    }
    const id = typeof answer === "string" ? answer : typeof answer === "object" && answer !== null ? (answer as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || id.length === 0 || id.length > 512) {
      throw new WalletError(-32603, "the wallet returned no batch identifier");
    }
    const deadline = Date.now() + 180_000;
    for (;;) {
      const outcome = parseCallsStatus(await call(this.provider, "wallet_getCallsStatus", [id]));
      if (outcome !== null) {
        return outcome;
      }
      if (Date.now() > deadline) {
        throw new WalletError(-32603, "the batch is still pending");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  onChange(listener: (event: AccountEvent) => void): () => void {
    const onAccounts = (): void => {
      listener("accounts");
    };
    const onChain = (): void => {
      listener("chain");
    };
    const onDisconnect = (): void => {
      listener("disconnect");
    };
    this.provider.on?.("accountsChanged", onAccounts);
    this.provider.on?.("chainChanged", onChain);
    this.provider.on?.("disconnect", onDisconnect);
    return () => {
      this.provider.removeListener?.("accountsChanged", onAccounts);
      this.provider.removeListener?.("chainChanged", onChain);
      this.provider.removeListener?.("disconnect", onDisconnect);
    };
  }
}

/** The EIP-6963 account layer for a window. */
export function eip6963Layer(target: Window = window, legacyDelayMs = 400): AccountLayer {
  const found = new Map<string, Discovered>();
  const listeners = new Set<(connectors: readonly Connector[]) => void>();
  let started = false;
  let legacyChecked = false;

  const snapshot = (): readonly Connector[] => [...found.values()].map((d) => d.connector);
  const publish = (): void => {
    const list = snapshot();
    for (const listener of listeners) {
      listener(list);
    }
  };

  const onAnnounce = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail as { info?: unknown; provider?: unknown } | null;
    const info = parseProviderInfo(detail?.info);
    if (info === null || !isProvider(detail?.provider) || found.has(info.rdns)) {
      return;
    }
    found.set(info.rdns, { connector: { id: info.rdns, name: info.name, icon: info.icon, layer: LAYER }, provider: detail.provider });
    found.delete(LEGACY_ID);
    publish();
  };

  const checkLegacy = (): void => {
    legacyChecked = true;
    const legacy = (target as unknown as { ethereum?: unknown }).ethereum;
    if (found.size === 0 && isProvider(legacy)) {
      found.set(LEGACY_ID, { connector: { id: LEGACY_ID, name: "Browser wallet", icon: null, layer: LAYER }, provider: legacy });
    }
    publish();
  };

  const start = (): void => {
    if (started) {
      return;
    }
    started = true;
    target.addEventListener("eip6963:announceProvider", onAnnounce);
    target.dispatchEvent(new Event("eip6963:requestProvider"));
    target.setTimeout(checkLegacy, legacyDelayMs);
  };

  return {
    id: LAYER,
    kind: "injected",
    watch(listener) {
      listeners.add(listener);
      start();
      if (legacyChecked || found.size > 0) {
        listener(snapshot());
      }
      return () => {
        listeners.delete(listener);
      };
    },
    async connect(connectorId, { silent }) {
      start();
      const entry = found.get(connectorId);
      if (entry === undefined) {
        return null;
      }
      const accounts = await call(entry.provider, silent ? "eth_accounts" : "eth_requestAccounts");
      const address = firstAccount(accounts);
      if (address === null) {
        if (silent) {
          return null;
        }
        throw new WalletError(4100, "the wallet shared no account");
      }
      return new InjectedAccount(entry.connector, address, entry.provider);
    },
  };
}
