// SPDX-License-Identifier: MIT
/**
 * The desk, its non-AI parts (docs/paypal/SPEC.md §10, §14.2 F5): the payee's view (proposals with exact values and a
 * fresh approval token, auto-records with their Undo window, alerts), "Check my invoices" (reconcile every open twin,
 * then run the assistant once), and the fence-side API the desk assistant (A2, the AI workstream) is given:
 *
 * - `allowedActions(K)`: the fence of the twin's last reconciliation, read-only;
 * - `propose(...)`: queues a proposal **only** if its kind and values are exactly a tap action of that fence; anything
 *   else is dropped and logged `fence.reject` (§9.2 A2). The stored values are the fence's, never the model's; the
 *   reason code is the fence's; the model's text is kept only if it is grounded in that twin's own facts (AI-5, checked
 *   again here) and is shown in a `data-ai` box (AI-4).
 *
 * The assistant itself (`DeskAgent`) is the AI workstream's; the sweep runs without one and says so.
 *
 * Owner: reconciler workstream.
 */
import type { Address, AlertView, AutoRecordView, DeskResponse, ExactValue, InvoiceKey, Locale, ProposalView, Rail } from "@paylink/api-contract";
import { PROPOSAL_KINDS } from "@paylink/api-contract";
import { checkMessage, factsOfTwin } from "../ai/desk/grounding.ts";
import { APPROVAL_TTL_MS } from "../approvals/types.ts";
import type { ApiServices } from "../core/services.ts";
import { chargeQuota } from "../store/quotas.ts";
import type { PayeeStore, ProposalRecord, TwinRecord } from "../store/types.ts";
import { CRON_TWIN_BUDGET } from "./cron.ts";
import { canonicalOf, chainTwinOf, CLOSED_RECHECK_MS, PROPOSAL_TTL_MS, proposalId, reconcileTwin } from "./engine.ts";
import { admits } from "./situation.ts";
import type { AllowedAction } from "./types.ts";

/** Proposals answered within this window stay visible on the desk (done, rejected, stale, expired). */
export const RECENT_MS = 24 * 60 * 60 * 1000;
/** Longest assistant text kept with a proposal (characters). */
export const MESSAGE_MAX = 1_000;

/** What the assistant may propose: a kind, a twin, optionally values (which must then equal the fence's), text. */
export interface AssistantProposal {
  readonly kind: string;
  readonly key: string;
  readonly args?: Readonly<Record<string, string>>;
  readonly message?: { readonly text: string; readonly language: "en" | "fr" | "mg"; readonly grounded: boolean };
}

export type ProposeOutcome =
  | { readonly outcome: "queued"; readonly id: string }
  | { readonly outcome: "rejected"; readonly reason: "unknown-kind" | "unknown-twin" | "outside-fence" | "automatic-only" | "values-differ" };

/** The tools the desk assistant gets from code: read the fence, propose inside it. Nothing else reaches an effect. */
export interface DeskToolbox {
  readonly payee: Address;
  /** The payee's interface language (the sweep request's `locale`): the assistant explains and drafts in it. */
  readonly locale?: Locale;
  /** The request's source (its client IP, src/core/http.ts `clientSource`), for the assistant's per-source limits. */
  readonly source?: string;
  /** The payee's open twins, as of this sweep (identifiers, statuses and amounts only). */
  readonly twins: readonly TwinRecord[];
  allowedActions(key: string): Promise<readonly AllowedAction[]>;
  propose(proposal: AssistantProposal): Promise<ProposeOutcome>;
}

/** The desk assistant (A2): implemented by the AI workstream (src/ai/), run once per sweep. */
export type DeskAgent = (services: ApiServices, toolbox: DeskToolbox, now: number) => Promise<DeskResponse["assistant"]>;

const KEY = /^0x[0-9a-f]{64}$/u;

/** The fence of one of the payee's twins (the last reconciliation's), or nothing for a key that is not theirs. */
export async function allowedActions(services: ApiServices, payee: Address, key: string): Promise<readonly AllowedAction[]> {
  const lower = key.toLowerCase();
  if (!KEY.test(lower)) {
    return [];
  }
  return (await services.stores.payee(payee).getTwin(lower as InvoiceKey))?.fence ?? [];
}

/** Queues an assistant proposal if, and only if, the fence holds it (module comment). */
export async function proposeFromAssistant(services: ApiServices, payee: Address, input: AssistantProposal, now: number): Promise<ProposeOutcome> {
  const { logger } = services.runtime;
  const reject = (reason: Extract<ProposeOutcome, { outcome: "rejected" }>["reason"]): ProposeOutcome => {
    logger.log("warn", "fence.reject", { kind: (PROPOSAL_KINDS as readonly string[]).includes(input.kind) ? input.kind : "unknown", reason });
    return { outcome: "rejected", reason };
  };
  if (!(PROPOSAL_KINDS as readonly string[]).includes(input.kind)) {
    return reject("unknown-kind");
  }
  const store = services.stores.payee(payee);
  const key = input.key.toLowerCase();
  const twin = KEY.test(key) ? await store.getTwin(key as InvoiceKey) : null;
  if (twin === null) {
    return reject("unknown-twin");
  }
  const candidates = twin.fence.filter((a) => a.kind === input.kind);
  const [action] = candidates;
  if (action === undefined) {
    return reject("outside-fence");
  }
  if (action.actor === "automatic") {
    return reject("automatic-only");
  }
  // The model may name values; every one it names must be the fence's exactly, and it cannot add any.
  if (input.args !== undefined && admits([action], action.kind, { ...action.args, ...input.args }) === null) {
    return reject("values-differ");
  }
  const id = await proposalId(action.kind, twin.key, action.args);
  // The model's text is kept only if the agent found it grounded and it holds against this twin's own facts here too
  // (AI-5: its amounts, dates and invoice number are this twin's; checked again so no caller can skip it).
  const message =
    input.message !== undefined && input.message.grounded && input.message.text.length > 0 && input.message.text.length <= MESSAGE_MAX && checkMessage(input.message.text, factsOfTwin(twin)).grounded
      ? { text: input.message.text, language: input.message.language, grounded: true }
      : null;
  const existing = await store.getProposal(id);
  if (existing !== null) {
    if (existing.state === "open") {
      await store.putProposal({ ...existing, message: message ?? existing.message, origin: existing.origin, updatedAt: now });
    }
    return { outcome: "queued", id };
  }
  const hash = await services.approvals.hash(canonicalOf(services, payee, { id, kind: action.kind, key: twin.key, args: action.args }));
  await store.putProposal({ id, kind: action.kind, key: twin.key, args: action.args, hash, reasonCode: action.reasonCode, message, origin: "assistant", state: "open", createdAt: now, updatedAt: now, expiresAt: now + PROPOSAL_TTL_MS });
  await store.audit({ at: now, action: "proposal.open", key: twin.key, actor: "assistant", result: "ok", code: action.kind });
  return { outcome: "queued", id };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The rail a proposal acts on: the token rail for the chain's actions, PayPal for PayPal's, none for sharing text. */
function railOf(p: ProposalRecord, twin: TwinRecord | undefined): Rail | null {
  switch (p.kind) {
    case "cancel_paylink":
    case "record_external_payment":
      return twin?.rail ?? null;
    case "cancel_paypal":
    case "send_reminder":
      return "PAYPAL";
    case "share_reminder_text":
      return null;
  }
}

/** The grid the payee approves: values computed by code from the stored proposal (never model text, AI-4). */
function exactValues(p: ProposalRecord, twin: TwinRecord | undefined): ExactValue[] {
  const effect: Readonly<Record<ProposalRecord["kind"], string>> = {
    send_reminder: "paypal-sends-its-reminder",
    share_reminder_text: "you-share-the-text",
    cancel_paylink: "closes-the-token-rail",
    cancel_paypal: "closes-the-paypal-rail",
    record_external_payment: "records-on-paypal",
  };
  const values: ExactValue[] = [
    { label: "invoice", value: p.args["invoice"] ?? twin?.invoiceNumber ?? "" },
    { label: "amount", value: `${p.args["amount"] ?? ""} ${p.args["currency"] ?? "USD"}` },
    { label: "action", value: p.kind },
    { label: "effect", value: effect[p.kind] },
  ];
  const rail = railOf(p, twin);
  if (rail !== null) {
    values.push({ label: "rail", value: rail });
  }
  if (p.args["due"] !== undefined && p.args["due"] !== "none") {
    values.push({ label: "due", value: p.args["due"] });
  }
  if (p.args["txHash"] !== undefined) {
    values.push({ label: "transaction", value: p.args["txHash"] });
  }
  return values;
}

/** The payee's desk (`GET /v1/desk`): open and recent proposals with fresh tokens, auto-records, alerts. */
/** Whether a sweep will run the assistant: only when one is wired and the provider is not switched off. */
export function assistantState(services: ApiServices, agent: DeskAgent | null): DeskResponse["assistant"] {
  return agent === null || services.ai.kind === "disabled" ? { available: false, reason: "disabled" } : { available: true, reason: null };
}

export async function deskView(services: ApiServices, payee: Address, now: number, assistant: DeskResponse["assistant"] = assistantState(services, null)): Promise<DeskResponse> {
  const store = services.stores.payee(payee);
  const twins = new Map((await store.listTwins()).map((t) => [t.key, t]));
  const proposals: ProposalView[] = [];
  for (const p of await store.listProposals()) {
    let state = p.state;
    if (state === "open" && now >= p.expiresAt && (await store.transitionProposal(p.id, "open", "expired", now))) {
      state = "expired";
    }
    if (state !== "open" && state !== "approving" && now - p.updatedAt > RECENT_MS) {
      continue;
    }
    const twin = twins.get(p.key);
    const token = state === "open" ? await services.approvals.issue(canonicalOf(services, payee, p), now, p.expiresAt) : null;
    proposals.push({
      id: p.id,
      kind: p.kind,
      key: p.key,
      invoiceNumber: p.args["invoice"] ?? twin?.invoiceNumber ?? "",
      amount: p.args["amount"] ?? "",
      rail: railOf(p, twin),
      situation: twin?.situation ?? "S0",
      exact: exactValues(p, twin),
      reasonCode: p.reasonCode as ProposalView["reasonCode"],
      origin: p.origin,
      message: p.message,
      args: p.args,
      hash: p.hash,
      token: token?.token ?? "",
      expiresAt: iso(token?.expiresAt ?? Math.min(now + APPROVAL_TTL_MS, p.expiresAt)),
      state,
      createdAt: iso(p.createdAt),
    });
  }
  const autoRecords: AutoRecordView[] = (await store.listAutoRecords())
    .filter((r) => now - r.undoUntil <= RECENT_MS)
    .map((r) => ({ id: `r_${r.paymentId}`, key: r.key, invoiceNumber: twins.get(r.key)?.invoiceNumber ?? "", paymentId: r.paymentId, rail: r.rail, txHash: r.txHash, recordedAt: iso(r.recordedAt), undoUntil: iso(r.undoUntil), undone: r.undone }));
  const alerts: AlertView[] = (await store.listAlerts()).map((a) => ({ key: a.key, invoiceNumber: a.invoiceNumber, situation: a.situation, code: a.code, raisedAt: iso(a.raisedAt) }));
  const checked = [...twins.values()].map((t) => t.checkedAt);
  return { proposals, autoRecords, alerts, checkedAt: checked.length === 0 ? null : iso(Math.max(...checked)), assistant };
}

/**
 * "Check my invoices" (`POST /v1/desk/sweep`): the payee's open twins, least recently checked first, then those closed
 * (S8) in the last 30 days (a PayPal invoice can reopen: a record deleted in PayPal's dashboard), at most 20 in all (the
 * Free plan's subrequest budget, §7.5), read with one chain multicall and one P5 each; then the assistant once.
 */
export async function sweep(
  services: ApiServices,
  payee: Address,
  now: number,
  agent: DeskAgent | null,
  options: { readonly locale?: Locale; readonly source?: string } = {},
): Promise<DeskResponse & { readonly sweep: { readonly checked: number; readonly remaining: number } }> {
  await chargeQuota(services, payee, "sweeps", now);
  const store: PayeeStore = services.stores.payee(payee);
  const byAge = (a: TwinRecord, b: TwinRecord): number => a.checkedAt - b.checkedAt;
  const open = [...(await store.listTwins({ open: true }))].sort(byAge);
  const recentlyClosed = (await store.listTwins()).filter((t) => t.situation === "S8" && t.closedAt !== null && now - t.closedAt < CLOSED_RECHECK_MS).sort(byAge);
  const batch = [...open, ...recentlyClosed].slice(0, CRON_TWIN_BUDGET);
  const chain = await services.chain.observeMany(batch.map(chainTwinOf));
  let checked = 0;
  for (const twin of batch) {
    const observation = chain.get(twin.key);
    const outcome = await reconcileTwin(services, payee, twin.key, now, { source: "sweep", ...(observation === undefined ? {} : { chain: observation }) });
    checked += outcome.status === "done" ? 1 : 0;
  }
  let assistant = assistantState(services, agent);
  if (agent !== null && assistant.available) {
    const twins = await store.listTwins({ open: true });
    try {
      assistant = await agent(
        services,
        {
          payee,
          ...(options.locale === undefined ? {} : { locale: options.locale }),
          ...(options.source === undefined ? {} : { source: options.source }),
          twins,
          allowedActions: async (key) => await allowedActions(services, payee, key),
          propose: async (proposal) => await proposeFromAssistant(services, payee, proposal, now),
        },
        now,
      );
    } catch {
      // The assistant failing never fails the desk: the reconciler's own proposals stand (U6).
      assistant = { available: false, reason: "error" };
    }
  }
  return { ...(await deskView(services, payee, now, assistant)), sweep: { checked, remaining: Math.max(0, open.length - batch.length) } };
}
