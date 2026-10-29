// SPDX-License-Identifier: MIT
/**
 * PayPal webhooks, PayPal side (docs/paypal/SPEC.md §7.5): the five transmission headers, the event's own fields, the
 * invoice id an invoicing event names, and the postback verification (P10). A webhook is a hint, never a fact: the
 * route (src/routes/webhook.ts) acts only after P10 answers `SUCCESS`, and then only by reading the invoice (P5).
 *
 * Header names are the ones `verify_webhook_signature`'s member descriptions give (V, `notifications_webhooks_v1.json`
 * at 90e8041). Their values are checked for shape only (present, bounded, printable, a date for the time) and passed to
 * PayPal unchanged: PayPal decides whether they verify. The schema's patterns for `transmission_id` and
 * `transmission_sig` (`^(?!\d+$)\w+\S+`) are deliberately not enforced here, because a base64 signature may begin with
 * `+` or `/` and refusing it would drop a genuine event.
 *
 * Where an invoicing event carries the invoice is not in the file (`resource` has `additionalProperties: true`):
 * `invoiceIdOf` accepts `resource.invoice.id`, then `resource.id`, then an invoice link in `resource.links` or the
 * event's `links` (UNVERIFIED: the owner's capture of 2026-10-29 found no event in PayPal's event list right after the
 * payment, so it recorded no event's shape; the id is only ever used for P5). The same day the deployed Worker logged five
 * real sandbox deliveries `processed`, each after P10 answered `SUCCESS` and P5 read the invoice it named: one of those
 * places carries it, and nothing depends on knowing which.
 *
 * Owner: PayPal spine workstream.
 */
import type { PayPalClient } from "./client.ts";
import type { WebhookEvent, WebhookTransmission } from "./types.ts";

/** Request header of each transmission value (lower case, as `Headers` reports them). */
export const TRANSMISSION_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const satisfies Readonly<Record<keyof WebhookTransmission, string>>;

/** `maxLength` of each member (V). */
const MAX_LENGTH: Readonly<Record<keyof WebhookTransmission, number>> = { auth_algo: 100, cert_url: 500, transmission_id: 50, transmission_sig: 500, transmission_time: 100 };

/** Printable ASCII without spaces: what every transmission value is. */
const PRINTABLE = /^[\x21-\x7e]+$/u;
/** A PayPal id as PayLink accepts it in a URL (invoice ids are ≤ 30 characters, V). */
const INVOICE_ID = /^[A-Za-z0-9_-]{1,30}$/u;
const EVENT_ID = /^[A-Za-z0-9_.-]{1,128}$/u;
/** `webhook_id`: ≤ 50, `^[a-zA-Z0-9]+$` (V). */
export const WEBHOOK_ID_PATTERN = /^[a-zA-Z0-9]{1,50}$/u;
const INVOICE_LINK = /\/v2\/invoicing\/invoices\/(?<id>[A-Za-z0-9_-]{1,30})(?:[/?#]|$)/u;

/** The event types the route acts on: every invoicing invoice event (PayLink subscribes to PAID, CANCELLED, UPDATED). */
export const INVOICE_EVENT_PREFIX = "INVOICING.INVOICE.";

/** The transmission values of a delivery, or the name of the first header that is missing or malformed. */
export function readTransmission(header: (name: string) => string | null | undefined): { readonly ok: true; readonly transmission: WebhookTransmission } | { readonly ok: false; readonly header: string } {
  const values: Partial<Record<keyof WebhookTransmission, string>> = {};
  for (const [member, name] of Object.entries(TRANSMISSION_HEADERS) as [keyof WebhookTransmission, string][]) {
    const value = header(name)?.trim() ?? "";
    if (value === "" || value.length > MAX_LENGTH[member] || !PRINTABLE.test(value)) {
      return { ok: false, header: name };
    }
    values[member] = value;
  }
  const transmission = values as WebhookTransmission;
  if (!/^[a-zA-Z0-9]+$/u.test(transmission.auth_algo)) {
    return { ok: false, header: TRANSMISSION_HEADERS.auth_algo };
  }
  if (!/^https?:\/\/[^/]+\//u.test(transmission.cert_url)) {
    return { ok: false, header: TRANSMISSION_HEADERS.cert_url };
  }
  if (Number.isNaN(Date.parse(transmission.transmission_time))) {
    return { ok: false, header: TRANSMISSION_HEADERS.transmission_time };
  }
  return { ok: true, transmission };
}

/** The fields of a webhook event the route uses. */
export interface EventFacts {
  /** `event.id`, for idempotency (null when PayPal sent none that PayLink can store). */
  readonly id: string | null;
  readonly eventType: string;
  /** The invoice the event names, or null when it names none PayLink can read. */
  readonly invoiceId: string | null;
}

/** The raw body as one JSON object, or null. */
export function parseEventBody(raw: string): WebhookEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/** What the route needs from an event: its id, its type and the invoice id it names. */
export function eventFacts(event: WebhookEvent): EventFacts {
  const id = typeof event.id === "string" && EVENT_ID.test(event.id) ? event.id : null;
  const eventType = typeof event.event_type === "string" ? event.event_type : "";
  return { id, eventType, invoiceId: eventType.startsWith(INVOICE_EVENT_PREFIX) ? invoiceIdOf(event) : null };
}

/** The invoice id an invoicing event names (shape UNVERIFIED, see the module comment), or null. */
export function invoiceIdOf(event: WebhookEvent): string | null {
  const resource = asRecord(event.resource);
  const invoice = asRecord(resource?.["invoice"]);
  for (const candidate of [invoice?.["id"], resource?.["id"]]) {
    if (typeof candidate === "string" && INVOICE_ID.test(candidate)) {
      return candidate;
    }
  }
  for (const links of [invoice?.["links"], resource?.["links"], event.links]) {
    for (const link of Array.isArray(links) ? (links as unknown[]) : []) {
      const href = asRecord(link)?.["href"];
      const id = typeof href === "string" ? INVOICE_LINK.exec(href)?.groups?.["id"] : undefined;
      if (id !== undefined) {
        return id;
      }
    }
  }
  return null;
}

/** The outcome of P10 for one delivery. */
export type Verification = { readonly verified: true } | { readonly verified: false };

/**
 * P10: asks PayPal whether this delivery is genuine, with the raw body spliced in. Throws `PayPalError` when PayPal does
 * not answer (the route answers 503 and PayPal delivers again later).
 */
export async function verifyDelivery(paypal: PayPalClient, webhookId: string, transmission: WebhookTransmission, raw: string): Promise<Verification> {
  const answer = await paypal.verifyWebhookSignature({ ...transmission, webhook_id: webhookId }, raw);
  return { verified: answer.verification_status === "SUCCESS" };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null;
}
