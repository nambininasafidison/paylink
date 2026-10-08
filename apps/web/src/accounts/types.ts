// SPDX-License-Identifier: MIT
/**
 * The account layer (edition extension point 1, ARCHITECTURE "Account providers"): one `AccountProvider` interface,
 * `{ address, chainId, kind, signTypedData, sendTransaction, sendCalls? }`, whatever signs underneath. Today: EIP-6963
 * injected wallets (`eip6963.ts`). Tier T1 adds Mera passkeys (Monad edition: a local account behind a SigningDisplay,
 * no wallet popup) and Base Account (payers only, EIP-5792 `sendCalls`), each as another `AccountLayer`.
 */
import type { ChainDefinition } from "@paylink/chains";
import type { TypedDataSigner } from "@paylink/sdk";
import type { Address, Hex } from "viem";

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
}

export interface AccountLayer {
  readonly id: string;
  /** Starts discovery and reports the connectors found so far, then each change. Returns the unsubscribe function. */
  watch(listener: (connectors: readonly Connector[]) => void): () => void;
  /**
   * Connects. `silent` reconnects without any prompt (EIP-1193 `eth_accounts`) and resolves `null` when the user has
   * not authorised this site before.
   */
  connect(connectorId: string, options: { readonly silent: boolean }): Promise<AccountProvider | null>;
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
