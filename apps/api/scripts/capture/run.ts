// SPDX-License-Identifier: MIT
/**
 * The capture run (docs/paypal/SPEC.md §15.1 and D1 of §17.2): one pass over PayPal's sandbox with PayLink's own client
 * (src/paypal/http.ts), recording what the OpenAPI files do not say, for every behaviour the spine tagged UNVERIFIED:
 *
 * | Step | Calls | Establishes |
 * |---|---|---|
 * | token | P1 | lifetime and scopes of a sandbox token |
 * | create-a, create-b, create-c | P3 ×3 | `payment_term` with `due_date` alone, with `term_type` too; a twin without an email |
 * | send-a, send-c | P4, P5 | 200 or 202, `SENT` or `SHARED` after a share link, the host of `recipient_view_url`, a share without an email |
 * | search-exact, search-partial | P2 ×2 | whether `reference` search is exact or partial |
 * | remind-a, remind-c | P9 ×2 | PayPal's reminder with and without an email |
 * | payer-pays (optional) | P5, webhook events | the status and transaction after a sandbox buyer pays, and an `INVOICING.INVOICE.PAID` event's shape |
 * | create-d, send-d, record-d | P3, P4, P6, P5 | the status after a recorded payment (K4), the note kept as written, the payment id |
 * | undo-d | P7, P5 | that P7's `transaction_id` is P6's `payment_id`, and the status after it |
 * | cancel-d, cleanup | P8, P5 | cancel after an undo; open invoices of the run are cancelled unless `keep` |
 *
 * The invoices are the run's own: random keys, a placeholder payee address, a synthetic client ("Capture" at
 * `payer@example.com`), $1.00 each. The report (./report.ts) keeps no secret and no personal data.
 *
 * Owner: PayPal spine workstream.
 */
import type { InvoiceKey } from "@paylink/api-contract";
import type { PayPalClient } from "../../src/paypal/client.ts";
import { isPayPalError } from "../../src/paypal/client.ts";
import { CANCEL_SILENTLY, REMIND_RECIPIENT, SHARE_LINK, twinCreateBody } from "../../src/paypal/invoice.ts";
import type { CreateInvoiceRequest, Invoice } from "../../src/paypal/types.ts";
import type { CaptureFindings, CaptureReport, CaptureStep, StepOutcome } from "./report.ts";
import { paths, redact, urlShape } from "./report.ts";

/** The chain the run's twins name (the edition's, D-CHAIN). */
const CHAIN_ID = 11155111;
/** A placeholder payee: the run's memos name no real account. */
const PLACEHOLDER_PAYEE = "0x0000000000000000000000000000000000000001";
const SYNTHETIC_RECIPIENT = { givenName: "Capture", email: "payer@example.com" } as const;
/** The shape of P6's `payment_id` (`payment_reference`, V: 1–22 characters, `^[0-9A-Za-z_-]+$`). */
const PAYMENT_ID = /^[0-9A-Za-z_-]{1,22}$/u;

export interface CaptureOptions {
  readonly paypal: PayPalClient;
  /** Scheme and host of the REST base, for the report. */
  readonly base: string;
  readonly hasWebhookId: boolean;
  readonly clock: () => number;
  readonly random: (bytes: number) => Uint8Array;
  /** Progress for the owner (stderr): steps, and the URLs of the manual checks. Never a secret. */
  readonly say: (line: string) => void;
  /** Waits while the owner pays `url` as a sandbox buyer; `null` skips the payer step. */
  readonly waitForPayment: ((url: string, invoiceId: string) => Promise<void>) | null;
  /** Lists recent webhook events of a type (`GET /v1/notifications/webhooks-events`); `null` skips the event's shape. */
  readonly listEvents: ((eventType: string) => Promise<unknown>) | null;
  /** Leave the run's open invoices open instead of cancelling them. */
  readonly keep: boolean;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function runCapture(options: CaptureOptions): Promise<CaptureReport> {
  const { paypal, say } = options;
  const steps: CaptureStep[] = [];
  const key = (): InvoiceKey => `0x${hex(options.random(32))}`;
  const today = new Date(options.clock()).toISOString().slice(0, 10);
  const inAWeek = new Date(options.clock() + 7 * 86_400_000).toISOString().slice(0, 10);

  /** Runs one call, records it, and returns its answer (or null when PayPal refused or did not answer). */
  const step = async <T>(id: string, operation: string, call: () => Promise<T>, show: (answer: T) => unknown = (a) => a): Promise<T | null> => {
    say(`capture: ${id} (${operation})`);
    try {
      const answer = await call();
      const shown: unknown = answer;
      steps.push({ id, operation, outcome: { result: "ok", status: null }, ...(shown === undefined ? {} : { answer: redact(show(answer)) }) });
      return answer;
    } catch (error) {
      if (!isPayPalError(error)) {
        throw error;
      }
      const outcome: StepOutcome = error.status === 0 ? { result: "no-answer" } : { result: "refused", status: error.status, name: error.paypalName, issue: error.issue, debugId: error.debugId };
      steps.push({ id, operation, outcome });
      return null;
    }
  };
  const verdict = (id: string): string => {
    const outcome = steps.findLast((s) => s.id === id)?.outcome;
    if (outcome === undefined) {
      return "not-run";
    }
    if (outcome.result === "refused") {
      return `refused:${String(outcome.status)}:${outcome.name ?? ""}:${outcome.issue ?? ""}`;
    }
    return outcome.result === "ok" ? "accepted" : outcome.result;
  };
  const body = (k: InvoiceKey, overrides: { readonly recipient?: { readonly givenName?: string; readonly email?: string } | null; readonly termType?: boolean } = {}): CreateInvoiceRequest => {
    const built = twinCreateBody({
      key: k,
      chainId: CHAIN_ID,
      payee: PLACEHOLDER_PAYEE,
      amountUsd: "1.00",
      description: "PayLink capture run",
      dueDate: inAWeek,
      recipient: overrides.recipient === undefined ? SYNTHETIC_RECIPIENT : overrides.recipient,
      payLink: null,
    });
    return overrides.termType === true ? { ...built, detail: { ...built.detail, payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: inAWeek } as never } } : built;
  };
  const read = async (id: string, invoiceId: string): Promise<Invoice | null> => await step(id, "P5", () => paypal.getInvoice(invoiceId));

  // P1.
  const token = await step(
    "token",
    "P1",
    () => paypal.token(),
    (t) => ({ token_type: t.token_type, expires_in: t.expires_in }),
  );
  const scopes = (token?.scope ?? "").split(/\s+/u).filter((s) => /^https:\/\/uri\.paypal\.com\/services\/[a-z/_-]+$/u.test(s));

  // P3: the three bodies.
  const keyA = key();
  const keyB = key();
  const keyC = key();
  const a = await step("create-a", "P3", () => paypal.createInvoice(body(keyA)));
  const b = await step("create-b", "P3", () => paypal.createInvoice(body(keyB, { termType: true })));
  const c = await step("create-c", "P3", () => paypal.createInvoice(body(keyC, { recipient: { givenName: "Capture" } })));

  // P4 then P5.
  const sendA = a?.id === undefined ? null : await step("send-a", "P4", () => paypal.sendInvoice(a.id ?? "", SHARE_LINK), (s) => ({ status: s.status, rel: s.link?.rel ?? null }));
  const sharedA = a?.id === undefined ? null : await read("read-a", a.id);
  if (c?.id !== undefined) {
    await step("send-c", "P4", () => paypal.sendInvoice(c.id ?? "", SHARE_LINK), (s) => ({ status: s.status }));
    await read("read-c", c.id);
  }

  // P2: exact and partial.
  const exact = await step("search-exact", "P2", () => paypal.searchInvoices({ reference: keyA }), (p) => ({ matches: (p.items ?? []).length }));
  const partial = await step("search-partial", "P2", () => paypal.searchInvoices({ reference: keyA.slice(0, 34) }), (p) => ({ matches: (p.items ?? []).length }));
  const exactCount = (exact?.items ?? []).filter((i) => i.detail.reference === keyA).length;
  const partialCount = (partial?.items ?? []).filter((i) => i.detail.reference === keyA).length;
  const referenceSearch = exact === null || partial === null || exactCount !== 1 ? "unknown" : partialCount > 0 ? "partial" : "exact";

  // P9: with and without an email.
  if (a?.id !== undefined) {
    await step("remind-a", "P9", () => paypal.remindInvoice(a.id ?? "", REMIND_RECIPIENT));
  }
  if (c?.id !== undefined) {
    await step("remind-c", "P9", () => paypal.remindInvoice(c.id ?? "", REMIND_RECIPIENT));
  }

  // The payer pays A (the owner, as a sandbox buyer), then the event's shape.
  let paidA: Invoice | null = null;
  let eventPaths: readonly string[] | null = null;
  const viewA = sharedA?.detail.metadata?.recipient_view_url ?? null;
  if (options.waitForPayment !== null && viewA !== null && a?.id !== undefined) {
    say(`capture: pay ${viewA} as a sandbox buyer now`);
    await options.waitForPayment(viewA, a.id);
    paidA = await read("payer-paid-a", a.id);
    if (options.listEvents !== null) {
      const listed = await step("events-paid", "webhooks-events", () => options.listEvents?.("INVOICING.INVOICE.PAID") ?? Promise.resolve(null), () => ({}));
      const events = (listed as { readonly events?: readonly unknown[] } | null)?.events ?? [];
      const mine = events.find((e) => JSON.stringify(e).includes(a.id ?? "\u0000"));
      eventPaths = mine === undefined ? [] : paths(mine).filter((p) => !p.startsWith("links"));
    }
  } else {
    steps.push({ id: "payer-pays", operation: "manual", outcome: { result: "skipped", reason: options.waitForPayment === null ? "not asked (--wait-payment)" : "no payer view" } });
  }

  // D: record, undo, cancel.
  const keyD = key();
  const d = await step("create-d", "P3", () => paypal.createInvoice(body(keyD)));
  let recorded: { readonly payment_id: string } | null = null;
  let afterRecord: Invoice | null = null;
  let afterUndo: Invoice | null = null;
  let afterCancel: Invoice | null = null;
  // The §7.3 note exactly as the reconciler writes it on a recorded chain payment (src/reconciler/echo.ts), with a zero
  // transaction hash: whether PayPal keeps it byte for byte (the "·" separators included) is one of the findings.
  const note = `PayLink · eip155:${String(CHAIN_ID)} · tx 0x${"0".repeat(64)} · key ${keyD}`;
  if (d?.id !== undefined) {
    const id = d.id;
    await step("send-d", "P4", () => paypal.sendInvoice(id, SHARE_LINK), (s) => ({ status: s.status }));
    recorded = await step("record-d", "P6", () => paypal.recordPayment(id, { method: "OTHER", payment_date: today, amount: { currency_code: "USD", value: "1.00" }, note }), () => ({}));
    afterRecord = await read("read-d-recorded", id);
    const viewD = afterRecord?.detail.metadata?.recipient_view_url;
    if (viewD !== undefined) {
      say(`capture: manual check (K4): does ${viewD} still accept a payment after the record? Note it before the undo below runs.`);
    }
    if (recorded !== null) {
      const paymentId = recorded.payment_id;
      await step("undo-d", "P7", () => paypal.deletePayment(id, paymentId));
      afterUndo = await read("read-d-undone", id);
    }
    await step("cancel-d", "P8", () => paypal.cancelInvoice(id, CANCEL_SILENTLY));
    afterCancel = await read("read-d-cancelled", id);
  }

  // Cleanup: the run's invoices that are still open.
  if (!options.keep) {
    for (const [label, invoice] of [
      ["a", a],
      ["c", c],
    ] as const) {
      if (invoice?.id !== undefined) {
        const now = await paypal.getInvoice(invoice.id).catch(() => null);
        if (now !== null && ["SENT", "SHARED", "UNPAID"].includes(now.status ?? "")) {
          await step(`cleanup-${label}`, "P8", () => paypal.cancelInvoice(invoice.id ?? "", CANCEL_SILENTLY));
        }
      }
    }
    if (b !== null) {
      steps.push({ id: "cleanup-b", operation: "none", outcome: { result: "skipped", reason: "a draft cannot be cancelled (CANNOT_CANCEL_DRAFT_INVOICE); delete it in the dashboard if wanted" } });
    }
  }

  const transaction = (invoice: Invoice | null, type: string): { readonly type: string | null; readonly method: string | null } | null => {
    const found = invoice?.payments?.transactions?.find((t) => t.type === type) ?? invoice?.payments?.transactions?.[0];
    return found === undefined ? null : { type: found.type ?? null, method: found.method ?? null };
  };
  const recordedNote = afterRecord?.payments?.transactions?.find((t) => t.payment_id === recorded?.payment_id)?.note ?? afterRecord?.payments?.transactions?.[0]?.note;
  const findings: CaptureFindings = {
    tokenLifetimeSeconds: token?.expires_in ?? null,
    tokenScopes: scopes,
    createWithDueDateOnly: verdict("create-a"),
    createWithTermTypeAndDueDate: verdict("create-b"),
    createWithoutEmail: verdict("create-c"),
    sendAnswer: sendA === null ? verdict("send-a") : String(sendA.status),
    statusAfterShare: sharedA?.status ?? null,
    shareWithoutEmail: verdict("send-c"),
    recipientViewUrl: viewA === null ? null : urlShape(viewA),
    referenceSearch,
    remindWithEmail: verdict("remind-a"),
    remindWithoutEmail: verdict("remind-c"),
    payerPayment: paidA === null ? "not-run" : "paid",
    statusAfterPayerPayment: paidA?.status ?? null,
    payerTransaction: transaction(paidA, "PAYPAL"),
    webhookEventPaths: eventPaths,
    statusAfterRecord: afterRecord?.status ?? null,
    recordNote: recorded === null ? "not-run" : recordedNote === undefined ? "absent" : recordedNote === note ? "exact" : "changed",
    paymentIdShape: recorded === null ? null : { length: recorded.payment_id.length, pattern: PAYMENT_ID.test(recorded.payment_id) },
    undoWithPaymentId: verdict("undo-d"),
    statusAfterUndo: afterUndo?.status ?? null,
    cancelAfterUndo: verdict("cancel-d"),
    statusAfterCancel: afterCancel?.status ?? null,
  };
  return {
    tool: "paylink-api capture",
    format: 1,
    ranAt: new Date(options.clock()).toISOString(),
    base: options.base,
    credentials: { clientId: "present", clientSecret: "present", webhookId: options.hasWebhookId ? "present" : "absent" },
    findings,
    steps,
    manual: [
      "K4: whether the payer page of the recorded invoice still accepted a payment after the record (the run printed its URL before the undo).",
      "P9: where the sandbox reminder appeared (Developer Dashboard > Testing tools > Sandbox notifications, or nowhere).",
      "P10: one real delivery verified by the deployed Worker (its log line webhook.received, outcome processed) after a sandbox payment.",
    ],
  };
}
