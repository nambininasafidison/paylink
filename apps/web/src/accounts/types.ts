// SPDX-License-Identifier: MIT
/**
 * The account layer (edition extension point 1, ARCHITECTURE "Account providers"): one `AccountProvider` interface,
 * `{ address, chainId, kind, signTypedData, sendTransaction, sendCalls? }`, whatever signs underneath:
 *
 * - EIP-6963 injected wallets (`eip6963.ts`), with EIP-5792 `wallet_sendCalls` where the wallet offers atomic batches
 *   (the Base edition's "Pay with Base" for smart-account payers);
 * - Mera passkeys (`passkey.ts`, the Monad edition's only layer): a local account derived from the passkey's PRF output
 *   for one signature at a time, behind a signing display (no wallet popup states what is signed).
 */
import type { ChainDefinition, Registry } from "@paylink/chains";
import type { TypedDataSigner } from "@paylink/sdk";
import type { Address, Hex } from "viem";
import type { ChainClient } from "../core/clients.ts";

/** How the account signs. Payees must be EOAs or deployed ERC-1271 accounts (spec §3.6 "Accounts"). */
export type AccountKind = "injected" | "passkey" | "smart-account";

/** Something the user can pick: a discovered wallet, a passkey, … */
export interface Connector {
  /** Stable across visits (the EIP-6963 `rdns`), so a choice can be remembered. */
  readonly id: string;
  readonly name: string;
  /** A `data:image/…` URI (EIP-6963 requires one), or `null`. */
  readonly icon: string | null;
  /** The `AccountLayer.id` that owns it. */
  readonly layer: string;
}

export interface TransactionRequest {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  /** Always explicit: Monad charges the gas limit (spec §3.3.6); never the wallet's default. */
  readonly gas: bigint;
}

export type AccountEvent = "accounts" | "chain" | "disconnect";

/** One call of an EIP-5792 batch. */
export interface BatchCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** EIP-5792 `atomic` capability of the account on a chain (`wallet_getCapabilities`). */
export type AtomicCapability = "supported" | "ready" | "unsupported";

/** The outcome of an EIP-5792 batch (`wallet_getCallsStatus`), once final. */
export interface BatchOutcome {
  /** `confirmed`: every call landed (atomically when asked); `reverted`/`failed`: nothing to verify. */
  readonly status: "confirmed" | "reverted" | "failed";
  /** Transaction hashes from the wallet's receipts (one for an atomic batch); verified on the registry RPC by the caller. */
  readonly txHashes: readonly Hex[];
}

export interface AccountProvider extends TypedDataSigner {
  readonly connector: Connector;
  readonly kind: AccountKind;
  readonly address: Address;
  /** The chain the signer is on now (wallets can switch under us). */
  chainId(): Promise<number>;
  /** EIP-3326 `wallet_switchEthereumChain`, falling back to EIP-3085 `wallet_addEthereumChain` with the registry's data. */
  switchChain(chain: ChainDefinition): Promise<void>;
  /** Sends a transaction from `address` with the given gas limit; resolves with its hash. */
  sendTransaction(request: TransactionRequest): Promise<Hex>;
  /** Subscribes to account, chain and disconnect events; returns the unsubscribe function. */
  onChange(listener: (event: AccountEvent) => void): () => void;
  /** EIP-5792 `wallet_getCapabilities`: whether the wallet executes atomic batches on the chain. Absent: never. */
  atomicCapability?(chainId: number): Promise<AtomicCapability>;
  /** EIP-5792 `wallet_sendCalls` (atomic required), then `wallet_getCallsStatus` until final. */
  sendCalls?(request: { readonly chainId: number; readonly calls: readonly BatchCall[] }): Promise<BatchOutcome>;
}

/** What a layer may need from the app once configuration is loaded (chain reads for local signers). */
export interface AccountDeps {
  readonly registry: Registry;
  client(chain: ChainDefinition): ChainClient;
}

export interface ConnectOptions {
  /** Reconnect without any prompt; resolves `null` when nothing can be restored silently. */
  readonly silent: boolean;
  /** A name for a new passkey (shown by the passkey manager); ignored by wallets. */
  readonly label?: string;
}

export interface AccountLayer {
  readonly id: string;
  /** `injected`: the user picks a wallet; `passkey`: the user creates or uses a PayLink key (KeyCard). */
  readonly kind: "injected" | "passkey";
  /** Called once at boot, after configuration is loaded. */
  bind?(deps: AccountDeps): void;
  /** Starts discovery and reports the connectors found so far, then each change. Returns the unsubscribe function. */
  watch(listener: (connectors: readonly Connector[]) => void): () => void;
  /**
   * Connects. `silent` reconnects without any prompt (EIP-1193 `eth_accounts`; a passkey account known to this device)
   * and resolves `null` when the user has not authorised this site before.
   */
  connect(connectorId: string, options: ConnectOptions): Promise<AccountProvider | null>;
}

/** An EIP-1193 provider error (`code` 4001 = rejected by the user, 4902 = unknown chain). */
export class WalletError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}
