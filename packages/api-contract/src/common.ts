// SPDX-License-Identifier: MIT
/**
 * What every part of the contract shares: identifiers, money strings, the route table of `apps/api`
 * (docs/paypal/SPEC.md §13, with the cuts of decision D-SCOPE), RFC 9457 problems, and the PayPal and chain
 * enumerations the web edition shows. Owner: the foundation; workstreams extend their own modules.
 *
 * Confidence of the PayPal facts below: **V**, read in `paypal/paypal-rest-api-specifications` at 90e8041
 * (`openapi/invoicing_v2.json`, Invoices 2.6), vendored as apps/api/test/openapi/invoicing_v2.json. Everything else is a
 * design decision of this project (**E**).
 */

/** Version of this contract. Bumped on any incompatible change; `GET /v1/health` reports it. */
export const API_CONTRACT_VERSION = 1;

/** A `0x`-prefixed hex string. */
export type Hex = `0x${string}`;
/** An EVM address, EIP-55 checksummed in responses. */
export type Address = `0x${string}`;
/** A PayLink invoice key K: `0x` + 64 lowercase hex characters (invoice spec §5). */
export type InvoiceKey = `0x${string}`;
/** An instant in ISO 8601, UTC with milliseconds: `2026-10-21T12:00:00.000Z`. */
export type IsoInstant = string;
/** A calendar date `YYYY-MM-DD` (PayPal's `date_no_time`). */
export type IsoDate = string;
/** An amount in the token's base units (6 decimals for USDC and PYUSD), as a decimal string without sign or exponent. */
export type BaseUnits = string;
/**
 * A PayPal money value: `^((-?[0-9]+)|(-?([0-9]+)?[.][0-9]+))$`, at most 32 characters (V, `money.value`). PayLink
 * always sends USD with exactly two decimals (`"120.00"`).
 */
export type DecimalString = string;
/** The interface languages: English, French, Malagasy. */
export type Locale = "en" | "fr" | "mg";

/** A PayLink invoice key as the API accepts it in paths and bodies. */
export const INVOICE_KEY_PATTERN = /^0x[0-9a-f]{64}$/u;

/** The only chain of the PayPal edition (decision D-CHAIN, ADR 0018): Ethereum Sepolia. */
export const PAYPAL_EDITION_CHAIN_ID = 11155111;

// ------------------------------------------------------------------------------------------- routes

/** Who may call a route: anyone, a payee proving an address by signature, a session token, or PayPal's postback. */
export type RouteAuth = "public" | "signature" | "session" | "paypal";

/** The four workstreams of the PayPal edition, and the foundation that set up the scaffold. */
export type Workstream = "foundation" | "paypal-spine" | "reconciler" | "ai" | "web";

export interface RouteSpec {
  readonly id: string;
  readonly method: "GET" | "POST";
  /** Hono path syntax: `:name` is a path parameter. */
  readonly path: string;
  readonly auth: RouteAuth;
  /** The workstream that implements the handler (docs/paypal/SPEC.md "Ownership"). */
  readonly owner: Workstream;
  readonly purpose: string;
}

/**
 * The route table of `apps/api` (docs/paypal/SPEC.md §13). Cut by D-SCOPE and therefore absent: `POST /v1/desk/ask` (the
 * free-text desk question). Every route answers 501 `not-implemented` until its workstream implements it, except
 * `GET /v1/health`.
 */
export const API_ROUTES = [
  { id: "session.create", method: "POST", path: "/v1/session", auth: "signature", owner: "reconciler", purpose: "Verify a signed PayLinkSession; return a session token" },
  { id: "ai.draft", method: "POST", path: "/v1/ai/draft", auth: "session", owner: "ai", purpose: "A1: a client message to an invoice draft" },
  { id: "twin.create", method: "POST", path: "/v1/twin", auth: "session", owner: "paypal-spine", purpose: "Verify the signed link, then P2, (P3, P4), P5: the PayPal twin" },
  { id: "twin.get", method: "GET", path: "/v1/twin/:key", auth: "session", owner: "paypal-spine", purpose: "The payee's twin, its situation and last check" },
  { id: "rails.get", method: "GET", path: "/v1/rails/:key", auth: "public", owner: "paypal-spine", purpose: "The PayPal rail of a link, for the pay page" },
  { id: "paypal.webhook", method: "POST", path: "/v1/paypal/webhook", auth: "paypal", owner: "paypal-spine", purpose: "Verified PayPal webhook: P10, then P5, then reconcile" },
  { id: "desk.get", method: "GET", path: "/v1/desk", auth: "session", owner: "reconciler", purpose: "Proposals, auto-records and alerts" },
  { id: "desk.sweep", method: "POST", path: "/v1/desk/sweep", auth: "session", owner: "reconciler", purpose: "Reconcile every twin, then run the A2 desk once" },
  { id: "desk.approve", method: "POST", path: "/v1/desk/:id/approve", auth: "session", owner: "reconciler", purpose: "Executor: fresh read, fence, act" },
  { id: "desk.reject", method: "POST", path: "/v1/desk/:id/reject", auth: "session", owner: "reconciler", purpose: "Close a proposal" },
  { id: "desk.undo", method: "POST", path: "/v1/desk/:id/undo", auth: "session", owner: "reconciler", purpose: "P7 within 24 h of an auto-record" },
  { id: "check", method: "POST", path: "/v1/check", auth: "session", owner: "reconciler", purpose: "Was I really paid? Deterministic verdict from P5 and the chain" },
  { id: "health", method: "GET", path: "/v1/health", auth: "public", owner: "foundation", purpose: "Status rows: PayPal, webhook, assistant, chain, store" },
] as const satisfies readonly RouteSpec[];

export type ApiRouteId = (typeof API_ROUTES)[number]["id"];

/** Header that carries the session token: `Authorization: Bearer <token>`. */
export const SESSION_HEADER = "Authorization";
/** Header of the per-request id, echoed in every response and problem. */
export const REQUEST_ID_HEADER = "X-Request-Id";

// ------------------------------------------------------------------------------------------- problems

/**
 * Stable problem codes. Clients branch on `code` (and `rule`), never on `detail`. A domain error of the specification
 * (`E_STALE`, `E_TWIN_PRECISION`, `E_PAYPAL_SCHEDULED`, …) travels as `rule`.
 */
export const API_PROBLEMS = {
  "invalid-json": { status: 400, title: "The request body is not valid JSON" },
  "invalid-request": { status: 400, title: "The request does not match the schema" },
  "unsupported-media-type": { status: 415, title: "The request body must be application/json" },
  "payload-too-large": { status: 413, title: "The request body is too large" },
  unauthorized: { status: 401, title: "A valid session is required" },
  forbidden: { status: 403, title: "This session may not do this" },
  "origin-not-allowed": { status: 403, title: "This origin may not call the API" },
  "not-found": { status: 404, title: "No such resource" },
  "method-not-allowed": { status: 405, title: "Method not allowed" },
  stale: { status: 409, title: "The situation changed: read it again" },
  conflict: { status: 409, title: "The request conflicts with the current state" },
  "rate-limited": { status: 429, title: "Too many requests" },
  "quota-exhausted": { status: 429, title: "The daily quota is used up" },
  "webhook-rejected": { status: 400, title: "The webhook did not verify" },
  "paypal-rejected": { status: 502, title: "PayPal refused the request" },
  "paypal-unavailable": { status: 503, title: "PayPal did not answer" },
  "chain-unavailable": { status: 503, title: "The chain could not be read" },
  "assistant-unavailable": { status: 503, title: "The assistant is not available" },
  "not-implemented": { status: 501, title: "Not implemented yet" },
  internal: { status: 500, title: "Internal error" },
} as const satisfies Readonly<Record<string, { readonly status: number; readonly title: string }>>;

export type ApiProblemCode = keyof typeof API_PROBLEMS;

/** An RFC 9457 problem (`application/problem+json`). */
export interface ApiProblem {
  /** A URI documenting the code. */
  readonly type: string;
  readonly code: ApiProblemCode;
  readonly status: number;
  readonly title: string;
  /** Prose for humans and logs; never parsed by clients. */
  readonly detail: string;
  /** The specification's error code or rule that failed (`E_STALE`, `E_TWIN_PRECISION`, ...). */
  readonly rule?: string;
  /** Seconds after which a retry can succeed; also sent as `Retry-After`. */
  readonly retryAfter?: number;
  /** For `invalid-request`: the first offending fields, as JSON paths. */
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
  readonly requestId?: string;
}

// ------------------------------------------------------------------------------------------- PayPal

/** The 16 invoice statuses (V, `invoice_status`). */
export const PAYPAL_INVOICE_STATUSES = [
  "DRAFT",
  "SENT",
  "SCHEDULED",
  "PAID",
  "MARKED_AS_PAID",
  "CANCELLED",
  "REFUNDED",
  "PARTIALLY_PAID",
  "PARTIALLY_REFUNDED",
  "MARKED_AS_REFUNDED",
  "UNPAID",
  "PAYMENT_PENDING",
  "AUTO_CANCELLED",
  "PAID_EXTERNAL",
  "REFUNDED_EXTERNAL",
  "SHARED",
] as const;

export type PayPalInvoiceStatus = (typeof PAYPAL_INVOICE_STATUSES)[number];

/**
 * How the reconciler reads a PayPal status (docs/paypal/SPEC.md §7.4). Any status PayPal adds later reads `unknown`
 * (situation S0, hands off).
 */
export const PAYPAL_STATUS_CLASSES = ["open", "open-not-sent", "not-sent", "paid", "paid-outside", "in-flight", "cancelled", "refunded", "unknown"] as const;

export type PayPalStatusClass = (typeof PAYPAL_STATUS_CLASSES)[number];

/** The class of each status (docs/paypal/SPEC.md §7.4). */
export const STATUS_CLASS: Readonly<Record<PayPalInvoiceStatus, PayPalStatusClass>> = {
  SENT: "open",
  SHARED: "open",
  UNPAID: "open",
  SCHEDULED: "open-not-sent",
  DRAFT: "not-sent",
  PAID: "paid",
  MARKED_AS_PAID: "paid-outside",
  PAID_EXTERNAL: "paid-outside",
  PAYMENT_PENDING: "in-flight",
  PARTIALLY_PAID: "in-flight",
  CANCELLED: "cancelled",
  AUTO_CANCELLED: "cancelled",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "refunded",
  MARKED_AS_REFUNDED: "refunded",
  REFUNDED_EXTERNAL: "refunded",
};

/** The class of any status string PayPal returns; an unlisted one is `unknown`. */
export function statusClassOf(status: string): PayPalStatusClass {
  return (PAYPAL_INVOICE_STATUSES as readonly string[]).includes(status) ? STATUS_CLASS[status as PayPalInvoiceStatus] : "unknown";
}

// ------------------------------------------------------------------------------------------- rails and chain

/** The engraved rail labels (docs/paypal/SPEC.md §14.1): PayPal's hosted invoice, or a token on Ethereum Sepolia. */
export const RAILS = ["PAYPAL", "USDC", "PYUSD"] as const;
export type Rail = (typeof RAILS)[number];

/**
 * What the chain says about a key (`statesOf`, docs/paypal/SPEC.md §10.1), plus `not-deployed` (no PayLinkV2 recorded on
 * the chain: decision D-CHAIN) and `unreadable` (the read failed; situation S0).
 */
export const CHAIN_STATES = ["payable", "paid", "cancelled", "expired", "not-deployed", "unreadable"] as const;
export type ChainState = (typeof CHAIN_STATES)[number];

// ------------------------------------------------------------------------------------------- reconciliation

/** The situations of docs/paypal/SPEC.md §10.2. */
export const SITUATIONS = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"] as const;
export type Situation = (typeof SITUATIONS)[number];

/**
 * The actions the fence can allow (docs/paypal/SPEC.md §10.2). `share_reminder_text` has no server effect: the payee
 * shares the text through the share sheet. Refunds, captures and dispute acceptance do not exist here (AI-2).
 */
export const PROPOSAL_KINDS = ["send_reminder", "share_reminder_text", "cancel_paylink", "cancel_paypal", "record_external_payment"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** Who acts on each kind: a tap, a tap and the payee's signature, or deterministic code (auto-record, D-07). */
export const PROPOSAL_ACTOR: Readonly<Record<ProposalKind, "tap" | "tap-and-signature" | "automatic">> = {
  send_reminder: "tap",
  share_reminder_text: "tap",
  cancel_paylink: "tap-and-signature",
  cancel_paypal: "tap",
  record_external_payment: "automatic",
};
