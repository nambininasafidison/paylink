// SPDX-License-Identifier: MIT
/**
 * The echo filter (docs/paypal/SPEC.md §7.3, §10.3). When a twin is paid on chain, PayLink records that payment on the
 * PayPal invoice (P6, `method: "OTHER"`) with a note naming the chain, the transaction and the key. PayPal then reports
 * the invoice paid; that record is PayLink's own **echo** and must never read as a second payment.
 *
 * A transaction is an echo iff all three hold:
 * 1. `method` is `OTHER`;
 * 2. its `note` is PayLink's note for **this** key and this chain;
 * 3. the chain shows a verified `Paid` event for K in **that** transaction, at the exact amount (and the record's own
 *    amount, when PayPal reports one, is the twin's).
 * A stored `payment_id` from P6 is a cache, never proof (a payee or anyone with the merchant's PayPal access could copy a
 * note; only the chain proves the payment). Echo-only twins are closed (S8), never S2 or S4.
 *
 * The note's separators are matched loosely (any run of non-word characters): PayPal's handling of `·` (U+00B7) in a
 * note is UNVERIFIED until the owner's capture run, and a mangled separator must not turn PayLink's own record into a
 * "paid twice" alarm. The fields themselves (chain id, 32-byte hash, 32-byte key) are matched exactly.
 *
 * Owner: reconciler workstream.
 */
import type { InvoiceKey } from "@paylink/api-contract";
import { sameMoney } from "./money.ts";
import type { ChainPayment, PayPalTransaction, TwinFacts } from "./types.ts";

/** Longest P6 note PayPal accepts (V: `payment_detail.note`, ≤ 2000). */
export const PAYPAL_NOTE_MAX = 2000;

/** PayLink's P6 note: `PayLink · eip155:<chainId> · tx 0x<64 hex> · key 0x<64 hex>` (§7.3). */
export function echoNote(chainId: number, txHash: `0x${string}`, key: InvoiceKey): string {
  return `PayLink · eip155:${String(chainId)} · tx ${txHash.toLowerCase()} · key ${key.toLowerCase()}`;
}

const NOTE = /^\s*PayLink\W+eip155:(?<chain>[1-9][0-9]{0,15})\W+tx\s*(?<tx>0x[0-9a-fA-F]{64})\W+key\s*(?<key>0x[0-9a-fA-F]{64})\s*$/u;

/** The fields of a PayLink note, or null when the note is anything else. */
export function parseEchoNote(note: string | null | undefined): { readonly chainId: number; readonly txHash: `0x${string}`; readonly key: InvoiceKey } | null {
  if (typeof note !== "string" || note.length > PAYPAL_NOTE_MAX) {
    return null;
  }
  const groups = NOTE.exec(note)?.groups;
  if (groups === undefined) {
    return null;
  }
  return {
    chainId: Number(groups["chain"]),
    txHash: (groups["tx"] ?? "").toLowerCase() as `0x${string}`,
    key: (groups["key"] ?? "").toLowerCase() as InvoiceKey,
  };
}

/** Whether `tx` is PayLink's echo of a verified chain payment of this twin (§10.3). */
export function isEcho(tx: PayPalTransaction, twin: Pick<TwinFacts, "key" | "chainId" | "amountBase" | "amountUsd">, verified: readonly ChainPayment[]): boolean {
  if (tx.method !== "OTHER") {
    return false;
  }
  const note = parseEchoNote(tx.note);
  if (note?.chainId !== twin.chainId || note.key !== twin.key.toLowerCase()) {
    return false;
  }
  if (tx.amount !== null && !sameMoney(tx.amount, twin.amountUsd)) {
    return false;
  }
  return verified.some((p) => p.txHash.toLowerCase() === note.txHash && p.amount === twin.amountBase);
}
