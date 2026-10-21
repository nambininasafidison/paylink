// SPDX-License-Identifier: MIT
/**
 * The stores' contract (src/store/types.ts), on the in-memory implementation, which runs the same code as the Durable
 * Objects (src/store/kv.ts): copies in and out, compare-and-set, quotas and ceilings, idempotency of webhook events and
 * session nonces, the twin index, the cron's due order, advisory locks, audit order, and retention (docs/paypal/SPEC.md
 * §11).
 */
import { describe, expect, it } from "vitest";
import { GlobalStoreCore, memoryKv, PayeeStoreCore, RETENTION } from "../../src/store/kv.ts";
import { createMemoryStores, STORE_METHOD_LISTS_COMPLETE } from "../../src/store/memory.ts";
import { chargeNeurons, chargeQuota, GLOBAL_DAILY } from "../../src/store/quotas.ts";
import type { ProposalRecord, TwinRecord } from "../../src/store/types.ts";
import { T0, testServices } from "../helpers.ts";
import { DAY, HOUR, KEY, OTHER_KEY, PAYEE, PAYER, TWIN, USDC } from "../reconciler/fixtures.ts";

export const TWIN_RECORD: TwinRecord = {
  key: KEY,
  payee: PAYEE,
  chainId: 11155111,
  paypalId: TWIN.paypalId,
  invoiceNumber: TWIN.invoiceNumber,
  amountBase: "120000000",
  token: USDC,
  rail: "USDC",
  validUntil: Math.floor(T0 / 1000) + 7 * 86_400,
  recipientViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-TEST",
  hasRecipientEmail: true,
  dueDate: "2026-11-06",
  sentAt: T0,
  currency: "USD",
  lastStatus: "SHARED",
  paidAmount: null,
  recordedPaymentIds: [],
  lastChainState: "payable",
  chainPayment: null,
  situation: "S1",
  fence: [],
  createdAt: T0,
  checkedAt: T0,
  lastReminderAt: null,
  closedAt: null,
};

const proposal = (id: string, createdAt = T0, state: ProposalRecord["state"] = "open"): ProposalRecord => ({
  id,
  kind: "cancel_paypal",
  key: KEY,
  args: { invoice: TWIN.invoiceNumber },
  hash: `0x${"00".repeat(32)}`,
  reasonCode: "chain-expired",
  message: null,
  origin: "reconciler",
  state,
  createdAt,
  updatedAt: createdAt,
  expiresAt: createdAt + 7 * DAY,
});

describe("memory key-value", () => {
  it("lists in key order with prefix, range, limit and reverse, and copies values in and out", () => {
    const kv = memoryKv();
    for (const k of ["b:2", "a:1", "b:1", "b:3", "c:1"]) {
      kv.put(k, { k });
    }
    expect([...kv.list({ prefix: "b:" })].map(([k]) => k)).toEqual(["b:1", "b:2", "b:3"]);
    expect([...kv.list({ prefix: "b:", end: "b:3" })].map(([k]) => k)).toEqual(["b:1", "b:2"]);
    expect([...kv.list({ prefix: "b:", reverse: true, limit: 2 })].map(([k]) => k)).toEqual(["b:3", "b:2"]);
    const value = { n: 1 };
    kv.put("x", value);
    value.n = 2;
    const read = kv.get<{ n: number }>("x");
    expect(read).toEqual({ n: 1 });
    if (read !== undefined) {
      read.n = 3;
    }
    expect(kv.get("x")).toEqual({ n: 1 });
    expect(kv.delete("x")).toBe(true);
    expect(kv.delete("x")).toBe(false);
  });

  it("lists every store method for the Durable Object wrappers", () => {
    expect(STORE_METHOD_LISTS_COMPLETE).toEqual({ payee: true, global: true });
  });
});

describe("payee store", () => {
  it("keeps one space per payee address, whatever its case", async () => {
    const stores = createMemoryStores();
    await stores.payee(PAYEE).putTwin(TWIN_RECORD);
    expect(await stores.payee(PAYEE.toLowerCase() as `0x${string}`).getTwin(KEY)).toEqual(TWIN_RECORD);
    expect(await stores.payee(PAYER).getTwin(KEY)).toBeNull();
    expect(stores.payee(PAYEE).payee).toBe(PAYEE);
  });

  it("lists twins in creation order, open ones apart", async () => {
    const store = createMemoryStores().payee(PAYEE);
    await store.putTwin({ ...TWIN_RECORD, key: OTHER_KEY, createdAt: T0 - HOUR, situation: "S8", closedAt: T0 });
    await store.putTwin(TWIN_RECORD);
    expect((await store.listTwins()).map((t) => t.key)).toEqual([OTHER_KEY, KEY]);
    expect((await store.listTwins({ open: true })).map((t) => t.key)).toEqual([KEY]);
    expect(await store.listTwins({ limit: 1 })).toHaveLength(1);
  });

  it("moves a proposal's state only from the expected state (compare-and-set), once", async () => {
    const store = createMemoryStores().payee(PAYEE);
    await store.putProposal(proposal("p_1"));
    const [first, second] = await Promise.all([store.transitionProposal("p_1", "open", "approving", T0 + 1), store.transitionProposal("p_1", "open", "approving", T0 + 2)]);
    expect([first, second].sort()).toEqual([false, true]);
    expect(await store.getProposal("p_1")).toMatchObject({ state: "approving", updatedAt: T0 + 1 });
    expect(await store.transitionProposal("p_missing", "open", "done")).toBe(false);
    await store.putProposal(proposal("p_2", T0 + 5));
    expect((await store.listProposals()).map((p) => p.id)).toEqual(["p_2", "p_1"]);
    expect((await store.listProposals({ states: ["open"] })).map((p) => p.id)).toEqual(["p_2"]);
    expect(await store.listProposals({ key: OTHER_KEY })).toEqual([]);
    await expect(store.getProposal("bad id")).rejects.toThrow(RangeError);
  });

  it("counts quotas per day and kind, refusing at the limit without counting", async () => {
    const store = createMemoryStores().payee(PAYEE);
    expect(await store.useQuota("2026-10-21", "twins", 2)).toEqual({ allowed: true, used: 1, limit: 2 });
    expect(await store.useQuota("2026-10-21", "twins", 2)).toEqual({ allowed: true, used: 2, limit: 2 });
    expect(await store.useQuota("2026-10-21", "twins", 2)).toEqual({ allowed: false, used: 2, limit: 2 });
    expect(await store.useQuota("2026-10-21", "aiCalls", 2)).toMatchObject({ allowed: true, used: 1 });
    expect(await store.useQuota("2026-10-22", "twins", 2)).toMatchObject({ allowed: true, used: 1 });
  });

  it("holds an advisory lock per twin until it expires or its holder releases it", async () => {
    const store = createMemoryStores().payee(PAYEE);
    expect(await store.lock(KEY, "cron", T0, 30_000)).toBe(true);
    expect(await store.lock(KEY, "webhook", T0 + 1, 30_000)).toBe(false);
    expect(await store.lock(KEY, "cron", T0 + 2, 30_000)).toBe(true);
    expect(await store.lock(OTHER_KEY, "webhook", T0, 30_000)).toBe(true);
    await store.unlock(KEY, "webhook");
    expect(await store.lock(KEY, "webhook", T0 + 3, 30_000)).toBe(false);
    await store.unlock(KEY, "cron");
    expect(await store.lock(KEY, "webhook", T0 + 4, 30_000)).toBe(true);
    expect(await store.lock(KEY, "cron", T0 + 4 + 30_000, 30_000)).toBe(true);
  });

  it("numbers audit lines and lists the latest first", async () => {
    const store = createMemoryStores().payee(PAYEE);
    for (let i = 0; i < 3; i += 1) {
      await store.audit({ at: T0 + i, action: "twin.situation", key: KEY, actor: "system", result: "ok", code: `S${String(i)}` });
    }
    expect((await store.listAudit(2)).map((l) => [l.seq, l.code])).toEqual([
      [3, "S2"],
      [2, "S1"],
    ]);
  });

  it("keeps an alert's first time while the same alert persists", async () => {
    const store = createMemoryStores().payee(PAYEE);
    await store.putAlert({ key: KEY, invoiceNumber: "PL", situation: "S0", code: "chain-unreadable", raisedAt: T0 });
    await store.putAlert({ key: KEY, invoiceNumber: "PL", situation: "S0", code: "chain-unreadable", raisedAt: T0 + HOUR });
    expect(await store.listAlerts()).toEqual([expect.objectContaining({ raisedAt: T0 })]);
    await store.putAlert({ key: KEY, invoiceNumber: "PL", situation: "S4", code: "paid-twice", raisedAt: T0 + 2 * HOUR });
    expect(await store.listAlerts()).toEqual([expect.objectContaining({ code: "paid-twice", raisedAt: T0 + 2 * HOUR })]);
    await store.clearAlert(KEY);
    expect(await store.listAlerts()).toEqual([]);
  });

  it("purges what is past retention: closed twins and their records after 90 days, proposals after 30, audit after 90, old quotas and locks", () => {
    const kv = memoryKv();
    const store = new PayeeStoreCore(kv);
    store.putTwin({ ...TWIN_RECORD, situation: "S8", closedAt: T0 });
    store.putTwin({ ...TWIN_RECORD, key: OTHER_KEY, situation: "S1", closedAt: null });
    store.putProposal(proposal("p_old", T0));
    store.putAutoRecord({ key: KEY, paymentId: "PAY1", rail: "USDC", txHash: `0x${"12".repeat(32)}`, recordedAt: T0, undoUntil: T0 + DAY, undone: false });
    store.putAlert({ key: KEY, invoiceNumber: null, situation: "S0", code: "chain-unreadable", raisedAt: T0 });
    store.audit({ at: T0, action: "a", key: null, actor: "system", result: "ok", code: null });
    store.useQuota("2026-10-21", "twins", 5);
    store.lock(KEY, "x", T0, 1000);
    expect(store.purge(T0 + 29 * DAY).removed).toBe(2); // the quota of an old day and the expired lock
    expect(store.getProposal("p_old")).not.toBeNull();
    expect(store.purge(T0 + 30 * DAY).removed).toBe(1);
    expect(store.getProposal("p_old")).toBeNull();
    expect(store.purge(T0 + RETENTION.closedTwinMs).removed).toBe(4); // twin, its alert, its auto-record, the audit line
    expect(store.listTwins().map((t) => t.key)).toEqual([OTHER_KEY]);
    expect(store.listAutoRecords()).toEqual([]);
    expect(store.listAudit(10)).toEqual([]);
  });
});

describe("global store", () => {
  it("caches the PayPal token until it expires", async () => {
    const global = createMemoryStores().global();
    expect(await global.getToken(T0)).toBeNull();
    await global.putToken({ token: "access", expiresAtMs: T0 + HOUR });
    expect(await global.getToken(T0)).toEqual({ token: "access", expiresAtMs: T0 + HOUR });
    expect(await global.getToken(T0 + HOUR)).toBeNull();
  });

  it("enforces the daily AI ceiling and global quotas without overspending", async () => {
    const global = createMemoryStores().global();
    expect(await global.spendAiBudget("2026-10-21", 9_990, 10_000)).toEqual({ allowed: true, used: 9_990, limit: 10_000 });
    expect(await global.spendAiBudget("2026-10-21", 11, 10_000)).toEqual({ allowed: false, used: 9_990, limit: 10_000 });
    expect(await global.spendAiBudget("2026-10-21", 10, 10_000)).toMatchObject({ allowed: true, used: 10_000 });
    await expect(global.spendAiBudget("2026-10-21", -1, 10_000)).rejects.toThrow(RangeError);
    await expect(global.spendAiBudget("2026-10-21", Number.NaN, 10_000)).rejects.toThrow(RangeError);
    expect(await global.useQuota("2026-10-21", "sessions", 1)).toMatchObject({ allowed: true });
    expect(await global.useQuota("2026-10-21", "sessions", 1)).toMatchObject({ allowed: false });
  });

  it("answers a webhook event id and a session nonce `new` once, then `seen`", async () => {
    const global = createMemoryStores().global();
    expect(await global.markWebhookEvent("WH-1", T0)).toBe("new");
    expect(await global.markWebhookEvent("WH-1", T0 + 1)).toBe("seen");
    expect(await global.markNonce("session", "0x01", T0 + HOUR, T0)).toBe("new");
    expect(await global.markNonce("session", "0x01", T0 + HOUR, T0)).toBe("seen");
    await expect(global.markWebhookEvent("a".repeat(129), T0)).rejects.toThrow(RangeError);
    await expect(global.markWebhookEvent("has space", T0)).rejects.toThrow(RangeError);
  });

  it("indexes twins by PayPal id and by key", async () => {
    const global = createMemoryStores().global();
    await global.indexTwin({ paypalId: "INV2-1", payee: PAYEE, key: KEY }, T0);
    expect(await global.findTwinByPayPalId("INV2-1")).toEqual({ paypalId: "INV2-1", payee: PAYEE, key: KEY });
    expect(await global.findTwinByKey(KEY.toUpperCase().replace("0X", "0x") as `0x${string}`)).toEqual({ paypalId: "INV2-1", payee: PAYEE, key: KEY });
    expect(await global.findTwinByPayPalId("INV2-2")).toBeNull();
  });

  it("answers due checks oldest first, at most the limit, one plan per twin", async () => {
    const global = createMemoryStores().global();
    await global.scheduleCheck({ payee: PAYEE, key: KEY, dueAt: T0 + 60_000 });
    await global.scheduleCheck({ payee: PAYER, key: KEY, dueAt: T0 - 60_000 });
    await global.scheduleCheck({ payee: PAYEE, key: OTHER_KEY, dueAt: T0 });
    expect((await global.dueChecks(T0, 20)).map((c) => [c.payee, c.key])).toEqual([
      [PAYER, KEY],
      [PAYEE, OTHER_KEY],
    ]);
    // Re-planning replaces the earlier plan.
    await global.scheduleCheck({ payee: PAYER, key: KEY, dueAt: T0 + 120_000 });
    expect((await global.dueChecks(T0, 20)).map((c) => c.payee)).toEqual([PAYEE]);
    expect(await global.dueChecks(T0 + 200_000, 2)).toHaveLength(2);
    await global.unscheduleCheck(PAYEE, KEY);
    expect((await global.dueChecks(T0 + 200_000, 20)).map((c) => [c.payee, c.key])).toEqual([
      [PAYEE, OTHER_KEY],
      [PAYER, KEY],
    ]);
  });

  it("names the payees to purge once a day", async () => {
    const global = createMemoryStores().global();
    await global.notePayee(PAYEE, T0);
    await global.notePayee(PAYER, T0);
    expect(await global.payeesToPurge(T0, 1)).toHaveLength(1);
    await global.markPayeePurged(PAYEE, T0);
    expect(await global.payeesToPurge(T0 + HOUR, 10)).toEqual([PAYER]);
    expect(await global.payeesToPurge(T0 + DAY, 10)).toEqual([PAYER, PAYEE]); // in address order
  });

  it("keeps the health facts and purges webhook ids, nonces, budgets, quotas, index entries and the expired token", () => {
    const kv = memoryKv();
    const global = new GlobalStoreCore(kv);
    global.noteHealth("cron-run", T0);
    global.noteHealth("paypal-backoff", T0, 60_000);
    expect(global.readHealth()).toEqual({ "cron-run": { at: T0, value: null }, "paypal-backoff": { at: T0, value: 60_000 } });
    global.markWebhookEvent("WH-1", T0);
    global.markNonce("session", "0x01", T0 + HOUR, T0);
    global.spendAiBudget("2026-10-21", 5, 10);
    global.useQuota("2026-10-21", "twins", 10);
    global.indexTwin({ paypalId: "INV2-1", payee: PAYEE, key: KEY }, T0);
    global.putToken({ token: "t", expiresAtMs: T0 + HOUR });
    expect(global.purge(T0 + HOUR).removed).toBe(2); // the nonce and the token
    expect(global.purge(T0 + 7 * DAY).removed).toBe(2); // the webhook id and the quota
    expect(global.purge(T0 + 30 * DAY).removed).toBe(1); // the budget
    expect(global.purge(T0 + RETENTION.twinIndexMs).removed).toBe(2); // both index entries
    expect(global.readHealth()["cron-run"]).toEqual({ at: T0, value: null });
  });
});

describe("quotas (§9.4, T-60)", () => {
  it("count the payee's daily twins, then refuse with Retry-After at the next UTC midnight", async () => {
    const services = testServices();
    for (let i = 0; i < services.runtime.config.quotas.twinsPerDay; i += 1) {
      await chargeQuota(services, PAYEE, "twins", T0);
    }
    await expect(chargeQuota(services, PAYEE, "twins", T0)).rejects.toMatchObject({ problem: { code: "quota-exhausted", rule: "E_QUOTA_PAYEE", retryAfter: 12 * 3600 } });
    await expect(chargeQuota(services, PAYER, "twins", T0)).resolves.toBeUndefined();
    await expect(chargeQuota(services, PAYEE, "twins", T0 + 12 * HOUR)).resolves.toBeUndefined();
  });

  it("stop the whole deployment at its own daily limit", async () => {
    const services = testServices();
    const global = services.stores.global();
    for (let i = 0; i < GLOBAL_DAILY.checks; i += 1) {
      await global.useQuota("2026-10-21", "checks", GLOBAL_DAILY.checks);
    }
    await expect(chargeQuota(services, PAYEE, "checks", T0)).rejects.toMatchObject({ problem: { rule: "E_QUOTA_GLOBAL" } });
  });

  it("charge assistant neurons against the configured daily ceiling", async () => {
    const services = testServices();
    expect(await chargeNeurons(services, services.runtime.config.ai.dailyNeuronBudget, T0)).toMatchObject({ allowed: true });
    expect(await chargeNeurons(services, 1, T0)).toMatchObject({ allowed: false });
  });
});
