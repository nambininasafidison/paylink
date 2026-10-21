// SPDX-License-Identifier: MIT
/**
 * The reconciler's contract (docs/paypal/SPEC.md §10): a pure function from what PayPal's GET (P5) and the chain say
 * about one twin to its situation (S0–S9) and the fence, the exact set of actions allowed in that situation. The
 * executor runs an action only if a fresh read still puts it in the fence (else 409 `stale`, rule `E_STALE`). The model
 * never decides any of this: `allowed_actions(K)` is this fence, read by the desk agent as a tool.
 *
 * Property (L1, fast-check): for every input, the executor accepts exactly the fence and nothing else.
 *
 * Owner: reconciler workstream (types, situation table, echo filter, executor, cron; other workstreams ask for changes
 * through a handoff).
 */
import type { Address, ChainState, InvoiceKey, PayPalStatusClass, ProposalKind, Rail, Situation } from "@paylink/api-contract";
import type { PaymentMethod } from "../paypal/types.ts";

/** One `payments.transactions[]` entry, as the reconciler needs it. */
export interface PayPalTransaction {
  readonly paymentId: string | null;
  readonly type: "PAYPAL" | "EXTERNAL" | null;
  readonly method: PaymentMethod | null;
  readonly note: string | null;
  /** USD, two decimals. */
  readonly amount: string | null;
  readonly paymentDate: string | null;
}

/** What P5 said about the twin (or that it could not be read). */
export type PayPalObservation =
  | {
      readonly read: "ok";
      /** A `PayPalInvoiceStatus`, or a status PayPal added later (its class is then `unknown`: S0). */
      readonly status: string;
      readonly statusClass: PayPalStatusClass;
      /** `amount.value` (the invoice total). */
      readonly amount: string | null;
      readonly currency: string | null;
      /** `detail.reference`: must equal K, or the situation is S0. */
      readonly reference: string | null;
      /** `payments.paid_amount.value`. */
      readonly paidAmount: string | null;
      readonly transactions: readonly PayPalTransaction[];
      readonly hasRecipientEmail: boolean;
    }
  | { readonly read: "failed"; readonly retryable: boolean };

/** A verified `Paid` event of PayLinkV2 for K (SDK `verifyReceipt`, exact amount and payee). */
export interface ChainPayment {
  readonly txHash: `0x${string}`;
  readonly logIndex: number;
  readonly payer: Address;
  /** Base units. */
  readonly amount: string;
  readonly token: Address;
  readonly rail: Exclude<Rail, "PAYPAL">;
}

/** What the chain said (`statesOf(K)` and, when paid, the verified receipt). */
export interface ChainObservation {
  readonly state: ChainState;
  readonly payments: readonly ChainPayment[];
}

/** The facts of the twin the reconciler compares with (from the signed invoice and the store). */
export interface TwinFacts {
  readonly key: InvoiceKey;
  readonly payee: Address;
  readonly chainId: number;
  /** The signed amount in base units, and as PayPal's two-decimal USD string. */
  readonly amountBase: string;
  readonly amountUsd: string;
  readonly recordedPaymentIds: readonly string[];
  /** The last P9, for the one-per-24-hours fence. */
  readonly lastReminderAt: number | null;
  /** Days since the twin was shared, and whether it is past due (reminder rule of S1). */
  readonly sentAt: number | null;
  readonly dueDate: string | null;
}

export interface ReconcileInput {
  readonly twin: TwinFacts;
  readonly paypal: PayPalObservation;
  readonly chain: ChainObservation;
  readonly now: number;
}

/** An action inside the fence, with the exact values the executor will use. */
export interface AllowedAction {
  readonly kind: ProposalKind;
  readonly args: Readonly<Record<string, string>>;
  /** A fixed reason code (rendered with owner-reviewed i18n text). */
  readonly reasonCode: string;
}

export interface ReconcileResult {
  readonly situation: Situation;
  /** The fence: exactly what may happen now, possibly nothing. */
  readonly allowed: readonly AllowedAction[];
  /** PayPal transactions recognised as PayLink echoes (§10.3), by payment id. */
  readonly echoes: readonly string[];
  /** Why the situation is S0 or S4, as a fixed code; null otherwise. */
  readonly alert: string | null;
  /** Whether the till may light, and from which rail (U3: only from a verified GET or a verified receipt). */
  readonly paidVia: Rail | null;
}

/** The pure situation function every caller uses (webhook, cron, sweep, executor, desk tool). */
export type Reconcile = (input: ReconcileInput) => ReconcileResult;

/** The executor's verdict on one approved proposal, after its fresh read. */
export type ExecutionResult =
  | { readonly outcome: "done"; readonly code: string }
  | { readonly outcome: "signature-required"; readonly key: InvoiceKey; readonly deadline: bigint }
  | { readonly outcome: "stale"; readonly situation: Situation }
  | { readonly outcome: "refused"; readonly rule: string }
  | { readonly outcome: "failed"; readonly retryable: boolean; readonly code: string };
