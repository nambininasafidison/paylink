// SPDX-License-Identifier: MIT
/**
 * The executor (docs/paypal/SPEC.md §10.2 "Fresh-read on execute", §10.5, invariant AI-3): the only code that turns an
 * approved proposal into an effect. In order, each refusal leaving nothing changed:
 *
 * 1. the proposal exists in the session payee's own store (`not-found` otherwise: another payee's id is not visible);
 * 2. the request's hash is the stored proposal's, and the stored proposal still hashes to it (exact values unchanged);
 * 3. the HMAC approval token checks: its MAC, that hash, the session's payee, not expired;
 * 4. the proposal moves `open` → `approving` by compare-and-set (a replayed or concurrent approval finds it moved);
 * 5. under the twin's lock, a fresh read of P5 and the chain, the situation table again, and the action must still be
 *    in the fence with exactly the same values, or the proposal goes `stale` and the answer is 409 `E_STALE`;
 * 6. the effect, by kind: P9 (PayPal's reminder), P8 (cancel the PayPal twin), P6 (record, after an Undo), nothing on
 *    the server for `share_reminder_text`, and for `cancel_paylink` the payee's own signature: the answer carries the
 *    `Cancel(key, deadline)` to sign (deadline: one hour, invoice spec §9.2) and the proposal closes when the chain shows
 *    the key cancelled (src/reconciler/engine.ts).
 *
 * Nothing here takes a value from the request beyond the proposal id, the hash and the token: every exact value comes
 * from the stored proposal, checked against the fence. Model text never reaches this module.
 *
 * Owner: reconciler workstream.
 */
import type { Address, ApproveResponse } from "@paylink/api-contract";
import { DEFAULT_CANCEL_TTL_SECONDS } from "@paylink/sdk";
import { errorFields } from "../core/log.ts";
import { ProblemError } from "../core/problem.ts";
import type { ApiServices } from "../core/services.ts";
import { isPayPalError } from "../paypal/client.ts";
import type { PayeeStore, ProposalRecord, TwinRecord } from "../store/types.ts";
import { canonicalOf, chainTwinOf, LOCK_TTL_MS, readPayPal, reconcileTwin, recordPayment } from "./engine.ts";
import { twinFacts } from "./observe.ts";
import { admits, reconcile } from "./situation.ts";

/** PayPal's own reminder and cancel bodies (P9, P8): PayPal ignores any subject or note (V), so none is sent. */
const REMIND = { send_to_recipient: true, send_to_invoicer: false } as const;
const CANCEL = { send_to_recipient: false, send_to_invoicer: false } as const;

function paypalProblem(error: unknown, kind: string): ProblemError {
  if (isPayPalError(error)) {
    const rule = kind === "send_reminder" && (error.status === 429 || error.status === 422) ? "E_PAYPAL_REMINDER_LIMIT" : (error.paypalName ?? `HTTP_${String(error.status)}`);
    return error.retryable ? new ProblemError("paypal-unavailable", "PayPal did not carry out the action; try again later", { rule, retryAfter: 60 }) : new ProblemError("paypal-rejected", "PayPal refused the action", { rule });
  }
  return new ProblemError("paypal-unavailable", "PayPal did not carry out the action", { rule: "E_PAYPAL_UNAVAILABLE", retryAfter: 60 });
}

async function proposalOf(store: PayeeStore, id: string): Promise<ProposalRecord> {
  const proposal = /^p_[0-9a-f]{24}$/u.test(id) ? await store.getProposal(id) : null;
  if (proposal === null) {
    throw new ProblemError("not-found", "no such proposal");
  }
  return proposal;
}

/** `POST /v1/desk/:id/approve`. */
export async function approveProposal(services: ApiServices, payee: Address, id: string, request: { readonly hash: string; readonly token: string }, now: number): Promise<ApproveResponse> {
  const store = services.stores.payee(payee);
  const proposal = await proposalOf(store, id);
  const canonical = canonicalOf(services, payee, proposal);
  // 2. The hash the payee saw is the stored one, and the stored values still hash to it.
  if (request.hash.toLowerCase() !== proposal.hash) {
    throw new ProblemError("forbidden", "the approval names other values than this proposal's", { rule: "E_APPROVAL_HASH" });
  }
  if ((await services.approvals.hash(canonical)) !== proposal.hash) {
    throw new ProblemError("conflict", "the stored proposal does not match its hash", { rule: "E_PROPOSAL_CORRUPT" });
  }
  if (proposal.state !== "open") {
    throw new ProblemError("conflict", `the proposal is ${proposal.state}`, { rule: proposal.state === "approving" || proposal.state === "done" ? "E_ALREADY_USED" : `E_PROPOSAL_${proposal.state.toUpperCase()}` });
  }
  // 3. The token.
  const check = await services.approvals.verify(request.token, canonical, payee, now);
  if (!check.ok) {
    await store.audit({ at: now, action: "proposal.approve", key: proposal.key, actor: "payee", result: "refused", code: check.reason });
    if (check.reason === "expired") {
      throw new ProblemError("stale", "the approval expired: read the desk again", { rule: "E_APPROVAL_EXPIRED" });
    }
    throw new ProblemError("forbidden", "the approval token is not valid for this proposal and payee", { rule: check.reason === "other-payee" ? "E_APPROVAL_OTHER_PAYEE" : check.reason === "hash-mismatch" ? "E_APPROVAL_HASH" : "E_APPROVAL_INVALID" });
  }
  if (now >= proposal.expiresAt) {
    await store.transitionProposal(id, "open", "expired", now);
    throw new ProblemError("stale", "the proposal expired: read the desk again", { rule: "E_PROPOSAL_EXPIRED" });
  }
  // 4. Single use.
  if (!(await store.transitionProposal(id, "open", "approving", now))) {
    throw new ProblemError("conflict", "the proposal was already answered", { rule: "E_ALREADY_USED" });
  }
  const holder = `executor:${id}`;
  if (!(await store.lock(proposal.key, holder, now, LOCK_TTL_MS))) {
    await store.transitionProposal(id, "approving", "open", now);
    throw new ProblemError("conflict", "the invoice is being checked: try again in a moment", { rule: "E_BUSY", retryAfter: 5 });
  }
  let response: ApproveResponse;
  try {
    response = await execute(services, store, proposal, now);
  } catch (error) {
    // A failure that is not one of the executor's own answers (a store or runtime fault): release the approval.
    if (!(error instanceof ProblemError)) {
      await store.transitionProposal(id, "approving", "open", now);
    }
    throw error;
  } finally {
    await store.unlock(proposal.key, holder);
  }
  // Bring the twin's record up to date after the effect (P5 again: what PayPal now says).
  if (response.state === "done" && (proposal.kind === "cancel_paypal" || proposal.kind === "record_external_payment")) {
    await reconcileTwin(services, payee, proposal.key, now, { source: "executor", automatic: false });
  }
  return response;
}

async function execute(services: ApiServices, store: PayeeStore, proposal: ProposalRecord, now: number): Promise<ApproveResponse> {
  const twin = await store.getTwin(proposal.key);
  const stale = async (code: string): Promise<never> => {
    await store.transitionProposal(proposal.id, "approving", "stale", now);
    await store.audit({ at: now, action: "proposal.approve", key: proposal.key, actor: "approved", result: "stale", code });
    throw new ProblemError("stale", "the situation changed: read the desk again", { rule: "E_STALE" });
  };
  if (twin === null) {
    return await stale("unknown-twin");
  }
  // 5. Fresh read, fence again.
  const read = await readPayPal(services, twin.paypalId);
  const chain = await services.chain.observe(chainTwinOf(twin));
  const autoRecords = await store.listAutoRecords({ key: twin.key });
  const result = reconcile({ twin: twinFacts(twin, autoRecords), paypal: read.observation, chain, now });
  if (admits(result.allowed, proposal.kind, proposal.args) === null) {
    return await stale(`${twin.situation}->${result.situation}`);
  }
  // 6. The effect.
  const done = async (code: string): Promise<ApproveResponse> => {
    await store.transitionProposal(proposal.id, "approving", "done", now);
    await store.audit({ at: now, action: `desk.${proposal.kind}`, key: proposal.key, actor: "approved", result: "ok", code });
    return { state: "done", proposalId: proposal.id };
  };
  const failed = async (error: unknown): Promise<never> => {
    await store.transitionProposal(proposal.id, "approving", "open", now);
    await store.audit({ at: now, action: `desk.${proposal.kind}`, key: proposal.key, actor: "approved", result: "failed", code: isPayPalError(error) ? (error.paypalName ?? `HTTP_${String(error.status)}`) : "error" });
    services.runtime.logger.log("warn", "executor.failed", { kind: proposal.kind, ...errorFields(error) });
    throw paypalProblem(error, proposal.kind);
  };
  switch (proposal.kind) {
    case "share_reminder_text":
      return await done("share");
    case "send_reminder":
      try {
        await services.paypal.remindInvoice(twin.paypalId, REMIND);
      } catch (error) {
        return await failed(error);
      }
      await store.putTwin({ ...twin, lastReminderAt: now } satisfies TwinRecord);
      return await done("P9");
    case "cancel_paypal":
      try {
        await services.paypal.cancelInvoice(twin.paypalId, CANCEL);
      } catch (error) {
        return await failed(error);
      }
      return await done("P8");
    case "record_external_payment": {
      const record = await recordPayment(services, store, twin, proposal.args, now, "approved");
      if (record === null) {
        return await failed(new Error("record failed"));
      }
      return await done(record.paymentId);
    }
    case "cancel_paylink": {
      const deadline = BigInt(Math.floor(now / 1000)) + DEFAULT_CANCEL_TTL_SECONDS;
      await store.audit({ at: now, action: "desk.cancel_paylink", key: proposal.key, actor: "approved", result: "ok", code: "signature-required" });
      return { state: "signature-required", proposalId: proposal.id, cancel: { key: twin.key, deadline: deadline.toString() } };
    }
  }
}

/** `POST /v1/desk/:id/reject`: closes an open proposal; nothing else happens. */
export async function rejectProposal(services: ApiServices, payee: Address, id: string, now: number): Promise<{ readonly state: "rejected"; readonly proposalId: string }> {
  const store = services.stores.payee(payee);
  const proposal = await proposalOf(store, id);
  if (!(await store.transitionProposal(id, "open", "rejected", now))) {
    throw new ProblemError("conflict", `the proposal is ${proposal.state}`, { rule: "E_ALREADY_USED" });
  }
  await store.audit({ at: now, action: "proposal.reject", key: proposal.key, actor: "payee", result: "ok", code: proposal.kind });
  return { state: "rejected", proposalId: id };
}

/** `POST /v1/desk/:id/undo` with `id` = `r_<payment id>`: P7 within 24 hours of an automatic record (D-07). */
export async function undoRecord(services: ApiServices, payee: Address, id: string, now: number): Promise<{ readonly state: "undone"; readonly key: `0x${string}`; readonly paymentId: string }> {
  const store = services.stores.payee(payee);
  const paymentId = /^r_[0-9A-Za-z_-]{1,22}$/u.test(id) ? id.slice(2) : null;
  const record = paymentId === null ? null : await store.getAutoRecord(paymentId);
  if (record === null || paymentId === null) {
    throw new ProblemError("not-found", "no such record");
  }
  if (record.undone) {
    throw new ProblemError("conflict", "the record was already undone", { rule: "E_ALREADY_UNDONE" });
  }
  if (now > record.undoUntil) {
    throw new ProblemError("conflict", "the record can no longer be undone here (24 hours): use the PayPal dashboard", { rule: "E_UNDO_EXPIRED" });
  }
  const twin = await store.getTwin(record.key);
  if (twin === null) {
    throw new ProblemError("not-found", "no such twin");
  }
  const holder = `undo:${paymentId}`;
  if (!(await store.lock(record.key, holder, now, LOCK_TTL_MS))) {
    throw new ProblemError("conflict", "the invoice is being checked: try again in a moment", { rule: "E_BUSY", retryAfter: 5 });
  }
  try {
    try {
      // UNVERIFIED until the owner's capture run: that P7's transaction id is P6's payment_id (§7.1 P7).
      await services.paypal.deletePayment(twin.paypalId, paymentId);
    } catch (error) {
      await store.audit({ at: now, action: "paypal.undo", key: record.key, actor: "payee", result: "failed", code: isPayPalError(error) ? (error.paypalName ?? `HTTP_${String(error.status)}`) : "error" });
      throw paypalProblem(error, "undo");
    }
    await store.putAutoRecord({ ...record, undone: true });
    await store.putTwin({ ...twin, recordedPaymentIds: twin.recordedPaymentIds.filter((p) => p !== paymentId) });
    await store.audit({ at: now, action: "paypal.undo", key: record.key, actor: "payee", result: "ok", code: paymentId });
  } finally {
    await store.unlock(record.key, holder);
  }
  // From now on this twin is recorded only by a tap (the table's `recorded-then-undone`).
  await reconcileTwin(services, payee, record.key, now, { source: "undo", automatic: false });
  return { state: "undone", key: record.key, paymentId };
}
