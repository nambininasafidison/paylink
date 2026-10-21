// SPDX-License-Identifier: MIT
/**
 * Chain reads (docs/paypal/SPEC.md §10.1) through the registry's RPC for Ethereum Sepolia: PayLinkV2's `statesOf(K)` with
 * the chain's own clock, then, for a paid key, its `Paid` event (decoded strictly by the SDK and checked at the exact
 * amount, payee and token), and, for a cancelled key, its `InvoiceCancelled` event. Read-only: the API holds no key,
 * imports no wallet client and never submits a transaction (invariant AI-1). While PayLinkV2 has no recorded deployment
 * on the chain (decision D-CHAIN), every state reads `not-deployed`.
 *
 * Owner: reconciler workstream (types and implementation; other workstreams ask for changes through a handoff).
 */
import type { Address, InvoiceKey } from "@paylink/api-contract";
import type { ChainObservation, ChainPayment, ChainRail } from "../reconciler/types.ts";

/** What the reader needs to know about a twin's signed invoice (from its record). */
export interface ChainTwin {
  readonly key: InvoiceKey;
  readonly payee: Address;
  readonly token: Address;
  readonly rail: ChainRail;
  /** The signed amount, base units. */
  readonly amountBase: string;
  /** The signed `validUntil`, unix seconds (0: none). */
  readonly validUntil: number;
  /** A payment verified on an earlier read (reused while `stateOf` still says paid: no log lookup). */
  readonly chainPayment: ChainPayment | null;
}

export interface ObserveOptions {
  /** Event lookups (`eth_getLogs`) allowed in this read, at most; the rest wait for a later read (the cron's budget). */
  readonly logLookups?: number;
}

export interface ChainReader {
  readonly chainId: number;
  /** True once the registry records a PayLinkV2 deployment on the chain. */
  readonly deployed: boolean;
  /** The chain's view of one twin; `unreadable` when the RPC fails (never a guess). */
  observe(twin: ChainTwin, options?: ObserveOptions): Promise<ChainObservation>;
  /** Many twins with one `eth_call` (a Multicall3 `aggregate3` of `statesOf` and the chain's clock), plus event lookups. */
  observeMany(twins: readonly ChainTwin[], options?: ObserveOptions): Promise<ReadonlyMap<InvoiceKey, ChainObservation>>;
}
