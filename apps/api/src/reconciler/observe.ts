// SPDX-License-Identifier: MIT
/**
 * What the reconciler reads from PayPal's GET of an invoice (P5, the only PayPal truth: docs/paypal/SPEC.md §7.1, §10.1)
 * and from the store. PayPal's answer is parsed defensively: a member of the wrong type reads as absent, which the
 * situation table turns into S0 rather than a guess. Field names are those of `invoicing_v2.json` at 90e8041 (V), as
 * src/paypal/types.ts transcribes them.
 *
 * Owner: reconciler workstream.
 */
import { statusClassOf } from "@paylink/api-contract";
import type { Invoice, PaymentMethod } from "../paypal/types.ts";
import { usdFromBase } from "./money.ts";
import type { PayPalObservation, PayPalTransaction, TwinFacts } from "./types.ts";
import type { AutoRecord, TwinRecord } from "../store/types.ts";

const METHODS: ReadonlySet<string> = new Set(["BANK_TRANSFER", "CASH", "CHECK", "CREDIT_CARD", "DEBIT_CARD", "PAYPAL", "WIRE_TRANSFER", "OTHER"]);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const record = (value: unknown): Readonly<Record<string, unknown>> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

function transactionOf(value: unknown): PayPalTransaction {
  const tx = record(value) ?? {};
  const type = text(tx["type"]);
  const method = text(tx["method"]);
  return {
    paymentId: text(tx["payment_id"]),
    type: type === "PAYPAL" || type === "EXTERNAL" ? type : null,
    method: method !== null && METHODS.has(method) ? (method as PaymentMethod) : null,
    note: text(tx["note"]),
    amount: text(record(tx["amount"])?.["value"]),
    paymentDate: text(tx["payment_date"]),
  };
}

/** P5's answer as the situation table reads it. */
export function observeInvoice(invoice: Invoice): PayPalObservation {
  const raw = invoice as unknown as Readonly<Record<string, unknown>>;
  const status = text(raw["status"]) ?? "";
  const detail = record(raw["detail"]) ?? {};
  const amount = record(raw["amount"]);
  const payments = record(raw["payments"]);
  const transactions = Array.isArray(payments?.["transactions"]) ? (payments["transactions"] as unknown[]) : [];
  const recipients = Array.isArray(raw["primary_recipients"]) ? (raw["primary_recipients"] as unknown[]) : [];
  return {
    read: "ok",
    status,
    statusClass: statusClassOf(status),
    amount: text(amount?.["value"]),
    currency: text(amount?.["currency_code"]) ?? text(detail["currency_code"]),
    reference: text(detail["reference"]),
    paidAmount: text(record(payments?.["paid_amount"])?.["value"]),
    transactions: transactions.map(transactionOf),
    hasRecipientEmail: recipients.some((r) => {
      const email = text(record(record(r)?.["billing_info"])?.["email_address"]);
      return email !== null && email.length > 0;
    }),
  };
}

/** The twin's facts for the situation table, from its record and its auto-records. */
export function twinFacts(twin: TwinRecord, autoRecords: readonly AutoRecord[]): TwinFacts {
  return {
    key: twin.key,
    payee: twin.payee,
    chainId: twin.chainId,
    paypalId: twin.paypalId,
    invoiceNumber: twin.invoiceNumber,
    amountBase: twin.amountBase,
    // A twin is created only for an amount with cent precision (E_TWIN_PRECISION); "" never matches PayPal's amount (S0).
    amountUsd: usdFromBase(twin.amountBase) ?? "",
    token: twin.token,
    rail: twin.rail,
    recordedPaymentIds: twin.recordedPaymentIds,
    lastReminderAt: twin.lastReminderAt,
    sentAt: twin.sentAt,
    dueDate: twin.dueDate,
    autoRecordUndone: autoRecords.some((r) => r.key === twin.key && r.undone),
    recordMissing: autoRecords.some((r) => r.key === twin.key && r.undone && r.missing === true),
  };
}
