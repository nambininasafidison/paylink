// SPDX-License-Identifier: MIT
/**
 * The indexer's arithmetic, as pure functions over plain entity values (spec §3.8 "Handlers are pure, with unit
 * tests"). `src/handlers/PayLinkV2.ts` only loads the entities an event touches, calls `applyPaid` or
 * `applyCancelled`, and writes back what they return; everything worth testing is here and runs without Envio.
 *
 * Rules the functions keep:
 * - Every id starts with the chain ID (`<chainId>-…`), so both chains share one table without collisions.
 * - Addresses and 32-byte values are lowercase hex (config.yaml `address_format: lowercase`; normalised again here).
 * - Replaying an event that was already applied changes nothing: the handler skips a Paid whose `Payment` row exists,
 *   and `applyCancelled` leaves an already-cancelled link as it was. Envio applies each log once and rolls back on
 *   reorgs, so this is a second line of defence, not the mechanism.
 * - `Invoice.payments` follows `Paid.index + 1`, the counter the contract itself assigns (LinkState.payments), and
 *   never decreases; `total` sums the amounts. Once caught up both equal the chain's LinkState, which the web app
 *   still reads on its own (ADR 0009: the indexer is a cache).
 */
import type { DailyActivity, DailyVolume, Invoice, Payee, PayeeToken, PayerPayee, Payment } from "envio";

export const SECONDS_PER_DAY = 86_400;

/** One decoded `Paid` log with the block and transaction fields the handler selects. */
export interface PaidLog {
  readonly chainId: number;
  readonly key: string;
  readonly payee: string;
  readonly payer: string;
  readonly token: string;
  readonly amount: bigint;
  readonly index: bigint;
  readonly payerRef: string;
  readonly blockNumber: number;
  /** Block timestamp, unix seconds. */
  readonly timestamp: number;
  readonly txHash: string;
  readonly logIndex: number;
}

/** One decoded `InvoiceCancelled` log. */
export interface CancelledLog {
  readonly chainId: number;
  readonly key: string;
  readonly payee: string;
  readonly blockNumber: number;
  readonly timestamp: number;
  readonly txHash: string;
  readonly logIndex: number;
}

/** UTC day number of a unix time: floor(seconds / 86400). */
export function dayOf(timestamp: number): number {
  return Math.floor(timestamp / SECONDS_PER_DAY);
}

/** `YYYY-MM-DD` of a UTC day number. */
export function dateOf(day: number): string {
  return new Date(day * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);
}

const lower = (value: string): string => value.toLowerCase();

/** Entity ids, all prefixed with the chain ID. */
export const ids = {
  invoice: (chainId: number, key: string): string => `${String(chainId)}-${lower(key)}`,
  payment: (chainId: number, txHash: string, logIndex: number): string => `${String(chainId)}-${lower(txHash)}-${String(logIndex)}`,
  payee: (chainId: number, payee: string): string => `${String(chainId)}-${lower(payee)}`,
  payeeToken: (chainId: number, payee: string, token: string): string => `${String(chainId)}-${lower(payee)}-${lower(token)}`,
  payerPayee: (chainId: number, payee: string, payer: string): string => `${String(chainId)}-${lower(payee)}-${lower(payer)}`,
  dailyVolume: (chainId: number, token: string, day: number): string => `${String(chainId)}-${lower(token)}-${String(day)}`,
  dailyActivity: (chainId: number, day: number): string => `${String(chainId)}-${String(day)}`,
} as const;

/** The ids of every entity a `Paid` log touches. */
export function paidIds(log: PaidLog): { readonly invoice: string; readonly payment: string; readonly payee: string; readonly payeeToken: string; readonly payerPayee: string; readonly dailyVolume: string; readonly dailyActivity: string } {
  const day = dayOf(log.timestamp);
  return {
    invoice: ids.invoice(log.chainId, log.key),
    payment: ids.payment(log.chainId, log.txHash, log.logIndex),
    payee: ids.payee(log.chainId, log.payee),
    payeeToken: ids.payeeToken(log.chainId, log.payee, log.token),
    payerPayee: ids.payerPayee(log.chainId, log.payee, log.payer),
    dailyVolume: ids.dailyVolume(log.chainId, log.token, day),
    dailyActivity: ids.dailyActivity(log.chainId, day),
  };
}

/** The ids of every entity an `InvoiceCancelled` log touches. */
export function cancelledIds(log: CancelledLog): { readonly invoice: string; readonly payee: string; readonly dailyActivity: string } {
  return {
    invoice: ids.invoice(log.chainId, log.key),
    payee: ids.payee(log.chainId, log.payee),
    dailyActivity: ids.dailyActivity(log.chainId, dayOf(log.timestamp)),
  };
}

/** The stored entities a `Paid` log updates; `undefined` when none exists yet. */
export interface PaidState {
  readonly invoice: Invoice | undefined;
  readonly payee: Payee | undefined;
  readonly payeeToken: PayeeToken | undefined;
  readonly payerPayee: PayerPayee | undefined;
  readonly dailyVolume: DailyVolume | undefined;
  readonly dailyActivity: DailyActivity | undefined;
}

/** What a `Paid` log writes: the new `Payment` and every aggregate it moves. */
export interface PaidWrites {
  readonly payment: Payment;
  readonly invoice: Invoice;
  readonly payee: Payee;
  readonly payeeToken: PayeeToken;
  readonly payerPayee: PayerPayee;
  readonly dailyVolume: DailyVolume;
  readonly dailyActivity: DailyActivity;
}

const minTime = (a: bigint | undefined, b: bigint): bigint => (a === undefined || b < a ? b : a);
const maxTime = (a: bigint | undefined, b: bigint): bigint => (a === undefined || b > a ? b : a);

/** Applies one `Paid` log to the entities it touches (none of which may hold this log yet). */
export function applyPaid(state: PaidState, raw: PaidLog): PaidWrites {
  const log: PaidLog = { ...raw, key: lower(raw.key), payee: lower(raw.payee), payer: lower(raw.payer), token: lower(raw.token), payerRef: lower(raw.payerRef), txHash: lower(raw.txHash) };
  const key = paidIds(log);
  const time = BigInt(log.timestamp);
  const day = dayOf(log.timestamp);

  const before = state.invoice;
  const firstPaymentOfLink = before === undefined || before.payments === 0;
  const invoice: Invoice = {
    id: key.invoice,
    chainId: log.chainId,
    key: log.key,
    payee: log.payee,
    token: log.token,
    payments: Math.max(before?.payments ?? 0, Number(log.index) + 1),
    total: (before?.total ?? 0n) + log.amount,
    cancelled: before?.cancelled ?? false,
    firstPaidAt: minTime(before?.firstPaidAt, time),
    lastPaidAt: maxTime(before?.lastPaidAt, time),
    cancelledAt: before?.cancelledAt,
    cancelledTx: before?.cancelledTx,
    lastActivityAt: maxTime(before?.lastActivityAt, time),
  };

  const payment: Payment = {
    id: key.payment,
    chainId: log.chainId,
    invoice_id: key.invoice,
    key: log.key,
    payee: log.payee,
    payer: log.payer,
    token: log.token,
    amount: log.amount,
    index: Number(log.index),
    payerRef: log.payerRef,
    blockNumber: BigInt(log.blockNumber),
    timestamp: time,
    txHash: log.txHash,
    logIndex: log.logIndex,
  };

  const newPayer = state.payerPayee === undefined;
  const payerPayee: PayerPayee = {
    id: key.payerPayee,
    chainId: log.chainId,
    payee: log.payee,
    payer: log.payer,
    payments: (state.payerPayee?.payments ?? 0) + 1,
    firstPaidAt: minTime(state.payerPayee?.firstPaidAt, time),
    lastPaidAt: maxTime(state.payerPayee?.lastPaidAt, time),
  };

  const p = state.payee;
  const firstPaymentOfPayee = p?.firstPaidAt === undefined;
  const payee: Payee = {
    id: key.payee,
    chainId: log.chainId,
    payee: log.payee,
    payments: (p?.payments ?? 0) + 1,
    links: (p?.links ?? 0) + (firstPaymentOfLink ? 1 : 0),
    uniquePayers: (p?.uniquePayers ?? 0) + (newPayer ? 1 : 0),
    cancellations: p?.cancellations ?? 0,
    firstPaidAt: minTime(p?.firstPaidAt, time),
    lastPaidAt: maxTime(p?.lastPaidAt, time),
  };

  const t = state.payeeToken;
  const payeeToken: PayeeToken = {
    id: key.payeeToken,
    chainId: log.chainId,
    payee: log.payee,
    token: log.token,
    stats_id: key.payee,
    payments: (t?.payments ?? 0) + 1,
    volume: (t?.volume ?? 0n) + log.amount,
    firstPaidAt: minTime(t?.firstPaidAt, time),
    lastPaidAt: maxTime(t?.lastPaidAt, time),
  };

  const dailyVolume: DailyVolume = {
    id: key.dailyVolume,
    chainId: log.chainId,
    token: log.token,
    day,
    date: dateOf(day),
    payments: (state.dailyVolume?.payments ?? 0) + 1,
    volume: (state.dailyVolume?.volume ?? 0n) + log.amount,
  };

  const a = state.dailyActivity;
  const dailyActivity: DailyActivity = {
    id: key.dailyActivity,
    chainId: log.chainId,
    day,
    date: dateOf(day),
    payments: (a?.payments ?? 0) + 1,
    cancellations: a?.cancellations ?? 0,
    newPayees: (a?.newPayees ?? 0) + (firstPaymentOfPayee ? 1 : 0),
  };

  return { payment, invoice, payee, payeeToken, payerPayee, dailyVolume, dailyActivity };
}

/** The stored entities an `InvoiceCancelled` log updates. */
export interface CancelledState {
  readonly invoice: Invoice | undefined;
  readonly payee: Payee | undefined;
  readonly dailyActivity: DailyActivity | undefined;
}

/**
 * Applies one `InvoiceCancelled` log. A link can be cancelled before any payment, so the `Invoice` and `Payee` rows may
 * start here (no token, no payment yet). `null` when the link is already recorded as cancelled: the contract rejects a
 * second cancellation, so a repeat can only be a replay.
 */
export function applyCancelled(state: CancelledState, raw: CancelledLog): { readonly invoice: Invoice; readonly payee: Payee; readonly dailyActivity: DailyActivity } | null {
  if (state.invoice?.cancelled === true) {
    return null;
  }
  const log: CancelledLog = { ...raw, key: lower(raw.key), payee: lower(raw.payee), txHash: lower(raw.txHash) };
  const key = cancelledIds(log);
  const time = BigInt(log.timestamp);
  const day = dayOf(log.timestamp);
  const before = state.invoice;
  const invoice: Invoice = {
    id: key.invoice,
    chainId: log.chainId,
    key: log.key,
    payee: log.payee,
    token: before?.token,
    payments: before?.payments ?? 0,
    total: before?.total ?? 0n,
    cancelled: true,
    firstPaidAt: before?.firstPaidAt,
    lastPaidAt: before?.lastPaidAt,
    cancelledAt: time,
    cancelledTx: log.txHash,
    lastActivityAt: maxTime(before?.lastActivityAt, time),
  };
  const p = state.payee;
  const payee: Payee = {
    id: key.payee,
    chainId: log.chainId,
    payee: log.payee,
    payments: p?.payments ?? 0,
    links: p?.links ?? 0,
    uniquePayers: p?.uniquePayers ?? 0,
    cancellations: (p?.cancellations ?? 0) + 1,
    firstPaidAt: p?.firstPaidAt,
    lastPaidAt: p?.lastPaidAt,
  };
  const a = state.dailyActivity;
  const dailyActivity: DailyActivity = {
    id: key.dailyActivity,
    chainId: log.chainId,
    day,
    date: dateOf(day),
    payments: a?.payments ?? 0,
    cancellations: (a?.cancellations ?? 0) + 1,
    newPayees: a?.newPayees ?? 0,
  };
  return { invoice, payee, dailyActivity };
}
