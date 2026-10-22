// SPDX-License-Identifier: MIT
/**
 * The reconciler end to end (docs/paypal/SPEC.md §10, L1), over the real services with a PayPal stand-in and a scripted
 * Sepolia: registration, the cross-rail closes (S2 → signed cancel, S3 → automatic record with Undo, K4), the echo
 * filter keeping a recorded twin "closed" and never "paid twice", the S4 alarm, the advisory lock, the executor's
 * refusals (wrong hash, another account, expiry, replay, stale), reminders, the webhook's way in, and the assistant's
 * proposals held to the fence. Each PayPal write is counted: none happens without the payee's tap, except the
 * deterministic record of a verified chain payment (D-07).
 */
import type { Address, InvoiceKey } from "@paylink/api-contract";
import { describe, expect, it } from "vitest";
import { canonicalOf, reconcileTwin, reconcileTwinEvent, registerTwin } from "../../src/reconciler/engine.ts";
import { allowedActions, deskView, proposeFromAssistant, sweep } from "../../src/reconciler/desk.ts";
import { approveProposal, rejectProposal, undoRecord } from "../../src/reconciler/executor.ts";
import { parseEchoNote } from "../../src/reconciler/echo.ts";
import type { ApiProblem, ProposalView } from "@paylink/api-contract";
import { T0 } from "../helpers.ts";
import { DAY, HOUR, KEY, OTHER_KEY, PAYEE, PAYER, TX } from "./fixtures.ts";
import { world } from "./world.ts";
import type { World } from "./world.ts";

const ID = "INV2-TEST-0000-0000-0001";

async function registered(w: World = world(), key: InvoiceKey = KEY, id = ID, overrides = {}): Promise<World> {
  w.paypal.add(id, key);
  const outcome = await registerTwin(w.services, w.twin(key, id, overrides), w.clock.now);
  expect(outcome.status).toBe("done");
  return w;
}

const store = (w: World, payee: Address = PAYEE) => w.services.stores.payee(payee);
const twinOf = async (w: World, key: InvoiceKey = KEY) => await store(w).getTwin(key);
const reconcileNow = async (w: World, key: InvoiceKey = KEY) => await reconcileTwin(w.services, PAYEE, key, w.clock.now, { source: "cron" });
const desk = async (w: World): Promise<readonly ProposalView[]> => (await deskView(w.services, PAYEE, w.clock.now)).proposals;
const openOf = async (w: World, kind: string): Promise<ProposalView> => {
  const found = (await desk(w)).find((p) => p.kind === kind && p.state === "open");
  if (found === undefined) {
    throw new Error(`no open ${kind} proposal`);
  }
  return found;
};
const approve = async (w: World, p: ProposalView, overrides: { hash?: string; token?: string } = {}) => await approveProposal(w.services, PAYEE, p.id, { hash: overrides.hash ?? p.hash, token: overrides.token ?? p.token }, w.clock.now);
const problemOf = async (promise: Promise<unknown>): Promise<Partial<ApiProblem>> => {
  try {
    await promise;
  } catch (error) {
    return (error as { problem?: ApiProblem }).problem ?? { detail: String(error) };
  }
  throw new Error("expected a problem");
};

describe("registration", () => {
  it("records, indexes and reconciles a new twin: S1 with the share proposal, checked again in a minute", async () => {
    const w = await registered();
    expect(await twinOf(w)).toMatchObject({ situation: "S1", lastStatus: "SHARED", lastChainState: "payable", closedAt: null });
    expect(await w.services.stores.global().findTwinByPayPalId(ID)).toEqual({ paypalId: ID, payee: PAYEE, key: KEY });
    expect((await desk(w)).map((p) => [p.kind, p.state, p.origin])).toEqual([["share_reminder_text", "open", "reconciler"]]);
    expect((await w.services.stores.global().dueChecks(T0 + 60_000, 20)).map((c) => c.key)).toEqual([KEY]);
    expect((await store(w).listAudit(10)).map((l) => l.action)).toEqual(["twin.situation", "proposal.open", "twin.register"]);
    expect(w.paypal.writes()).toEqual([]);
  });

  it("is idempotent: registering again keeps the reconciler's fields and proposes nothing twice", async () => {
    const w = await registered();
    await registerTwin(w.services, w.twin(KEY, ID), w.clock.now + 1000);
    expect((await desk(w)).length).toBe(1);
    expect((await store(w).listTwins()).length).toBe(1);
  });
});

describe("S2: paid on PayPal closes the token rail by the payee's signature", () => {
  it("proposes cancel_paylink, answers the Cancel to sign, and closes the proposal when the chain shows it cancelled", async () => {
    const w = await registered();
    w.paypal.payOnPayPal(ID);
    const outcome = await reconcileNow(w);
    expect(outcome).toMatchObject({ status: "done", result: { situation: "S2", paidVia: "PAYPAL" } });
    const cancel = await openOf(w, "cancel_paylink");
    expect(cancel.exact).toEqual([
      { label: "invoice", value: `PL-11155111-${KEY.slice(2, 14)}` },
      { label: "amount", value: "120.00 USD" },
      { label: "action", value: "cancel_paylink" },
      { label: "effect", value: "closes-the-token-rail" },
      { label: "rail", value: "USDC" },
    ]);
    expect((await desk(w)).find((p) => p.kind === "share_reminder_text")?.state).toBe("stale");
    const answer = await approve(w, cancel);
    expect(answer).toEqual({ state: "signature-required", proposalId: cancel.id, cancel: { key: KEY, deadline: String(Math.floor(T0 / 1000) + 3600) } });
    expect((await store(w).getProposal(cancel.id))?.state).toBe("approving");
    // The payee signs; the chain shows the key cancelled; the next read closes everything.
    w.cancelOnChain(KEY);
    w.advance(60_000);
    expect(await reconcileNow(w)).toMatchObject({ result: { situation: "S8", reasonCode: "closed-paid-paypal", paidVia: "PAYPAL" } });
    expect((await store(w).getProposal(cancel.id))?.state).toBe("done");
    // Closed: read again once a day (a PayPal invoice can reopen), not every few minutes.
    expect(await w.services.stores.global().dueChecks(w.clock.now + DAY - 1, 20)).toEqual([]);
    expect(await w.services.stores.global().dueChecks(w.clock.now + DAY, 20)).toEqual([{ payee: PAYEE, key: KEY, dueAt: w.clock.now + DAY }]);
    expect(w.paypal.writes()).toEqual([]);
  });

  it("offers an approved but never signed cancel again after the deadline", async () => {
    const w = await registered();
    w.paypal.payOnPayPal(ID);
    await reconcileNow(w);
    const cancel = await openOf(w, "cancel_paylink");
    await approve(w, cancel);
    w.advance(71 * 60_000);
    await reconcileNow(w);
    expect((await store(w).getProposal(cancel.id))?.state).toBe("open");
  });
});

describe("S3: paid on chain records the payment on PayPal automatically, undoable for 24 hours", () => {
  it("records once with PayLink's echo note; the echo then reads closed (S8), never paid twice", async () => {
    const w = await registered();
    w.payOnChain(KEY, TX);
    const outcome = await reconcileNow(w);
    expect(outcome).toMatchObject({ status: "done", recorded: true, result: { situation: "S8", reasonCode: "closed-paid-chain", paidVia: "USDC", alert: null } });
    const [record] = w.paypal.writes();
    expect(record?.op).toBe("record");
    expect(record?.body).toMatchObject({ method: "OTHER", amount: { currency_code: "USD", value: "120.00" }, payment_date: "2026-10-21" });
    expect(parseEchoNote((record?.body as { note: string }).note)).toEqual({ chainId: 11155111, txHash: TX, key: KEY });
    expect((record?.body as Record<string, unknown>)["type"]).toBeUndefined();
    const view = await deskView(w.services, PAYEE, w.clock.now);
    expect(view.autoRecords).toEqual([expect.objectContaining({ id: "r_EXT00000001", key: KEY, paymentId: "EXT00000001", rail: "USDC", txHash: TX, undone: false, undoUntil: new Date(T0 + DAY).toISOString() })]);
    expect(view.alerts).toEqual([]);
    // Read again and again: never a second record.
    w.advance(60_000);
    await reconcileNow(w);
    expect(w.paypal.writes().filter((c) => c.op === "record")).toHaveLength(1);
  });

  for (const status of ["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"] as const) {
    it(`keeps a recorded twin closed whatever status PayPal shows after P6 (${status}, UNVERIFIED which)`, async () => {
      const w = await registered();
      w.paypal.afterRecord = status;
      w.payOnChain(KEY, TX);
      expect(await reconcileNow(w)).toMatchObject({ result: { situation: "S8", alert: null } });
    });
  }

  it("proposes closing PayPal's rail when the invoice stays open after the record (K4)", async () => {
    const w = await registered();
    w.paypal.afterRecord = "SHARED";
    w.payOnChain(KEY, TX);
    expect(await reconcileNow(w)).toMatchObject({ result: { situation: "S3", reasonCode: "paypal-still-open-after-record" } });
    const cancel = await openOf(w, "cancel_paypal");
    expect(await approve(w, cancel)).toEqual({ state: "done", proposalId: cancel.id });
    expect(w.paypal.writes().map((c) => [c.op, c.body])).toEqual([
      ["record", expect.anything()],
      ["cancel", { send_to_recipient: false, send_to_invoicer: false }],
    ]);
    expect(await twinOf(w)).toMatchObject({ situation: "S8", lastStatus: "CANCELLED" });
  });

  it("Undo deletes the record (P7) and leaves recording to the payee's tap, never automatic again", async () => {
    const w = await registered();
    w.payOnChain(KEY, TX);
    await reconcileNow(w);
    w.advance(HOUR);
    expect(await undoRecord(w.services, PAYEE, "r_EXT00000001", w.clock.now)).toEqual({ state: "undone", key: KEY, paymentId: "EXT00000001" });
    expect(w.paypal.writes().map((c) => [c.op, c.body])).toEqual([
      ["record", expect.anything()],
      ["delete", "EXT00000001"],
    ]);
    expect(await twinOf(w)).toMatchObject({ situation: "S3" });
    w.advance(60_000);
    await reconcileNow(w);
    expect(w.paypal.writes().filter((c) => c.op === "record")).toHaveLength(1);
    const again = await openOf(w, "record_external_payment");
    expect(again.reasonCode).toBe("recorded-then-undone");
    expect(await approve(w, again)).toEqual({ state: "done", proposalId: again.id });
    expect(w.paypal.writes().filter((c) => c.op === "record")).toHaveLength(2);
    expect(await twinOf(w)).toMatchObject({ situation: "S8" });
    expect(await problemOf(undoRecord(w.services, PAYEE, "r_EXT00000001", w.clock.now))).toMatchObject({ rule: "E_ALREADY_UNDONE" });
  });

  it("refuses an Undo after 24 hours, and of a record that does not exist", async () => {
    const w = await registered();
    w.payOnChain(KEY, TX);
    await reconcileNow(w);
    expect(await problemOf(undoRecord(w.services, PAYEE, "r_EXT00000001", T0 + DAY + 1))).toMatchObject({ code: "conflict", rule: "E_UNDO_EXPIRED" });
    expect(await problemOf(undoRecord(w.services, PAYEE, "r_NOPE", w.clock.now))).toMatchObject({ code: "not-found" });
    expect(await problemOf(undoRecord(w.services, PAYER, "r_EXT00000001", w.clock.now))).toMatchObject({ code: "not-found" });
  });

  it("does not record a payment to another payee or of another amount (the reader refuses the log)", async () => {
    const w = await registered();
    w.payOnChain(KEY, TX, { amount: 1n });
    w.advance(20 * 60_000);
    expect(await reconcileNow(w)).toMatchObject({ result: { situation: "S0", alert: "chain-paid-unverified" } });
    expect(w.paypal.writes()).toEqual([]);
  });
});

describe("a record PayPal no longer shows: P5 decides, the store only holds off for PayPal's lag", () => {
  const recordedOnChain = async (): Promise<World> => {
    const w = await registered();
    w.payOnChain(KEY, TX);
    expect(await reconcileNow(w)).toMatchObject({ recorded: true, result: { situation: "S8" } });
    return w;
  };

  it("(a) an Undo whose answer is lost is settled by reading P5: undone, with no 503 and no blind retry (the review's probe)", async () => {
    const w = await recordedOnChain();
    w.advance(HOUR);
    w.paypal.loseAnswer.delete = true;
    expect(await undoRecord(w.services, PAYEE, "r_EXT00000001", w.clock.now)).toEqual({ state: "undone", key: KEY, paymentId: "EXT00000001" });
    expect((await store(w).listAudit(10)).find((l) => l.action === "paypal.undo")).toMatchObject({ result: "ok", code: "EXT00000001:settled-by-read" });
    for (let i = 0; i < 3; i += 1) {
      w.advance(15 * 60_000);
      await reconcileNow(w);
    }
    expect(await twinOf(w)).toMatchObject({ situation: "S3" });
    expect((await openOf(w, "record_external_payment")).reasonCode).toBe("recorded-then-undone");
    expect(w.paypal.writes().map((c) => c.op)).toEqual(["record", "delete"]);
    // A second Undo of the same record finds nothing to undo, and says so; PayPal is not written to again.
    expect(await problemOf(undoRecord(w.services, PAYEE, "r_EXT00000001", w.clock.now))).toMatchObject({ rule: "E_ALREADY_UNDONE" });
  });

  it("(a') a record gone from PayPal without an Undo here: held while PayPal may lag, then the alert, a tap to record again or to cancel PayPal, never a blind re-record", async () => {
    const w = await registered();
    w.paypal.afterRecord = "SHARED";
    w.payOnChain(KEY, TX);
    await reconcileNow(w);
    // A P7 sent by a lost request (or anyone with the merchant's PayPal access) removes it; PayLink does not know.
    w.paypal.deleteOutside(ID, "EXT00000001");
    w.advance(5 * 60_000);
    expect(await reconcileNow(w)).toMatchObject({ recorded: false, result: { situation: "S3", reasonCode: "paid-on-chain" } });
    expect((await deskView(w.services, PAYEE, w.clock.now)).alerts).toEqual([]);
    w.advance(6 * 60_000);
    expect(await reconcileNow(w)).toMatchObject({ recorded: false, result: { situation: "S3", reasonCode: "record-missing", alert: "record-missing" } });
    const view = await deskView(w.services, PAYEE, w.clock.now);
    expect(view.alerts).toEqual([{ key: KEY, invoiceNumber: `PL-11155111-${KEY.slice(2, 14)}`, situation: "S3", code: "record-missing", raisedAt: new Date(w.clock.now).toISOString() }]);
    // (cancel_paypal was already open since the record left the invoice open: the same action, the same values.)
    expect(view.proposals.filter((p) => p.state === "open").map((p) => p.kind).sort()).toEqual(["cancel_paypal", "record_external_payment"]);
    expect((await openOf(w, "record_external_payment")).reasonCode).toBe("record-missing");
    expect(view.autoRecords).toEqual([expect.objectContaining({ paymentId: "EXT00000001", undone: true })]);
    expect(w.paypal.writes().map((c) => c.op)).toEqual(["record"]);
    // The payee records it again by a tap: a new attempt, a new request id; the alert clears.
    const again = await openOf(w, "record_external_payment");
    expect(await approve(w, again)).toEqual({ state: "done", proposalId: again.id });
    expect(w.paypal.writes().map((c) => c.requestId)).toEqual([`pl-record-${KEY.slice(2, 26)}-${TX.slice(2, 26)}-0`, `pl-record-${KEY.slice(2, 26)}-${TX.slice(2, 26)}-1`]);
    expect((await deskView(w.services, PAYEE, w.clock.now)).alerts).toEqual([]);
  });

  it("(b) a record deleted in PayPal's dashboard after the Undo window: the closed twin's daily re-check finds it (the review's probe)", async () => {
    const w = await recordedOnChain();
    w.advance(25 * HOUR);
    expect(await problemOf(undoRecord(w.services, PAYEE, "r_EXT00000001", w.clock.now))).toMatchObject({ rule: "E_UNDO_EXPIRED" });
    // As E_UNDO_EXPIRED tells the payee: the dashboard deletes the record. The invoice is SHARED and payable again.
    w.paypal.deleteOutside(ID, "EXT00000001");
    expect((await w.services.stores.global().dueChecks(w.clock.now, 20)).map((c) => c.key)).toEqual([KEY]);
    expect(await reconcileNow(w)).toMatchObject({ result: { situation: "S3", reasonCode: "record-missing", alert: "record-missing" } });
    expect((await deskView(w.services, PAYEE, w.clock.now)).alerts.map((a) => a.code)).toEqual(["record-missing"]);
    expect(w.paypal.writes().map((c) => c.op)).toEqual(["record"]);
  });

  it("(b') \"Check my invoices\" reads a recently closed twin again, and stops after 30 days", async () => {
    const w = await recordedOnChain();
    w.advance(2 * DAY);
    w.paypal.deleteOutside(ID, "EXT00000001");
    const swept = await sweep(w.services, PAYEE, w.clock.now, null);
    expect(swept.sweep).toEqual({ checked: 1, remaining: 0 });
    expect(swept.alerts.map((a) => a.code)).toEqual(["record-missing"]);
    const old = await recordedOnChain();
    old.advance(31 * DAY);
    expect((await sweep(old.services, PAYEE, old.clock.now, null)).sweep).toEqual({ checked: 0, remaining: 0 });
    expect(await old.services.stores.global().dueChecks(old.clock.now + 2 * DAY, 20)).toHaveLength(1);
    await reconcileNow(old);
    expect(await old.services.stores.global().dueChecks(old.clock.now + 2 * DAY, 20)).toEqual([]);
  });

  it("every write carries a deterministic PayPal-Request-Id: record per attempt, undo per payment, cancel per twin", async () => {
    const w = await recordedOnChain();
    w.advance(HOUR);
    await undoRecord(w.services, PAYEE, "r_EXT00000001", w.clock.now);
    const s7 = await registered(world(), OTHER_KEY, "INV2-TEST-0000-0000-0002");
    s7.cancelOnChain(OTHER_KEY);
    await reconcileNow(s7, OTHER_KEY);
    await approve(s7, await openOf(s7, "cancel_paypal"));
    expect([...w.paypal.writes(), ...s7.paypal.writes()].map((c) => [c.op, c.requestId])).toEqual([
      ["record", `pl-record-${KEY.slice(2, 26)}-${TX.slice(2, 26)}-0`],
      ["delete", "pl-undo-EXT00000001"],
      ["cancel", `pl-cancel-${OTHER_KEY.slice(2, 26)}`],
    ]);
  });
});

describe("the advisory lock (T-59)", () => {
  it("lets one of two simultaneous reconciliations act, so a chain payment is recorded once", async () => {
    const w = await registered();
    w.payOnChain(KEY, TX);
    const outcomes = await Promise.all([reconcileNow(w), reconcileNow(w), reconcileNow(w)]);
    expect(outcomes.filter((o) => o.status === "busy").length).toBeGreaterThanOrEqual(1);
    expect(w.paypal.writes().filter((c) => c.op === "record")).toHaveLength(1);
  });
});

describe("S4: paid on both rails", () => {
  it("alarms and acts on nothing", async () => {
    const w = await registered();
    w.paypal.payOnPayPal(ID);
    w.payOnChain(KEY, TX);
    expect(await reconcileNow(w)).toMatchObject({ result: { situation: "S4", alert: "paid-twice", allowed: [] } });
    expect((await deskView(w.services, PAYEE, w.clock.now)).alerts).toEqual([{ key: KEY, invoiceNumber: `PL-11155111-${KEY.slice(2, 14)}`, situation: "S4", code: "paid-twice", raisedAt: new Date(T0).toISOString() }]);
    expect(w.paypal.writes()).toEqual([]);
  });
});

describe("the executor's refusals", () => {
  async function s7(): Promise<{ w: World; cancel: ProposalView }> {
    const w = await registered();
    w.cancelOnChain(KEY);
    await reconcileNow(w);
    return { w, cancel: await openOf(w, "cancel_paypal") };
  }

  it("refuses a wrong hash, a forged token, another account's token, an expired token, without any effect", async () => {
    const { w, cancel } = await s7();
    expect(await problemOf(approve(w, cancel, { hash: `0x${"00".repeat(32)}` }))).toMatchObject({ code: "forbidden", rule: "E_APPROVAL_HASH" });
    expect(await problemOf(approve(w, cancel, { token: `${cancel.token.slice(0, -2)}AA` }))).toMatchObject({ code: "forbidden", rule: "E_APPROVAL_INVALID" });
    // Another payee's session cannot even see the proposal.
    expect(await problemOf(approveProposal(w.services, PAYER, cancel.id, { hash: cancel.hash, token: cancel.token }, w.clock.now))).toMatchObject({ code: "not-found" });
    // A token issued for another payee's identical proposal does not approve this one.
    const theirs = await w.services.approvals.issue(canonicalOf(w.services, PAYER, { id: cancel.id, kind: cancel.kind, key: cancel.key, args: cancel.args }), w.clock.now);
    expect(await problemOf(approve(w, cancel, { token: theirs.token }))).toMatchObject({ code: "forbidden", rule: "E_APPROVAL_HASH" });
    w.advance(15 * 60_000 + 1);
    expect(await problemOf(approve(w, cancel))).toMatchObject({ code: "stale", rule: "E_APPROVAL_EXPIRED" });
    expect(w.paypal.writes()).toEqual([]);
    expect((await store(w).getProposal(cancel.id))?.state).toBe("open");
  });

  it("acts once: a replayed approval is refused", async () => {
    const { w, cancel } = await s7();
    expect(await approve(w, cancel)).toEqual({ state: "done", proposalId: cancel.id });
    expect(await problemOf(approve(w, cancel))).toMatchObject({ code: "conflict", rule: "E_ALREADY_USED" });
    expect(w.paypal.writes().filter((c) => c.op === "cancel")).toHaveLength(1);
  });

  it("acts once under concurrent approvals of the same proposal", async () => {
    const { w, cancel } = await s7();
    const answers = await Promise.allSettled([approve(w, cancel), approve(w, cancel), approve(w, cancel)]);
    expect(answers.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(w.paypal.writes().filter((c) => c.op === "cancel")).toHaveLength(1);
  });

  it("reads fresh before acting: a proposal the situation no longer allows is stale (409 E_STALE), with no effect", async () => {
    const { w, cancel } = await s7();
    // Meanwhile the client paid on PayPal: cancelling PayPal's rail is no longer the right action.
    w.paypal.payOnPayPal(ID);
    expect(await problemOf(approve(w, cancel))).toMatchObject({ code: "stale", rule: "E_STALE" });
    expect((await store(w).getProposal(cancel.id))?.state).toBe("stale");
    expect(w.paypal.writes()).toEqual([]);
  });

  it("rejects a proposal once; it is never proposed again", async () => {
    const { w, cancel } = await s7();
    expect(await rejectProposal(w.services, PAYEE, cancel.id, w.clock.now)).toEqual({ state: "rejected", proposalId: cancel.id });
    expect(await problemOf(rejectProposal(w.services, PAYEE, cancel.id, w.clock.now))).toMatchObject({ rule: "E_ALREADY_USED" });
    w.advance(20 * 60_000);
    await reconcileNow(w);
    expect((await desk(w)).filter((p) => p.kind === "cancel_paypal").map((p) => p.state)).toEqual(["rejected"]);
    expect(await problemOf(approve(w, cancel))).toMatchObject({ code: "conflict" });
  });

  it("refuses an unknown or malformed proposal id", async () => {
    const { w } = await s7();
    expect(await problemOf(approveProposal(w.services, PAYEE, "p_000000000000000000000000", { hash: `0x${"00".repeat(32)}`, token: "x" }, w.clock.now))).toMatchObject({ code: "not-found" });
    expect(await problemOf(approveProposal(w.services, PAYEE, "../etc", { hash: `0x${"00".repeat(32)}`, token: "x" }, w.clock.now))).toMatchObject({ code: "not-found" });
  });
});

describe("reminders (P9)", () => {
  it("sends PayPal's own reminder once when due, and not again for 24 hours", async () => {
    const w = await registered(world(), KEY, ID, { dueDate: "2026-10-20" });
    const remind = await openOf(w, "send_reminder");
    expect(await approve(w, remind)).toEqual({ state: "done", proposalId: remind.id });
    expect(w.paypal.writes()).toEqual([{ op: "remind", id: ID, body: { send_to_recipient: true, send_to_invoicer: false }, requestId: `pl-remind-${KEY.slice(2, 26)}-first` }]);
    await reconcileNow(w);
    expect((await desk(w)).filter((p) => p.kind === "send_reminder" && p.state === "open")).toEqual([]);
    w.advance(DAY);
    await reconcileNow(w);
    expect((await desk(w)).filter((p) => p.kind === "send_reminder" && p.state === "open")).toHaveLength(1);
  });

  it("maps PayPal's reminder limit to a retryable answer and keeps the proposal open", async () => {
    const w = await registered(world(), KEY, ID, { dueDate: "2026-10-20" });
    const remind = await openOf(w, "send_reminder");
    w.paypal.failNext.remind = 429;
    expect(await problemOf(approve(w, remind))).toMatchObject({ code: "paypal-unavailable", rule: "E_PAYPAL_REMINDER_LIMIT" });
    expect((await store(w).getProposal(remind.id))?.state).toBe("open");
    w.paypal.failNext.remind = 400;
    expect(await problemOf(approve(w, remind))).toMatchObject({ code: "paypal-rejected" });
  });

  it("a reminder whose answer is lost counts as sent: closed unconfirmed, never sent again within 24 hours (the review's probe)", async () => {
    const w = await registered(world(), KEY, ID, { dueDate: "2026-10-20" });
    const remind = await openOf(w, "send_reminder");
    // PayPal sends the reminder, then the answer is lost (no answer, or a 5xx).
    w.paypal.loseAnswer.remind = true;
    expect(await approve(w, remind)).toEqual({ state: "done", proposalId: remind.id, unconfirmed: true });
    expect((await twinOf(w))?.lastReminderAt).toBe(w.clock.now);
    expect((await store(w).listAudit(5)).find((l) => l.action === "desk.send_reminder")).toMatchObject({ result: "ok", code: "P9-unconfirmed" });
    // The next tap cannot send a second one: the proposal is used, and the fence offers none for 24 hours.
    expect(await problemOf(approve(w, remind))).toMatchObject({ code: "conflict", rule: "E_ALREADY_USED" });
    w.advance(60_000);
    await reconcileNow(w);
    expect((await desk(w)).filter((p) => p.kind === "send_reminder" && p.state === "open")).toEqual([]);
    expect(w.paypal.writes().filter((c) => c.op === "remind")).toHaveLength(1);
    // A day later, a new round with its own request id.
    w.advance(DAY);
    await reconcileNow(w);
    const next = await openOf(w, "send_reminder");
    expect(await approve(w, next)).toEqual({ state: "done", proposalId: next.id });
    const ids = w.paypal.writes().map((c) => c.requestId);
    expect(ids).toEqual([`pl-remind-${KEY.slice(2, 26)}-first`, `pl-remind-${KEY.slice(2, 26)}-${String(T0)}`]);
  });

  it("a 5xx on the reminder is a possible send too; only PayPal's definite refusal (4xx) reopens it", async () => {
    const w = await registered(world(), KEY, ID, { dueDate: "2026-10-20" });
    const remind = await openOf(w, "send_reminder");
    w.paypal.failNext.remind = 503;
    expect(await approve(w, remind)).toMatchObject({ state: "done", unconfirmed: true });
    const other = await registered(world(), KEY, ID, { dueDate: "2026-10-20" });
    const again = await openOf(other, "send_reminder");
    other.paypal.failNext.remind = 422;
    expect(await problemOf(approve(other, again))).toMatchObject({ code: "paypal-rejected" });
    expect((await store(other).getProposal(again.id))?.state).toBe("open");
    expect((await twinOf(other))?.lastReminderAt).toBeNull();
  });

  it("offers no PayPal reminder for a twin without a recipient email", async () => {
    const w = world();
    w.paypal.add(ID, KEY, { email: false });
    await registerTwin(w.services, w.twin(KEY, ID, { dueDate: "2026-10-20", hasRecipientEmail: false }), w.clock.now);
    expect((await desk(w)).map((p) => p.kind)).toEqual(["share_reminder_text"]);
  });
});

describe("the webhook's way in", () => {
  it("reconciles with the invoice the spine already read (no second P5) and notes the verified webhook", async () => {
    const w = await registered();
    w.paypal.payOnPayPal(ID);
    const invoice = await w.services.paypal.getInvoice(ID);
    const gets = w.paypal.calls.filter((c) => c.op === "get").length;
    expect(await reconcileTwinEvent(w.services, { invoice, key: KEY, payee: PAYEE }, w.clock.now)).toBe("reconciled");
    expect(w.paypal.calls.filter((c) => c.op === "get").length).toBe(gets);
    expect(await twinOf(w)).toMatchObject({ situation: "S2" });
    expect((await w.services.stores.global().readHealth())["webhook-verified"]).toEqual({ at: T0, value: null });
    expect(await reconcileTwinEvent(w.services, { invoice, key: OTHER_KEY, payee: PAYEE }, w.clock.now)).toBe("scheduled");
  });
});

describe("PayPal unreadable", () => {
  it("makes open proposals stale while hands off, and offers them again once PayPal answers", async () => {
    const w = await registered();
    w.paypal.failGets = 500;
    await reconcileNow(w);
    expect((await desk(w)).map((p) => [p.kind, p.state])).toEqual([["share_reminder_text", "stale"]]);
    w.paypal.failGets = null;
    w.advance(5 * 60_000);
    await reconcileNow(w);
    expect((await desk(w)).map((p) => [p.kind, p.state])).toEqual([["share_reminder_text", "open"]]);
  });

  it("hands off with an alert and acts on nothing", async () => {
    const w = await registered();
    w.payOnChain(KEY, TX);
    w.paypal.failGets = 503;
    expect(await reconcileNow(w)).toMatchObject({ result: { situation: "S0", alert: "paypal-unreadable" }, paypalError: expect.objectContaining({ status: 503 }) as unknown });
    expect(w.paypal.writes()).toEqual([]);
    w.paypal.failGets = null;
    w.advance(5 * 60_000);
    expect(await reconcileNow(w)).toMatchObject({ result: { situation: "S8" } });
    expect((await deskView(w.services, PAYEE, w.clock.now)).alerts).toEqual([]);
  });
});

describe("the desk assistant's proposals, held to the fence (A2, AI-2, AI-3)", () => {
  it("queues only a tap action of the fence, with the fence's values and reason; drops everything else", async () => {
    const w = await registered(world(), KEY, ID, { dueDate: "2026-10-20" });
    const fence = await allowedActions(w.services, PAYEE, KEY);
    expect(fence.map((a) => a.kind)).toEqual(["share_reminder_text", "send_reminder"]);
    const message = { text: "Bonjour Sarah, la facture de 120.00 USD est due.", language: "fr" as const, grounded: true };
    const queued = await proposeFromAssistant(w.services, PAYEE, { kind: "send_reminder", key: KEY, message }, w.clock.now);
    expect(queued.outcome).toBe("queued");
    const p = (await desk(w)).find((x) => x.kind === "send_reminder");
    expect(p).toMatchObject({ message, reasonCode: "reminder-due", args: fence[1]?.args });
    const refused = await Promise.all([
      proposeFromAssistant(w.services, PAYEE, { kind: "create_refund", key: KEY }, w.clock.now),
      proposeFromAssistant(w.services, PAYEE, { kind: "cancel_paypal", key: KEY }, w.clock.now),
      proposeFromAssistant(w.services, PAYEE, { kind: "send_reminder", key: KEY, args: { amount: "12000.00" } }, w.clock.now),
      proposeFromAssistant(w.services, PAYEE, { kind: "send_reminder", key: KEY, args: { payTo: PAYER } }, w.clock.now),
      proposeFromAssistant(w.services, PAYEE, { kind: "send_reminder", key: OTHER_KEY }, w.clock.now),
      proposeFromAssistant(w.services, PAYER, { kind: "send_reminder", key: KEY }, w.clock.now),
    ]);
    expect(refused).toEqual([
      { outcome: "rejected", reason: "unknown-kind" },
      { outcome: "rejected", reason: "outside-fence" },
      { outcome: "rejected", reason: "values-differ" },
      { outcome: "rejected", reason: "values-differ" },
      { outcome: "rejected", reason: "unknown-twin" },
      { outcome: "rejected", reason: "unknown-twin" },
    ]);
    expect(w.lines.filter((l) => l.includes('"fence.reject"'))).toHaveLength(6);
    expect(w.paypal.writes()).toEqual([]);
  });

  it("never lets the assistant trigger the automatic record, and drops ungrounded text", async () => {
    const w = await registered();
    w.paypal.failNext.record = 503; // the automatic record fails this time: S3 stays, with its automatic fence
    w.payOnChain(KEY, TX);
    await reconcileNow(w);
    expect(await proposeFromAssistant(w.services, PAYEE, { kind: "record_external_payment", key: KEY }, w.clock.now)).toEqual({ outcome: "rejected", reason: "automatic-only" });
    const w2 = await registered();
    await proposeFromAssistant(w2.services, PAYEE, { kind: "share_reminder_text", key: KEY, message: { text: "Pay $9,999 now", language: "en", grounded: false } }, w2.clock.now);
    expect((await desk(w2)).find((p) => p.kind === "share_reminder_text")?.message).toBeNull();
  });

  it("runs the assistant on a sweep with only these tools, and survives it failing", async () => {
    const w = await registered(world(), KEY, ID, { dueDate: "2026-10-20" });
    const seen: string[] = [];
    const answer = await sweep(w.services, PAYEE, w.clock.now, async (_services, tools) => {
      seen.push(...Object.keys(tools).sort());
      await tools.propose({ kind: "send_reminder", key: KEY });
      return { available: true, reason: null };
    });
    expect(seen).toEqual(["allowedActions", "payee", "propose", "twins"]);
    expect(answer).toMatchObject({ assistant: { available: true, reason: null }, sweep: { checked: 1, remaining: 0 } });
    const failing = await sweep(w.services, PAYEE, w.clock.now, () => Promise.reject(new Error("model down")));
    expect(failing.assistant).toEqual({ available: false, reason: "error" });
    expect(failing.proposals.length).toBeGreaterThan(0);
  });
});

describe("an approval interrupted between the tap and the effect", () => {
  it("is released by the executor on a fault, and by the next reconciliation after 10 minutes", async () => {
    const w = await registered();
    w.cancelOnChain(KEY);
    await reconcileNow(w);
    const cancel = await openOf(w, "cancel_paypal");
    const faulty: Pick<typeof w.services.paypal, "cancelInvoice"> = { cancelInvoice: () => Promise.reject(new Error("runtime fault")) };
    Object.assign(w.services.paypal, faulty);
    await expect(approve(w, cancel)).rejects.toThrow();
    expect((await store(w).getProposal(cancel.id))?.state).toBe("open");
    // A crash after the compare-and-set leaves it approving: the reconciler releases it later.
    await store(w).transitionProposal(cancel.id, "open", "approving", w.clock.now);
    w.advance(11 * 60_000);
    await reconcileNow(w);
    expect((await store(w).getProposal(cancel.id))?.state).toBe("open");
  });
});
