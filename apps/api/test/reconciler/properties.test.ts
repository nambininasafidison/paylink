// SPDX-License-Identifier: MIT
/**
 * Properties of the situation table and its fence (docs/paypal/SPEC.md §10.2, L1), over random reads with fast-check:
 *
 * 1. Pure: the same reads give the same answer.
 * 2. No situation but S1 (nobody paid), S5 (wait) or S0 (hands off) leaves both rails able to take money.
 * 3. Once a rail has taken money, the other is closed, or the fence closes it, or the reconciler waits (S5) or hands off
 *    with an alert (S0); S4 (paid twice) always alarms.
 * 4. The executor admits exactly the fence's tap actions with exactly their values, and nothing else: not another kind,
 *    not a changed value, not an automatic action, not a refund.
 * 5. The till lights from PayPal only on a verified PayPal payment, and from the chain only on a verified chain payment.
 */
import { CHAIN_STATES, PAYPAL_INVOICE_STATUSES, PROPOSAL_KINDS, statusClassOf } from "@paylink/api-contract";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ALERT_CODES } from "../../src/reconciler/codes.ts";
import { echoNote, isEcho } from "../../src/reconciler/echo.ts";
import { sameMoney } from "../../src/reconciler/money.ts";
import { admits, canonicalArgs, reconcile } from "../../src/reconciler/situation.ts";
import type { ChainObservation, ChainPayment, PayPalObservation, PayPalTransaction, ReconcileInput } from "../../src/reconciler/types.ts";
import { T0 } from "../helpers.ts";
import { CHAIN_ID, DAY, KEY, OTHER_KEY, OTHER_TX, PAYMENT, PYUSD, TWIN, TX } from "./fixtures.ts";

const RUNS = { numRuns: 3000 } as const;

const amountArb = fc.constantFrom("120.00", "120", "120.0", "60.00", "120.001", "", "abc", "0.00");
const noteArb = fc.oneof(
  fc.constantFrom(echoNote(CHAIN_ID, TX, KEY), echoNote(CHAIN_ID, OTHER_TX, KEY), echoNote(CHAIN_ID, TX, OTHER_KEY), echoNote(1, TX, KEY), echoNote(CHAIN_ID, TX, KEY).replaceAll("·", "|")),
  fc.string({ maxLength: 40 }),
  fc.constant(null),
);
const txArb: fc.Arbitrary<PayPalTransaction> = fc.record({
  paymentId: fc.option(fc.stringMatching(/^[A-Z0-9]{1,22}$/u), { nil: null }),
  type: fc.constantFrom("PAYPAL", "EXTERNAL", null),
  method: fc.constantFrom("OTHER", "PAYPAL", "CASH", "BANK_TRANSFER", null),
  note: noteArb,
  amount: fc.option(amountArb, { nil: null }),
  paymentDate: fc.constant("2026-10-21"),
});
const statusArb = fc.oneof(fc.constantFrom(...PAYPAL_INVOICE_STATUSES), fc.constantFrom("SOME_FUTURE_STATUS", ""));
const paypalArb: fc.Arbitrary<PayPalObservation> = fc.oneof(
  { weight: 1, arbitrary: fc.record({ read: fc.constant("failed" as const), retryable: fc.boolean() }) },
  {
    weight: 12,
    arbitrary: fc
      .record({
        status: statusArb,
        amount: fc.option(amountArb, { nil: null, freq: 8 }),
        currency: fc.constantFrom("USD", "USD", "USD", "EUR", null),
        reference: fc.constantFrom(KEY, KEY, KEY, OTHER_KEY, KEY.toUpperCase(), null),
        paidAmount: fc.option(amountArb, { nil: null }),
        transactions: fc.array(txArb, { maxLength: 3 }),
        hasRecipientEmail: fc.boolean(),
      })
      .map((p) => ({ read: "ok" as const, ...p, statusClass: statusClassOf(p.status) })),
  },
);
const paymentArb: fc.Arbitrary<ChainPayment> = fc.constantFrom(PAYMENT, { ...PAYMENT, txHash: OTHER_TX }, { ...PAYMENT, amount: "60000000" }, { ...PAYMENT, token: PYUSD, rail: "PYUSD" as const });
const chainArb: fc.Arbitrary<ChainObservation> = fc.record({
  state: fc.constantFrom(...CHAIN_STATES),
  payments: fc.array(paymentArb, { maxLength: 2 }),
  paidAt: fc.option(fc.integer({ min: Math.floor(T0 / 1000) - 7200, max: Math.floor(T0 / 1000) }), { nil: null }),
  chainTime: fc.option(fc.constant(Math.floor(T0 / 1000)), { nil: null }),
});
const inputArb: fc.Arbitrary<ReconcileInput> = fc.record({
  twin: fc.record({
    lastReminderAt: fc.option(fc.integer({ min: T0 - 3 * DAY, max: T0 }), { nil: null }),
    sentAt: fc.option(fc.integer({ min: T0 - 10 * DAY, max: T0 }), { nil: null }),
    dueDate: fc.constantFrom("2026-10-01", "2026-10-21", "2026-11-06", null),
    autoRecordUndone: fc.boolean(),
    recordMissing: fc.boolean(),
  }).map((t) => ({ ...TWIN, ...t })),
  paypal: paypalArb,
  chain: chainArb,
  now: fc.integer({ min: T0, max: T0 + 2 * DAY }),
});

const verifiedOf = (input: ReconcileInput): ChainPayment[] => input.chain.payments.filter((p) => p.amount === input.twin.amountBase && p.token.toLowerCase() === input.twin.token.toLowerCase());
/** Money taken on PayPal as the reads show it: a non-echo transaction on a paid invoice (independent of the table). */
const paypalTookMoney = (input: ReconcileInput): boolean =>
  input.paypal.read === "ok" && (input.paypal.statusClass === "paid" || input.paypal.statusClass === "paid-outside") && input.paypal.transactions.some((tx) => !isEcho(tx, input.twin, verifiedOf(input)));

describe("properties of the situation table (fast-check)", () => {
  it("1. is pure", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(reconcile(structuredClone(input))).toEqual(reconcile(input));
      }),
      RUNS,
    );
  });

  it("2. never leaves both rails open unless nobody paid (S1), it waits (S5) or it hands off (S0)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = reconcile(input);
        if (result.paypalOpen && result.chainOpen) {
          expect(["S0", "S1", "S5"]).toContain(result.situation);
        }
      }),
      RUNS,
    );
  });

  it("3. once a rail took money, the other is closed, closed by the fence, waited on (S5), or alarmed (S0, S4)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = reconcile(input);
        const kinds = result.allowed.map((a) => a.kind);
        const tookMoney = paypalTookMoney(input) || input.chain.state === "paid";
        if (!tookMoney || result.situation === "S5") {
          return;
        }
        if (result.situation === "S0" || result.situation === "S4") {
          expect(ALERT_CODES).toContain(result.alert);
          expect(result.allowed).toEqual([]);
          return;
        }
        if (result.chainOpen) {
          expect(kinds).toContain("cancel_paylink");
        }
        if (result.paypalOpen) {
          expect(kinds.some((k) => k === "record_external_payment" || k === "cancel_paypal")).toBe(true);
        }
        if (paypalTookMoney(input) && input.chain.state === "paid") {
          expect.unreachable("paid on both rails must be S4 or S0");
        }
      }),
      RUNS,
    );
  });

  it("alerts exactly in S0, S4 and a record gone from PayPal (S3 record-missing); nothing is allowed in S0, S4, S5, S8, S9", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = reconcile(input);
        expect(result.alert !== null).toBe(result.situation === "S0" || result.situation === "S4" || (result.situation === "S3" && result.reasonCode === "record-missing"));
        if (["S0", "S4", "S5", "S8", "S9"].includes(result.situation)) {
          expect(result.allowed).toEqual([]);
        }
        if (result.situation === "S4") {
          expect(result.alert).toBe("paid-twice");
        }
      }),
      RUNS,
    );
  });

  it("4. the executor admits exactly the fence's tap actions with their exact values, and nothing else", () => {
    const candidateArb = fc.record({
      kind: fc.constantFrom(...PROPOSAL_KINDS, "create_refund", "pay_order", "record_refund_for_invoice", "accept_dispute_claim"),
      args: fc.dictionary(fc.constantFrom("invoice", "paypalId", "amount", "currency", "key", "chainId", "rail", "txHash", "paymentDate", "round", "due"), fc.constantFrom("120.00", "12.00", "USD", KEY, TX, "11155111", "USDC")),
    });
    fc.assert(
      fc.property(inputArb, candidateArb, fc.nat(), (input, random, pick) => {
        const fence = reconcile(input).allowed;
        expect(fence.every((a) => (PROPOSAL_KINDS as readonly string[]).includes(a.kind))).toBe(true);
        expect(new Set(fence.map((a) => a.kind)).size).toBe(fence.length);
        // Every tap action of the fence is admitted as is; every automatic one is refused to an approval.
        for (const a of fence) {
          expect(admits(fence, a.kind, a.args) !== null).toBe(a.actor !== "automatic");
          expect(admits(fence, a.kind, a.args, { automatic: true }) !== null).toBe(a.actor === "automatic");
        }
        // A changed value of a fence action is refused.
        const target = fence.length === 0 ? undefined : fence[pick % fence.length];
        if (target !== undefined) {
          const keys = Object.keys(target.args);
          const changed = keys[pick % keys.length] ?? "amount";
          expect(admits(fence, target.kind, { ...target.args, [changed]: `${target.args[changed] ?? ""}0` })).toBeNull();
        }
        // A random proposal is admitted iff it is exactly a tap action of the fence.
        const exact = fence.some((a) => a.actor !== "automatic" && a.kind === random.kind && canonicalArgs(a.args) === canonicalArgs(random.args));
        expect(admits(fence, random.kind, random.args) !== null).toBe(exact);
      }),
      RUNS,
    );
  });

  it("5. the till lights from PayPal only on PayPal's verified payment, and from the chain only on a verified payment", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = reconcile(input);
        if (result.paidVia === "PAYPAL") {
          expect(input.paypal.read).toBe("ok");
          if (input.paypal.read === "ok") {
            expect(["paid", "paid-outside"]).toContain(input.paypal.statusClass);
            expect(sameMoney(input.paypal.paidAmount, input.twin.amountUsd)).toBe(true);
            expect(paypalTookMoney(input)).toBe(true);
          }
        } else if (result.paidVia !== null) {
          expect(input.chain.state).toBe("paid");
          expect(verifiedOf(input).some((p) => p.rail === result.paidVia)).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
