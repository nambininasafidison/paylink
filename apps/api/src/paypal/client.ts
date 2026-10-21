// SPDX-License-Identifier: MIT
/**
 * The PayPal client every other part of the API codes against: one method per operation P1–P11 of
 * docs/paypal/SPEC.md §7.1 (P12, the QR code, is cut by D-SCOPE). Implementations: the HTTP client against
 * `https://api-m.sandbox.paypal.com` and the PayPal fake (a Hono app serving captured fixtures with a status machine),
 * both owned by the PayPal spine workstream; tests may stub it.
 *
 * Rules every implementation keeps:
 * - Truth is P5 (`getInvoice`): no other answer, and never a webhook body, decides that an invoice is paid (AI-6, §7.5).
 * - No method moves money: there is no capture, refund or dispute method, and none may be added (AI-2).
 * - Errors are `PayPalError` carrying the HTTP status and PayPal's `name`, `debug_id` and first `issue` only: never the
 *   token, the client secret or a request body, so logs stay clean (§12.1).
 * - The access token is cached by the implementation (Global Durable Object in the Worker) until `expires_in` − 10 min.
 *
 * Owner: PayPal spine workstream (interface and implementations). Other workstreams code against it and ask for changes
 * through a handoff (docs/paypal/SPEC.md "Ownership").
 */
import type {
  CreateInvoiceRequest,
  Invoice,
  InvoicePage,
  Notification,
  OAuthTokenResponse,
  PageQuery,
  PaymentDetail,
  PaymentReference,
  SearchInvoicesRequest,
  SendInvoiceResult,
  VerifyWebhookSignatureRequest,
  VerifyWebhookSignatureResponse,
  Webhook,
} from "./types.ts";

/** The operations of docs/paypal/SPEC.md §7.1, by id. */
export const PAYPAL_OPERATIONS = {
  P1: { method: "POST", path: "/v1/oauth2/token", scope: null },
  P2: { method: "POST", path: "/v2/invoicing/search-invoices", scope: "invoices/read" },
  P3: { method: "POST", path: "/v2/invoicing/invoices", scope: "invoices/readwrite" },
  P4: { method: "POST", path: "/v2/invoicing/invoices/{invoice_id}/send", scope: "invoices/readwrite" },
  P5: { method: "GET", path: "/v2/invoicing/invoices/{invoice_id}", scope: "invoices/read" },
  P6: { method: "POST", path: "/v2/invoicing/invoices/{invoice_id}/payments", scope: "invoices/readwrite" },
  P7: { method: "DELETE", path: "/v2/invoicing/invoices/{invoice_id}/payments/{transaction_id}", scope: "invoices/readwrite" },
  P8: { method: "POST", path: "/v2/invoicing/invoices/{invoice_id}/cancel", scope: "invoices/readwrite" },
  P9: { method: "POST", path: "/v2/invoicing/invoices/{invoice_id}/remind", scope: "invoices/readwrite" },
  P10: { method: "POST", path: "/v1/notifications/verify-webhook-signature", scope: "applications/webhooks" },
  P11: { method: "POST", path: "/v1/notifications/webhooks", scope: "applications/webhooks" },
} as const;

export type PayPalOperationId = keyof typeof PAYPAL_OPERATIONS;

/** A cached access token. */
export interface AccessToken {
  readonly token: string;
  /** Milliseconds since the epoch after which the token must not be used (`expires_in` − 10 min, docs/paypal/SPEC.md P1). */
  readonly expiresAtMs: number;
}

/** A failed PayPal call: what may be logged and shown, nothing more. */
export class PayPalError extends Error {
  readonly operation: PayPalOperationId;
  /** HTTP status, or 0 when PayPal did not answer (network, timeout). */
  readonly status: number;
  /** PayPal's error `name` (`INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `UNPROCESSABLE_ENTITY`, ...), when it sent one. */
  readonly paypalName: string | null;
  /** PayPal's `debug_id`, for a support request. */
  readonly debugId: string | null;
  /** The first `details[].issue`, when present. */
  readonly issue: string | null;

  constructor(operation: PayPalOperationId, status: number, fields: { readonly name?: string | null; readonly debugId?: string | null; readonly issue?: string | null } = {}) {
    super(`PayPal ${operation} failed with ${status === 0 ? "no answer" : `HTTP ${String(status)}`}${fields.name === undefined || fields.name === null ? "" : ` ${fields.name}`}`);
    this.name = "PayPalError";
    this.operation = operation;
    this.status = status;
    this.paypalName = fields.name ?? null;
    this.debugId = fields.debugId ?? null;
    this.issue = fields.issue ?? null;
  }

  /** PayPal throttled or failed on its side (429, 5xx) or did not answer: retry later, with back-off (§7.5). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function isPayPalError(error: unknown): error is PayPalError {
  return error instanceof PayPalError;
}

/**
 * PayPal operations P1–P11. Every method resolves with the parsed answer or rejects with `PayPalError`. Ids are PayPal's
 * (`invoice.id`, ≤ 30 characters); the client never retries a write on its own (writes are not idempotent: no
 * `PayPal-Request-Id` exists for Invoicing, so P2 runs before every P3).
 */
export interface PayPalClient {
  /** P1: a fresh token (`grant_type=client_credentials`). Callers normally rely on the client's own cache. */
  token(): Promise<OAuthTokenResponse>;
  /** P2: invoices whose `reference` matches. Callers keep only `detail.reference === key` (exactness UNVERIFIED). */
  searchInvoices(body: SearchInvoicesRequest, page?: PageQuery): Promise<InvoicePage>;
  /** P3: creates a `DRAFT` (201). */
  createInvoice(body: CreateInvoiceRequest): Promise<Invoice>;
  /** P4: send as a share link (`send_to_recipient: false`); 202 means scheduled (E_PAYPAL_SCHEDULED, situation S0). */
  sendInvoice(invoiceId: string, notification: Notification): Promise<SendInvoiceResult>;
  /** P5: the only PayPal truth. */
  getInvoice(invoiceId: string): Promise<Invoice>;
  /** P6: records an external payment (`method: "OTHER"`, the echo note of §7.3); returns the id kept for Undo. */
  recordPayment(invoiceId: string, payment: PaymentDetail): Promise<PaymentReference>;
  /** P7: deletes a recorded external payment (Undo, 24 h); 204. Whether `transactionId` is P6's `payment_id` is UNVERIFIED. */
  deletePayment(invoiceId: string, transactionId: string): Promise<void>;
  /** P8: cancels a sent invoice; 204. */
  cancelInvoice(invoiceId: string, notification: Notification): Promise<void>;
  /** P9: PayPal's own reminder (PayPal's wording, never ours); 204. At most one per invoice per 24 h (fence). */
  remindInvoice(invoiceId: string, notification: Notification): Promise<void>;
  /**
   * P10: postback verification. `rawEvent` is the webhook body exactly as received; the implementation splices it into
   * the request as `webhook_event` without re-serialising it.
   */
  verifyWebhookSignature(headers: VerifyWebhookSignatureRequest, rawEvent: string): Promise<VerifyWebhookSignatureResponse>;
  /** P11: subscribes a URL to `SUBSCRIBED_EVENTS` (also possible in the dashboard). */
  createWebhook(webhook: Webhook): Promise<Webhook>;
}
