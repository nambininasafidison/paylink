// SPDX-License-Identifier: MIT
/**
 * A PayPal stand-in for the reconciler's tests: one sandbox merchant's invoices in memory with the status changes the
 * reconciler depends on (shape of `invoicing_v2.json` at 90e8041). By default it answers as the sandbox did in the
 * owner's capture of 2026-10-29 (docs/research/paypal/capture-2026-10-29.md): `UNPAID` once shared, `MARKED_AS_PAID`
 * after a recorded payment (P6), `UNPAID` again after its Undo (P7). What P6 leaves stays a switch, so the tests also run
 * the other plausible answers (K4's payer page after a record is still open). The PayPal spine's own fake
 * (src/paypal/fake/) serves the e2e suite; this one only needs the five calls the reconciler makes, and records each.
 */
import type { InvoiceKey, PayPalInvoiceStatus } from "@paylink/api-contract";
import { PayPalError } from "../../src/paypal/client.ts";
import type { PayPalClient } from "../../src/paypal/client.ts";
import type { Invoice, PaymentDetail } from "../../src/paypal/types.ts";

export interface StubCall {
  readonly op: "get" | "record" | "delete" | "cancel" | "remind";
  readonly id: string;
  readonly body?: unknown;
  /** The write's `PayPal-Request-Id`, when the caller sent one. */
  readonly requestId?: string;
}

export interface PayPalStub {
  readonly client: PayPalClient;
  readonly calls: StubCall[];
  readonly invoices: Map<string, Invoice>;
  /** Adds a shared twin of `amount` for K (`status`, an email or not). */
  add(id: string, key: InvoiceKey, options?: { readonly amount?: string; readonly status?: PayPalInvoiceStatus; readonly email?: boolean }): void;
  /** A buyer pays on PayPal's hosted page. */
  payOnPayPal(id: string): void;
  /** What P6 leaves: `MARKED_AS_PAID` (the sandbox's, C), or `PAID`, `PAID_EXTERNAL`, or still open. */
  afterRecord: PayPalInvoiceStatus;
  /** The next call of `op` fails with this HTTP status (0: no answer). */
  failNext: Partial<Record<StubCall["op"], number>>;
  /** The issue (`details[0].issue`) of that failure, as PayPal names it. */
  failIssue: Partial<Record<StubCall["op"], string>>;
  /** Every `get` fails with this status while set. */
  failGets: number | null;
  /** The next call of `op` is carried out, then its answer is lost (no answer, `ambiguous`), as a timeout would. */
  loseAnswer: Partial<Record<StubCall["op"], true>>;
  /** Deletes a recorded payment outside PayLink (the merchant's PayPal dashboard): no call is recorded. */
  deleteOutside(id: string, paymentId: string): void;
  writes(): StubCall[];
}

const copy = <T>(value: T): T => structuredClone(value);

export function paypalStub(): PayPalStub {
  const invoices = new Map<string, Invoice>();
  const calls: StubCall[] = [];
  let counter = 0;
  const stub: PayPalStub = {
    client: null as unknown as PayPalClient,
    calls,
    invoices,
    afterRecord: "MARKED_AS_PAID",
    failNext: {},
    failIssue: {},
    failGets: null,
    add(id, key, options = {}) {
      invoices.set(id, {
        id,
        status: options.status ?? "UNPAID",
        detail: { reference: key, currency_code: "USD", invoice_number: `PL-11155111-${key.slice(2, 14)}`, metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` } },
        primary_recipients: options.email === false ? [{ billing_info: { name: { given_name: "Sarah" } } }] : [{ billing_info: { name: { given_name: "Sarah" }, email_address: "sarah@example.com" } }],
        amount: { currency_code: "USD", value: options.amount ?? "120.00" },
        due_amount: { currency_code: "USD", value: options.amount ?? "120.00" },
        payments: { transactions: [] },
      });
    },
    payOnPayPal(id) {
      const inv = invoices.get(id);
      if (inv === undefined) {
        throw new Error("no such invoice");
      }
      counter += 1;
      const value = inv.amount?.value ?? "0.00";
      invoices.set(id, { ...inv, status: "PAID", payments: { paid_amount: { currency_code: "USD", value }, transactions: [...(inv.payments?.transactions ?? []), { type: "PAYPAL", payment_id: `PAYPAL${String(counter).padStart(8, "0")}`, method: "PAYPAL", amount: { currency_code: "USD", value }, payment_date: "2026-10-21" }] } });
    },
    writes: () => calls.filter((c) => c.op !== "get"),
    loseAnswer: {},
    deleteOutside: (id, paymentId) => {
      removePayment(id, paymentId);
    },
  };
  /** Throws the lost answer of `op` once, after the operation was applied. */
  const lose = (op: StubCall["op"]): void => {
    if (stub.loseAnswer[op] === true) {
      stub.loseAnswer = Object.fromEntries(Object.entries(stub.loseAnswer).filter(([k]) => k !== op));
      throw new PayPalError(op === "get" ? "P5" : op === "record" ? "P6" : op === "delete" ? "P7" : op === "cancel" ? "P8" : "P9", 0, { name: "E_PAYPAL_NO_ANSWER", ambiguous: true });
    }
  };
  function removePayment(id: string, transactionId: string): void {
    const inv = find(id);
    const transactions = (inv.payments?.transactions ?? []).filter((t) => t.payment_id !== transactionId);
    invoices.set(id, { ...inv, status: transactions.length === 0 ? "UNPAID" : (inv.status ?? "UNPAID"), payments: { paid_amount: { currency_code: "USD", value: "0.00" }, transactions } });
  }
  const fail = (op: StubCall["op"]): void => {
    const status = stub.failNext[op];
    if (status !== undefined) {
      stub.failNext = Object.fromEntries(Object.entries(stub.failNext).filter(([k]) => k !== op));
      const issue = stub.failIssue[op] ?? null;
      stub.failIssue = Object.fromEntries(Object.entries(stub.failIssue).filter(([k]) => k !== op));
      throw new PayPalError(op === "get" ? "P5" : op === "record" ? "P6" : op === "delete" ? "P7" : op === "cancel" ? "P8" : "P9", status, { name: status === 429 ? "RATE_LIMIT_REACHED" : status === 422 ? "UNPROCESSABLE_ENTITY" : status === 400 ? "INVALID_REQUEST" : null, issue });
    }
  };
  const find = (id: string): Invoice => {
    const inv = invoices.get(id);
    if (inv === undefined) {
      throw new PayPalError("P5", 404, { name: "RESOURCE_NOT_FOUND" });
    }
    return inv;
  };
  const client: Partial<PayPalClient> = {
    getInvoice: (id) => {
      calls.push({ op: "get", id });
      if (stub.failGets !== null) {
        return Promise.reject(new PayPalError("P5", stub.failGets));
      }
      try {
        fail("get");
        return Promise.resolve(copy(find(id)));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    recordPayment: (id, payment: PaymentDetail, options) => {
      calls.push({ op: "record", id, body: copy(payment), ...(options?.requestId === undefined ? {} : { requestId: options.requestId }) });
      try {
        fail("record");
        const inv = find(id);
        counter += 1;
        const paymentId = `EXT${String(counter).padStart(8, "0")}`;
        const value = payment.amount?.value ?? inv.amount?.value ?? "0.00";
        invoices.set(id, { ...inv, status: stub.afterRecord, payments: { paid_amount: { currency_code: "USD", value }, transactions: [...(inv.payments?.transactions ?? []), { ...payment, type: "EXTERNAL", payment_id: paymentId }] } });
        lose("record");
        return Promise.resolve({ payment_id: paymentId });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    deletePayment: (id, transactionId, options) => {
      calls.push({ op: "delete", id, body: transactionId, ...(options?.requestId === undefined ? {} : { requestId: options.requestId }) });
      try {
        fail("delete");
        if (!(find(id).payments?.transactions ?? []).some((t) => t.payment_id === transactionId)) {
          throw new PayPalError("P7", 404, { name: "RESOURCE_NOT_FOUND" });
        }
        removePayment(id, transactionId);
        lose("delete");
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    cancelInvoice: (id, notification, options) => {
      calls.push({ op: "cancel", id, body: copy(notification), ...(options?.requestId === undefined ? {} : { requestId: options.requestId }) });
      try {
        fail("cancel");
        invoices.set(id, { ...find(id), status: "CANCELLED" });
        lose("cancel");
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    remindInvoice: (id, notification, options) => {
      calls.push({ op: "remind", id, body: copy(notification), ...(options?.requestId === undefined ? {} : { requestId: options.requestId }) });
      try {
        fail("remind");
        find(id);
        lose("remind");
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  (stub as { client: PayPalClient }).client = client as PayPalClient;
  return stub;
}
