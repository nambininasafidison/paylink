// SPDX-License-Identifier: MIT
/**
 * One scripted session of store calls, run twice: on the in-memory stores in Node and on the Durable Objects in workerd
 * (test/store/workerd.test.ts). Both must answer exactly the same, which proves the Durable Object wrappers (RPC,
 * `ctx.storage.kv`, `transactionSync`) run the same logic as the stores the rest of the suite tests. Plain data only, so
 * the answers cross RPC and JSON unchanged.
 */
import type { StoreFactory, TwinRecord } from "../../src/store/types.ts";

const T = 1_792_584_000_000;
const PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const KEY = `0x${"ab".repeat(32)}` as const;
const OTHER = `0x${"cd".repeat(32)}` as const;

const TWIN: TwinRecord = {
  key: KEY,
  payee: PAYEE,
  chainId: 11155111,
  paypalId: "INV2-TEST",
  invoiceNumber: "PL-11155111-abababababab",
  amountBase: "120000000",
  token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  rail: "USDC",
  validUntil: 1_793_188_800,
  recipientViewUrl: null,
  hasRecipientEmail: true,
  dueDate: "2026-11-06",
  sentAt: T,
  currency: "USD",
  lastStatus: "SHARED",
  paidAmount: null,
  recordedPaymentIds: [],
  lastChainState: "payable",
  chainPayment: null,
  situation: "S1",
  fence: [{ kind: "share_reminder_text", args: { invoice: "PL-11155111-abababababab" }, reasonCode: "share-reminder", actor: "tap" }],
  createdAt: T,
  checkedAt: T,
  lastReminderAt: null,
  closedAt: null,
};

export async function storeScript(stores: StoreFactory): Promise<unknown[]> {
  const out: unknown[] = [];
  const payee = stores.payee(PAYEE);
  const global = stores.global();
  /** Awaits one store call and keeps its answer (`"void"` for none). */
  const note = async (call: Promise<unknown>): Promise<void> => {
    const value = await call;
    out.push(value === undefined ? "void" : value);
  };
  await note(payee.getTwin(KEY));
  await note(payee.putTwin(TWIN));
  await note(payee.putTwin({ ...TWIN, key: OTHER, createdAt: T - 1, situation: "S8", closedAt: T }));
  await note(payee.getTwin(KEY));
  await note(payee.listTwins().then((ts) => ts.map((t) => t.key)));
  await note(payee.listTwins({ open: true }).then((ts) => ts.map((t) => t.key)));
  const proposal = { id: "p_0123456789abcdef01234567", kind: "share_reminder_text" as const, key: KEY, args: { invoice: "PL" }, hash: `0x${"00".repeat(32)}` as const, reasonCode: "share-reminder", message: null, origin: "reconciler" as const, state: "open" as const, createdAt: T, updatedAt: T, expiresAt: T + 1000 };
  await note(payee.putProposal(proposal));
  await note(Promise.all([payee.transitionProposal(proposal.id, "open", "approving", T + 1), payee.transitionProposal(proposal.id, "open", "approving", T + 2)]));
  await note(payee.getProposal(proposal.id));
  await note(payee.listProposals({ states: ["approving"], key: KEY }));
  await note(payee.putAutoRecord({ key: KEY, paymentId: "EXT1", rail: "USDC", txHash: `0x${"12".repeat(32)}`, recordedAt: T, undoUntil: T + 86_400_000, undone: false }));
  await note(payee.getAutoRecord("EXT1"));
  await note(payee.listAutoRecords({ key: KEY }));
  await note(payee.putAlert({ key: KEY, invoiceNumber: "PL", situation: "S0", code: "chain-unreadable", raisedAt: T }));
  await note(payee.listAlerts());
  await note(payee.clearAlert(KEY));
  await note(payee.audit({ at: T, action: "twin.register", key: KEY, actor: "system", result: "ok", code: null }));
  await note(payee.audit({ at: T + 1, action: "twin.situation", key: KEY, actor: "system", result: "ok", code: "S0->S1" }));
  await note(payee.listAudit(5));
  await note(payee.useQuota("2026-10-21", "twins", 1));
  await note(payee.useQuota("2026-10-21", "twins", 1));
  await note(Promise.all([payee.lock(KEY, "a", T, 30_000), payee.lock(KEY, "b", T, 30_000)]));
  await note(payee.unlock(KEY, "a"));
  await note(payee.lock(KEY, "b", T + 1, 30_000));
  await note(payee.purge(T + 91 * 86_400_000));
  await note(payee.listTwins().then((ts) => ts.map((t) => t.key)));

  await note(global.getToken(T));
  await note(global.putToken({ token: "access-token-for-the-test", expiresAtMs: T + 3_600_000 }));
  await note(global.getToken(T));
  await note(global.spendAiBudget("2026-10-21", 9_000, 10_000));
  await note(global.spendAiBudget("2026-10-21", 2_000, 10_000));
  await note(global.useQuota("2026-10-21", "sessions", 1));
  await note(global.useQuota("2026-10-21", "sessions", 1));
  await note(Promise.all([global.markWebhookEvent("WH-1", T), global.markWebhookEvent("WH-1", T)]));
  await note(global.markNonce("session", "0x01", T + 1000, T));
  await note(global.markNonce("session", "0x01", T + 1000, T));
  await note(global.indexTwin({ paypalId: "INV2-TEST", payee: PAYEE, key: KEY }, T));
  await note(global.findTwinByPayPalId("INV2-TEST"));
  await note(global.findTwinByKey(KEY));
  await note(global.scheduleCheck({ payee: PAYEE, key: KEY, dueAt: T + 60_000 }));
  await note(global.scheduleCheck({ payee: PAYEE, key: OTHER, dueAt: T }));
  await note(global.dueChecks(T, 20));
  await note(global.scheduleCheck({ payee: PAYEE, key: OTHER, dueAt: T + 120_000 }));
  await note(global.dueChecks(T + 200_000, 1));
  await note(global.unscheduleCheck(PAYEE, KEY));
  await note(global.dueChecks(T + 200_000, 20));
  await note(global.notePayee(PAYEE, T));
  await note(global.payeesToPurge(T, 10));
  await note(global.markPayeePurged(PAYEE, T));
  await note(global.payeesToPurge(T + 1, 10));
  await note(global.noteHealth("cron-run", T));
  await note(global.noteHealth("paypal-backoff", T, 60_000));
  await note(global.readHealth());
  await note(global.purge(T + 8 * 86_400_000));
  return out;
}
