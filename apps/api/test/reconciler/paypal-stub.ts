// SPDX-License-Identifier: MIT
/**
 * A PayPal stand-in for the reconciler's tests: one sandbox merchant's invoices in memory with the status changes the
 * reconciler depends on (shape of `invoicing_v2.json` at 90e8041). What PayPal does after a recorded payment (P6), an
 * Undo (P7) and a cancel (P8) is UNVERIFIED until the owner's capture run, so each is a switch here and the tests run
 * every plausible answer. The PayPal spine's own fake (src/paypal/fake/) serves the e2e suite; this one only needs the
 * five calls the reconciler makes, and records each.
 */
import type { InvoiceKey, PayPalInvoiceStatus } from "@paylink/api-contract";
import { PayPalError } from "../../src/paypal/client.ts";
import type { PayPalClient } from "../../src/paypal/client.ts";
import type { Invoice, PaymentDetail } from "../../src/paypal/types.ts";

export interface StubCall {
  readonly op: "get" | "record" | "delete" | "cancel" | "remind";
  readonly id: string;
  readonly body?: unknown;
}

export interface PayPalStub {
  readonly client: PayPalClient;
  readonly calls: StubCall[];
  readonly invoices: Map<string, Invoice>;
  /** Adds a shared twin of `amount` for K (`status`, an email or not). */
  add(id: string, key: InvoiceKey, options?: { readonly amount?: string; readonly status?: PayPalInvoiceStatus; readonly email?: boolean }): void;
  /** A buyer pays on PayPal's hosted page. */
  payOnPayPal(id: string): void;
  /** What P6 leaves (UNVERIFIED: `PAID`, `MARKED_AS_PAID`, `PAID_EXTERNAL`, or still open). */
  afterRecord: PayPalInvoiceStatus;
  /** The next call of `op` fails with this HTTP status (0: no answer). */
  failNext: Partial<Record<StubCall["op"], number>>;
  /** Every `get` fails with this status while set. */
  failGets: number | null;
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
    failGets: null,
    add(id, key, options = {}) {
      invoices.set(id, {
        id,
        status: options.status ?? "SHARED",
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
  };
  const fail = (op: StubCall["op"]): void => {
    const status = stub.failNext[op];
    if (status !== undefined) {
      stub.failNext = Object.fromEntries(Object.entries(stub.failNext).filter(([k]) => k !== op));
      throw new PayPalError(op === "get" ? "P5" : op === "record" ? "P6" : op === "delete" ? "P7" : op === "cancel" ? "P8" : "P9", status, { name: status === 429 ? "RATE_LIMIT_REACHED" : status === 422 ? "UNPROCESSABLE_ENTITY" : null });
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
    recordPayment: (id, payment: PaymentDetail) => {
      calls.push({ op: "record", id, body: copy(payment) });
      try {
        fail("record");
        const inv = find(id);
        counter += 1;
        const paymentId = `EXT${String(counter).padStart(8, "0")}`;
        const value = payment.amount?.value ?? inv.amount?.value ?? "0.00";
        invoices.set(id, { ...inv, status: stub.afterRecord, payments: { paid_amount: { currency_code: "USD", value }, transactions: [...(inv.payments?.transactions ?? []), { ...payment, type: "EXTERNAL", payment_id: paymentId }] } });
        return Promise.resolve({ payment_id: paymentId });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    deletePayment: (id, transactionId) => {
      calls.push({ op: "delete", id, body: transactionId });
      try {
        fail("delete");
        const inv = find(id);
        const transactions = (inv.payments?.transactions ?? []).filter((t) => t.payment_id !== transactionId);
        invoices.set(id, { ...inv, status: transactions.length === 0 ? "SHARED" : (inv.status ?? "SHARED"), payments: { paid_amount: { currency_code: "USD", value: "0.00" }, transactions } });
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    cancelInvoice: (id, notification) => {
      calls.push({ op: "cancel", id, body: copy(notification) });
      try {
        fail("cancel");
        invoices.set(id, { ...find(id), status: "CANCELLED" });
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    remindInvoice: (id, notification) => {
      calls.push({ op: "remind", id, body: copy(notification) });
      try {
        fail("remind");
        find(id);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  (stub as { client: PayPalClient }).client = client as PayPalClient;
  return stub;
}
