// SPDX-License-Identifier: MIT
/**
 * The situation table (docs/paypal/SPEC.md §10.2): a pure, deterministic function of what PayPal's GET (P5) and the
 * chain say about one twin. It decides the situation S0–S9, the fence (the exact actions allowed now, with the exact
 * values they will use), whether the till may light and from which rail, and the alert of S0 and S4. It has no clock of
 * its own (`now` is an input), no randomness and no I/O, so the same reads always give the same answer whatever the
 * order or the number of webhooks that triggered them (test/reconciler/situation.test.ts, property-tested).
 *
 * | Situation | PayPal (class of §7.4)                          | Chain                     | Fence                                      |
 * |-----------|-------------------------------------------------|---------------------------|--------------------------------------------|
 * | S0        | unreadable, unknown, SCHEDULED, DRAFT, a mismatch | unreadable, not deployed, a mismatch | nothing (hands off), alert        |
 * | S1        | open                                            | payable                   | share_reminder_text; send_reminder if due  |
 * | S2        | paid (≥ 1 non-echo), or marked paid by the merchant | payable               | cancel_paylink (tap + signature)           |
 * | S3        | open                                            | paid, verified            | record_external_payment (automatic), or cancel_paypal once recorded, or a tap record after an Undo; after a record vanished from PayPal (`record-missing`, alert): a tap record or cancel_paypal |
 * | S4        | paid (≥ 1 non-echo transaction)                 | paid                      | nothing, alert `paid-twice`                |
 * | S5        | in flight (PAYMENT_PENDING, PARTIALLY_PAID), or open while a chain payment confirms | any | nothing (wait)        |
 * | S6        | cancelled                                       | payable                   | cancel_paylink (tap + signature)           |
 * | S7        | open                                            | cancelled or expired      | cancel_paypal (tap)                        |
 * | S8        | closed: echo-only paid; paid and chain closed; marked paid and chain paid; cancelled and chain closed or paid | consistent | nothing |
 * | S9        | refunded                                        | any                       | nothing (information)                      |
 *
 * Read failures, an unknown status and every mismatch (reference ≠ K, currency ≠ USD, amount ≠ the signed amount, paid
 * amount ≠ amount, a chain payment at another amount or token) are S0: the reconciler does nothing it cannot justify.
 *
 * Owner: reconciler workstream.
 */
import { PROPOSAL_ACTOR } from "@paylink/api-contract";
import type { ProposalKind, Rail } from "@paylink/api-contract";
import type { DeskAlertCode, DeskReasonCode } from "@paylink/api-contract";
import { isEcho } from "./echo.ts";
import { isDue, sameMoney, utcDay } from "./money.ts";
import type { AllowedAction, ChainPayment, ReconcileInput, ReconcileResult, TwinFacts } from "./types.ts";

type ReasonCode = DeskReasonCode;
type AlertCode = DeskAlertCode;

/** At most one PayPal reminder (P9) per invoice per 24 hours (docs/paypal/SPEC.md §7.1 P9, E). */
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A reminder may be proposed 3 days after the twin was shared, even before its due date (§10.2 S1, E). */
export const REMINDER_AFTER_SENT_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * A chain payment whose `Paid` log is not verified yet (not found, or not 2 blocks deep) reads S5 "confirming" for this
 * long after `stateOf(K).lastPaidAt`, then S0 (E).
 */
export const CONFIRMING_WINDOW_S = 15 * 60;

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function action(kind: ProposalKind, args: Readonly<Record<string, string>>, reasonCode: ReasonCode, actor = PROPOSAL_ACTOR[kind]): AllowedAction {
  return { kind, args, reasonCode, actor };
}

/** The exact values each kind binds (what the payee sees and approves, and all the executor uses). */
export const fenceArgs = {
  sendReminder: (t: TwinFacts): Record<string, string> => ({
    invoice: t.invoiceNumber,
    paypalId: t.paypalId,
    amount: t.amountUsd,
    currency: "USD",
    // A new round each time: an approved reminder never approves the next one.
    round: t.lastReminderAt === null ? "first" : new Date(t.lastReminderAt).toISOString(),
  }),
  shareReminderText: (t: TwinFacts): Record<string, string> => ({ invoice: t.invoiceNumber, amount: t.amountUsd, currency: "USD", due: t.dueDate ?? "none" }),
  cancelPayLink: (t: TwinFacts): Record<string, string> => ({ invoice: t.invoiceNumber, key: t.key, chainId: String(t.chainId), amount: t.amountUsd, currency: "USD", rail: t.rail }),
  cancelPayPal: (t: TwinFacts): Record<string, string> => ({ invoice: t.invoiceNumber, paypalId: t.paypalId, amount: t.amountUsd, currency: "USD" }),
  recordExternalPayment: (t: TwinFacts, p: ChainPayment): Record<string, string> => ({
    invoice: t.invoiceNumber,
    paypalId: t.paypalId,
    amount: t.amountUsd,
    currency: "USD",
    chainId: String(t.chainId),
    rail: p.rail,
    txHash: p.txHash.toLowerCase(),
    paymentDate: utcDay(p.timestamp * 1000),
  }),
};

interface Outcome {
  readonly situation: ReconcileResult["situation"];
  readonly reasonCode: ReasonCode;
  readonly allowed?: readonly AllowedAction[];
  readonly alert?: AlertCode;
  readonly paidVia?: Rail | null;
}

/** The situation of one twin. Pure: same input, same output. */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { twin, paypal, chain } = input;
  // A payment counts only while the chain itself says the key is paid (stateOf is the truth; a log is its evidence).
  const listed = chain.state === "paid" ? chain.payments : [];
  const verified = listed.filter((p) => p.amount === twin.amountBase && sameAddress(p.token, twin.token));
  const transactions = paypal.read === "ok" ? paypal.transactions : [];
  const echoes = transactions.filter((tx) => isEcho(tx, twin, verified)).map((tx) => tx.paymentId ?? "");
  const nonEcho = transactions.filter((tx) => !isEcho(tx, twin, verified));
  const outcome = decide(input, verified, listed.length, nonEcho.length);
  const paypalOpen = paypal.read === "ok" && (paypal.statusClass === "open" || paypal.statusClass === "in-flight" || paypal.statusClass === "open-not-sent");
  return {
    situation: outcome.situation,
    allowed: outcome.allowed ?? [],
    echoes: echoes.filter((id) => id !== ""),
    alert: outcome.alert ?? null,
    paidVia: outcome.paidVia ?? null,
    reasonCode: outcome.reasonCode,
    paypalOpen,
    chainOpen: chain.state === "payable",
  };
}

const handsOff = (alert: AlertCode): Outcome => ({ situation: "S0", reasonCode: "hands-off", alert });

function decide(input: ReconcileInput, verified: readonly ChainPayment[], listedCount: number, nonEchoCount: number): Outcome {
  const { twin, paypal, chain, now } = input;
  // Any read failure: hands off (§10.2 S0).
  if (paypal.read === "failed") {
    return handsOff("paypal-unreadable");
  }
  if (chain.state === "unreadable") {
    return handsOff("chain-unreadable");
  }
  if (chain.state === "not-deployed") {
    // A twin exists only for a link signed against a recorded deployment: a missing one is a configuration fault.
    return handsOff("chain-not-deployed");
  }
  // The twin must be the invoice PayLink made: reference, currency and amount (§7.2, §10.2 S0).
  if (paypal.reference?.toLowerCase() !== twin.key.toLowerCase()) {
    return handsOff("reference-mismatch");
  }
  if (paypal.currency !== "USD") {
    return handsOff("currency-mismatch");
  }
  if (!sameMoney(paypal.amount, twin.amountUsd)) {
    return handsOff("amount-mismatch");
  }
  // A chain payment for K at another amount or token cannot happen for a fixed one-payment invoice: never guess.
  if (verified.length !== listedCount) {
    return handsOff("chain-payment-mismatch");
  }
  const chainPaid = chain.state === "paid";
  const payment = verified[0] ?? null;
  const chainClosed = chain.state === "cancelled" || chain.state === "expired";
  const confirming = chainPaid && payment === null && chain.paidAt !== null && (chain.chainTime ?? Math.floor(now / 1000)) - chain.paidAt <= CONFIRMING_WINDOW_S;
  const unverifiedPaid = (): Outcome => (confirming ? { situation: "S5", reasonCode: "chain-payment-confirming" } : handsOff("chain-paid-unverified"));

  switch (paypal.statusClass) {
    case "unknown":
      return handsOff("paypal-status-unknown");
    case "open-not-sent":
      return handsOff("paypal-scheduled");
    case "not-sent":
      return handsOff("paypal-draft");
    case "refunded":
      // Hands off, information only: refunds are the owner's, in the PayPal dashboard (§2.2).
      return { situation: "S9", reasonCode: "refunded", paidVia: payment === null ? null : payment.rail };
    case "in-flight":
      return { situation: "S5", reasonCode: "payment-in-flight" };
    case "cancelled":
      if (chain.state === "payable") {
        return { situation: "S6", reasonCode: "paypal-cancelled", allowed: [action("cancel_paylink", fenceArgs.cancelPayLink(twin), "paypal-cancelled")] };
      }
      if (chainClosed) {
        return { situation: "S8", reasonCode: "closed-cancelled" };
      }
      // Paid on chain after the PayPal side was cancelled: one payment, the other rail closed.
      return payment === null ? unverifiedPaid() : { situation: "S8", reasonCode: "closed-paid-chain", paidVia: payment.rail };
    case "paid":
    case "paid-outside": {
      if (!sameMoney(paypal.paidAmount, twin.amountUsd)) {
        return handsOff("paid-amount-mismatch");
      }
      if (paypal.statusClass === "paid" && paypal.transactions.length === 0) {
        return handsOff("paid-without-transactions");
      }
      // Marked paid by the merchant without any payment record ("marked paid by you"): a statement, not money.
      const markedOnly = paypal.statusClass === "paid-outside" && paypal.transactions.length === 0;
      const reason: ReasonCode = paypal.statusClass === "paid" ? "paid-on-paypal" : "marked-paid-by-you";
      if (nonEchoCount === 0 && !markedOnly) {
        // Echo only: PayLink's own record of a verified chain payment (an echo needs one).
        return { situation: "S8", reasonCode: "closed-paid-chain", paidVia: payment === null ? null : payment.rail };
      }
      if (markedOnly && chainPaid) {
        // The chain was paid and the merchant marked the twin paid: one payment, both books closed.
        return payment === null ? unverifiedPaid() : { situation: "S8", reasonCode: "closed-paid-chain", paidVia: payment.rail };
      }
      if (chainPaid) {
        return { situation: "S4", reasonCode: "paid-twice", alert: "paid-twice", paidVia: "PAYPAL" };
      }
      // The till lights from PayPal only for a payment PayPal reports, not for the merchant's own mark (U3).
      const paidVia: Rail | null = markedOnly ? null : "PAYPAL";
      if (chain.state === "payable") {
        return { situation: "S2", reasonCode: reason, paidVia, allowed: [action("cancel_paylink", fenceArgs.cancelPayLink(twin), reason)] };
      }
      return { situation: "S8", reasonCode: "closed-paid-paypal", paidVia };
    }
    case "open": {
      if (nonEchoCount > 0) {
        // An open invoice with a payment PayLink did not make (partial payments are off on twins): never guess.
        return handsOff("paypal-open-with-payments");
      }
      if (chain.state === "payable") {
        return { situation: "S1", reasonCode: "open", allowed: openActions(input) };
      }
      if (chainClosed) {
        const reason: ReasonCode = chain.state === "cancelled" ? "chain-cancelled" : "chain-expired";
        return { situation: "S7", reasonCode: reason, allowed: [action("cancel_paypal", fenceArgs.cancelPayPal(twin), reason)] };
      }
      if (payment === null) {
        return unverifiedPaid();
      }
      const echoed = paypal.transactions.length > 0; // every transaction is an echo here (nonEchoCount is 0)
      if (echoed) {
        // Recorded, yet PayPal still shows the invoice open (K4): propose closing PayPal's rail.
        return { situation: "S3", reasonCode: "paypal-still-open-after-record", paidVia: payment.rail, allowed: [action("cancel_paypal", fenceArgs.cancelPayPal(twin), "paypal-still-open-after-record")] };
      }
      if (twin.recordMissing) {
        // A record PayLink made is gone from PayPal without an Undo here (a lost P7 answer, or the dashboard): the
        // invoice is payable on PayPal again while the chain is paid. Say so, and offer to close the gap by a tap.
        return {
          situation: "S3",
          reasonCode: "record-missing",
          alert: "record-missing",
          paidVia: payment.rail,
          allowed: [action("record_external_payment", fenceArgs.recordExternalPayment(twin, payment), "record-missing", "tap"), action("cancel_paypal", fenceArgs.cancelPayPal(twin), "record-missing")],
        };
      }
      if (twin.autoRecordUndone) {
        return { situation: "S3", reasonCode: "recorded-then-undone", paidVia: payment.rail, allowed: [action("record_external_payment", fenceArgs.recordExternalPayment(twin, payment), "recorded-then-undone", "tap")] };
      }
      return { situation: "S3", reasonCode: "paid-on-chain", paidVia: payment.rail, allowed: [action("record_external_payment", fenceArgs.recordExternalPayment(twin, payment), "paid-on-chain", "automatic")] };
    }
  }
}

/** S1: sharing the reminder text is always allowed; PayPal's own reminder only when due, emailed and not sent today. */
function openActions(input: ReconcileInput): AllowedAction[] {
  const { twin, paypal, now } = input;
  const allowed = [action("share_reminder_text", fenceArgs.shareReminderText(twin), "share-reminder")];
  const emailed = paypal.read === "ok" && paypal.hasRecipientEmail;
  const rested = twin.lastReminderAt === null || now - twin.lastReminderAt >= REMINDER_INTERVAL_MS;
  const due = isDue(twin.dueDate, now);
  const waited = twin.sentAt !== null && now - twin.sentAt >= REMINDER_AFTER_SENT_MS;
  if (emailed && rested && (due || waited)) {
    allowed.push(action("send_reminder", fenceArgs.sendReminder(twin), due ? "reminder-due" : "reminder-after-3-days"));
  }
  return allowed;
}

/** Canonical form of exact values: keys sorted (the order a payee reads them in does not change what they mean). */
export function canonicalArgs(args: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]));
}

/**
 * The executor's admission rule: an action is admitted iff the fence holds the same kind with exactly the same values.
 * Automatic actions are admitted only for deterministic code (`automatic: true`), never for an approval.
 */
export function admits(fence: readonly AllowedAction[], kind: string, args: Readonly<Record<string, string>>, options: { readonly automatic?: boolean } = {}): AllowedAction | null {
  const wanted = canonicalArgs(args);
  const found = fence.find((a) => a.kind === kind && canonicalArgs(a.args) === wanted);
  if (found === undefined) {
    return null;
  }
  return (found.actor === "automatic") === (options.automatic === true) ? found : null;
}
