// SPDX-License-Identifier: MIT
/**
 * The collections desk (docs/paypal/SPEC.md §10, §13, §14.2 F5): proposals inside the fence, auto-records with Undo,
 * alerts, and the approval round trip. Owner: reconciler workstream (the AI workstream fills `message`).
 *
 * Every AI-originated text sits in `message`, which the web edition renders in a box marked `data-ai`, never inside
 * the exact-values grid (invariant AI-4).
 */
import type { DecimalString, Hex, InvoiceKey, IsoInstant, Locale, ProposalKind, Rail, Situation } from "./common.ts";

export type ProposalState = "open" | "approving" | "done" | "stale" | "rejected" | "expired";

/** One exact value of the grid the payee approves (invoice number, amount, action, effect, rail). Fixed i18n labels. */
export interface ExactValue {
  readonly label: "invoice" | "amount" | "action" | "effect" | "rail" | "client" | "due";
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
  readonly reasonCode: string;
  readonly message: AssistantMessage | null;
  /** sha256 of the canonical proposal (docs/paypal/SPEC.md §10.5). */
  readonly hash: Hex;
  /** HMAC approval token over hash, payee and expiry. */
  readonly token: string;
  readonly expiresAt: IsoInstant;
  readonly state: ProposalState;
  readonly createdAt: IsoInstant;
}

/** An automatic record of a verified chain payment on its PayPal twin (S3, D-07), undoable for 24 hours. */
export interface AutoRecordView {
  readonly key: InvoiceKey;
  readonly invoiceNumber: string;
  /** P6 `payment_reference.payment_id` (V: at most 22 characters). */
  readonly paymentId: string;
  readonly rail: Rail;
  readonly recordedAt: IsoInstant;
  readonly undoUntil: IsoInstant;
  readonly undone: boolean;
}

/** A red alert: paid on both rails (S4) or hands off (S0). */
export interface AlertView {
  readonly key: InvoiceKey;
  readonly invoiceNumber: string | null;
  readonly situation: "S0" | "S4";
  readonly code: string;
  readonly raisedAt: IsoInstant;
}

export interface DeskResponse {
  readonly proposals: readonly ProposalView[];
  readonly autoRecords: readonly AutoRecordView[];
  readonly alerts: readonly AlertView[];
  readonly checkedAt: IsoInstant | null;
  /** The assistant's state: the desk lists the reconciler's own proposals with fixed text when it is not available. */
  readonly assistant: { readonly available: boolean; readonly reason: "disabled" | "resting" | "error" | null };
}

export type DeskSweepResponse = DeskResponse;

export interface ApproveRequest {
  readonly hash: Hex;
  readonly token: string;
}

/**
 * The executor's answer. A chain action (`cancel_paylink`) does not complete on the server: the web edition opens the
 * signing display for `Cancel(key, deadline)` and the proposal closes when the chain shows the invoice cancelled.
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
