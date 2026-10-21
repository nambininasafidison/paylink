// SPDX-License-Identifier: MIT
/**
 * Twin invoices (docs/paypal/SPEC.md §7, §13): `POST /v1/twin`, `GET /v1/twin/:key` and the public
 * `GET /v1/rails/:key`. A twin is the PayPal Invoicing v2 invoice whose `detail.reference` is the PayLink key K.
 * Owner: PayPal spine workstream.
 */
import type { DecimalString, InvoiceKey, IsoDate, IsoInstant, PayPalInvoiceStatus, PayPalStatusClass, Situation } from "./common.ts";

/** The payer as the payee typed it in the create form. Sent to PayPal only, never to the model (docs/paypal/SPEC.md §9.4). */
export interface TwinRecipient {
  /** `billing_info.name.given_name`, at most 140 characters (V). */
  readonly givenName?: string;
  /** `billing_info.email_address` (V, `restrictive_email_address`), only if the payee typed it. */
  readonly email?: string;
}

export interface TwinCreateRequest {
  /**
   * The signed PayLink invoice link, exactly as shared (its fragment carries the invoice and the payee's signature). It
   * must be a one-off invoice (`maxPayments` 1) with a fixed amount in whole cents, in USDC or PayPal USD, signed by the
   * session's payee on the edition's chain, and not expired.
   */
  readonly link: string;
  readonly recipient?: TwinRecipient;
  /** `payment_term.due_date` of the twin (`YYYY-MM-DD`); without it PayPal applies its default term (UNVERIFIED which). */
  readonly dueDate?: IsoDate;
}

/** A twin as the payee sees it. */
export interface TwinView {
  readonly key: InvoiceKey;
  /** PayPal's invoice id (`invoice.id`, at most 30 characters, V). */
  readonly paypalId: string;
  /** `detail.invoice_number`, at most 25 characters (V): `PL-<chainId>-<first 12 hex of K>` (E). */
  readonly number: string;
  /** PayPal's status as last read (a status PayPal adds later is passed through; its class is then `unknown`). */
  readonly status: PayPalInvoiceStatus;
  readonly statusClass: PayPalStatusClass;
  /** `detail.metadata.recipient_view_url` (V), or null while PayPal has not given one. */
  readonly recipientViewUrl: string | null;
  /** The invoice amount in USD with two decimals, from the signed amount (docs/paypal/SPEC.md §7.2). */
  readonly amount: DecimalString;
  readonly currency: "USD";
  readonly situation: Situation;
  /** When P5 last read the twin. */
  readonly checkedAt: IsoInstant;
}

/** `POST /v1/twin` answers 201 when this request made the twin, 200 when it already existed (found by P2 or stored). */
export type TwinCreateResponse = TwinView;
export type TwinGetResponse = TwinView;

/**
 * The PayPal rail of a link, for the pay page (public; docs/paypal/SPEC.md §12.2: only status, amount, currency, url,
 * checkedAt). The pay page navigates to `url` only if its host is the pinned PayPal host and `amount` equals the signed
 * amount (§12.3).
 */
export interface RailsResponse {
  /**
   * `open`: payable on PayPal (`url` set); `pending`: a payment is in flight on PayPal (held or partial), so the page
   * offers neither rail; `paid`: paid on PayPal (advisory); `closed`: cancelled or refunded; `none`: no twin, or one
   * PayLink cannot vouch for (not yet sent, scheduled, or a status PayPal added later).
   */
  readonly status: "open" | "pending" | "paid" | "closed" | "none";
  readonly amount: DecimalString | null;
  readonly currency: "USD" | null;
  readonly url: string | null;
  readonly checkedAt: IsoInstant | null;
}
