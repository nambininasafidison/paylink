// SPDX-License-Identifier: MIT
/**
 * Chain reads (docs/paypal/SPEC.md §10.1) through the registry's RPC for Ethereum Sepolia, with @paylink/sdk:
 * `statesOf(K)` and, when paid, the `Paid` receipt verified at the exact amount (`verifyReceipt`). Read-only: the API
 * holds no key, imports no wallet client and never submits a transaction (invariant AI-1). While PayLinkV2 has no
 * recorded deployment on the chain (decision D-CHAIN), every state reads `not-deployed`.
 *
 * Owner: reconciler workstream (types and implementation; other workstreams ask for changes through a handoff).
 */
import type { InvoiceKey } from "@paylink/api-contract";
import type { ChainObservation } from "../reconciler/types.ts";

export interface ChainReader {
  readonly chainId: number;
  /** True once the registry records a PayLinkV2 deployment on the chain. */
  readonly deployed: boolean;
  /** The chain's view of one key; `unreadable` when the RPC fails (never a guess). */
  observe(key: InvoiceKey): Promise<ChainObservation>;
  /** Many keys in one multicall (the cron's budget: one chain read per run, §7.5). */
  observeMany(keys: readonly InvoiceKey[]): Promise<ReadonlyMap<InvoiceKey, ChainObservation>>;
}
