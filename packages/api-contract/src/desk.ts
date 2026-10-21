// SPDX-License-Identifier: MIT
/**
 * The collections desk (docs/paypal/SPEC.md §10, §13, §14.2 F5): proposals inside the fence, auto-records with Undo,
 * alerts, and the approval round trip. Owner: reconciler workstream (the AI workstream fills `message`).
 *
 * Every AI-originated text sits in `message`, which the web edition renders in a box marked `data-ai`, never inside
 * the exact-values grid (invariant AI-4). Every other string here is a value computed by code or a fixed code the web
 * edition renders with owner-reviewed i18n text.
 */
import type { DecimalString, Hex, InvoiceKey, IsoInstant, Locale, ProposalKind, Rail, Situation } from "./common.ts";

/** Why a twin is in its situation, or why an action is proposed (fixed i18n text; the assistant cannot add one). */
export type DeskReasonCode =
  | "hands-off"
  | "open"
  | "reminder-due"
  | "reminder-after-3-days"
  | "share-reminder"
  | "paid-on-paypal"
  | "marked-paid-by-you"
  | "paid-on-chain"
  | "paypal-still-open-after-record"
  | "recorded-then-undone"
  | "paid-twice"
  | "payment-in-flight"
  | "chain-payment-confirming"
  | "paypal-cancelled"
  | "chain-cancelled"
  | "chain-expired"
  | "closed-paid-paypal"
  | "closed-paid-chain"
  | "closed-cancelled"
  | "refunded";

/** Why a twin is hands off (S0) or paid twice (S4). */
export type DeskAlertCode =
  | "paypal-unreadable"
  | "chain-unreadable"
  | "chain-not-deployed"
  | "reference-mismatch"
  | "currency-mismatch"
  | "amount-mismatch"
  | "paid-amount-mismatch"
  | "paypal-status-unknown"
  | "paypal-scheduled"
  | "paypal-draft"
  | "paid-without-transactions"
  | "paypal-open-with-payments"
  | "chain-paid-unverified"
  | "chain-payment-mismatch"
  | "paid-twice";

/**
 * `open`: waiting for the payee; `approving`: approved, waiting for the effect (a chain cancel waits for the payee's
 * signature and the chain); `done`; `stale`: the situation changed, the fence no longer holds it; `rejected` by the
 * payee; `expired` unanswered for 7 days.
 */
export type ProposalState = "open" | "approving" | "done" | "stale" | "rejected" | "expired";

/** One exact value of the grid the payee approves. Labels are fixed i18n text; values are computed by code. */
export interface ExactValue {
  readonly label: "invoice" | "amount" | "action" | "effect" | "rail" | "client" | "due" | "transaction";
  readonly value: string;
}

/** Model text attached to a proposal: shown labelled, its numbers checked against the record (AI-5). */
export interface AssistantMessage {
  readonly text: string;
  readonly language: Locale;
  /** Every number in `text` appears in the tool data; otherwise a fixed template replaced the text. */
  readonly grounded: boolean;
}

export interface ProposalView {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly key: InvoiceKey;
  readonly invoiceNumber: string;
  readonly amount: DecimalString;
  readonly rail: Rail | null;
  readonly situation: Situation;
  readonly exact: readonly ExactValue[];
  /** A fixed reason code, rendered with owner-reviewed i18n text. */
  readonly reasonCode: DeskReasonCode;
  /** Where the proposal came from: the reconciler's own fence, or the assistant (inside the same fence). */
  readonly origin: "reconciler" | "assistant";
  readonly message: AssistantMessage | null;
  /** The exact values the approval binds (the executor uses these and nothing else). */
  readonly args: Readonly<Record<string, string>>;
  /** sha256 of the canonical proposal (docs/paypal/SPEC.md §10.5). */
  readonly hash: Hex;
  /** HMAC approval token over hash, payee and expiry; empty unless the proposal is `open`. */
  readonly token: string;
  /** When `token` stops being accepted (15 minutes after this read); read the desk again for a fresh one. */
  readonly expiresAt: IsoInstant;
  readonly state: ProposalState;
  readonly createdAt: IsoInstant;
}

/** An automatic record of a verified chain payment on its PayPal twin (S3, D-07), undoable for 24 hours. */
export interface AutoRecordView {
  /** The id for `POST /v1/desk/:id/undo`: `r_` + the P6 payment id. */
  readonly id: string;
  readonly key: InvoiceKey;
  readonly invoiceNumber: string;
  /** P6 `payment_reference.payment_id` (V: at most 22 characters). */
  readonly paymentId: string;
  readonly rail: Rail;
  readonly txHash: Hex;
  readonly recordedAt: IsoInstant;
  readonly undoUntil: IsoInstant;
  readonly undone: boolean;
}

/** A red alert: paid on both rails (S4) or hands off (S0). */
export interface AlertView {
  readonly key: InvoiceKey;
  readonly invoiceNumber: string | null;
  readonly situation: "S0" | "S4";
  readonly code: DeskAlertCode;
  readonly raisedAt: IsoInstant;
}

export interface DeskResponse {
  readonly proposals: readonly ProposalView[];
  readonly autoRecords: readonly AutoRecordView[];
  readonly alerts: readonly AlertView[];
  /** The latest check of any of the payee's twins. */
  readonly checkedAt: IsoInstant | null;
  /** The assistant's state: the desk lists the reconciler's own proposals with fixed text when it is not available. */
  readonly assistant: { readonly available: boolean; readonly reason: "disabled" | "resting" | "error" | null };
}

/** `POST /v1/desk/sweep` ("Check my invoices"): the desk after every open twin was read again (at most 20 per sweep). */
export type DeskSweepResponse = DeskResponse & {
  readonly sweep: { readonly checked: number; readonly remaining: number };
};

export interface ApproveRequest {
  readonly hash: Hex;
  readonly token: string;
}

/**
 * The executor's answer. A chain action (`cancel_paylink`) does not complete on the server: the web edition opens the
 * signing display for `Cancel(key, deadline)` (unix seconds, decimal) and the proposal closes when the chain shows the
 * invoice cancelled. `share_reminder_text` has no server effect: `done` means the payee may share the text.
 */
export type ApproveResponse =
  | { readonly state: "done"; readonly proposalId: string }
  | { readonly state: "signature-required"; readonly proposalId: string; readonly cancel: { readonly key: InvoiceKey; readonly deadline: string } };

export interface RejectResponse {
  readonly state: "rejected";
  readonly proposalId: string;
}

export interface UndoResponse {
  readonly state: "undone";
  readonly key: InvoiceKey;
  readonly paymentId: string;
}
