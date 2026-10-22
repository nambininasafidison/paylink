// SPDX-License-Identifier: MIT
/**
 * The API's state (docs/paypal/SPEC.md §11): a cache, never a source of truth. Losing it loses no money and no fact:
 * P2 (search by `reference`) plus the chain's `statesOf` rebuild every twin (mirrors ADR 0009). Two stores:
 *
 * - `PayeeStore`, one per payee address (Durable Object `Payee` in the Worker): twins, proposals, auto-records, alerts,
 *   audit, quotas, advisory locks.
 * - `GlobalStore`, one for the deployment (Durable Object `Global`): the PayPal token, the daily AI budget, global
 *   quotas, webhook event ids, session nonces, the twin index (PayPal id and key to payee), the cron's schedule, the
 *   payees to purge, and the status rows' facts.
 *
 * Every method is async (a Durable Object RPC in the Worker, a map in Node) and every call is atomic: both
 * implementations run the same synchronous code (src/store/kv.ts) inside one transaction, so a compare-and-set
 * (`transitionProposal`, `lock`, `useQuota`, `markWebhookEvent`, `markNonce`) cannot interleave with another call. Records
 * hold identifiers, statuses and amounts only: no client email, no pasted text, no prompt (§11 "Not stored").
 *
 * Retention (§11, E): closed twins 90 days after they close, proposals 30 days, audit 90 days, payee quotas 2 days, the
 * AI budget 30 days, webhook event ids 7 days, session nonces until they expire.
 *
 * Owner: reconciler workstream (interface and implementations: src/store/kv.ts, src/store/memory.ts,
 * src/worker/durable.ts; other workstreams ask for changes through a handoff).
 */
import type { Address, AlertView, ChainState, InvoiceKey, PayPalInvoiceStatus, ProposalKind, ProposalState, Situation } from "@paylink/api-contract";
import type { AccessToken } from "../paypal/client.ts";
import type { AllowedAction, ChainPayment, ChainRail } from "../reconciler/types.ts";

/** Milliseconds since the epoch. */
export type EpochMs = number;
/** A UTC day, `YYYY-MM-DD`: the unit of quotas and budgets. */
export type UtcDay = string;

/**
 * What the PayPal spine knows when it has created (or found, by P2) and sent a twin: the input of `registerTwin`
 * (src/reconciler/engine.ts), which fills the reconciler's own fields.
 */
export interface NewTwin {
  readonly key: InvoiceKey;
  readonly payee: Address;
  readonly chainId: number;
  readonly paypalId: string;
  readonly invoiceNumber: string;
  /** The signed amount in 6-decimal base units, as a decimal string. */
  readonly amountBase: string;
  /** The signed invoice's token (USDC or PYUSD on Ethereum Sepolia) and its rail. */
  readonly token: Address;
  readonly rail: ChainRail;
  /** The signed invoice's `validUntil`, unix seconds (0: no expiry). Expiry is judged on chain time. */
  readonly validUntil: number;
  readonly recipientViewUrl: string | null;
  /** The twin has a recipient email, which PayPal's reminder (P9) may need (UNVERIFIED). The email itself is never stored. */
  readonly hasRecipientEmail: boolean;
  /** `payment_term.due_date`, if the payee set one. */
  readonly dueDate: string | null;
  /** When P4 shared it (null when it was not sent). */
  readonly sentAt: EpochMs | null;
}

/** A twin (DO `Payee` / twins, keyed by K; kept 90 days after it closes). */
export interface TwinRecord extends NewTwin {
  readonly currency: "USD";
  readonly lastStatus: PayPalInvoiceStatus | null;
  /** `payments.paid_amount.value` as PayPal last reported it. */
  readonly paidAmount: string | null;
  /** P6 `payment_id`s PayLink recorded (echo-filter shortcut; never proof on its own, §10.3). */
  readonly recordedPaymentIds: readonly string[];
  readonly lastChainState: ChainState | null;
  /** The verified chain payment, once found (saves the log lookup on later reads). */
  readonly chainPayment: ChainPayment | null;
  readonly situation: Situation;
  /** The fence of the last reconciliation (`allowed_actions(K)` for the desk assistant). */
  readonly fence: readonly AllowedAction[];
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
  /** The last state change. */
  readonly updatedAt: EpochMs;
  /** An open proposal not answered by then reads `expired` (7 days, E). */
  readonly expiresAt: EpochMs;
}

/** An automatic P6 on S3, undoable through P7 for 24 hours (D-07). */
export interface AutoRecord {
  readonly key: InvoiceKey;
  readonly paymentId: string;
  readonly rail: ChainRail;
  readonly txHash: `0x${string}`;
  readonly recordedAt: EpochMs;
  readonly undoUntil: EpochMs;
  readonly undone: boolean;
  /**
   * PayPal's GET (P5) no longer shows this record, though no Undo of this app removed it (a P7 whose answer was lost,
   * or the record deleted in PayPal's dashboard): the reconciler marked it undone, raised the alert `record-missing`
   * and offers the payee to record again or to cancel the PayPal invoice (src/reconciler/engine.ts).
   */
  readonly missing?: boolean;
}

/** An alert (S4 paid twice, or S0 hands off). */
export type AlertRecord = Omit<AlertView, "raisedAt"> & { readonly raisedAt: EpochMs };

/** One audit line (DO `Payee` / audit; kept 90 days). Identifiers and outcome codes only. */
export interface AuditEntry {
  readonly seq: number;
  readonly at: EpochMs;
  /** `twin.register`, `twin.situation`, `paypal.record`, `paypal.undo`, `paypal.cancel`, `paypal.remind`, `proposal.reject`, ... */
  readonly action: string;
  readonly key: InvoiceKey | null;
  readonly actor: "auto" | "approved" | "payee" | "system" | "assistant";
  readonly result: "ok" | "refused" | "failed" | "stale";
  readonly code: string | null;
}

/** The result of counting one use against a daily limit. */
export interface QuotaResult {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
}

/** Daily per-payee counters (§9.4): twins created, assistant calls, desk sweeps, "Was I really paid?" checks. */
export type PayeeQuotaKind = "twins" | "aiCalls" | "sweeps" | "checks";
/**
 * Daily deployment-wide counters (abuse of the public demo, threat T-60). `sessions` and `aiCalls` count the public lane;
 * `sessionsDemo` and `aiCallsDemo` the demo payees' reserved lane (`config.demoPayees`), which the public cannot spend.
 */
export type GlobalQuotaKind = "twins" | "aiCalls" | "sessions" | "checks" | "sessionsDemo" | "aiCallsDemo";
/**
 * Daily deployment-wide counters per subject (threat T-60: addresses cost nothing, so a payee cap alone does not bound a
 * Sybil): sessions per payee, and sessions, assistant calls and neurons per request source (the client IP, an IPv6
 * address by its /64; src/core/http.ts `clientSource`).
 */
export type SubjectQuotaKind = "sessions-payee" | "sessions-source" | "aiCalls-source" | "neurons-source";

export interface PurgeReport {
  readonly removed: number;
}

export interface PayeeStore {
  readonly payee: Address;
  getTwin(key: InvoiceKey): Promise<TwinRecord | null>;
  putTwin(twin: TwinRecord): Promise<void>;
  /** Twins in creation order; `open` keeps those not closed (S8, S9). */
  listTwins(options?: { readonly open?: boolean; readonly limit?: number }): Promise<readonly TwinRecord[]>;

  getProposal(id: string): Promise<ProposalRecord | null>;
  putProposal(proposal: ProposalRecord): Promise<void>;
  /** Newest first. */
  listProposals(options?: { readonly states?: readonly ProposalState[]; readonly key?: InvoiceKey }): Promise<readonly ProposalRecord[]>;
  /** Compare-and-set of a proposal's state: false (nothing written) when it is not in `from` any more. */
  transitionProposal(id: string, from: ProposalState, to: ProposalState, now?: EpochMs): Promise<boolean>;

  putAutoRecord(record: AutoRecord): Promise<void>;
  getAutoRecord(paymentId: string): Promise<AutoRecord | null>;
  /** Newest first; `key` keeps one twin's. */
  listAutoRecords(options?: { readonly key?: InvoiceKey }): Promise<readonly AutoRecord[]>;
  putAlert(alert: AlertRecord): Promise<void>;
  clearAlert(key: InvoiceKey): Promise<void>;
  listAlerts(): Promise<readonly AlertRecord[]>;

  /** Appends an audit line and returns it with its sequence number. */
  audit(entry: Omit<AuditEntry, "seq">): Promise<AuditEntry>;
  /** The latest `limit` lines, newest first. */
  listAudit(limit: number): Promise<readonly AuditEntry[]>;

  /** Counts one use for `day` against `limit`; refuses (without counting) at the limit. */
  useQuota(day: UtcDay, kind: PayeeQuotaKind, limit: number): Promise<QuotaResult>;

  /**
   * Takes the advisory lock of one twin for `ttlMs` (threat T-59: a webhook and the cron never act on the same twin at
   * once). True when taken; false while another holder's lock is alive. Re-entrant for the same holder.
   */
  lock(key: InvoiceKey, holder: string, now: EpochMs, ttlMs: number): Promise<boolean>;
  unlock(key: InvoiceKey, holder: string): Promise<void>;

  /** Deletes what is past its retention (§11): closed twins after 90 days, proposals after 30, audit after 90. */
  purge(now: EpochMs): Promise<PurgeReport>;
}

/** A twin the cron must read again (adaptive polling, §7.5). */
export interface ScheduledCheck {
  readonly payee: Address;
  readonly key: InvoiceKey;
  readonly dueAt: EpochMs;
}

/** Where a twin lives: its payee's store (the webhook knows PayPal's id, the public rails route only the key). */
export interface TwinIndexEntry {
  readonly paypalId: string;
  readonly payee: Address;
  readonly key: InvoiceKey;
}

/** Facts behind the status rows (GET /v1/health) and the cron's state. */
export type HealthFact = "paypal-get" | "webhook-verified" | "cron-run" | "paypal-backoff" | "purge";

export interface GlobalStore {
  /** The cached PayPal access token, or null when absent or expired at `now`. */
  getToken(now: EpochMs): Promise<AccessToken | null>;
  putToken(token: AccessToken): Promise<void>;

  /** Counts `neurons` (estimated from usage) against the day's ceiling; refuses (without counting) above it. */
  spendAiBudget(day: UtcDay, neurons: number, ceiling: number): Promise<QuotaResult>;
  /** Counts one use against a deployment-wide daily limit; refuses (without counting) at the limit. */
  useQuota(day: UtcDay, kind: GlobalQuotaKind, limit: number): Promise<QuotaResult>;
  /**
   * Counts `amount` for one subject (a payee or a request source) against a daily limit; refuses (without counting)
   * when the count would pass the limit. `amount` 0 reads the count.
   */
  useSubjectQuota(day: UtcDay, kind: SubjectQuotaKind, subject: string, amount: number, limit: number): Promise<QuotaResult>;

  /** Records a webhook event id: `new` the first time, `seen` afterwards (kept 7 days, §7.5 idempotency). */
  markWebhookEvent(eventId: string, now: EpochMs): Promise<"new" | "seen">;
  /** Records a single-use nonce (a signed session's) until `expiresAt`: `new` the first time, `seen` afterwards. */
  markNonce(scope: "session", nonce: string, expiresAt: EpochMs, now: EpochMs): Promise<"new" | "seen">;

  /** Indexes a twin by PayPal id and by key (kept 120 days after the last write, E). */
  indexTwin(entry: TwinIndexEntry, now: EpochMs): Promise<void>;
  findTwinByPayPalId(paypalId: string): Promise<TwinIndexEntry | null>;
  findTwinByKey(key: InvoiceKey): Promise<TwinIndexEntry | null>;

  /** Plans the next P5 of a twin (replaces an earlier plan for the same key). */
  scheduleCheck(check: ScheduledCheck): Promise<void>;
  unscheduleCheck(payee: Address, key: InvoiceKey): Promise<void>;
  /** The checks due at `now`, oldest first, at most `limit` (≤ 20 per cron run: the 50-subrequest Free-plan limit). */
  dueChecks(now: EpochMs, limit: number): Promise<readonly ScheduledCheck[]>;

  /** Remembers a payee with state, so the daily purge reaches every payee store. */
  notePayee(payee: Address, now: EpochMs): Promise<void>;
  /** Payees not purged in the last 24 hours, at most `limit`. */
  payeesToPurge(now: EpochMs, limit: number): Promise<readonly Address[]>;
  markPayeePurged(payee: Address, now: EpochMs): Promise<void>;

  /** The facts of the health rows: last P5, last verified webhook, last cron run, back-off (ms), last purge. */
  noteHealth(fact: HealthFact, at: EpochMs, value?: number): Promise<void>;
  readHealth(): Promise<Readonly<Partial<Record<HealthFact, { readonly at: EpochMs; readonly value: number | null }>>>>;

  purge(now: EpochMs): Promise<PurgeReport>;
}

/** Opens the stores. In the Worker each call returns a Durable Object stub; in Node, maps held by the process. */
export interface StoreFactory {
  payee(payee: Address): PayeeStore;
  global(): GlobalStore;
}
