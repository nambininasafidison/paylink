// SPDX-License-Identifier: MIT
/**
 * The API's state (docs/paypal/SPEC.md §11): a cache, never a source of truth. Losing it loses no money and no fact:
 * P2 (search by `reference`) plus the chain's `statesOf` rebuild every twin (mirrors ADR 0009). Two stores:
 *
 * - `PayeeStore`, one per payee address (Durable Object `Payee` in the Worker): twins, proposals, auto-records, alerts,
 *   audit, quotas.
 * - `GlobalStore`, one for the deployment (Durable Object `Global`): the PayPal token, the daily AI budget, webhook event
 *   ids, the cron's schedule of twins to poll, and the status rows.
 *
 * Every method is async (a Durable Object RPC in the Worker, a map in Node) and every write is atomic per call. Records
 * hold identifiers, statuses and amounts only: no client email, no pasted text, no prompt (§11 "Not stored").
 *
 * Owner: reconciler workstream (interface and implementations: src/store/memory.ts, src/worker/durable.ts; other
 * workstreams ask for changes through a handoff).
 */
import type { Address, AlertView, ChainState, InvoiceKey, PayPalInvoiceStatus, ProposalKind, ProposalState, Rail, Situation } from "@paylink/api-contract";
import type { AccessToken } from "../paypal/client.ts";

/** Milliseconds since the epoch. */
export type EpochMs = number;
/** A UTC day, `YYYY-MM-DD`: the unit of quotas and budgets. */
export type UtcDay = string;

/** A twin (DO `Payee` / twins, keyed by K; kept 90 days after it closes). */
export interface TwinRecord {
  readonly key: InvoiceKey;
  readonly payee: Address;
  readonly chainId: number;
  readonly paypalId: string;
  readonly invoiceNumber: string;
  /** The signed amount in 6-decimal base units, as a decimal string. */
  readonly amountBase: string;
  readonly currency: "USD";
  /** The token of the signed invoice (USDC or PYUSD on Ethereum Sepolia). */
  readonly rail: Exclude<Rail, "PAYPAL">;
  readonly recipientViewUrl: string | null;
  /** The twin has a recipient email, which PayPal's reminder (P9) may need (UNVERIFIED). */
  readonly hasRecipientEmail: boolean;
  readonly lastStatus: PayPalInvoiceStatus | null;
  /** `payments.paid_amount.value` as PayPal last reported it. */
  readonly paidAmount: string | null;
  /** P6 `payment_id`s PayLink recorded (echo-filter shortcut; never proof on its own, §10.3). */
  readonly recordedPaymentIds: readonly string[];
  readonly lastChainState: ChainState | null;
  readonly situation: Situation;
  readonly createdAt: EpochMs;
  readonly checkedAt: EpochMs;
  /** The last P9 (fence: at most one per invoice per 24 hours). */
  readonly lastReminderAt: EpochMs | null;
  /** When the twin reached S8 or S9; retention counts from here. */
  readonly closedAt: EpochMs | null;
}

/** Where a proposal came from: the reconciler's own fence, or the desk assistant through `propose_action`. */
export type ProposalOrigin = "reconciler" | "assistant";

/** A proposal (DO `Payee` / proposals; kept 30 days). Its hash binds exactly these values (src/approvals/types.ts). */
export interface ProposalRecord {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly key: InvoiceKey;
  /** Exact values the executor will use, as strings (canonical JSON input). */
  readonly args: Readonly<Record<string, string>>;
  readonly hash: `0x${string}`;
  readonly reasonCode: string;
  /** Model text (AI-4: shown in a `data-ai` box only), with its numeric-grounding result. */
  readonly message: { readonly text: string; readonly language: "en" | "fr" | "mg"; readonly grounded: boolean } | null;
  readonly origin: ProposalOrigin;
  readonly state: ProposalState;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
}

/** An automatic P6 on S3, undoable through P7 for 24 hours (D-07). */
export interface AutoRecord {
  readonly key: InvoiceKey;
  readonly paymentId: string;
  readonly rail: Exclude<Rail, "PAYPAL">;
  readonly txHash: `0x${string}`;
  readonly recordedAt: EpochMs;
  readonly undoUntil: EpochMs;
  readonly undone: boolean;
}

/** An alert (S4 paid twice, or S0 hands off). */
export type AlertRecord = Omit<AlertView, "raisedAt"> & { readonly raisedAt: EpochMs };

/** One audit line (DO `Payee` / audit; kept 90 days). Identifiers and outcome codes only. */
export interface AuditEntry {
  readonly seq: number;
  readonly at: EpochMs;
  /** `twin.create`, `paypal.record`, `paypal.undo`, `paypal.cancel`, `paypal.remind`, `proposal.reject`, ... */
  readonly action: string;
  readonly key: InvoiceKey | null;
  readonly actor: "auto" | "approved" | "payee" | "system";
  readonly result: "ok" | "refused" | "failed" | "stale";
  readonly code: string | null;
}

/** The result of counting one use against a daily limit. */
export interface QuotaResult {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
}

export interface PayeeStore {
  readonly payee: Address;
  getTwin(key: InvoiceKey): Promise<TwinRecord | null>;
  putTwin(twin: TwinRecord): Promise<void>;
  /** Twins in creation order; `open` keeps those not closed (S8, S9). */
  listTwins(options?: { readonly open?: boolean; readonly limit?: number }): Promise<readonly TwinRecord[]>;

  getProposal(id: string): Promise<ProposalRecord | null>;
  putProposal(proposal: ProposalRecord): Promise<void>;
  listProposals(options?: { readonly states?: readonly ProposalState[] }): Promise<readonly ProposalRecord[]>;
  /** Compare-and-set of a proposal's state: false (nothing written) when it is not in `from` any more. */
  transitionProposal(id: string, from: ProposalState, to: ProposalState): Promise<boolean>;

  putAutoRecord(record: AutoRecord): Promise<void>;
  listAutoRecords(): Promise<readonly AutoRecord[]>;
  putAlert(alert: AlertRecord): Promise<void>;
  clearAlert(key: InvoiceKey): Promise<void>;
  listAlerts(): Promise<readonly AlertRecord[]>;

  /** Appends an audit line and returns it with its sequence number. */
  audit(entry: Omit<AuditEntry, "seq">): Promise<AuditEntry>;
  listAudit(limit: number): Promise<readonly AuditEntry[]>;

  /** Counts one twin or AI call for `day` against `limit`; refuses (without counting) at the limit. */
  useQuota(day: UtcDay, kind: "twins" | "aiCalls", limit: number): Promise<QuotaResult>;

  /** Deletes what is past its retention (§11): closed twins after 90 days, proposals after 30, audit after 90. */
  purge(now: EpochMs): Promise<void>;
}

/** A twin the cron must read again (adaptive polling, §7.5). */
export interface ScheduledCheck {
  readonly payee: Address;
  readonly key: InvoiceKey;
  readonly dueAt: EpochMs;
}

export interface GlobalStore {
  /** The cached PayPal access token, or null when absent or expired at `now`. */
  getToken(now: EpochMs): Promise<AccessToken | null>;
  putToken(token: AccessToken): Promise<void>;

  /** Counts `neurons` (estimated from usage) against the day's ceiling; refuses (without counting) above it. */
  spendAiBudget(day: UtcDay, neurons: number, ceiling: number): Promise<QuotaResult>;

  /** Records a webhook event id: `new` the first time, `seen` afterwards (kept 7 days, §7.5 idempotency). */
  markWebhookEvent(eventId: string, now: EpochMs): Promise<"new" | "seen">;

  /** Plans the next P5 of a twin (replaces an earlier plan for the same key). */
  scheduleCheck(check: ScheduledCheck): Promise<void>;
  unscheduleCheck(payee: Address, key: InvoiceKey): Promise<void>;
  /** The checks due at `now`, oldest first, at most `limit` (≤ 20 per cron run: the 50-subrequest Free-plan limit). */
  dueChecks(now: EpochMs, limit: number): Promise<readonly ScheduledCheck[]>;

  /** The facts of the health rows: last P5, last verified webhook, last cron run, back-off. */
  noteHealth(fact: "paypal-get" | "webhook-verified" | "cron-run" | "paypal-backoff", at: EpochMs, value?: number): Promise<void>;
  readHealth(): Promise<Readonly<Partial<Record<"paypal-get" | "webhook-verified" | "cron-run" | "paypal-backoff", { readonly at: EpochMs; readonly value: number | null }>>>>;

  purge(now: EpochMs): Promise<void>;
}

/** Opens the stores. In the Worker each call returns a Durable Object stub; in Node, maps held by the process. */
export interface StoreFactory {
  payee(payee: Address): PayeeStore;
  global(): GlobalStore;
}
