// SPDX-License-Identifier: MIT
/**
 * The HTTP implementation of `PayPalClient` (src/paypal/client.ts): plain `fetch` against a REST base, the same code for
 * PayPal's sandbox (`https://api-m.sandbox.paypal.com`) and for the PayPal fake (src/paypal/fake/), so tests and the
 * offline demo exercise exactly what production runs. No PayPal SDK: `@paypal/paypal-server-sdk` has no Invoicing
 * (docs/paypal/SPEC.md §7, [PT §9.1]).
 *
 * Per call: the OAuth token from the cache (src/paypal/token.ts), the operation's method and path from
 * `PAYPAL_OPERATIONS`, ids checked before they enter a URL, a timeout per attempt, `PayPal-Request-Id` on writes, the
 * retry rules of client.ts (reads: no answer, 429, 5xx; writes: 429 only; any: one retry with a fresh token after a 401),
 * and the answer parsed by src/paypal/parse.ts. Each attempt logs one `paypal.call` line: operation, status, attempt,
 * duration and PayPal's `debug_id`; never a URL with an id, a header, a body or the token.
 *
 * Owner: PayPal spine workstream.
 */
import type { Logger } from "../core/log.ts";
import type { PayPalClient, PayPalErrorFields, PayPalOperationId, WriteOptions } from "./client.ts";
import { PAYPAL_OPERATIONS, PayPalError } from "./client.ts";
import { randomRequestId, REQUEST_ID_PATTERN } from "./idempotency.ts";
import { errorFieldsOf, parsePayPal } from "./parse.ts";
import type { TokenStore } from "./token.ts";
import { TokenCache } from "./token.ts";
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

/** Bounds of the retry loop. Defaults keep a read within about 3 × 8 s in the worst case, usually far less. */
export interface RetryPolicy {
  /** Attempts of a read (and of a write that PayPal throttled with 429). */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A `Retry-After` longer than this is not waited for inside a request: the error carries it to the caller. */
  readonly maxRetryAfterMs: number;
  /** Per attempt. */
  readonly timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 250, maxDelayMs: 2_000, maxRetryAfterMs: 5_000, timeoutMs: 8_000 };

export interface HttpPayPalClientOptions {
  /** REST base without a trailing slash. */
  readonly baseUrl: string;
  /** The app's credentials; `null` makes every call fail with `E_PAYPAL_NOT_CONFIGURED` before anything is sent. */
  readonly credentials: { readonly clientId: string; readonly clientSecret: string } | null;
  /** `fetch`, or the fake's in-process equivalent. */
  readonly transport: typeof fetch;
  readonly clock: () => number;
  readonly random: (bytes: number) => Uint8Array;
  readonly logger: Logger;
  /** The shared token cache (the Global store); `null` keeps the token in this isolate only. */
  readonly tokenStore?: TokenStore | null;
  readonly policy?: Partial<RetryPolicy>;
  /** Waits between attempts; tests pass an instant one. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** An id PayPal gave (invoice, transaction, event): safe in a URL path. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
/** Largest answer body read (PayPal's are a few kilobytes). */
const MAX_BODY_BYTES = 1024 * 1024;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Call<T> {
  readonly op: PayPalOperationId;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: PageQuery;
  /** A serialised JSON body. */
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Statuses that mean success. */
  readonly accept: readonly number[];
  /** Turns a successful answer into the result, or `null` when its body is not what PayLink expects. */
  readonly read: (status: number, body: unknown) => T | null;
  readonly requestId?: string;
}

/** The HTTP client. */
export function createHttpPayPalClient(options: HttpPayPalClientOptions): PayPalClient {
  return new HttpPayPalClient(options);
}

class HttpPayPalClient implements PayPalClient {
  private readonly options: HttpPayPalClientOptions;
  private readonly policy: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tokens: TokenCache;

  constructor(options: HttpPayPalClientOptions) {
    this.options = options;
    this.policy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = new TokenCache(() => this.token(), options.clock, options.tokenStore ?? null, options.logger);
  }

  // ----------------------------------------------------------------------------------------- P1

  async token(): Promise<OAuthTokenResponse> {
    const credentials = this.credentials("P1");
    const basic = btoa(`${credentials.clientId}:${credentials.clientSecret}`);
    return await this.attempts("P1", false, undefined, async (signal) => {
      const response = await this.options.transport(this.url("P1"), {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
        signal,
      });
      return { response, accept: [200], read: (_status, body) => parsePayPal.token(body) };
    });
  }

  // ----------------------------------------------------------------------------------------- invoices

  async searchInvoices(body: SearchInvoicesRequest, page?: PageQuery): Promise<InvoicePage> {
    return await this.call({ op: "P2", body: JSON.stringify(body), ...(page === undefined ? {} : { query: page }), accept: [200], read: (_s, b) => parsePayPal.invoicePage(b) });
  }

  async createInvoice(body: CreateInvoiceRequest, options?: WriteOptions): Promise<Invoice> {
    // "A JSON response body that shows invoice details is returned if you set prefer=return=representation" (P3's 201, V).
    const created = await this.call<Invoice | { readonly link: string }>({
      op: "P3",
      body: JSON.stringify(body),
      headers: { Prefer: "return=representation" },
      accept: [201],
      read: (_s, b) => {
        const invoice = parsePayPal.invoice(b);
        if (invoice?.id !== undefined) {
          return invoice;
        }
        const link = parsePayPal.link(b);
        return link === null ? null : { link: link.href };
      },
      ...requestIdOf(options),
    });
    if (!("link" in created)) {
      return created;
    }
    // A minimal answer (a link to the new invoice, UNVERIFIED shape): read the invoice it names.
    const id = /\/v2\/invoicing\/invoices\/(?<id>[A-Za-z0-9_-]{1,30})$/u.exec(created.link)?.groups?.["id"];
    if (id === undefined) {
      throw new PayPalError("P3", 201, { name: "E_PAYPAL_UNEXPECTED_RESPONSE", ambiguous: true, retryable: false });
    }
    return await this.getInvoice(id);
  }

  async sendInvoice(invoiceId: string, notification: Notification, options?: WriteOptions): Promise<SendInvoiceResult> {
    return await this.call({
      op: "P4",
      params: { invoice_id: invoiceId },
      body: JSON.stringify(notification),
      accept: [200, 202],
      read: (status, b): SendInvoiceResult | null => {
        const link = b === null ? null : parsePayPal.link(b);
        return b !== null && link === null ? null : { status: status === 202 ? 202 : 200, link };
      },
      ...requestIdOf(options),
    });
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    return await this.call({
      op: "P5",
      params: { invoice_id: invoiceId },
      accept: [200],
      read: (_s, b) => {
        const invoice = parsePayPal.invoice(b);
        return invoice?.id === undefined ? null : invoice;
      },
    });
  }

  async recordPayment(invoiceId: string, payment: PaymentDetail, options?: WriteOptions): Promise<PaymentReference> {
    // The 200's description reads "returns the HTTP `200 Created` status code" (V): 201 is accepted as the same answer.
    return await this.call({ op: "P6", params: { invoice_id: invoiceId }, body: JSON.stringify(payment), accept: [200, 201], read: (_s, b) => parsePayPal.paymentReference(b), ...requestIdOf(options) });
  }

  async deletePayment(invoiceId: string, transactionId: string, options?: WriteOptions): Promise<void> {
    await this.call({ op: "P7", params: { invoice_id: invoiceId, transaction_id: transactionId }, accept: [204], read: () => true, ...requestIdOf(options) });
  }

  async cancelInvoice(invoiceId: string, notification: Notification, options?: WriteOptions): Promise<void> {
    await this.call({ op: "P8", params: { invoice_id: invoiceId }, body: JSON.stringify(notification), accept: [204], read: () => true, ...requestIdOf(options) });
  }

  async remindInvoice(invoiceId: string, notification: Notification, options?: WriteOptions): Promise<void> {
    await this.call({ op: "P9", params: { invoice_id: invoiceId }, body: JSON.stringify(notification), accept: [204], read: () => true, ...requestIdOf(options) });
  }

  async listInvoices(page?: PageQuery): Promise<InvoicePage> {
    return await this.call({ op: "P13", ...(page === undefined ? {} : { query: page }), accept: [200], read: (_s, b) => parsePayPal.invoicePage(b) });
  }

  // ----------------------------------------------------------------------------------------- webhooks

  async verifyWebhookSignature(request: VerifyWebhookSignatureRequest, rawEvent: string): Promise<VerifyWebhookSignatureResponse> {
    return await this.call({ op: "P10", body: spliceVerification(request, rawEvent), accept: [200], read: (_s, b) => parsePayPal.verification(b) });
  }

  async createWebhook(webhook: Webhook, options?: WriteOptions): Promise<Webhook> {
    return await this.call({ op: "P11", body: JSON.stringify(webhook), accept: [201], read: (_s, b) => parsePayPal.webhook(b), ...requestIdOf(options) });
  }

  async getWebhookEvent(eventId: string): Promise<WebhookEvent> {
    return await this.call({ op: "P14", params: { event_id: eventId }, accept: [200], read: (_s, b) => parsePayPal.event(b) });
  }

  // ----------------------------------------------------------------------------------------- machinery

  private credentials(op: PayPalOperationId): NonNullable<HttpPayPalClientOptions["credentials"]> {
    const credentials = this.options.credentials;
    if (credentials === null || credentials.clientId === "" || credentials.clientSecret === "") {
      throw new PayPalError(op, 0, { name: "E_PAYPAL_NOT_CONFIGURED", retryable: false });
    }
    return credentials;
  }

  /** The URL of `op`, its path parameters checked and encoded, its page query validated. */
  private url(op: PayPalOperationId, params: Readonly<Record<string, string>> = {}, query?: PageQuery): string {
    const path = PAYPAL_OPERATIONS[op].path.replace(/\{(?<name>[a-z_]+)\}/gu, (_match, name: string) => {
      const value = params[name];
      if (value === undefined || !ID_PATTERN.test(value)) {
        throw new PayPalError(op, 0, { name: "E_PAYPAL_INVALID_INPUT", retryable: false });
      }
      return encodeURIComponent(value);
    });
    return `${this.options.baseUrl}${path}${queryString(op, query)}`;
  }

  /** One logical call with the bearer token: the retry loop of client.ts around one request. */
  private async call<T>(call: Call<T>): Promise<T> {
    this.credentials(call.op);
    const spec = PAYPAL_OPERATIONS[call.op];
    const url = this.url(call.op, call.params, call.query);
    const requestId = spec.write ? (call.requestId ?? randomRequestId(this.options.random)) : undefined;
    if (requestId !== undefined && !REQUEST_ID_PATTERN.test(requestId)) {
      throw new PayPalError(call.op, 0, { name: "E_PAYPAL_INVALID_INPUT", retryable: false });
    }
    let refreshed = false;
    for (;;) {
      const token = await this.tokens.get();
      try {
        return await this.attempts(call.op, spec.write, requestId, async (signal) => {
          const response = await this.options.transport(url, {
            method: spec.method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
              ...(requestId === undefined ? {} : { "PayPal-Request-Id": requestId }),
              ...call.headers,
            },
            ...(call.body === undefined ? {} : { body: call.body }),
            signal,
          });
          return { response, accept: call.accept, read: call.read };
        });
      } catch (error) {
        // A 401 means PayPal refused the token, so nothing was applied: once, drop it and try with a fresh one.
        if (!refreshed && error instanceof PayPalError && error.operation === call.op && error.status === 401) {
          refreshed = true;
          this.tokens.invalidate(token);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * The attempt loop of one request. `send` performs one attempt; the loop decides from its answer whether to return,
   * retry (after a back-off, or PayPal's `Retry-After` when it is short) or fail.
   */
  private async attempts<T>(
    op: PayPalOperationId,
    write: boolean,
    requestId: string | undefined,
    send: (signal: AbortSignal) => Promise<{ readonly response: Response; readonly accept: readonly number[]; readonly read: (status: number, body: unknown) => T | null }>,
  ): Promise<T> {
    const { attempts, timeoutMs } = this.policy;
    for (let attempt = 1; ; attempt += 1) {
      const started = this.options.clock();
      let answer: Awaited<ReturnType<typeof send>>;
      try {
        answer = await send(AbortSignal.timeout(timeoutMs));
      } catch (error) {
        if (error instanceof PayPalError) {
          throw error;
        }
        this.logCall(op, 0, attempt, started, null, requestId);
        // No answer: a read may be repeated; a write may have been applied, so it is not (client.ts).
        if (!write && attempt < attempts) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new PayPalError(op, 0, { name: "E_PAYPAL_NO_ANSWER", ambiguous: write });
      }
      const { response, accept, read } = answer;
      const status = response.status;
      const body = await readBody(response);
      if (accept.includes(status)) {
        const result = body === undefined ? null : read(status, body);
        this.logCall(op, status, attempt, started, debugIdOf(response, null), requestId);
        if (result === null) {
          throw new PayPalError(op, status, { name: "E_PAYPAL_UNEXPECTED_RESPONSE", ambiguous: write, retryable: false });
        }
        return result;
      }
      const fields = errorFieldsOf(body);
      this.logCall(op, status, attempt, started, debugIdOf(response, fields.debugId), requestId);
      const retryAfterMs = retryAfterOf(response, this.options.clock());
      const throttled = status === 429;
      const serverSide = status >= 500;
      if ((throttled || (serverSide && !write)) && attempt < attempts && (retryAfterMs ?? 0) <= this.policy.maxRetryAfterMs) {
        await this.sleep(retryAfterMs ?? this.backoff(attempt));
        continue;
      }
      const errorFields: PayPalErrorFields = {
        ...fields,
        ...(op === "P1" && (status === 400 || status === 401) ? { name: fields.name ?? "E_PAYPAL_TOKEN", retryable: false } : {}),
        ambiguous: write && serverSide,
        retryAfterMs,
      };
      throw new PayPalError(op, status, errorFields);
    }
  }

  /** Exponential back-off with jitter in [50 %, 100 %] of the step, from the runtime's randomness. */
  private backoff(attempt: number): number {
    const step = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (attempt - 1));
    const jitter = (this.options.random(1)[0] ?? 255) / 255;
    return Math.round(step * (0.5 + jitter / 2));
  }

  private logCall(op: PayPalOperationId, status: number, attempt: number, started: number, debugId: string | null, requestId: string | undefined): void {
    const ok = status >= 200 && status < 300;
    this.options.logger.log(ok ? "info" : "warn", "paypal.call", {
      op,
      status,
      attempt,
      durationMs: Math.max(0, this.options.clock() - started),
      ...(debugId === null ? {} : { debugId }),
      ...(requestId === undefined ? {} : { paypalRequestId: requestId }),
    });
  }
}

function requestIdOf(options: WriteOptions | undefined): { readonly requestId?: string } {
  return options?.requestId === undefined ? {} : { requestId: options.requestId };
}

function queryString(op: PayPalOperationId, query: PageQuery | undefined): string {
  if (query === undefined) {
    return "";
  }
  const search = new URLSearchParams();
  const { page, page_size: pageSize, total_required: total } = query;
  if (page !== undefined) {
    if (!Number.isInteger(page) || page < 1 || page > 1000) {
      throw new PayPalError(op, 0, { name: "E_PAYPAL_INVALID_INPUT", retryable: false });
    }
    search.set("page", String(page));
  }
  if (pageSize !== undefined) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new PayPalError(op, 0, { name: "E_PAYPAL_INVALID_INPUT", retryable: false });
    }
    search.set("page_size", String(pageSize));
  }
  if (total !== undefined) {
    search.set("total_required", String(total));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

/**
 * The P10 body with the webhook event spliced in as received (§7.5): PayPal checks the signature against the event's
 * exact bytes, which a parse and re-serialisation would change. The event must be one JSON object.
 */
export function spliceVerification(request: VerifyWebhookSignatureRequest, rawEvent: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PayPalError("P10", 0, { name: "E_PAYPAL_INVALID_INPUT", retryable: false });
  }
  const members = [
    ["auth_algo", request.auth_algo],
    ["cert_url", request.cert_url],
    ["transmission_id", request.transmission_id],
    ["transmission_sig", request.transmission_sig],
    ["transmission_time", request.transmission_time],
    ["webhook_id", request.webhook_id],
  ] as const;
  return `{${members.map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(",")},"webhook_event":${rawEvent}}`;
}

/** The answer body as JSON, `null` when empty, `undefined` when it is not JSON or too large. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    return undefined;
  }
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `Retry-After` in milliseconds (seconds or an HTTP date), or null. */
function retryAfterOf(response: Response, now: number): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) {
    return null;
  }
  if (/^\d{1,6}$/u.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** PayPal's `debug_id`: from the error body, else the `PayPal-Debug-Id` header (header name UNVERIFIED), when it looks like one. */
function debugIdOf(response: Response, fromBody: string | null): string | null {
  const header = response.headers.get("paypal-debug-id");
  const value = fromBody ?? header;
  return value !== null && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;
}
