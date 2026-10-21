// SPDX-License-Identifier: MIT
/**
 * PayPal REST types used by operations P1–P11 (docs/paypal/SPEC.md §7.1), transcribed from PayPal's OpenAPI files at
 * `paypal/paypal-rest-api-specifications@90e8041` (vendored in test/openapi/, provenance in test/openapi/SOURCE.md):
 * `invoicing_v2.json` (Invoices 2.6) and `notifications_webhooks_v1.json` (Webhooks Management 1.11). Each type names its
 * schema; limits are the schema's `maxLength`/`maxItems`. Only the members PayLink reads or writes are listed, plus every
 * member of the objects PayLink sends, so an outgoing body cannot carry a field PayPal does not define. Response objects
 * may carry more members than listed (PayPal adds fields): parse them leniently, validate them against the vendored
 * schema in tests (L0).
 *
 * Exception: the OAuth 2.0 token (P1) is in neither file. Its shape is the PayPal Agent Toolkit's
 * (`typescript/src/shared/client.ts` and its README's example response at `a3aa963`, vendored in
 * test/vendor/paypal-agent-toolkit-1.11.0/).
 *
 * Behaviours the files do not state are tagged UNVERIFIED in docs/paypal/SPEC.md and decided by the owner's sandbox
 * capture run (§15.1): which open status `send` leaves (`SENT` or `SHARED`), the status after a recorded payment, whether
 * P7's `transaction_id` equals P6's `payment_id`, and whether `reference` search is exact.
 *
 * Owner: PayPal spine workstream (each member added names its schema).
 */
import type { PayPalInvoiceStatus } from "@paylink/api-contract";

// ------------------------------------------------------------------------------------------- shared

/** `currency_code`: three-character ISO-4217 code. PayLink sends `USD` only. */
export type CurrencyCode = string;

/** `money` (required: currency_code, value). `value` matches `^((-?[0-9]+)|(-?([0-9]+)?[.][0-9]+))$`, ≤ 32 characters. */
export interface Money {
  readonly currency_code: CurrencyCode;
  readonly value: string;
}

/** `date_no_time`: `YYYY-MM-DD`. */
export type DateNoTime = string;
/** `date_time`: RFC 3339 with seconds. */
export type DateTime = string;

/** `link_description` (required: href, rel). */
export interface LinkDescription {
  readonly href: string;
  readonly rel: string;
  readonly method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "CONNECT" | "OPTIONS" | "PATCH";
}

/** `error_details` (required: issue). */
export interface PayPalErrorDetail {
  readonly field?: string;
  readonly value?: string;
  readonly location?: string;
  readonly issue: string;
  readonly description?: string;
}

/** The error body of `error_400` … `error_500` (Invoicing) and `error`/`error-2` (Webhooks): name, message, debug_id, details. */
export interface PayPalErrorBody {
  readonly name?: string;
  readonly message?: string;
  readonly debug_id?: string;
  readonly details?: readonly PayPalErrorDetail[];
  readonly links?: readonly LinkDescription[];
}

// ------------------------------------------------------------------------------------------- P1 OAuth 2.0 (not in the files)

/**
 * `POST /v1/oauth2/token` with HTTP Basic `client_id:client_secret` and the form body `grant_type=client_credentials`
 * (Agent Toolkit `client.ts`). Response as in the toolkit README; sandbox tokens last 3–8 hours (toolkit README, S).
 */
export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  /** Seconds. */
  readonly expires_in: number;
  readonly scope?: string;
  readonly app_id?: string;
  readonly nonce?: string;
}

/** OAuth 2.0 scopes per operation (`security` of each operation, V). */
export const SCOPES = {
  invoicesRead: "https://uri.paypal.com/services/invoicing/invoices/read",
  invoicesReadWrite: "https://uri.paypal.com/services/invoicing/invoices/readwrite",
  webhooks: "https://uri.paypal.com/services/applications/webhooks",
  verifyWebhookSignature: "https://uri.paypal.com/services/applications/verify-webhook-signature",
} as const;

// ------------------------------------------------------------------------------------------- invoices (invoicing_v2.json)

/** `payment_term_type`. */
export type PaymentTermType = "DUE_ON_RECEIPT" | "DUE_ON_DATE_SPECIFIED" | "NET_10" | "NET_15" | "NET_30" | "NET_45" | "NET_60" | "NET_90" | "NO_DUE_DATE";

/** `invoice_payment_term`: "Value is either but not both `term_type` or `due_date`" (V). */
export type InvoicePaymentTerm = { readonly term_type: PaymentTermType; readonly due_date?: never } | { readonly due_date: DateNoTime; readonly term_type?: never };

/** `metadata` (read-only): audit fields and the two hosted views. */
export interface InvoiceMetadata {
  readonly create_time?: DateTime;
  readonly last_update_time?: DateTime;
  readonly cancel_time?: DateTime;
  readonly first_sent_time?: DateTime;
  readonly last_sent_time?: DateTime;
  /** "The URL for the invoice payer view hosted on paypal.com." */
  readonly recipient_view_url?: string;
  /** "The URL for the invoice merchant view hosted on paypal.com." */
  readonly invoicer_view_url?: string;
}

/** `invoice_detail` = `detail` (required: currency_code) + invoice number, date, payment term, metadata. */
export interface InvoiceDetail {
  /** ≤ 120: PayLink puts the invoice key K here (66 characters). Searchable (`search_data.reference`). */
  readonly reference?: string;
  readonly currency_code: CurrencyCode;
  /** ≤ 4000: "A note to the invoice recipient." */
  readonly note?: string;
  /** ≤ 4000. */
  readonly terms_and_conditions?: string;
  /** ≤ 500: "A private bookkeeping memo for the user." */
  readonly memo?: string;
  /** ≤ 25. */
  readonly invoice_number?: string;
  /** Omitted by PayLink so PayPal uses its own current date (a future date makes `send` answer 202). */
  readonly invoice_date?: DateNoTime;
  readonly payment_term?: InvoicePaymentTerm;
  readonly metadata?: InvoiceMetadata;
}

/** `name`: each part ≤ 140, `full_name` ≤ 300. */
export interface PartyName {
  readonly prefix?: string;
  readonly given_name?: string;
  readonly surname?: string;
  readonly middle_name?: string;
  readonly suffix?: string;
  readonly full_name?: string;
}

/** `billing_info` (a subset: name, email, language; PayLink sends no address or phone). */
export interface BillingInfo {
  readonly name?: PartyName;
  /** `restrictive_email_address`. "If you omit this value, the invoice is payable and a notification email is not sent." */
  readonly email_address?: string;
  /** ≤ 40. */
  readonly additional_info?: string;
  readonly language?: string;
}

/** `recipient_info`. */
export interface RecipientInfo {
  readonly billing_info?: BillingInfo;
}

/** `item` (required: name, quantity, unit_amount). */
export interface InvoiceItem {
  /** Read-only, ≤ 22. */
  readonly id?: string;
  /** ≤ 200. */
  readonly name: string;
  /** ≤ 1000. */
  readonly description?: string;
  /** ≤ 14, decimal string from -1000000 to 1000000. */
  readonly quantity: string;
  readonly unit_amount: Money;
  readonly item_date?: DateNoTime;
}

/** `partial_payment`. */
export interface PartialPayment {
  readonly allow_partial_payment?: boolean;
  readonly minimum_amount_due?: Money;
}

/** `configuration` (`template_configuration` + `template_id`). */
export interface InvoiceConfiguration {
  readonly tax_calculated_after_discount?: boolean;
  readonly tax_inclusive?: boolean;
  readonly allow_tip?: boolean;
  readonly partial_payment?: PartialPayment;
  /** ≤ 30. */
  readonly template_id?: string;
}

/** `payment_type`. */
export type PaymentType = "PAYPAL" | "EXTERNAL";
/** `payment_method`. */
export type PaymentMethod = "BANK_TRANSFER" | "CASH" | "CHECK" | "CREDIT_CARD" | "DEBIT_CARD" | "PAYPAL" | "WIRE_TRANSFER" | "OTHER";

/** `payment_detail` (required: method). `type` is read-only: never sent (docs/paypal/SPEC.md §7.1 P6). */
export interface PaymentDetail {
  readonly type?: PaymentType;
  /** ≤ 22: "The ID for a PayPal payment transaction. Required for the PAYPAL payment type." */
  readonly payment_id?: string;
  readonly payment_date?: DateNoTime;
  readonly method: PaymentMethod;
  /** ≤ 2000: PayLink's echo signature (docs/paypal/SPEC.md §7.3). */
  readonly note?: string;
  /** "If you omit this parameter, the total invoice amount is marked as paid. This amount cannot exceed the amount due." */
  readonly amount?: Money;
}

/** `payments`. */
export interface InvoicePayments {
  /** Read-only: the aggregated payment amounts. */
  readonly paid_amount?: Money;
  /** `payment_detail_list`, ≤ 100. */
  readonly transactions?: readonly PaymentDetail[];
}

/** `refunds` (read only for PayLink: refunds are never made from the app). */
export interface InvoiceRefunds {
  readonly refund_amount?: Money;
  readonly transactions?: readonly unknown[];
}

/** `amount_summary_detail` (PayLink reads `currency_code` and `value`). */
export interface AmountSummary {
  readonly currency_code?: CurrencyCode;
  readonly value?: string;
  readonly breakdown?: unknown;
}

/** `invoice` (required: detail), as PayPal returns it. */
export interface Invoice {
  /** Read-only, ≤ 30. */
  readonly id?: string;
  readonly status?: PayPalInvoiceStatus;
  readonly detail: InvoiceDetail;
  readonly invoicer?: unknown;
  /** `recipient_info_list`, ≤ 100. */
  readonly primary_recipients?: readonly RecipientInfo[];
  /** `email_address_list`, ≤ 100. */
  readonly additional_recipients?: readonly string[];
  /** `item_list`, ≤ 100. */
  readonly items?: readonly InvoiceItem[];
  readonly configuration?: InvoiceConfiguration;
  readonly amount?: AmountSummary;
  /** Read-only: "the balance amount outstanding after payments". */
  readonly due_amount?: Money;
  /** Read-only. */
  readonly gratuity?: Money;
  readonly payments?: InvoicePayments;
  readonly refunds?: InvoiceRefunds;
  readonly links?: readonly LinkDescription[];
}

/** The body PayLink sends to create a twin (P3): an `invoice` without its read-only members (docs/paypal/SPEC.md §7.2). */
export interface CreateInvoiceRequest {
  readonly detail: Omit<InvoiceDetail, "metadata">;
  readonly primary_recipients?: readonly RecipientInfo[];
  readonly items: readonly Omit<InvoiceItem, "id">[];
  readonly configuration?: InvoiceConfiguration;
}

/** `notification`: body of send (P4), remind (P9) and cancel (P8). PayPal ignores `subject` and `note` (V). */
export interface Notification {
  /** "User-provided values for this field will not be honored" (V): PayLink never sends it. */
  readonly subject?: string;
  /** Same: ignored by PayPal; never sent. */
  readonly note?: string;
  /** Default false. */
  readonly send_to_invoicer?: boolean;
  /** Default true. false = "share link, not through PayPal" for `send`. */
  readonly send_to_recipient?: boolean;
  readonly additional_recipients?: readonly string[];
}

/** `invoice_status_list`: at most 5 statuses. */
export type InvoiceStatusList = readonly PayPalInvoiceStatus[];

/** `search_data` (P2): PayLink searches by `reference` only. */
export interface SearchInvoicesRequest {
  readonly reference?: string;
  readonly invoice_number?: string;
  readonly status?: InvoiceStatusList;
  readonly currency_code?: CurrencyCode;
  readonly recipient_email?: string;
  readonly archived?: boolean;
}

/** Query parameters of `search-invoices` and `GET /v2/invoicing/invoices`: page ≥ 1, page_size 1–100 (default 20). */
export interface PageQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly total_required?: boolean;
}

/** `invoices`: a page of invoices (`invoice_list`, ≤ 100). */
export interface InvoicePage {
  readonly total_pages?: number;
  readonly total_items?: number;
  readonly items?: readonly Invoice[];
  readonly links?: readonly LinkDescription[];
}

/** `payment_reference` (P6 response): `payment_id` ≤ 22, pattern `^[0-9A-Za-z_-]+$`. */
export interface PaymentReference {
  readonly payment_id: string;
}

/** P4's answer: 200 = sent now, 202 = "execute at a later time" (V); both carry a `link_description`. */
export interface SendInvoiceResult {
  readonly status: 200 | 202;
  readonly link: LinkDescription | null;
}

// ------------------------------------------------------------------------------------------- webhooks (notifications_webhooks_v1.json)

/** `event` (the webhook body). PayLink reads `id`, `event_type` and the invoice id inside `resource`; truth comes from P5. */
export interface WebhookEvent {
  readonly id?: string;
  readonly create_time?: DateTime;
  readonly resource_type?: string;
  readonly event_version?: string;
  readonly event_type?: string;
  readonly summary?: string;
  readonly resource_version?: string;
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly links?: readonly LinkDescription[];
}

/**
 * `verify_webhook_signature` (P10, every member required). The header names the values come from (`PAYPAL-AUTH-ALGO`,
 * `PAYPAL-CERT-URL`, `PAYPAL-TRANSMISSION-ID`, `PAYPAL-TRANSMISSION-SIG`, `PAYPAL-TRANSMISSION-TIME`) are named in the
 * members' descriptions (V). `webhook_event` must be the raw body spliced in, not a re-serialisation (§7.5).
 */
export interface VerifyWebhookSignatureRequest {
  /** ≤ 100. */
  readonly auth_algo: string;
  /** ≤ 500, a URI. */
  readonly cert_url: string;
  /** ≤ 50. */
  readonly transmission_id: string;
  /** ≤ 500. */
  readonly transmission_sig: string;
  /** ≤ 100, date-time. */
  readonly transmission_time: string;
  /** ≤ 50: the subscription's id (`PAYPAL_WEBHOOK_ID`). */
  readonly webhook_id: string;
}

/** `verify_webhook_signature_response`. */
export interface VerifyWebhookSignatureResponse {
  readonly verification_status: "SUCCESS" | "FAILURE";
}

/** `event_type` (required: name). */
export interface WebhookEventType {
  readonly name: string;
  readonly description?: string;
  readonly status?: string;
}

/** `webhook` (required: url, event_types): body and answer of P11. */
export interface Webhook {
  readonly id?: string;
  /** ≤ 2048, a URI. */
  readonly url: string;
  readonly event_types: readonly WebhookEventType[];
  readonly links?: readonly LinkDescription[];
}

/** The webhook events PayLink subscribes to (names S: PayPal's event-names page, docs/research/paypal/paypal-tech.md §5.2). */
export const SUBSCRIBED_EVENTS = ["INVOICING.INVOICE.PAID", "INVOICING.INVOICE.CANCELLED", "INVOICING.INVOICE.UPDATED"] as const;
