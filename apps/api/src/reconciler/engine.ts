// SPDX-License-Identifier: MIT
/**
 * The reconciler's engine (docs/paypal/SPEC.md §10): reads one twin fresh (P5 and the chain), runs the situation table,
 * and applies its outcome to the payee's store, under the twin's advisory lock (threat T-59):
 *
 * 1. the automatic action of S3: record the verified chain payment on the PayPal twin (P6, PayLink's echo note), once
 *    per chain transaction, then read PayPal again (D-07; Undo in src/reconciler/desk.ts);
 * 2. the twin's cached record: status, paid amount, chain state, verified payment, situation, fence, closing time;
 * 3. the alert of S0 and S4, cleared when the situation moves on;
 * 4. proposals: one open proposal per tap action of the fence (deduplicated by its exact values, a rejected one never
 *    re-proposed), proposals the fence no longer holds made `stale`, unanswered ones `expired`, an approved chain cancel
 *    `done` when the chain shows the key cancelled;
 * 5. the audit line of every change of situation and every effect;
 * 6. the next check in the cron's schedule (adaptive polling, §7.5), or none once closed (S8, S9).
 *
 * Every entry point (webhook, cron, "Check my invoices", the executor, "Was I really paid?") goes through
 * `reconcileTwin`; twins enter through `registerTwin`, which is idempotent (re-registering the same key keeps the
 * reconciler's fields), so the store can be rebuilt by registering the payee's links again (§11 "Rebuild").
 *
 * Owner: reconciler workstream.
 */
import type { Address, InvoiceKey, ProposalState } from "@paylink/api-contract";
import { canonicalJson, sha256Hex } from "../approvals/crypto.ts";
import type { CanonicalProposal } from "../approvals/types.ts";
import type { ChainTwin } from "../chain/types.ts";
import { errorFields } from "../core/log.ts";
import type { ApiServices } from "../core/services.ts";
import { isPayPalError } from "../paypal/client.ts";
import type { PayPalError } from "../paypal/client.ts";
import type { Invoice } from "../paypal/types.ts";
import type { AutoRecord, NewTwin, PayeeStore, ProposalRecord, TwinRecord } from "../store/types.ts";
import { echoNote } from "./echo.ts";
import { isDue } from "./money.ts";
import { observeInvoice, twinFacts } from "./observe.ts";
import { admits, reconcile } from "./situation.ts";
import type { ChainObservation, PayPalObservation, ReconcileResult } from "./types.ts";

/** How long a reconciliation may hold a twin's lock (a crashed holder never blocks a twin for longer). */
export const LOCK_TTL_MS = 30_000;
/** An automatic record is undoable this long (D-07). */
export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
/** An unanswered proposal expires after 7 days (E). */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** An approved chain cancel waits this long for the payee's signature and the chain (the Cancel deadline + 10 min). */
export const CANCEL_WAIT_MS = 70 * 60 * 1000;
/** Any other approval left half-done this long (a crash between the approval and the effect) is released (E). */
export const APPROVING_WAIT_MS = 10 * 60 * 1000;

const MINUTE = 60_000;

/** Where a reconciliation was started from (logged and audited). */
export type ReconcileSource = "register" | "webhook" | "cron" | "sweep" | "executor" | "check" | "undo";

export interface ReconcileOptions {
  readonly source: ReconcileSource;
  /** P5's answer, when the caller has just read it (saves a subrequest). */
  readonly invoice?: Invoice;
  /** The chain's answer, when the caller read many twins at once (the cron's one multicall). */
  readonly chain?: ChainObservation;
  /** Whether the automatic record of S3 may run in this pass (the cron limits them per run). */
  readonly automatic?: boolean;
}

export type ReconcileOutcome =
  | { readonly status: "done"; readonly twin: TwinRecord; readonly result: ReconcileResult; readonly paypalError: PayPalError | null; readonly recorded: boolean }
  | { readonly status: "busy" }
  | { readonly status: "unknown-twin" };

/** The chain reader's view of a twin's record. */
export const chainTwinOf = (twin: TwinRecord): ChainTwin => ({
  key: twin.key,
  payee: twin.payee,
  token: twin.token,
  rail: twin.rail,
  amountBase: twin.amountBase,
  validUntil: twin.validUntil,
  chainPayment: twin.chainPayment,
});

/** A proposal's id: `p_` + 24 hex of the SHA-256 of its kind, key and exact values (the same action, the same id). */
export async function proposalId(kind: string, key: InvoiceKey, args: Readonly<Record<string, string>>): Promise<string> {
  return `p_${(await sha256Hex(canonicalJson({ kind, key: key.toLowerCase(), args }))).slice(2, 26)}`;
}

export const canonicalOf = (services: ApiServices, payee: Address, p: Pick<ProposalRecord, "id" | "kind" | "key" | "args">): CanonicalProposal => ({
  id: p.id,
  kind: p.kind,
  key: p.key,
  payee,
  chainId: services.runtime.config.chainId,
  args: p.args,
});

/** P5, as an observation: a failure is `failed`, never an exception (the table hands off). */
export async function readPayPal(services: ApiServices, paypalId: string): Promise<{ readonly observation: PayPalObservation; readonly error: PayPalError | null; readonly invoice: Invoice | null }> {
  try {
    const invoice = await services.paypal.getInvoice(paypalId);
    return { observation: observeInvoice(invoice), error: null, invoice };
  } catch (error) {
    services.runtime.logger.log("warn", "reconcile.paypal-read-failed", errorFields(error));
    return { observation: { read: "failed", retryable: isPayPalError(error) ? error.retryable : false }, error: isPayPalError(error) ? error : null, invoice: null };
  }
}

/**
 * Enters (or re-enters) a twin the PayPal spine created or found by P2, then reconciles it. `invoice` is P5's answer
 * when the caller has it. Idempotent: the reconciler's own fields of an existing record are kept.
 */
export async function registerTwin(services: ApiServices, input: NewTwin, now: number, options: { readonly invoice?: Invoice } = {}): Promise<ReconcileOutcome> {
  const store = services.stores.payee(input.payee);
  const existing = await store.getTwin(input.key);
  const record: TwinRecord = {
    currency: "USD",
    lastStatus: null,
    paidAmount: null,
    recordedPaymentIds: [],
    lastChainState: null,
    chainPayment: null,
    situation: "S0",
    fence: [],
    createdAt: now,
    checkedAt: now,
    lastReminderAt: null,
    closedAt: null,
    ...existing,
    ...input,
    key: input.key.toLowerCase() as InvoiceKey,
  };
  await store.putTwin(record);
  const global = services.stores.global();
  await global.indexTwin({ paypalId: input.paypalId, payee: input.payee, key: record.key }, now);
  await global.notePayee(input.payee, now);
  if (existing === null) {
    await store.audit({ at: now, action: "twin.register", key: record.key, actor: "system", result: "ok", code: input.paypalId });
  }
  return await reconcileTwin(services, input.payee, record.key, now, { source: "register", ...(options.invoice === undefined ? {} : { invoice: options.invoice }) });
}

/** The webhook's way in: a verified event whose P5 the spine already read (src/routes/webhook.ts `TwinEventSink`). */
export async function reconcileTwinEvent(services: ApiServices, event: { readonly invoice: Invoice; readonly key: InvoiceKey; readonly payee: Address }, now: number): Promise<"reconciled" | "scheduled"> {
  const outcome = await reconcileTwin(services, event.payee, event.key, now, { source: "webhook", invoice: event.invoice });
  if (outcome.status === "done") {
    await services.stores.global().noteHealth("webhook-verified", now);
    return "reconciled";
  }
  // Busy (another reconciliation holds the twin) or unknown here: the cron reads it again in a minute.
  await services.stores.global().scheduleCheck({ payee: event.payee, key: event.key, dueAt: now + MINUTE });
  return "scheduled";
}

/** Reads one twin fresh and applies the situation table's outcome (the module comment's steps 1 to 6). */
export async function reconcileTwin(services: ApiServices, payee: Address, key: InvoiceKey, now: number, options: ReconcileOptions): Promise<ReconcileOutcome> {
  const store = services.stores.payee(payee);
  const holder = `${options.source}:${[...services.runtime.random(6)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (!(await store.lock(key, holder, now, LOCK_TTL_MS))) {
    return { status: "busy" };
  }
  try {
    const twin = await store.getTwin(key);
    if (twin === null) {
      await services.stores.global().unscheduleCheck(payee, key);
      return { status: "unknown-twin" };
    }
    return await reconcileLocked(services, store, twin, now, options);
  } finally {
    await store.unlock(key, holder);
  }
}

async function reconcileLocked(services: ApiServices, store: PayeeStore, twin: TwinRecord, now: number, options: ReconcileOptions): Promise<ReconcileOutcome & { status: "done" }> {
  const { logger } = services.runtime;
  const read = options.invoice === undefined ? await readPayPal(services, twin.paypalId) : { observation: observeInvoice(options.invoice), error: null, invoice: options.invoice };
  if (read.observation.read === "ok") {
    await services.stores.global().noteHealth("paypal-get", now);
  }
  const chain = options.chain ?? (await services.chain.observe(chainTwinOf(twin)));
  let autoRecords = await store.listAutoRecords({ key: twin.key });
  let result = reconcile({ twin: twinFacts(twin, autoRecords), paypal: read.observation, chain, now });
  let paypal = read.observation;
  let recorded = false;

  // 1. The automatic record of S3, once per chain transaction (the store remembers it even before PayPal shows it).
  const automatic = result.allowed.find((a) => a.actor === "automatic");
  if (automatic !== undefined && options.automatic !== false && admits(result.allowed, automatic.kind, automatic.args, { automatic: true }) !== null) {
    const txHash = automatic.args["txHash"] ?? "";
    if (!autoRecords.some((r) => r.txHash.toLowerCase() === txHash && !r.undone)) {
      const record = await recordPayment(services, store, twin, automatic.args, now, "auto");
      if (record !== null) {
        recorded = true;
        autoRecords = [record, ...autoRecords];
        const again = await readPayPal(services, twin.paypalId);
        paypal = again.observation;
        result = reconcile({ twin: twinFacts({ ...twin, recordedPaymentIds: [...twin.recordedPaymentIds, record.paymentId] }, autoRecords), paypal, chain, now });
      }
    } else {
      logger.log("info", "reconcile.record-pending", { key: twin.key, situation: result.situation });
    }
  }

  // 2. The twin's record.
  const verified = chain.state === "paid" ? (chain.payments[0] ?? null) : null;
  const closed = result.situation === "S8" || result.situation === "S9";
  const updated: TwinRecord = {
    ...twin,
    lastStatus: paypal.read === "ok" && paypal.statusClass !== "unknown" ? (paypal.status as TwinRecord["lastStatus"]) : twin.lastStatus,
    paidAmount: paypal.read === "ok" ? paypal.paidAmount : twin.paidAmount,
    lastChainState: chain.state,
    chainPayment: verified ?? (chain.state === "paid" ? twin.chainPayment : null),
    recordedPaymentIds: [...new Set([...twin.recordedPaymentIds, ...autoRecords.filter((r) => !r.undone).map((r) => r.paymentId), ...result.echoes])],
    situation: result.situation,
    fence: result.allowed,
    checkedAt: now,
    closedAt: closed ? (twin.closedAt ?? now) : null,
  };
  await store.putTwin(updated);

  // 3. Alerts.
  if (result.alert !== null && (result.situation === "S0" || result.situation === "S4")) {
    await store.putAlert({ key: twin.key, invoiceNumber: twin.invoiceNumber, situation: result.situation, code: result.alert, raisedAt: now });
  } else {
    await store.clearAlert(twin.key);
  }

  // 4. Proposals.
  await syncProposals(services, store, updated, result, chain, now);

  // 5. Audit a change of situation.
  if (twin.situation !== result.situation || twin.checkedAt === twin.createdAt) {
    await store.audit({ at: now, action: "twin.situation", key: twin.key, actor: options.source === "executor" ? "approved" : "system", result: "ok", code: `${twin.situation}->${result.situation}:${result.alert ?? result.reasonCode}` });
  }

  // 6. The next check.
  const global = services.stores.global();
  const next = nextCheckAt(updated, result, now);
  if (next === null) {
    await global.unscheduleCheck(twin.payee, twin.key);
  } else {
    await global.scheduleCheck({ payee: twin.payee, key: twin.key, dueAt: next });
  }
  logger.log("info", "reconcile.done", { source: options.source, situation: result.situation, code: result.alert ?? result.reasonCode, fence: result.allowed.map((a) => a.kind), recorded });
  return { status: "done", twin: updated, result, paypalError: read.error, recorded };
}

/**
 * P6: records a verified chain payment on the PayPal twin with PayLink's echo note (§7.3), and keeps it for Undo.
 * Returns null (audited) when PayPal refuses or does not answer; the next reconciliation tries again.
 */
export async function recordPayment(services: ApiServices, store: PayeeStore, twin: TwinRecord, args: Readonly<Record<string, string>>, now: number, actor: "auto" | "approved"): Promise<AutoRecord | null> {
  const txHash = (args["txHash"] ?? "") as `0x${string}`;
  try {
    const reference = await services.paypal.recordPayment(twin.paypalId, {
      method: "OTHER",
      payment_date: args["paymentDate"] ?? "",
      amount: { currency_code: "USD", value: args["amount"] ?? "" },
      note: echoNote(twin.chainId, txHash, twin.key),
    });
    const record: AutoRecord = { key: twin.key, paymentId: reference.payment_id, rail: twin.rail, txHash, recordedAt: now, undoUntil: now + UNDO_WINDOW_MS, undone: false };
    await store.putAutoRecord(record);
    await store.audit({ at: now, action: "paypal.record", key: twin.key, actor, result: "ok", code: reference.payment_id });
    return record;
  } catch (error) {
    await store.audit({ at: now, action: "paypal.record", key: twin.key, actor, result: "failed", code: isPayPalError(error) ? (error.paypalName ?? `HTTP_${String(error.status)}`) : "error" });
    services.runtime.logger.log("warn", "reconcile.record-failed", errorFields(error));
    return null;
  }
}

/** Step 4: the store's proposals follow the fence. */
async function syncProposals(services: ApiServices, store: PayeeStore, twin: TwinRecord, result: ReconcileResult, chain: ChainObservation, now: number): Promise<void> {
  const existing = await store.listProposals({ key: twin.key });
  const byId = new Map(existing.map((p) => [p.id, p]));
  const move = async (p: ProposalRecord, to: ProposalState, code: string): Promise<void> => {
    if (await store.transitionProposal(p.id, p.state, to, now)) {
      await store.audit({ at: now, action: `proposal.${to}`, key: twin.key, actor: "system", result: to === "done" ? "ok" : "stale", code: `${p.kind}:${code}` });
    }
  };
  for (const action of result.allowed) {
    if (action.actor === "automatic") {
      continue;
    }
    const id = await proposalId(action.kind, twin.key, action.args);
    const known = byId.get(id);
    if (known !== undefined) {
      // Stale or expired while the situation was elsewhere (a read failure, a payment in flight): the fence holds it
      // again, so it is offered again. Open, approving, done and rejected ones are never proposed twice.
      if ((known.state === "stale" || known.state === "expired") && (await store.transitionProposal(id, known.state, "open", now))) {
        await store.putProposal({ ...known, state: "open", updatedAt: now, expiresAt: now + PROPOSAL_TTL_MS });
        await store.audit({ at: now, action: "proposal.open", key: twin.key, actor: "system", result: "ok", code: `${action.kind}:again` });
      }
      continue;
    }
    const hash = await services.approvals.hash(canonicalOf(services, twin.payee, { id, kind: action.kind, key: twin.key, args: action.args }));
    await store.putProposal({ id, kind: action.kind, key: twin.key, args: action.args, hash, reasonCode: action.reasonCode, message: null, origin: "reconciler", state: "open", createdAt: now, updatedAt: now, expiresAt: now + PROPOSAL_TTL_MS });
    await store.audit({ at: now, action: "proposal.open", key: twin.key, actor: "system", result: "ok", code: action.kind });
  }
  for (const p of existing) {
    const held = result.allowed.some((a) => a.actor !== "automatic" && admits([a], p.kind, p.args) !== null);
    if (p.state === "open") {
      if (!held) {
        await move(p, "stale", result.situation);
      } else if (now >= p.expiresAt) {
        await move(p, "expired", "ttl");
      }
    } else if (p.state === "approving" && p.kind === "cancel_paylink") {
      if (chain.state === "cancelled") {
        await move(p, "done", chain.cancelTx ?? "cancelled");
      } else if (!held) {
        await move(p, "stale", result.situation);
      } else if (now - p.updatedAt >= CANCEL_WAIT_MS) {
        // Approved but never signed: offer it again (a fresh approval gives a fresh deadline).
        await move(p, "open", "unsigned");
      }
    } else if (p.state === "approving" && now - p.updatedAt >= APPROVING_WAIT_MS) {
      // The executor stopped between the approval and the effect: the fence decides whether it is offered again.
      await move(p, held ? "open" : "stale", "interrupted");
    }
  }
}

/** Adaptive polling (§7.5, E): often while something is about to happen, rarely while nothing will. */
export function nextCheckAt(twin: TwinRecord, result: ReconcileResult, now: number): number | null {
  switch (result.situation) {
    case "S8":
    case "S9":
      return null;
    case "S5":
    case "S3":
      return now + MINUTE;
    case "S2":
    case "S6":
    case "S0":
      return now + 5 * MINUTE;
    case "S4":
      return now + 60 * MINUTE;
    case "S7":
      return now + 15 * MINUTE;
    case "S1": {
      const since = now - (twin.sentAt ?? twin.createdAt);
      return now + (since < 60 * MINUTE ? MINUTE : isDue(twin.dueDate, now) ? 60 * MINUTE : 15 * MINUTE);
    }
  }
}
