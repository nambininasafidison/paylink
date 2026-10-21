// SPDX-License-Identifier: MIT
/**
 * The PayPal fake's HTTP surface: the operations PayLink calls (P1–P11, P13, P14), served from `FakeState`
 * (src/paypal/fake/model.ts) with PayPal's paths, statuses and error bodies, plus the payer's page and the fake's own
 * controls. The answers validate against the vendored OpenAPI schemas (test/openapi/, L0), so a test that passes on the
 * fake has exercised the same wire contract the sandbox speaks.
 *
 * Error bodies are `error_400` … `error_503` of `invoicing_v2.json` (each status's `name` and `message` are fixed there,
 * V) with one `details[]` entry naming the issue; the issue names are the files' where they list one for the operation
 * (`CANNOT_REMIND_INVOICE`, `CANNOT_CANCEL_PAID_INVOICE`, ...) and the fake's own otherwise, marked in model.ts.
 *
 * The fake is stricter than PayPal may be on purpose: it refuses read-only members in requests (`type` in a payment,
 * `id`, `status`, `metadata`, ... in an invoice) and both `term_type` and `due_date` in one payment term, so a PayLink
 * mistake fails a test instead of passing silently.
 *
 * Outside PayPal's API (never called by the PayPal client):
 * - `GET /invoice/p/{id}` and `POST /invoice/p/{id}/pay`: the payer's view (`recipient_view_url`), a plain page with
 *   one button, for the e2e suite and the offline demo;
 * - `/__fake/...`: controls for tests (pay, force a status, deliver webhooks, inject faults, list invoices).
 *
 * Owner: PayPal spine workstream.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SUBSCRIBED_EVENTS } from "../types.ts";
import type { FakeInvoice, FakePayment, FakeState } from "./model.ts";
import { centsOf, FakeRefusal, valueOf } from "./model.ts";
import { payerPage } from "./page.ts";
import { AUTH_ALGO, publicKeyPem, signatureInput, verify } from "./signing.ts";

/** `name` and `message` of each error status (V, `error_400` … `error_503`; 429's are not in the files: UNVERIFIED). */
export const PAYPAL_ERRORS: Readonly<Record<number, { readonly name: string; readonly message: string }>> = {
  400: { name: "INVALID_REQUEST", message: "Request is not well-formed, syntactically incorrect, or violates schema." },
  401: { name: "AUTHENTICATION_FAILURE", message: "Authentication failed due to missing authorization header, or invalid authentication credentials." },
  403: { name: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions." },
  404: { name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." },
  409: { name: "RESOURCE_CONFLICT", message: "The server has detected a conflict while processing this request." },
  415: { name: "UNSUPPORTED_MEDIA_TYPE", message: "The server does not support the request payload's media type." },
  422: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed, semantically incorrect, or failed business validation." },
  429: { name: "RATE_LIMIT_REACHED", message: "Too many requests. Blocked due to rate limiting." },
  500: { name: "INTERNAL_SERVER_ERROR", message: "An internal server error occurred." },
  503: { name: "SERVICE_UNAVAILABLE", message: "Service Unavailable." },
};

/** What the app needs besides the state. */
export interface FakeHost {
  readonly state: FakeState;
  readonly credentials: { readonly clientId: string; readonly clientSecret: string };
  /** The fake's public base (links, payer pages, certificate URL), without a trailing slash. */
  publicUrl(): string;
  /** Called after a state change that PayPal would announce with a webhook event. */
  announce(eventType: string, invoice: FakeInvoice): void;
  /** Delivers the queued webhooks now. */
  flush(): Promise<void>;
  /** Fault control (`/__fake/faults`). */
  inject(fault: unknown): void;
}

type Json = Record<string, unknown>;

function errorBody(host: FakeHost, status: number, issue: string | null, field: string | null): Json {
  const { name, message } = PAYPAL_ERRORS[status] ?? { name: "INTERNAL_SERVER_ERROR", message: "An internal server error occurred." };
  return {
    name,
    message,
    debug_id: host.state.ids.debugId(),
    ...(issue === null ? {} : { details: [{ ...(field === null ? {} : { field, location: "body" }), issue }] }),
  };
}

function fail(c: Context, host: FakeHost, status: number, issue: string | null = null, field: string | null = null): Response {
  return c.json(errorBody(host, status, issue, field), status as ContentfulStatusCode);
}

/** Rendered PayPal `invoice`. */
export function renderInvoice(host: FakeHost, invoice: FakeInvoice): Json {
  const base = host.publicUrl();
  const iso = (ms: number): string => new Date(ms).toISOString();
  const paid = host.state.paidCents(invoice);
  const money = (cents: bigint): Json => ({ currency_code: invoice.currency, value: valueOf(cents) });
  const sent = invoice.firstSentAt !== null;
  return {
    id: invoice.id,
    status: invoice.status,
    detail: {
      ...(invoice.reference === null ? {} : { reference: invoice.reference }),
      currency_code: invoice.currency,
      ...(invoice.note === null ? {} : { note: invoice.note }),
      ...(invoice.memo === null ? {} : { memo: invoice.memo }),
      invoice_number: invoice.invoiceNumber,
      invoice_date: invoice.invoiceDate,
      ...(invoice.paymentTerm === null ? {} : { payment_term: invoice.paymentTerm }),
      metadata: {
        create_time: iso(invoice.createdAt),
        last_update_time: iso(invoice.updatedAt),
        ...(invoice.cancelledAt === null ? {} : { cancel_time: iso(invoice.cancelledAt) }),
        ...(invoice.firstSentAt === null ? {} : { first_sent_time: iso(invoice.firstSentAt) }),
        ...(invoice.lastSentAt === null ? {} : { last_sent_time: iso(invoice.lastSentAt) }),
        created_by_flow: "REGULAR_SINGLE",
        ...(sent ? { recipient_view_url: `${base}/invoice/p/${invoice.id}` } : {}),
        invoicer_view_url: `${base}/invoice/details/${invoice.id}`,
      },
    },
    ...(invoice.recipients.length === 0 ? {} : { primary_recipients: invoice.recipients }),
    items: invoice.items.map((item) => ({ id: item.id, name: item.name, ...(item.description === undefined ? {} : { description: item.description }), quantity: item.quantity, unit_amount: item.unitAmount })),
    configuration: invoice.configuration,
    amount: { ...money(invoice.totalCents), breakdown: { item_total: money(invoice.totalCents) } },
    due_amount: money(host.state.dueCents(invoice)),
    ...(invoice.payments.length === 0 ? {} : { payments: { paid_amount: money(paid), transactions: invoice.payments.map((p) => renderPayment(invoice, p)) } }),
    links: [
      { href: `${base}/v2/invoicing/invoices/${invoice.id}`, rel: "self", method: "GET" },
      ...(invoice.status === "DRAFT" ? [{ href: `${base}/v2/invoicing/invoices/${invoice.id}/send`, rel: "send", method: "POST" }] : []),
    ],
  };
}

function renderPayment(invoice: FakeInvoice, payment: FakePayment): Json {
  return {
    type: payment.type,
    payment_id: payment.paymentId,
    payment_date: payment.date,
    method: payment.method,
    ...(payment.note === null ? {} : { note: payment.note }),
    amount: { currency_code: invoice.currency, value: valueOf(payment.cents) },
  };
}

// ------------------------------------------------------------------------------------------- request checks

const DATE = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u;
/** `restrictive_email_address.pattern` (V). */
const RESTRICTIVE_EMAIL = /^(?!\.)(?:[A-Za-z0-9!#$&'*/=?^`{|}~_%+-]|\.(?!\.)){1,64}(?<!\.)@(?:[A-Za-z0-9-]|\.(?!\.))+\.[a-zA-Z]{2,}$/u;
const PAYMENT_METHODS = ["BANK_TRANSFER", "CASH", "CHECK", "CREDIT_CARD", "DEBIT_CARD", "PAYPAL", "WIRE_TRANSFER", "OTHER"];

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function str(value: unknown, field: string, max: number): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", field);
  }
  if (value.length > max) {
    throw new FakeRefusal(400, "INVALID_STRING_MAX_LENGTH", field);
  }
  return value;
}

/** The JSON body of a request: `application/json` and well formed, or a refusal. */
async function jsonBody(c: Context): Promise<unknown> {
  if (!/^application\/json\b/iu.test(c.req.header("content-type") ?? "")) {
    throw new FakeRefusal(415, null);
  }
  try {
    return JSON.parse(await c.req.text()) as unknown;
  } catch {
    throw new FakeRefusal(400, null);
  }
}

function notification(body: unknown): { readonly toRecipient: boolean } {
  if (!isRecord(body)) {
    throw new FakeRefusal(400, null);
  }
  str(body["subject"], "/subject", 4000);
  str(body["note"], "/note", 4000);
  for (const flag of ["send_to_invoicer", "send_to_recipient"]) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
      throw new FakeRefusal(400, null, `/${flag}`);
    }
  }
  const extra = body["additional_recipients"];
  if (extra !== undefined && (!Array.isArray(extra) || extra.length > 100)) {
    throw new FakeRefusal(400, "INVALID_ARRAY_MAX_ITEMS", "/additional_recipients");
  }
  return { toRecipient: body["send_to_recipient"] !== false };
}

const READ_ONLY_INVOICE = ["id", "parent_id", "status", "due_amount", "gratuity", "payments", "refunds", "links"];

function createInput(body: unknown, today: string, fallbackNumber: string): Parameters<FakeState["create"]>[0] {
  if (!isRecord(body) || !isRecord(body["detail"])) {
    throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/detail");
  }
  for (const member of READ_ONLY_INVOICE) {
    if (body[member] !== undefined) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", `/${member}`);
    }
  }
  const detail = body["detail"];
  if (detail["metadata"] !== undefined) {
    throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/detail/metadata");
  }
  const currency = str(detail["currency_code"], "/detail/currency_code", 3);
  if (currency?.length !== 3) {
    throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/detail/currency_code");
  }
  const invoiceDate = str(detail["invoice_date"], "/detail/invoice_date", 10) ?? today;
  if (!DATE.test(invoiceDate)) {
    throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/detail/invoice_date");
  }
  let paymentTerm: Record<string, string> | null = null;
  if (detail["payment_term"] !== undefined) {
    const term = detail["payment_term"];
    if (!isRecord(term) || (term["term_type"] !== undefined && term["due_date"] !== undefined)) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/detail/payment_term");
    }
    const due = str(term["due_date"], "/detail/payment_term/due_date", 10);
    if (due !== null && !DATE.test(due)) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/detail/payment_term/due_date");
    }
    const type = str(term["term_type"], "/detail/payment_term/term_type", 30);
    paymentTerm = { ...(type === null ? {} : { term_type: type }), ...(due === null ? {} : { due_date: due }) };
  }
  const items = body["items"];
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/items");
  }
  let total = 0n;
  const parsedItems = items.map((item: unknown, i) => {
    if (!isRecord(item) || !isRecord(item["unit_amount"])) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", `/items/${String(i)}`);
    }
    if (item["id"] !== undefined) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", `/items/${String(i)}/id`);
    }
    const name = str(item["name"], `/items/${String(i)}/name`, 200);
    const quantity = str(item["quantity"], `/items/${String(i)}/quantity`, 14);
    const description = str(item["description"], `/items/${String(i)}/description`, 1000);
    const unit = item["unit_amount"];
    const value = str(unit["value"], `/items/${String(i)}/unit_amount/value`, 32);
    const cents = value === null ? null : centsOf(value);
    if (name === null || quantity === null || cents === null || unit["currency_code"] !== currency || !/^[0-9]{1,7}$/u.test(quantity)) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", `/items/${String(i)}`);
    }
    total += cents * BigInt(quantity);
    return { id: `ITEM-${String(i + 1)}`, name, quantity, unitAmount: { currency_code: currency, value: value ?? "0" }, ...(description === null ? {} : { description }) };
  });
  const recipients = body["primary_recipients"];
  if (recipients !== undefined) {
    if (!Array.isArray(recipients) || recipients.length > 100) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/primary_recipients");
    }
    recipients.forEach((recipient: unknown, i) => {
      const billing = isRecord(recipient) ? recipient["billing_info"] : undefined;
      const email = isRecord(billing) ? billing["email_address"] : undefined;
      if (email !== undefined && (typeof email !== "string" || !RESTRICTIVE_EMAIL.test(email))) {
        throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", `/primary_recipients/${String(i)}/billing_info/email_address`);
      }
      const name = isRecord(billing) ? billing["name"] : undefined;
      if (isRecord(name)) {
        str(name["given_name"], `/primary_recipients/${String(i)}/billing_info/name/given_name`, 140);
      }
    });
  }
  return {
    reference: str(detail["reference"], "/detail/reference", 120),
    currency,
    note: str(detail["note"], "/detail/note", 4000),
    memo: str(detail["memo"], "/detail/memo", 500),
    invoiceNumber: str(detail["invoice_number"], "/detail/invoice_number", 25) ?? fallbackNumber,
    invoiceDate,
    paymentTerm,
    recipients: Array.isArray(recipients) ? recipients : [],
    items: parsedItems,
    configuration: body["configuration"] ?? {},
    totalCents: total,
  };
}

function paymentInput(body: unknown, currency: string): Parameters<FakeState["record"]>[1] {
  if (!isRecord(body)) {
    throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX");
  }
  if (body["type"] !== undefined) {
    throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/type");
  }
  const method = body["method"];
  if (method === undefined) {
    throw new FakeRefusal(400, "MISSING_REQUIRED_PARAMETER", "/method");
  }
  if (typeof method !== "string" || !PAYMENT_METHODS.includes(method)) {
    throw new FakeRefusal(400, "INVALID_PAYMENT_METHOD", "/method");
  }
  const date = str(body["payment_date"], "/payment_date", 10);
  if (date !== null && !DATE.test(date)) {
    throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/payment_date");
  }
  const note = str(body["note"], "/note", 2000);
  let cents: bigint | null = null;
  const amount = body["amount"];
  if (amount !== undefined) {
    if (!isRecord(amount) || typeof amount["value"] !== "string" || amount["currency_code"] !== currency) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/amount");
    }
    cents = centsOf(amount["value"]);
    if (cents === null) {
      throw new FakeRefusal(400, "INVALID_DECIMAL_VALUE", "/amount/value");
    }
    if (cents === 0n) {
      throw new FakeRefusal(400, "VALUE_CANNOT_BE_ZERO", "/amount/value");
    }
  }
  return { method, date, note, cents };
}

function pageOf(c: Context): { readonly page: number; readonly size: number; readonly total: boolean } {
  const page = Number(c.req.query("page") ?? "1");
  const size = Number(c.req.query("page_size") ?? "20");
  if (!Number.isInteger(page) || page < 1) {
    throw new FakeRefusal(400, "INVALID_INTEGER_MIN_VALUE", "page");
  }
  if (page > 1000) {
    throw new FakeRefusal(400, "INVALID_INTEGER_MAX_VALUE", "page");
  }
  if (!Number.isInteger(size) || size < 1) {
    throw new FakeRefusal(400, "INVALID_INTEGER_MIN_VALUE", "page_size");
  }
  if (size > 100) {
    throw new FakeRefusal(400, "INVALID_INTEGER_MAX_VALUE", "page_size");
  }
  return { page, size, total: c.req.query("total_required") === "true" };
}

function invoicePage(host: FakeHost, c: Context, invoices: readonly FakeInvoice[]): Response {
  const { page, size, total } = pageOf(c);
  const items = invoices.slice((page - 1) * size, page * size).map((i) => renderInvoice(host, i));
  const pages = Math.max(1, Math.ceil(invoices.length / size));
  return c.json({ items, ...(total ? { total_items: invoices.length, total_pages: pages } : {}), links: [] }, 200);
}

/**
 * The raw text of the top-level member `name` of a JSON object (`text` already parsed once): how the fake reads the
 * spliced `webhook_event` byte for byte, as PayPal must to check the signature against the delivered bytes.
 */
export function rawMember(text: string, name: string): string | null {
  let i = 0;
  const skip = (): void => {
    while (i < text.length && /\s/u.test(text[i] ?? "")) {
      i += 1;
    }
  };
  const readString = (): string => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') {
      i += text[i] === "\\" ? 2 : 1;
    }
    i += 1;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const skipValue = (): void => {
    skip();
    const first = text[i];
    if (first === '"') {
      readString();
      return;
    }
    if (first === "{" || first === "[") {
      let depth = 0;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
          readString();
          continue;
        }
        if (ch === "{" || ch === "[") {
          depth += 1;
        } else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            return;
          }
        }
        i += 1;
      }
      return;
    }
    while (i < text.length && !/[,}\]\s]/u.test(text[i] ?? "")) {
      i += 1;
    }
  };
  skip();
  if (text[i] !== "{") {
    return null;
  }
  i += 1;
  for (;;) {
    skip();
    if (text[i] !== '"') {
      return null;
    }
    const key = readString();
    skip();
    if (text[i] !== ":") {
      return null;
    }
    i += 1;
    skip();
    const start = i;
    skipValue();
    if (key === name) {
      return text.slice(start, i);
    }
    skip();
    if (text[i] !== ",") {
      return null;
    }
    i += 1;
  }
}

// ------------------------------------------------------------------------------------------- the app

export function createFakeApp(host: FakeHost): Hono {
  const { state } = host;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof FakeRefusal) {
      return fail(c, host, error.status, error.issue, error.field);
    }
    return fail(c, host, 500);
  });

  app.notFound((c) => fail(c, host, 404));

  // P1 (the Agent Toolkit's request and response, README.md at a3aa963).
  app.post("/v1/oauth2/token", async (c) => {
    const expected = `Basic ${btoa(`${host.credentials.clientId}:${host.credentials.clientSecret}`)}`;
    if (c.req.header("authorization") !== expected) {
      return c.json({ error: "invalid_client", error_description: "Client Authentication failed" }, 401);
    }
    const form = new URLSearchParams(await c.req.text());
    if (!/^application\/x-www-form-urlencoded\b/iu.test(c.req.header("content-type") ?? "") || form.get("grant_type") !== "client_credentials") {
      return c.json({ error: "unsupported_grant_type", error_description: "Grant Type is NULL" }, 400);
    }
    const { token, expiresIn } = state.issueToken();
    return c.json({ scope: "https://uri.paypal.com/services/invoicing", access_token: token, token_type: "Bearer", app_id: "APP-FAKE0PAYLINK0TWIN", expires_in: expiresIn, nonce: `${new Date(state.clock()).toISOString()}${state.ids.debugId()}` }, 200);
  });

  // Every REST operation needs a valid bearer token.
  for (const prefix of ["/v2/*", "/v1/notifications/*"]) {
    app.use(prefix, async (c, next) => {
      if (c.req.path.startsWith("/v1/notifications/certs/")) {
        await next();
        return undefined;
      }
      const match = /^Bearer (?<token>\S+)$/u.exec(c.req.header("authorization") ?? "");
      if (match?.groups?.["token"] === undefined || !state.tokenValid(match.groups["token"])) {
        return c.json(errorBody(host, 401, null, null), 401);
      }
      await next();
      return undefined;
    });
  }

  // P3.
  app.post("/v2/invoicing/invoices", async (c) => {
    // Without a number PayPal auto-increments "from the last number" (V); the fake counts its invoices.
    const input = createInput(await jsonBody(c), state.today(), String(state.invoices.size + 1).padStart(4, "0"));
    const invoice = state.create(input);
    if (c.req.header("prefer") === "return=representation") {
      return c.json(renderInvoice(host, invoice), 201);
    }
    // Without the preference, a link to the new invoice (the 201's description, V; the exact minimal body is UNVERIFIED).
    return c.json({ rel: "self", href: `${host.publicUrl()}/v2/invoicing/invoices/${invoice.id}`, method: "GET" }, 201);
  });

  // P13.
  app.get("/v2/invoicing/invoices", (c) => invoicePage(host, c, [...state.invoices.values()].reverse()));

  // P2.
  app.post("/v2/invoicing/search-invoices", async (c) => {
    const body = await jsonBody(c);
    if (!isRecord(body)) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX");
    }
    const reference = str(body["reference"], "/reference", 120);
    const invoiceNumber = str(body["invoice_number"], "/invoice_number", 25);
    const currency = str(body["currency_code"], "/currency_code", 3);
    const status = body["status"];
    if (status !== undefined && (!Array.isArray(status) || status.length > 5 || !status.every((s) => typeof s === "string"))) {
      throw new FakeRefusal(400, "INVALID_ARRAY_MAX_ITEMS", "/status");
    }
    const search = {
      ...(reference === null ? {} : { reference }),
      ...(invoiceNumber === null ? {} : { invoice_number: invoiceNumber }),
      ...(currency === null ? {} : { currency_code: currency }),
      ...(Array.isArray(status) ? { status } : {}),
    };
    return invoicePage(
      host,
      c,
      [...state.invoices.values()].filter((invoice) => state.matches(invoice, search)),
    );
  });

  // P5.
  app.get("/v2/invoicing/invoices/:id", (c) => c.json(renderInvoice(host, state.get(c.req.param("id"))), 200));

  // P4.
  app.post("/v2/invoicing/invoices/:id/send", async (c) => {
    const { toRecipient } = notification(await jsonBody(c));
    const id = c.req.param("id");
    const status = state.send(id, toRecipient);
    const invoice = state.get(id);
    if (status === 200) {
      host.announce("INVOICING.INVOICE.SENT", invoice);
    } else {
      host.announce("INVOICING.INVOICE.SCHEDULED", invoice);
    }
    return c.json({ href: `${host.publicUrl()}/invoice/p/${id}`, rel: "payer-view", method: "GET" }, status);
  });

  // P9.
  app.post("/v2/invoicing/invoices/:id/remind", async (c) => {
    notification(await jsonBody(c));
    state.remind(c.req.param("id"));
    return c.body(null, 204);
  });

  // P8.
  app.post("/v2/invoicing/invoices/:id/cancel", async (c) => {
    notification(await jsonBody(c));
    const id = c.req.param("id");
    state.cancel(id);
    host.announce("INVOICING.INVOICE.CANCELLED", state.get(id));
    return c.body(null, 204);
  });

  // P6.
  app.post("/v2/invoicing/invoices/:id/payments", async (c) => {
    const id = c.req.param("id");
    const payment = paymentInput(await jsonBody(c), state.get(id).currency);
    const recorded = state.record(id, payment);
    host.announce("INVOICING.INVOICE.UPDATED", state.get(id));
    return c.json({ payment_id: recorded.paymentId }, 200);
  });

  // P7.
  app.delete("/v2/invoicing/invoices/:id/payments/:transaction", (c) => {
    const id = c.req.param("id");
    state.deletePayment(id, c.req.param("transaction"));
    host.announce("INVOICING.INVOICE.UPDATED", state.get(id));
    return c.body(null, 204);
  });

  // P11 and the subscription list.
  app.post("/v1/notifications/webhooks", async (c) => {
    const body = await jsonBody(c);
    const url = isRecord(body) ? body["url"] : undefined;
    const types = isRecord(body) ? body["event_types"] : undefined;
    if (typeof url !== "string" || !/^https?:\/\/\S+$/u.test(url) || url.length > 2048) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/url");
    }
    if (!Array.isArray(types) || types.length === 0 || !types.every((t) => isRecord(t) && typeof t["name"] === "string")) {
      throw new FakeRefusal(400, "INVALID_PARAMETER_SYNTAX", "/event_types");
    }
    const subscription = state.subscribe(
      url,
      types.map((t) => String((t as Json)["name"])),
    );
    return c.json(renderSubscription(host, subscription), 201);
  });
  app.get("/v1/notifications/webhooks", (c) => c.json({ webhooks: [...state.subscriptions.values()].filter((s) => s.url !== null).map((s) => renderSubscription(host, s)) }, 200));

  // P10: checks the signature against the spliced event's exact bytes.
  app.post("/v1/notifications/verify-webhook-signature", async (c) => {
    if (!/^application\/json\b/iu.test(c.req.header("content-type") ?? "")) {
      throw new FakeRefusal(415, null);
    }
    const text = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new FakeRefusal(400, null);
    }
    const raw = rawMember(text, "webhook_event");
    if (!isRecord(body) || raw === null) {
      throw new FakeRefusal(400, "MISSING_REQUIRED_PARAMETER", "/webhook_event");
    }
    for (const member of ["auth_algo", "cert_url", "transmission_id", "transmission_sig", "transmission_time", "webhook_id"]) {
      if (typeof body[member] !== "string" || body[member] === "") {
        throw new FakeRefusal(400, "MISSING_REQUIRED_PARAMETER", `/${member}`);
      }
    }
    const webhookId = String(body["webhook_id"]);
    const genuine =
      state.subscriptions.has(webhookId) &&
      body["auth_algo"] === AUTH_ALGO &&
      body["cert_url"] === certUrl(host) &&
      (await verify(signatureInput(String(body["transmission_id"]), String(body["transmission_time"]), webhookId, raw), String(body["transmission_sig"])));
    return c.json({ verification_status: genuine ? "SUCCESS" : "FAILURE" }, 200);
  });

  // P14, and the event list the capture script reads.
  app.get("/v1/notifications/webhooks-events/:id", (c) => {
    const event = state.events.get(c.req.param("id"));
    if (event === undefined) {
      throw new FakeRefusal(404, "INVALID_RESOURCE_ID");
    }
    return c.body(event.raw, 200, { "Content-Type": "application/json" });
  });
  app.get("/v1/notifications/webhooks-events", (c) => {
    const type = c.req.query("event_type");
    const events = state.eventOrder.map((id) => state.events.get(id)).filter((e) => e !== undefined && (type === undefined || e.eventType === type));
    return c.json({ events: events.map((e) => JSON.parse(e?.raw ?? "{}") as unknown), count: events.length, links: [] }, 200);
  });

  // The certificate URL of the fake's deliveries (a public key, not an X.509 certificate: only the fake reads it).
  app.get("/v1/notifications/certs/:id", async (c) => c.body(await publicKeyPem(), 200, { "Content-Type": "application/x-pem-file" }));

  // The payer's view.
  app.get("/invoice/p/:id", (c) => {
    const invoice = state.invoices.get(c.req.param("id"));
    const view =
      invoice === undefined
        ? null
        : { id: invoice.id, number: invoice.invoiceNumber, status: invoice.status, currency: invoice.currency, total: valueOf(invoice.totalCents), due: valueOf(state.dueCents(invoice)), payable: state.dueCents(invoice) > 0n && ["SENT", "SHARED", "UNPAID", "PARTIALLY_PAID"].includes(invoice.status) };
    return c.html(payerPage(view, `${host.publicUrl()}/invoice/p/${c.req.param("id")}/pay`), invoice === undefined ? 404 : 200, PAGE_HEADERS);
  });
  app.post("/invoice/p/:id/pay", async (c) => {
    const id = c.req.param("id");
    const payment = state.payerPays(id);
    host.announce("INVOICING.INVOICE.PAID", state.get(id));
    await host.flush();
    return c.redirect(`${host.publicUrl()}/invoice/p/${id}?paid=${payment.paymentId}`, 303);
  });

  // Controls (tests and the offline demo only).
  app.post("/__fake/invoices/:id/pay", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Json;
    const cents = typeof body["amount"] === "string" ? centsOf(body["amount"]) : null;
    const payment = state.payerPays(id, cents ?? undefined);
    host.announce(state.get(id).status === "PAYMENT_PENDING" ? "INVOICING.INVOICE.UPDATED" : "INVOICING.INVOICE.PAID", state.get(id));
    return c.json({ payment_id: payment.paymentId, status: state.get(id).status }, 200);
  });
  app.post("/__fake/invoices/:id/status", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Json;
    state.forceStatus(id, String(body["status"]));
    host.announce("INVOICING.INVOICE.UPDATED", state.get(id));
    return c.json({ status: state.get(id).status }, 200);
  });
  app.get("/__fake/invoices", (c) => c.json({ items: [...state.invoices.values()].map((i) => renderInvoice(host, i)) }, 200));
  app.post("/__fake/webhooks/flush", async (c) => {
    await host.flush();
    return c.json({ deliveries: state.deliveries.map((d) => ({ ...d })) }, 200);
  });
  app.post("/__fake/faults", async (c) => {
    host.inject(await c.req.json());
    return c.body(null, 204);
  });

  return app;
}

const PAGE_HEADERS = { "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", "Cache-Control": "no-store" };

/** The certificate URL the fake's deliveries carry. */
export function certUrl(host: FakeHost): string {
  return `${host.publicUrl()}/v1/notifications/certs/CERT-FAKE-PAYLINK-1`;
}

function renderSubscription(host: FakeHost, subscription: { readonly id: string; readonly url: string | null; readonly eventTypes: readonly string[] }): Json {
  return {
    id: subscription.id,
    url: subscription.url ?? "",
    event_types: subscription.eventTypes.map((name) => ({ name, ...(SUBSCRIBED_EVENTS.includes(name as (typeof SUBSCRIBED_EVENTS)[number]) ? { description: name } : {}) })),
    links: [{ href: `${host.publicUrl()}/v1/notifications/webhooks/${subscription.id}`, rel: "self", method: "GET" }],
  };
}
