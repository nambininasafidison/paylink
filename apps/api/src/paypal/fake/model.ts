// SPDX-License-Identifier: MIT
/**
 * The PayPal fake's state: invoices with the status machine of Invoicing v2, payments, OAuth tokens, webhook
 * subscriptions, events and their deliveries. Pure state and rules, no HTTP (src/paypal/fake/app.ts serves it).
 *
 * The status machine (statuses and their meanings V, `invoice_status` in `invoicing_v2.json`; transitions are the
 * operations' descriptions where they state them, the sandbox's where the owner's capture of 2026-10-29 recorded them,
 * **C** (docs/research/paypal/capture-2026-10-29.md), and the fake's documented choice otherwise):
 *
 * | From | Event | To | Source |
 * |---|---|---|---|
 * | (none) | P3 create | `DRAFT` | "Creates a draft invoice" (V) |
 * | `DRAFT` | P4 send, issue date today or past | `SENT` (to the recipient) or `behaviour.statusAfterShare` (share link: `UNPAID`) | 200 "when the invoice issue date is current date" (V); 200 and `UNPAID` after a share link (C) |
 * | `DRAFT` | P4 send, issue date in the future | `SCHEDULED` (answer 202) | 202 description (V) |
 * | open | the payer pays the whole amount | `behaviour.payerPaymentStatus` (`PAID`), a transaction of type and method `PAYPAL` | `PAID`: "The payer has paid for the invoice" (V); both (C) |
 * | open | P6 records the whole amount due | `behaviour.statusAfterRecord` (`MARKED_AS_PAID`), the note kept exactly | "If no payment is due, the invoice is marked as `PAID`" (V); the sandbox shows `MARKED_AS_PAID` (C) |
 * | open | P6 or a payment covers part of it | `PARTIALLY_PAID` | "Otherwise, the invoice is marked as PARTIALLY PAID" (V) |
 * | paid by P6 | P7 deletes the external payment (P6's `payment_id` as `transaction_id`) | the open status it had (`UNPAID`) | C |
 * | open, `SCHEDULED` excepted | P8 cancel | `CANCELLED` | 422 issues `CANNOT_CANCEL_DRAFT_INVOICE`, `CANNOT_CANCEL_PAID_INVOICE`, `CANNOT_CANCEL_REFUNDED_INVOICE`, `CANNOT_CANCEL_SCHEDULED_INVOICE`, `INVOICE_CANCELED_ALREADY` (V); `CANCELLED` after an undo (C) |
 * | open or `PARTIALLY_PAID` | P9 remind | unchanged | 422 issue `CANNOT_REMIND_INVOICE` (V) otherwise, and past `behaviour.remindersPerDay` (S: two a day); without a billing email 400 `INVALID_REQUEST`, issue `CANNOT_REMIND_AS_BILLING_INFO_ABSENT` (C) |
 *
 * "open" is `SENT`, `SHARED` or `UNPAID`. `SHARED` after a share link is reached only through `behaviour`, and
 * `AUTO_CANCELLED` and the refund statuses only through the fake's own controls (`forceStatus`), for tests of the
 * situations they lead to.
 *
 * Owner: PayPal spine workstream.
 */
import { SUBSCRIBED_EVENTS } from "../types.ts";
import type { FakeIds } from "./ids.ts";

/**
 * Behaviours the OpenAPI files leave open. Each default is what the sandbox did in the owner's capture of 2026-10-29
 * (**C**, docs/research/paypal/capture-2026-10-29.md) where the capture recorded it, and otherwise the pessimistic or
 * expected choice (UNVERIFIED). Each stays switchable, so the tests prove PayLink against the other answers too, and the
 * capture script (apps/api/scripts/capture/) can be shown to tell them apart.
 */
export interface FakeBehaviour {
  /** Open status after a share-link send (`send_to_recipient: false`). C: `UNPAID`. */
  readonly statusAfterShare: "UNPAID" | "SHARED" | "SENT";
  /** Status after P6 records the whole amount due. C: `MARKED_AS_PAID` (K4's payer page after a record is still open). */
  readonly statusAfterRecord: "PAID" | "MARKED_AS_PAID" | "PAID_EXTERNAL";
  /** How P2 matches `reference`. C: partly (`contains`), which PayLink's exact filter must survive. */
  readonly referenceSearch: "exact" | "contains";
  /** Status a payer's whole payment leaves: `PAID` (C), or `PAYMENT_PENDING` (a held payment). */
  readonly payerPaymentStatus: "PAID" | "PAYMENT_PENDING";
  /** P9 needs a billing email: C, refused without one (400 `CANNOT_REMIND_AS_BILLING_INFO_ABSENT`). */
  readonly remindRequiresEmail: boolean;
  /** P9 calls allowed per invoice per 24 hours (S: "2 manual reminders per invoice within 24 hours"). */
  readonly remindersPerDay: number;
  /** Where an invoicing event carries the invoice: `{ invoice: {...} }` or the invoice itself. UNVERIFIED (the capture's event list was empty). */
  readonly eventResource: "invoice-wrapper" | "flat";
  /** Deduplicate writes by `PayPal-Request-Id`. UNVERIFIED for Invoicing: off, so tests prove read-before-retry. */
  readonly honourRequestId: boolean;
  /** Seconds a token lives (`expires_in`). C: the sandbox's token answered 32,326. */
  readonly tokenLifetimeSeconds: number;
}

export const DEFAULT_BEHAVIOUR: FakeBehaviour = {
  statusAfterShare: "UNPAID",
  statusAfterRecord: "MARKED_AS_PAID",
  referenceSearch: "contains",
  payerPaymentStatus: "PAID",
  remindRequiresEmail: true,
  remindersPerDay: 2,
  eventResource: "invoice-wrapper",
  honourRequestId: false,
  tokenLifetimeSeconds: 32_326,
};

/** Open statuses (§7.4). */
export const OPEN_STATUSES: readonly string[] = ["SENT", "SHARED", "UNPAID"];
const PAID_STATUSES: readonly string[] = ["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL", "PAYMENT_PENDING"];
const REFUNDED_STATUSES: readonly string[] = ["REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED", "REFUNDED_EXTERNAL"];

/**
 * A rule a request broke: the HTTP status and the `details[].issue`. The issue is one the files list for that operation
 * and status where they list any (their composite error schemas, `invoices.cancel-422` and so on), so the fake's answers
 * stay valid against them (L0); `null` sends no `details` where the files name no issue that fits.
 */
export class FakeRefusal extends Error {
  readonly status: number;
  readonly issue: string | null;
  readonly field: string | null;

  constructor(status: number, issue: string | null, field: string | null = null) {
    super(issue ?? `HTTP ${String(status)}`);
    this.name = "FakeRefusal";
    this.status = status;
    this.issue = issue;
    this.field = field;
  }
}

export interface FakePayment {
  readonly type: "PAYPAL" | "EXTERNAL";
  readonly paymentId: string;
  readonly date: string;
  readonly method: string;
  readonly note: string | null;
  readonly cents: bigint;
}

/** One invoice as the fake keeps it; rendered to PayPal's JSON by app.ts. */
export interface FakeInvoice {
  readonly id: string;
  status: string;
  readonly reference: string | null;
  readonly currency: string;
  readonly note: string | null;
  readonly memo: string | null;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly paymentTerm: Readonly<Record<string, string>> | null;
  readonly recipients: readonly unknown[];
  readonly items: readonly { readonly id: string; readonly name: string; readonly quantity: string; readonly unitAmount: { readonly currency_code: string; readonly value: string }; readonly description?: string }[];
  readonly configuration: unknown;
  readonly totalCents: bigint;
  readonly payments: FakePayment[];
  /** The open status a send left, to return to when recorded payments are deleted. */
  openStatus: string | null;
  readonly reminders: number[];
  readonly createdAt: number;
  updatedAt: number;
  firstSentAt: number | null;
  lastSentAt: number | null;
  cancelledAt: number | null;
}

export interface FakeSubscription {
  readonly id: string;
  url: string | null;
  readonly eventTypes: readonly string[];
}

export interface FakeEvent {
  readonly id: string;
  readonly eventType: string;
  /** The event exactly as delivered (the raw body). */
  readonly raw: string;
}

export interface FakeDelivery {
  readonly eventId: string;
  readonly subscriptionId: string;
  attempts: number;
  state: "pending" | "delivered" | "failed";
  lastStatus: number | null;
}

/** Events and settled deliveries kept (the latest). */
const MAX_KEPT = 1_000;

/** The id of the subscription every fake starts with (`webhook_id` pattern `^[a-zA-Z0-9]+$`, ≤ 50, V). */
export const FAKE_WEBHOOK_ID = "0FAKEWEBHOOKPAYLINK0";

/** Cents of a PayPal money value (non-negative, at most two decimals), or null. */
export function centsOf(value: string): bigint | null {
  const match = /^(?<whole>[0-9]{1,15})(?:\.(?<fraction>[0-9]{1,2}))?$/u.exec(value);
  if (match?.groups === undefined) {
    return null;
  }
  return BigInt(match.groups["whole"] ?? "0") * 100n + BigInt((match.groups["fraction"] ?? "").padEnd(2, "0"));
}

/** A cent amount as PayPal's two-decimal value. */
export function valueOf(cents: bigint): string {
  return `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export class FakeState {
  readonly behaviour: FakeBehaviour;
  readonly invoices = new Map<string, FakeInvoice>();
  readonly tokens = new Map<string, number>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly events = new Map<string, FakeEvent>();
  readonly eventOrder: string[] = [];
  readonly deliveries: FakeDelivery[] = [];
  /** Answers already given to a `PayPal-Request-Id` (only with `behaviour.honourRequestId`). */
  readonly replies = new Map<string, { readonly status: number; readonly body: string }>();
  readonly ids: FakeIds;
  readonly clock: () => number;

  constructor(ids: FakeIds, clock: () => number, behaviour: FakeBehaviour) {
    this.ids = ids;
    this.clock = clock;
    this.behaviour = behaviour;
    this.subscriptions.set(FAKE_WEBHOOK_ID, { id: FAKE_WEBHOOK_ID, url: null, eventTypes: [...SUBSCRIBED_EVENTS] });
  }

  today(): string {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  // ----------------------------------------------------------------------------------------- tokens

  issueToken(): { readonly token: string; readonly expiresIn: number } {
    const token = this.ids.accessToken();
    this.tokens.set(token, this.clock() + this.behaviour.tokenLifetimeSeconds * 1000);
    return { token, expiresIn: this.behaviour.tokenLifetimeSeconds };
  }

  tokenValid(token: string): boolean {
    const expiresAt = this.tokens.get(token);
    return expiresAt !== undefined && expiresAt > this.clock();
  }

  /** Every token issued so far stops working (as if they expired). */
  revokeTokens(): void {
    this.tokens.clear();
  }

  // ----------------------------------------------------------------------------------------- invoices

  get(id: string): FakeInvoice {
    const invoice = this.invoices.get(id);
    if (invoice === undefined) {
      throw new FakeRefusal(404, "INVALID_RESOURCE_ID");
    }
    return invoice;
  }

  dueCents(invoice: FakeInvoice): bigint {
    const paid = invoice.payments.reduce((sum, p) => sum + p.cents, 0n);
    return invoice.totalCents > paid ? invoice.totalCents - paid : 0n;
  }

  paidCents(invoice: FakeInvoice): bigint {
    return invoice.payments.reduce((sum, p) => sum + p.cents, 0n);
  }

  create(input: Omit<FakeInvoice, "id" | "status" | "payments" | "openStatus" | "reminders" | "createdAt" | "updatedAt" | "firstSentAt" | "lastSentAt" | "cancelledAt">): FakeInvoice {
    for (const other of this.invoices.values()) {
      if (other.invoiceNumber === input.invoiceNumber) {
        // create's 422 lists only USER_NOT_FOUND (V): PayPal's answer to a reused number is UNVERIFIED, so the fake sends
        // the 422 without an issue. PayLink never branches on it: P2 runs before every P3.
        throw new FakeRefusal(422, null, "/detail/invoice_number");
      }
    }
    const now = this.clock();
    const invoice: FakeInvoice = { ...input, id: this.ids.invoiceId(), status: "DRAFT", payments: [], openStatus: null, reminders: [], createdAt: now, updatedAt: now, firstSentAt: null, lastSentAt: null, cancelledAt: null };
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  /** P4. Returns 200 (sent now) or 202 (scheduled). */
  send(id: string, toRecipient: boolean): 200 | 202 {
    const invoice = this.get(id);
    if (invoice.status !== "DRAFT") {
      // The files list no issue for send's 422; PayPal's answer to a repeated send is UNVERIFIED.
      throw new FakeRefusal(422, "INVOICE_ALREADY_SENT");
    }
    const now = this.clock();
    invoice.updatedAt = now;
    if (invoice.invoiceDate > this.today()) {
      invoice.status = "SCHEDULED";
      return 202;
    }
    invoice.status = toRecipient ? "SENT" : this.behaviour.statusAfterShare;
    invoice.openStatus = invoice.status;
    invoice.firstSentAt ??= now;
    invoice.lastSentAt = now;
    return 200;
  }

  /**
   * The payer pays on PayPal's page (the whole amount due unless `cents` says less), with the payer's own `note` if any:
   * text the payer controls, which PayLink must treat as data (the injection suite and the L3 two-rail test send some).
   */
  payerPays(id: string, cents?: bigint, note: string | null = null): FakePayment {
    const invoice = this.get(id);
    if (!OPEN_STATUSES.includes(invoice.status) && invoice.status !== "PARTIALLY_PAID") {
      throw new FakeRefusal(422, "CANNOT_PROCESS_PAYMENTS");
    }
    const due = this.dueCents(invoice);
    const amount = cents ?? due;
    if (amount <= 0n || amount > due) {
      throw new FakeRefusal(422, "PAYMENT_AMOUNT_GREATER_THAN_AMOUNT_DUE");
    }
    const payment: FakePayment = { type: "PAYPAL", paymentId: this.ids.paypalPaymentId(), date: this.today(), method: "PAYPAL", note, cents: amount };
    invoice.payments.push(payment);
    invoice.status = this.dueCents(invoice) === 0n ? this.behaviour.payerPaymentStatus : "PARTIALLY_PAID";
    invoice.updatedAt = this.clock();
    return payment;
  }

  /** A held payer payment clears (`PAYMENT_PENDING` → `PAID`). */
  clearPending(id: string): void {
    const invoice = this.get(id);
    if (invoice.status !== "PAYMENT_PENDING") {
      throw new FakeRefusal(422, "CANNOT_PROCESS_PAYMENTS");
    }
    invoice.status = "PAID";
    invoice.updatedAt = this.clock();
  }

  /** P6. */
  record(id: string, payment: { readonly method: string; readonly date: string | null; readonly note: string | null; readonly cents: bigint | null }): FakePayment {
    const invoice = this.get(id);
    if (!OPEN_STATUSES.includes(invoice.status) && invoice.status !== "PARTIALLY_PAID") {
      if (PAID_STATUSES.includes(invoice.status)) {
        throw new FakeRefusal(422, "PAYMENT_AMOUNT_GREATER_THAN_AMOUNT_DUE", "/amount");
      }
      throw new FakeRefusal(422, "CANNOT_PROCESS_PAYMENTS");
    }
    const due = this.dueCents(invoice);
    const cents = payment.cents ?? due;
    if (cents > due) {
      throw new FakeRefusal(422, "PAYMENT_AMOUNT_GREATER_THAN_AMOUNT_DUE", "/amount");
    }
    const recorded: FakePayment = { type: "EXTERNAL", paymentId: this.ids.externalPaymentId(), date: payment.date ?? this.today(), method: payment.method, note: payment.note, cents };
    invoice.payments.push(recorded);
    invoice.status = this.dueCents(invoice) === 0n ? this.behaviour.statusAfterRecord : "PARTIALLY_PAID";
    invoice.updatedAt = this.clock();
    return recorded;
  }

  /** P7: the transaction id is the recorded payment's `payment_id`, as in the sandbox (C, capture of 2026-10-29). */
  deletePayment(id: string, transactionId: string): void {
    const invoice = this.get(id);
    const index = invoice.payments.findIndex((p) => p.paymentId === transactionId);
    const payment = invoice.payments[index];
    if (payment === undefined) {
      throw new FakeRefusal(404, "INVALID_RESOURCE_ID", "/transaction_id");
    }
    if (payment.type !== "EXTERNAL") {
      throw new FakeRefusal(422, "CANNOT_DELETE_EXTERNAL_PAYMENT");
    }
    invoice.payments.splice(index, 1);
    invoice.status = invoice.payments.length === 0 ? (invoice.openStatus ?? "SENT") : this.dueCents(invoice) === 0n ? invoice.status : "PARTIALLY_PAID";
    invoice.updatedAt = this.clock();
  }

  /** P8. */
  cancel(id: string): void {
    const invoice = this.get(id);
    const issue =
      invoice.status === "DRAFT"
        ? "CANNOT_CANCEL_DRAFT_INVOICE"
        : invoice.status === "SCHEDULED"
          ? "CANNOT_CANCEL_SCHEDULED_INVOICE"
          : invoice.status === "CANCELLED" || invoice.status === "AUTO_CANCELLED"
            ? "INVOICE_CANCELED_ALREADY"
            : REFUNDED_STATUSES.includes(invoice.status)
              ? "CANNOT_CANCEL_REFUNDED_INVOICE"
              : PAID_STATUSES.includes(invoice.status) || invoice.status === "PARTIALLY_PAID"
                ? "CANNOT_CANCEL_PAID_INVOICE"
                : null;
    if (issue !== null) {
      throw new FakeRefusal(422, issue);
    }
    const now = this.clock();
    invoice.status = "CANCELLED";
    invoice.cancelledAt = now;
    invoice.updatedAt = now;
  }

  /** P9. Without a billing email, the sandbox's own refusal (C, capture of 2026-10-29); the files' 422 otherwise. */
  remind(id: string): void {
    const invoice = this.get(id);
    const now = this.clock();
    const recent = invoice.reminders.filter((at) => now - at < 24 * 60 * 60 * 1000);
    const hasEmail = invoice.recipients.some((r) => {
      const email = (r as { readonly billing_info?: { readonly email_address?: unknown } }).billing_info?.email_address;
      return typeof email === "string" && email !== "";
    });
    if (!OPEN_STATUSES.includes(invoice.status) && invoice.status !== "PARTIALLY_PAID") {
      throw new FakeRefusal(422, "CANNOT_REMIND_INVOICE");
    }
    if (this.behaviour.remindRequiresEmail && !hasEmail) {
      throw new FakeRefusal(400, "CANNOT_REMIND_AS_BILLING_INFO_ABSENT");
    }
    if (recent.length >= this.behaviour.remindersPerDay) {
      throw new FakeRefusal(422, "CANNOT_REMIND_INVOICE");
    }
    invoice.reminders.push(now);
    invoice.lastSentAt = now;
    invoice.updatedAt = now;
  }

  /** Test control: any status, as if PayPal or the merchant's dashboard had set it. Not a PayPal operation. */
  forceStatus(id: string, status: string): void {
    const invoice = this.get(id);
    invoice.status = status;
    invoice.updatedAt = this.clock();
  }

  /** P2 / P13 filter. */
  matches(invoice: FakeInvoice, search: { readonly reference?: string; readonly invoice_number?: string; readonly status?: readonly string[]; readonly currency_code?: string }): boolean {
    if (search.reference !== undefined) {
      const reference = invoice.reference ?? "";
      if (this.behaviour.referenceSearch === "exact" ? reference !== search.reference : !reference.includes(search.reference)) {
        return false;
      }
    }
    if (search.invoice_number !== undefined && invoice.invoiceNumber !== search.invoice_number) {
      return false;
    }
    if (search.status !== undefined && search.status.length > 0 && !search.status.includes(invoice.status)) {
      return false;
    }
    return search.currency_code === undefined || invoice.currency === search.currency_code;
  }

  // ----------------------------------------------------------------------------------------- webhooks

  subscribe(url: string, eventTypes: readonly string[]): FakeSubscription {
    for (const existing of this.subscriptions.values()) {
      if (existing.url === url) {
        // PayPal's name for this refusal is UNVERIFIED (S: WEBHOOK_URL_ALREADY_EXISTS).
        throw new FakeRefusal(400, "WEBHOOK_URL_ALREADY_EXISTS", "/url");
      }
    }
    const subscription: FakeSubscription = { id: this.ids.webhookId(), url, eventTypes: [...eventTypes] };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  /** Records an event and queues one delivery per subscription that listens to its type. */
  emit(eventType: string, raw: (eventId: string) => string): FakeEvent {
    const id = this.ids.eventId();
    const event: FakeEvent = { id, eventType, raw: raw(id) };
    this.events.set(id, event);
    this.eventOrder.push(id);
    for (const subscription of this.subscriptions.values()) {
      if (subscription.eventTypes.includes(eventType) || subscription.eventTypes.includes("*")) {
        this.deliveries.push({ eventId: id, subscriptionId: subscription.id, attempts: 0, state: "pending", lastStatus: null });
      }
    }
    // A long-running offline demo keeps the latest events and settled deliveries only.
    while (this.eventOrder.length > MAX_KEPT) {
      const oldest = this.eventOrder.shift();
      if (oldest !== undefined) {
        this.events.delete(oldest);
      }
    }
    const settled = this.deliveries.filter((d) => d.state !== "pending").length;
    if (settled > MAX_KEPT) {
      let drop = settled - MAX_KEPT;
      for (let i = 0; i < this.deliveries.length && drop > 0; ) {
        if (this.deliveries[i]?.state === "pending") {
          i += 1;
        } else {
          this.deliveries.splice(i, 1);
          drop -= 1;
        }
      }
    }
    return event;
  }
}
