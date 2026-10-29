// SPDX-License-Identifier: MIT
/**
 * The PayPal client every other part of the API codes against: one method per operation P1–P11 of
 * docs/paypal/SPEC.md §7.1 (P12, the QR code, is cut by D-SCOPE), plus two reads the spine adds: P13 lists invoices
 * (the desk's `list_invoices` read tool, §7.6) and P14 reads one webhook event (the daily smoke, §15.2 L5, and the
 * capture run). One implementation, the HTTP client (src/paypal/http.ts), runs against PayPal's sandbox
 * (`https://api-m.sandbox.paypal.com`) or against the PayPal fake (src/paypal/fake/) through the same code; tests may
 * stub the interface.
 *
 * Rules every implementation keeps:
 * - Truth is P5 (`getInvoice`): no other answer, and never a webhook body, decides that an invoice is paid (AI-6, §7.5).
 * - No method moves money: there is no capture, refund or dispute method, and none may be added (AI-2).
 * - Errors are `PayPalError` carrying the HTTP status and PayPal's `name`, `debug_id` and first `issue` only: never the
 *   token, the client secret or a body, so logs stay clean (§12.1).
 * - The access token is cached (per isolate, and in the Global Durable Object for the deployment) until `expires_in`
 *   − 10 min (§7.1 P1); a 401 drops it and the call is tried once more with a fresh one.
 * - Reads are retried on no answer, 429 and 5xx (bounded, with back-off). Writes are retried on 429 only: PayPal did not
 *   process them. Any other failure of a write that may have reached PayPal is `ambiguous`, and the caller settles it
 *   by reading (P2 or P5) before trying again, never by repeating the write blind (§7.1 P2: no Invoicing operation
 *   documents an idempotency header).
 * - Every write carries `PayPal-Request-Id` (the caller's, or one the client makes), the same on every attempt of that
 *   write. PayPal's Agent Toolkit sends the same header on its Invoicing calls when configured (`client.ts` at
 *   `a3aa963`), but neither OpenAPI file documents it for Invoicing or Webhooks, so whether PayPal deduplicates on it
 *   there is UNVERIFIED: it is a second line, the read-before-retry rule above is the first.
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
  WebhookEvent,
} from "./types.ts";

/**
 * The operations, by id: method, path (OpenAPI template) and the OAuth 2.0 scope of the operation's `security` (V).
 * `write` operations change PayPal's state and carry `PayPal-Request-Id`.
 */
export const PAYPAL_OPERATIONS = {
  P1: { method: "POST", path: "/v1/oauth2/token", scope: null, write: false },
  P2: { method: "POST", path: "/v2/invoicing/search-invoices", scope: "invoices/read", write: false },
  P3: { method: "POST", path: "/v2/invoicing/invoices", scope: "invoices/readwrite", write: true },
  P4: { method: "POST", path: "/v2/invoicing/invoices/{invoice_id}/send", scope: "invoices/readwrite", write: true },
  P5: { method: "GET", path: "/v2/invoicing/invoices/{invoice_id}", scope: "invoices/read", write: false },
  P6: { method: "POST", path: "/v2/invoicing/invoices/{invoice_id}/payments", scope: "invoices/readwrite", write: true },
  P7: { method: "DELETE", path: "/v2/invoicing/invoices/{invoice_id}/payments/{transaction_id}", scope: "invoices/readwrite", write: true },
  P8: { method: "POST", path: "/v2/invoicing/invoices/{invoice_id}/cancel", scope: "invoices/readwrite", write: true },
  P9: { method: "POST", path: "/v2/invoicing/invoices/{invoice_id}/remind", scope: "invoices/readwrite", write: true },
  P10: { method: "POST", path: "/v1/notifications/verify-webhook-signature", scope: "applications/webhooks", write: false },
  P11: { method: "POST", path: "/v1/notifications/webhooks", scope: "applications/webhooks", write: true },
  P13: { method: "GET", path: "/v2/invoicing/invoices", scope: "invoices/read", write: false },
  P14: { method: "GET", path: "/v1/notifications/webhooks-events/{event_id}", scope: "applications/webhooks", write: false },
} as const;

export type PayPalOperationId = keyof typeof PAYPAL_OPERATIONS;

/** A cached access token. */
export interface AccessToken {
  readonly token: string;
  /** Milliseconds since the epoch after which the token must not be used (`expires_in` − 10 min, docs/paypal/SPEC.md P1). */
  readonly expiresAtMs: number;
}

/** Options of a write. */
export interface WriteOptions {
  /**
   * `PayPal-Request-Id`: 1–64 characters of `[A-Za-z0-9_-]`, the same for every attempt of one logical write. Pass a
   * deterministic one (src/paypal/idempotency.ts) when the write may be repeated by a later run (executor, cron).
   */
  readonly requestId?: string;
}

/** Fields of a `PayPalError` beyond the operation and the status. */
export interface PayPalErrorFields {
  /** PayPal's error `name`, or one of the client's own `E_PAYPAL_*` codes. */
  readonly name?: string | null;
  readonly debugId?: string | null;
  readonly issue?: string | null;
  /** Overrides the default (no answer, 429 or 5xx). */
  readonly retryable?: boolean;
  /** A write that may have reached PayPal: settle it by reading before writing again. */
  readonly ambiguous?: boolean;
  /** PayPal's `Retry-After`, in milliseconds. */
  readonly retryAfterMs?: number | null;
}

/**
 * The client's own error names (PayPal's are upper-case words without the `E_` prefix):
 *
 * | Name | Meaning |
 * |---|---|
 * | `E_PAYPAL_NOT_CONFIGURED` | no client id or secret in this runtime: nothing was sent |
 * | `E_PAYPAL_INVALID_INPUT` | an id or a request id the client refuses to put in a URL or header: nothing was sent |
 * | `E_PAYPAL_NO_ANSWER` | network failure or timeout (status 0) |
 * | `E_PAYPAL_UNEXPECTED_RESPONSE` | PayPal answered a status or a body this client does not expect |
 * | `E_PAYPAL_TOKEN` | the token endpoint refused the credentials or answered without a usable token |
 */
export const CLIENT_ERROR_NAMES = ["E_PAYPAL_NOT_CONFIGURED", "E_PAYPAL_INVALID_INPUT", "E_PAYPAL_NO_ANSWER", "E_PAYPAL_UNEXPECTED_RESPONSE", "E_PAYPAL_TOKEN"] as const;

/** A failed PayPal call: what may be logged and shown, nothing more. */
export class PayPalError extends Error {
  readonly operation: PayPalOperationId;
  /** HTTP status, or 0 when PayPal did not answer (network, timeout) or nothing was sent. */
  readonly status: number;
  /** PayPal's error `name` (`INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `UNPROCESSABLE_ENTITY`, ...) or the client's own. */
  readonly paypalName: string | null;
  /** PayPal's `debug_id`, for a support request. */
  readonly debugId: string | null;
  /** The first `details[].issue`, when present (`CANNOT_CANCEL_PAID_INVOICE`, ...). */
  readonly issue: string | null;
  /** Worth trying again later (no answer, 429, 5xx), unless the client said otherwise. */
  readonly retryable: boolean;
  /** A write that may have been applied although it failed: read before writing again. */
  readonly ambiguous: boolean;
  /** PayPal's `Retry-After`, in milliseconds, when it sent one. */
  readonly retryAfterMs: number | null;

  constructor(operation: PayPalOperationId, status: number, fields: PayPalErrorFields = {}) {
    super(`PayPal ${operation} failed with ${status === 0 ? "no answer" : `HTTP ${String(status)}`}${fields.name === undefined || fields.name === null ? "" : ` ${fields.name}`}`);
    this.name = "PayPalError";
    this.operation = operation;
    this.status = status;
    this.paypalName = fields.name ?? null;
    this.debugId = fields.debugId ?? null;
    this.issue = fields.issue ?? null;
    this.retryable = fields.retryable ?? (status === 0 || status === 429 || status >= 500);
    this.ambiguous = fields.ambiguous ?? false;
    this.retryAfterMs = fields.retryAfterMs ?? null;
  }
}

export function isPayPalError(error: unknown): error is PayPalError {
  return error instanceof PayPalError;
}

/**
 * PayPal operations. Every method resolves with the parsed answer or rejects with `PayPalError`. Ids are PayPal's
 * (`invoice.id`, ≤ 30 characters, `[A-Za-z0-9_-]`); the client refuses any other id before sending anything.
 */
export interface PayPalClient {
  /** P1: a fresh token (`grant_type=client_credentials`). Callers normally rely on the client's own cache. */
  token(): Promise<OAuthTokenResponse>;
  /** P2: invoices whose `reference` matches, partly (C, the owner's capture of 2026-10-29): callers keep only `detail.reference === key`. */
  searchInvoices(body: SearchInvoicesRequest, page?: PageQuery): Promise<InvoicePage>;
  /**
   * P3: creates a `DRAFT` (201), sent with `Prefer: return=representation` so the answer is the invoice (the 201's
   * description, V). If PayPal answers a link instead, the client reads the invoice it names (P5).
   */
  createInvoice(body: CreateInvoiceRequest, options?: WriteOptions): Promise<Invoice>;
  /** P4: send as a share link (`send_to_recipient: false`); 202 means scheduled (E_PAYPAL_SCHEDULED, situation S0). */
  sendInvoice(invoiceId: string, notification: Notification, options?: WriteOptions): Promise<SendInvoiceResult>;
  /** P5: the only PayPal truth. */
  getInvoice(invoiceId: string): Promise<Invoice>;
  /** P6: records an external payment (`method: "OTHER"`, the echo note of §7.3); returns the id kept for Undo. */
  recordPayment(invoiceId: string, payment: PaymentDetail, options?: WriteOptions): Promise<PaymentReference>;
  /** P7: deletes a recorded external payment (Undo, 24 h); 204. `transactionId` is P6's `payment_id` (C, the owner's capture of 2026-10-29). */
  deletePayment(invoiceId: string, transactionId: string, options?: WriteOptions): Promise<void>;
  /** P8: cancels a sent invoice; 204. */
  cancelInvoice(invoiceId: string, notification: Notification, options?: WriteOptions): Promise<void>;
  /** P9: PayPal's own reminder (PayPal's wording, never ours); 204. At most one per invoice per 24 h (fence). */
  remindInvoice(invoiceId: string, notification: Notification, options?: WriteOptions): Promise<void>;
  /**
   * P10: postback verification. `rawEvent` is the webhook body exactly as received; the implementation splices it into
   * the request as `webhook_event` without re-serialising it.
   */
  verifyWebhookSignature(request: VerifyWebhookSignatureRequest, rawEvent: string): Promise<VerifyWebhookSignatureResponse>;
  /** P11: subscribes a URL to events (`SUBSCRIBED_EVENTS`; also possible in the dashboard). */
  createWebhook(webhook: Webhook, options?: WriteOptions): Promise<Webhook>;
  /** P13: one page of the merchant's invoices (the desk's `list_invoices` read tool). */
  listInvoices(page?: PageQuery): Promise<InvoicePage>;
  /** P14: one webhook event as PayPal stored it (`GET /v1/notifications/webhooks-events/{event_id}`). */
  getWebhookEvent(eventId: string): Promise<WebhookEvent>;
}
