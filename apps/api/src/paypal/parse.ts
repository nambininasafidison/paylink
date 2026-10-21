// SPDX-License-Identifier: MIT
/**
 * PayPal's answers are a trust boundary (CONTRIBUTING.md §6): every body the client reads is parsed here with zod before
 * any code looks at it. The schemas are lenient where PayPal may add members (`looseObject`: unknown members pass
 * through untouched) and strict on what PayLink relies on: an invoice id, a status string, the reference, money values
 * in PayPal's `money.value` pattern, the payment ids. A body that fails is `E_PAYPAL_UNEXPECTED_RESPONSE`, never a guess.
 *
 * Limits and patterns are the vendored OpenAPI files' (test/openapi/, `paypal-rest-api-specifications@90e8041`, V);
 * test/openapi/ validates the same bodies against the full schemas with ajv (L0), so the two cannot drift silently.
 *
 * Owner: PayPal spine workstream.
 */
import { z } from "zod";
import type {
  Invoice,
  InvoicePage,
  LinkDescription,
  OAuthTokenResponse,
  PaymentReference,
  VerifyWebhookSignatureResponse,
  Webhook,
  WebhookEvent,
} from "./types.ts";

/** `money.value` (V). */
const MONEY_VALUE = /^((-?[0-9]+)|(-?([0-9]+)?[.][0-9]+))$/u;

const Money = z.looseObject({ currency_code: z.string().length(3), value: z.string().max(32).regex(MONEY_VALUE) });

const Link = z.looseObject({ href: z.string().min(1), rel: z.string(), method: z.string().optional() });

const Payment = z.looseObject({
  type: z.string().optional(),
  payment_id: z.string().max(22).optional(),
  payment_date: z.string().optional(),
  method: z.string().optional(),
  note: z.string().max(2000).optional(),
  amount: Money.optional(),
});

const Metadata = z.looseObject({
  create_time: z.string().optional(),
  last_update_time: z.string().optional(),
  cancel_time: z.string().optional(),
  first_sent_time: z.string().optional(),
  last_sent_time: z.string().optional(),
  recipient_view_url: z.string().optional(),
  invoicer_view_url: z.string().optional(),
});

const InvoiceSchema = z.looseObject({
  id: z.string().min(1).max(30).optional(),
  status: z.string().min(1).max(255).optional(),
  detail: z.looseObject({
    reference: z.string().max(120).optional(),
    currency_code: z.string().length(3),
    note: z.string().max(4000).optional(),
    memo: z.string().max(500).optional(),
    invoice_number: z.string().max(25).optional(),
    invoice_date: z.string().optional(),
    payment_term: z.looseObject({ term_type: z.string().optional(), due_date: z.string().optional() }).optional(),
    metadata: Metadata.optional(),
  }),
  primary_recipients: z.array(z.looseObject({ billing_info: z.looseObject({ email_address: z.string().optional() }).optional() })).max(100).optional(),
  items: z.array(z.looseObject({ name: z.string(), quantity: z.string(), unit_amount: Money })).max(100).optional(),
  amount: z.looseObject({ currency_code: z.string().length(3).optional(), value: z.string().max(32).regex(MONEY_VALUE).optional() }).optional(),
  due_amount: Money.optional(),
  payments: z.looseObject({ paid_amount: Money.optional(), transactions: z.array(Payment).max(100).optional() }).optional(),
  refunds: z.looseObject({ refund_amount: Money.optional() }).optional(),
  links: z.array(Link).optional(),
});

const InvoicePageSchema = z.looseObject({
  total_pages: z.int().min(0).optional(),
  total_items: z.int().min(0).optional(),
  items: z.array(InvoiceSchema).max(100).optional(),
  links: z.array(Link).optional(),
});

const TokenSchema = z.looseObject({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().regex(/^bearer$/iu),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  app_id: z.string().optional(),
  nonce: z.string().optional(),
});

const PaymentReferenceSchema = z.looseObject({ payment_id: z.string().min(1).max(22).regex(/^[0-9A-Za-z_-]+$/u) });

const VerifySchema = z.looseObject({ verification_status: z.enum(["SUCCESS", "FAILURE"]) });

const WebhookSchema = z.looseObject({
  id: z.string().min(1).optional(),
  url: z.string().min(1).max(2048),
  event_types: z.array(z.looseObject({ name: z.string().min(1) })).max(500),
  links: z.array(Link).optional(),
});

const EventSchema = z.looseObject({
  id: z.string().min(1).max(256).optional(),
  create_time: z.string().optional(),
  resource_type: z.string().optional(),
  event_type: z.string().optional(),
  resource_version: z.string().optional(),
  resource: z.record(z.string(), z.unknown()).optional(),
  links: z.array(Link).optional(),
});

const ErrorSchema = z.looseObject({
  name: z.string().max(200).optional(),
  message: z.string().optional(),
  debug_id: z.string().max(200).optional(),
  details: z.array(z.looseObject({ issue: z.string().max(200) })).optional(),
  // RFC 6749 §5.2 (the token endpoint).
  error: z.string().max(200).optional(),
  error_description: z.string().optional(),
});

/**
 * The parsers, by answer kind. Each returns the typed value or `null` when the body is not what PayLink expects. The
 * value is the parsed body itself (zod keeps unknown members), so a caller sees what PayPal sent, typed by
 * src/paypal/types.ts once validated.
 */
export const parsePayPal = {
  token: (body: unknown): OAuthTokenResponse | null => validated(TokenSchema, body) as OAuthTokenResponse | null,
  invoice: (body: unknown): Invoice | null => validated(InvoiceSchema, body) as Invoice | null,
  invoicePage: (body: unknown): InvoicePage | null => validated(InvoicePageSchema, body) as InvoicePage | null,
  link: (body: unknown): LinkDescription | null => validated(Link, body) as LinkDescription | null,
  paymentReference: (body: unknown): PaymentReference | null => validated(PaymentReferenceSchema, body) as PaymentReference | null,
  verification: (body: unknown): VerifyWebhookSignatureResponse | null => validated(VerifySchema, body) as VerifyWebhookSignatureResponse | null,
  webhook: (body: unknown): Webhook | null => validated(WebhookSchema, body) as Webhook | null,
  event: (body: unknown): WebhookEvent | null => validated(EventSchema, body) as WebhookEvent | null,
};

/** What may be read from an error body: PayPal's `name`, `debug_id` and first `issue` (or OAuth's `error`). */
export function errorFieldsOf(body: unknown): { readonly name: string | null; readonly debugId: string | null; readonly issue: string | null } {
  const parsed = ErrorSchema.safeParse(body);
  if (!parsed.success) {
    return { name: null, debugId: null, issue: null };
  }
  const error = parsed.data;
  return {
    name: safeCode(error.name ?? error.error ?? null),
    debugId: safeCode(error.debug_id ?? null),
    issue: safeCode(error.details?.[0]?.issue ?? null),
  };
}

/** A code from an error body, kept only if it looks like one (so a log line never carries free text from PayPal). */
function safeCode(value: string | null): string | null {
  return value !== null && /^[A-Za-z0-9_.-]{1,128}$/u.test(value) ? value : null;
}

/**
 * The parsed body, or null. The schema checked the members PayLink relies on; the remaining members are PayPal's, typed
 * by the interfaces of types.ts. zod's inferred optional members (`T | undefined`) differ from the interfaces' under
 * `exactOptionalPropertyTypes`, hence the casts in `parsePayPal`, after validation only.
 */
function validated(schema: z.ZodType, body: unknown): unknown {
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
