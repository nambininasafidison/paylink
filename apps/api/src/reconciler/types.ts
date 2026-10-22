// SPDX-License-Identifier: MIT
/**
 * The reconciler's contract (docs/paypal/SPEC.md §10): a pure function from what PayPal's GET (P5) and the chain say
 * about one twin to its situation (S0–S9) and the fence, the exact set of actions allowed in that situation. The
 * executor runs an action only if a fresh read still puts it in the fence (else 409 `stale`, rule `E_STALE`). The model
 * never decides any of this: `allowed_actions(K)` is this fence, read by the desk agent as a tool.
 *
 * Properties (L1, fast-check, test/reconciler/): for every input the executor accepts exactly the fence and nothing
 * else; no situation leaves both rails able to take money once one of them has; every S0 is hands off with an alert.
 *
 * Owner: reconciler workstream (types, situation table, echo filter, executor, cron; other workstreams ask for changes
 * through a handoff).
 */
import type { Address, ChainState, DeskAlertCode, DeskReasonCode, InvoiceKey, PayPalStatusClass, ProposalKind, Rail, Situation } from "@paylink/api-contract";
import type { PaymentMethod } from "../paypal/types.ts";

/** A token rail of the chain (the PayPal rail is the twin itself). */
export type ChainRail = Exclude<Rail, "PAYPAL">;

/** One `payments.transactions[]` entry, as the reconciler needs it. */
export interface PayPalTransaction {
  readonly paymentId: string | null;
  readonly type: "PAYPAL" | "EXTERNAL" | null;
  readonly method: PaymentMethod | null;
  readonly note: string | null;
  /** USD, as PayPal wrote it (`amount.value`); null when PayPal omitted it. */
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
      /** A primary recipient has an email address (PayPal's reminder, P9, may need one: UNVERIFIED). */
      readonly hasRecipientEmail: boolean;
    }
  | { readonly read: "failed"; readonly retryable: boolean };

/**
 * A `Paid` event of PayLinkV2 for K, decoded strictly by the SDK (`decodePaidLog`) from a log the registry's RPC returned
 * for the canonical deployment, and checked against the twin: key, payee, an allowlisted token equal to the invoice's,
 * and the exact amount (src/chain/reader.ts).
 */
export interface ChainPayment {
  readonly txHash: `0x${string}`;
  readonly logIndex: number;
  readonly blockNumber: number;
  /** The block's timestamp, unix seconds (the P6 `payment_date` is its UTC date). */
  readonly timestamp: number;
  readonly payer: Address;
  /** Base units. */
  readonly amount: string;
  readonly token: Address;
  readonly rail: ChainRail;
}

/** What the chain said (`stateOf(K)`, the chain's own clock and, when paid, the verified payment). */
export interface ChainObservation {
  readonly state: ChainState;
  /** Verified payments for K (at most one for a one-payment invoice). Empty while a `Paid` log is not found or confirmed. */
  readonly payments: readonly ChainPayment[];
  /** `stateOf(K).lastPaidAt`, unix seconds; null when never paid or not read. */
  readonly paidAt: number | null;
  /** The latest block's timestamp, unix seconds (expiry is judged on chain time, never the server's clock). */
  readonly chainTime: number | null;
  /** The `InvoiceCancelled` transaction, when the key is cancelled and the event was found (information only). */
  readonly cancelTx?: `0x${string}`;
}

/** The facts of the twin the reconciler compares with (from the signed invoice and the store). */
export interface TwinFacts {
  readonly key: InvoiceKey;
  readonly payee: Address;
  readonly chainId: number;
  /** PayPal's invoice id and number (`PL-<chainId>-<first 12 hex of K>`). */
  readonly paypalId: string;
  readonly invoiceNumber: string;
  /** The signed amount in base units, and as PayPal's two-decimal USD string. */
  readonly amountBase: string;
  readonly amountUsd: string;
  /** The invoice's token on the chain and its rail. */
  readonly token: Address;
  readonly rail: ChainRail;
  /** P6 `payment_id`s PayLink recorded: a cache, never proof of an echo on its own (§10.3). */
  readonly recordedPaymentIds: readonly string[];
  /** The last P9, for the one-per-24-hours fence. */
  readonly lastReminderAt: number | null;
  /** When the twin was shared (P4), and its due date: the reminder rule of S1. */
  readonly sentAt: number | null;
  readonly dueDate: string | null;
  /** The payee undid an automatic record of this twin: never record it automatically again (a tap proposal instead). */
  readonly autoRecordUndone: boolean;
  /** A record of this twin disappeared from PayPal without an Undo here (AutoRecord `missing`): alert, tap actions only. */
  readonly recordMissing: boolean;
}

export interface ReconcileInput {
  readonly twin: TwinFacts;
  readonly paypal: PayPalObservation;
  readonly chain: ChainObservation;
  /** Milliseconds since the epoch. */
  readonly now: number;
}

/** Who carries out an allowed action (`PROPOSAL_ACTOR` of the contract, made exact per situation). */
export type ActionActor = "tap" | "tap-and-signature" | "automatic";

/** An action inside the fence, with the exact values the executor will use. */
export interface AllowedAction {
  readonly kind: ProposalKind;
  /** Exact values, as strings: what the payee sees in the grid and what the approval's hash binds. */
  readonly args: Readonly<Record<string, string>>;
  /** A fixed reason code (rendered with owner-reviewed i18n text, `REASON_CODES`). */
  readonly reasonCode: DeskReasonCode;
  readonly actor: ActionActor;
}

export interface ReconcileResult {
  readonly situation: Situation;
  /** The fence: exactly what may happen now, possibly nothing. */
  readonly allowed: readonly AllowedAction[];
  /** PayPal transactions recognised as PayLink echoes (§10.3), by payment id. */
  readonly echoes: readonly string[];
  /** Why the situation is S0 or S4, as a fixed code (`ALERT_CODES`); null otherwise. */
  readonly alert: DeskAlertCode | null;
  /** Whether the till may light, and from which rail (U3: only from a verified GET or a verified receipt). */
  readonly paidVia: Rail | null;
  /** The situation's fixed reason code (`REASON_CODES`), for the desk and the twin view. */
  readonly reasonCode: DeskReasonCode;
  /** Whether each rail can still take money as far as the reads show (open or in flight on PayPal; payable on chain). */
  readonly paypalOpen: boolean;
  readonly chainOpen: boolean;
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
