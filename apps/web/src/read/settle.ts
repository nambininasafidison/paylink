// SPDX-License-Identifier: MIT
/**
 * Time to get paid: from issuing an invoice on this device to its first payment on the chain. The chain never learns
 * when an invoice was issued (it is signed off-chain; `validAfter` is optional), so this is derived here, where both
 * ends are known (read model chain > device > indexer):
 *
 * - issued: the device's own record (`InvoiceRecord.createdAt`, the device clock);
 * - first payment: the indexer's `Invoice.firstPaidAt` when it has the link, else, for a one-off invoice (at most one
 *   payment), the chain's own `LinkState.lastPaidAt`, which is then the first and only payment.
 *
 * Multi-payment links the indexer does not cover are left out (their first payment time is not on the chain), and so
 * is any interval below zero (a device clock ahead of the chain). The result is a median over what remains.
 */
import type { Hex } from "viem";
import type { LedgerRow } from "./ledger.ts";

export interface SettleTime {
  /** Median seconds from issue to first payment. */
  readonly median: number;
  /** Invoices it is the median of. */
  readonly count: number;
}

/** The median time to get paid over `rows`, or `null` when no paid invoice has both ends known. */
export function medianSettleTime(rows: readonly Pick<LedgerRow, "record" | "link" | "state">[], firstPaid: ReadonlyMap<string, bigint> = new Map()): SettleTime | null {
  const intervals: number[] = [];
  for (const row of rows) {
    if (row.state === null || row.state.payments === 0) {
      continue;
    }
    const indexed = firstPaid.get(firstPaidKey(row.link.chainId, row.link.key));
    const first = indexed ?? (row.link.invoice.maxPayments === 1 && row.state.lastPaidAt > 0n ? row.state.lastPaidAt : null);
    if (first === null) {
      continue;
    }
    const seconds = Number(first) - Math.floor(row.record.createdAt / 1000);
    if (seconds >= 0) {
      intervals.push(seconds);
    }
  }
  if (intervals.length === 0) {
    return null;
  }
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const median = intervals.length % 2 === 1 ? (intervals[mid] ?? 0) : ((intervals[mid - 1] ?? 0) + (intervals[mid] ?? 0)) / 2;
  return { median, count: intervals.length };
}

/** The `firstPaid` map key of a link. */
export function firstPaidKey(chainId: number, key: Hex): string {
  return `${String(chainId)}:${key.toLowerCase()}`;
}
