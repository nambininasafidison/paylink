// SPDX-License-Identifier: MIT
/**
 * The situation table (docs/paypal/SPEC.md §10.2), exhaustively: every PayPal status of the 16 (and one PayPal might
 * add) × every chain variant × no, an echo, a PayPal, and both transactions. The expected table below is written by
 * hand from the specification, row by row; every combination must match exactly one row. Then each situation's fence is
 * checked value by value, with the rules around it: mismatches are hands off, the reminder rule, Undo, chain time.
 */
import { PAYPAL_INVOICE_STATUSES, statusClassOf } from "@paylink/api-contract";
import type { PayPalStatusClass } from "@paylink/api-contract";
import { describe, expect, it } from "vitest";
import { ALERT_CODES, REASON_CODES } from "../../src/reconciler/codes.ts";
import { usdFromBase } from "../../src/reconciler/money.ts";
import { admits, CONFIRMING_WINDOW_S, reconcile, REMINDER_AFTER_SENT_MS, REMINDER_INTERVAL_MS } from "../../src/reconciler/situation.ts";
import type { ReconcileInput } from "../../src/reconciler/types.ts";
import { T0 } from "../helpers.ts";
import { CHAINS, DAY, ECHO_TX, HOUR, KEY, PAYMENT, paypal, PAYPAL_FAILED, PAYPAL_TX, PYUSD, TWIN, TXS } from "./fixtures.ts";
import type { ChainVariant, TxVariant } from "./fixtures.ts";

const VALID_CHAINS = ["payable", "paid", "confirming", "unverified", "cancelled", "expired"] as const satisfies readonly ChainVariant[];
const ALL_TXS = Object.keys(TXS) as TxVariant[];

/**
 * class | chain (a name, `valid` = the six readable states, or a/b) | transactions (a name, `*`, or a/b) | situation |
 * reason or alert code | fence kinds (`-` for none).
 */
const TABLE = `
open          payable                       none               S1 open                            share_reminder_text
open          payable                       echo/paypal/echo+paypal S0 paypal-open-with-payments  -
open          paid                          none               S3 paid-on-chain                   record_external_payment
open          paid                          echo               S3 paypal-still-open-after-record  cancel_paypal
open          paid                          paypal/echo+paypal S0 paypal-open-with-payments       -
open          confirming                    none               S5 chain-payment-confirming        -
open          confirming                    echo/paypal/echo+paypal S0 paypal-open-with-payments  -
open          unverified                    none               S0 chain-paid-unverified           -
open          unverified                    echo/paypal/echo+paypal S0 paypal-open-with-payments  -
open          cancelled                     none               S7 chain-cancelled                 cancel_paypal
open          expired                       none               S7 chain-expired                   cancel_paypal
open          cancelled/expired             echo/paypal/echo+paypal S0 paypal-open-with-payments  -
paid          valid                         none               S0 paid-without-transactions       -
paid          payable                       echo/paypal/echo+paypal S2 paid-on-paypal             cancel_paylink
paid          paid                          echo               S8 closed-paid-chain               -
paid          paid                          paypal/echo+paypal S4 paid-twice                      -
paid          confirming/unverified         echo/paypal/echo+paypal S4 paid-twice                 -
paid          cancelled/expired             echo/paypal/echo+paypal S8 closed-paid-paypal         -
paid-outside  payable                       *                  S2 marked-paid-by-you              cancel_paylink
paid-outside  paid                          none/echo          S8 closed-paid-chain               -
paid-outside  paid                          paypal/echo+paypal S4 paid-twice                      -
paid-outside  confirming                    none               S5 chain-payment-confirming        -
paid-outside  unverified                    none               S0 chain-paid-unverified           -
paid-outside  confirming/unverified         echo/paypal/echo+paypal S4 paid-twice                 -
paid-outside  cancelled/expired             *                  S8 closed-paid-paypal              -
cancelled     payable                       *                  S6 paypal-cancelled                cancel_paylink
cancelled     paid                          *                  S8 closed-paid-chain               -
cancelled     confirming                    *                  S5 chain-payment-confirming        -
cancelled     unverified                    *                  S0 chain-paid-unverified           -
cancelled     cancelled/expired             *                  S8 closed-cancelled                -
in-flight     valid                         *                  S5 payment-in-flight               -
refunded      valid                         *                  S9 refunded                        -
open-not-sent valid                         *                  S0 paypal-scheduled                -
not-sent      valid                         *                  S0 paypal-draft                    -
unknown       valid                         *                  S0 paypal-status-unknown           -
*             not-deployed                  *                  S0 chain-not-deployed              -
*             unreadable                    *                  S0 chain-unreadable                -
`;

interface Row {
  readonly line: string;
  readonly classes: ReadonlySet<string>;
  readonly chains: ReadonlySet<string>;
  readonly txs: ReadonlySet<string>;
  readonly situation: string;
  readonly code: string;
  readonly kinds: readonly string[];
}

const set = (cell: string, all: readonly string[]): ReadonlySet<string> => new Set(cell === "*" ? all : cell === "valid" ? VALID_CHAINS : cell.split("/"));
const CLASSES: readonly PayPalStatusClass[] = ["open", "paid", "paid-outside", "cancelled", "in-flight", "refunded", "open-not-sent", "not-sent", "unknown"];

const ROWS: readonly Row[] = TABLE.trim()
  .split("\n")
  .map((line) => {
    const [classes = "", chains = "", txs = "", situation = "", code = "", kinds = ""] = line.trim().split(/\s+/u);
    return { line, classes: set(classes, CLASSES), chains: set(chains, Object.keys(CHAINS)), txs: set(txs, ALL_TXS), situation, code, kinds: kinds === "-" ? [] : kinds.split(",") };
  });

/** Every status PayPal documents, and one it might add (class `unknown`). */
const STATUSES = [...PAYPAL_INVOICE_STATUSES, "SOME_FUTURE_STATUS"];

const input = (status: string, chain: ChainVariant, tx: TxVariant, overrides: Partial<ReconcileInput> = {}): ReconcileInput => ({
  twin: TWIN,
  paypal: paypal(status, { transactions: TXS[tx] }),
  chain: CHAINS[chain],
  now: T0,
  ...overrides,
});

describe("the situation table, exhaustively (17 statuses × 8 chain variants × 4 transaction sets)", () => {
  it("matches exactly one hand-written row for every combination, with that row's situation, code and fence", () => {
    let combinations = 0;
    const used = new Set<string>();
    for (const status of STATUSES) {
      for (const chain of Object.keys(CHAINS) as ChainVariant[]) {
        for (const tx of ALL_TXS) {
          combinations += 1;
          const cls = statusClassOf(status);
          const rows = ROWS.filter((r) => r.classes.has(cls) && r.chains.has(chain) && r.txs.has(tx));
          const where = `${status} (${cls}) × ${chain} × ${tx}`;
          expect(rows.map((r) => r.line), where).toHaveLength(1);
          const [row] = rows;
          if (row === undefined) {
            continue;
          }
          used.add(row.line);
          const result = reconcile(input(status, chain, tx));
          expect(result.situation, where).toBe(row.situation);
          expect(row.situation === "S0" || row.situation === "S4" ? result.alert : result.reasonCode, where).toBe(row.code);
          expect(result.allowed.map((a) => a.kind), where).toEqual(row.kinds);
        }
      }
    }
    expect(combinations).toBe(17 * 8 * 4);
    expect(ROWS.filter((r) => !used.has(r.line)).map((r) => r.line)).toEqual([]);
  });

  it("speaks only in the fixed codes the web edition renders", () => {
    for (const status of STATUSES) {
      for (const chain of Object.keys(CHAINS) as ChainVariant[]) {
        for (const tx of ALL_TXS) {
          const result = reconcile(input(status, chain, tx));
          expect(REASON_CODES).toContain(result.reasonCode);
          if (result.alert !== null) {
            expect(ALERT_CODES).toContain(result.alert);
          }
          for (const a of result.allowed) {
            expect(REASON_CODES).toContain(a.reasonCode);
          }
        }
      }
    }
  });
});

describe("hands off (S0)", () => {
  it("on a PayPal read failure, whatever the chain says", () => {
    for (const chain of Object.keys(CHAINS) as ChainVariant[]) {
      expect(reconcile({ ...input("PAID", chain, "paypal"), paypal: PAYPAL_FAILED })).toMatchObject({ situation: "S0", alert: "paypal-unreadable", allowed: [], paidVia: null });
    }
  });

  it("when the twin is not the invoice PayLink made: reference, currency, amount, paid amount", () => {
    const cases = [
      [paypal("SENT", { reference: `0x${"ef".repeat(32)}` }), "reference-mismatch"],
      [paypal("SENT", { reference: "" }), "reference-mismatch"],
      [paypal("SENT", { currency: "EUR" }), "currency-mismatch"],
      [paypal("SENT", { amount: "12.00" }), "amount-mismatch"],
      [paypal("SENT", { amount: "120.001" }), "amount-mismatch"],
      [paypal("PAID", { transactions: [PAYPAL_TX], paidAmount: "60.00" }), "paid-amount-mismatch"],
      [paypal("PAID", { transactions: [PAYPAL_TX], paidAmount: null }), "paid-amount-mismatch"],
    ] as const;
    for (const [observation, alert] of cases) {
      expect(reconcile({ twin: TWIN, paypal: observation, chain: CHAINS.payable, now: T0 })).toMatchObject({ situation: "S0", alert, allowed: [] });
    }
  });

  it("accepts PayPal's equivalent spellings of the same amount, and the reference in any hex case", () => {
    for (const amount of ["120", "120.0", "120.00", "0120.00"]) {
      expect(reconcile({ twin: TWIN, paypal: paypal("SENT", { amount }), chain: CHAINS.payable, now: T0 }).situation).toBe("S1");
    }
    expect(reconcile({ twin: TWIN, paypal: paypal("SENT", { reference: KEY.toUpperCase().replace("0X", "0x") }), chain: CHAINS.payable, now: T0 }).situation).toBe("S1");
  });

  it("when the chain reports a payment for K at another amount or in another token", () => {
    const wrongAmount = { ...CHAINS.paid, payments: [{ ...PAYMENT, amount: "60000000" }] };
    const wrongToken = { ...CHAINS.paid, payments: [{ ...PAYMENT, token: PYUSD, rail: "PYUSD" as const }] };
    expect(reconcile({ ...input("SENT", "paid", "none"), chain: wrongAmount })).toMatchObject({ situation: "S0", alert: "chain-payment-mismatch" });
    expect(reconcile({ ...input("SENT", "paid", "none"), chain: wrongToken })).toMatchObject({ situation: "S0", alert: "chain-payment-mismatch" });
  });
});

describe("fences carry the exact values the executor will use", () => {
  it("S3 records the verified payment with PayLink's note fields, automatically", () => {
    const result = reconcile(input("SHARED", "paid", "none"));
    expect(result).toMatchObject({ situation: "S3", paidVia: "USDC", paypalOpen: true, chainOpen: false });
    expect(result.allowed).toEqual([
      {
        kind: "record_external_payment",
        actor: "automatic",
        reasonCode: "paid-on-chain",
        args: { invoice: TWIN.invoiceNumber, paypalId: TWIN.paypalId, amount: "120.00", currency: "USD", chainId: "11155111", rail: "USDC", txHash: PAYMENT.txHash, paymentDate: "2026-10-21" },
      },
    ]);
  });

  it("S3 after an Undo offers the same record as a tap, never automatically again", () => {
    const result = reconcile({ ...input("SHARED", "paid", "none"), twin: { ...TWIN, autoRecordUndone: true } });
    expect(result.allowed).toEqual([expect.objectContaining({ kind: "record_external_payment", actor: "tap", reasonCode: "recorded-then-undone" })]);
  });

  it("S2 closes the chain rail by the payee's signature; S6 too", () => {
    for (const [status, tx, reason] of [
      ["PAID", "paypal", "paid-on-paypal"],
      ["CANCELLED", "none", "paypal-cancelled"],
    ] as const) {
      const result = reconcile(input(status, "payable", tx));
      expect(result.allowed).toEqual([{ kind: "cancel_paylink", actor: "tap-and-signature", reasonCode: reason, args: { invoice: TWIN.invoiceNumber, key: KEY, chainId: "11155111", amount: "120.00", currency: "USD", rail: "USDC" } }]);
    }
    expect(reconcile(input("PAID", "payable", "paypal")).paidVia).toBe("PAYPAL");
  });

  it("S7 cancels the PayPal twin by a tap", () => {
    expect(reconcile(input("UNPAID", "expired", "none")).allowed).toEqual([{ kind: "cancel_paypal", actor: "tap", reasonCode: "chain-expired", args: { invoice: TWIN.invoiceNumber, paypalId: TWIN.paypalId, amount: "120.00", currency: "USD" } }]);
  });

  it("a merchant's own mark does not light the till as a PayPal payment", () => {
    expect(reconcile(input("MARKED_AS_PAID", "payable", "none"))).toMatchObject({ situation: "S2", paidVia: null, reasonCode: "marked-paid-by-you" });
    expect(reconcile(input("MARKED_AS_PAID", "paid", "none"))).toMatchObject({ situation: "S8", paidVia: "USDC" });
  });
});

describe("S1 reminders (§7.1 P9, §10.2)", () => {
  const s1 = (twin: Partial<typeof TWIN>, options: { readonly now?: number; readonly email?: boolean } = {}) =>
    reconcile({ twin: { ...TWIN, ...twin }, paypal: paypal("SENT", { email: options.email ?? true }), chain: CHAINS.payable, now: options.now ?? T0 }).allowed;

  it("always allows sharing the reminder text; PayPal's reminder only when due or 3 days after sending", () => {
    expect(s1({}).map((a) => a.kind)).toEqual(["share_reminder_text"]);
    expect(s1({ dueDate: "2026-10-21" }).map((a) => [a.kind, a.reasonCode])).toEqual([
      ["share_reminder_text", "share-reminder"],
      ["send_reminder", "reminder-due"],
    ]);
    expect(s1({ sentAt: T0 - REMINDER_AFTER_SENT_MS }).map((a) => a.reasonCode)).toEqual(["share-reminder", "reminder-after-3-days"]);
    expect(s1({ sentAt: T0 - REMINDER_AFTER_SENT_MS + 1 }).map((a) => a.kind)).toEqual(["share_reminder_text"]);
    expect(s1({ sentAt: null, dueDate: null }).map((a) => a.kind)).toEqual(["share_reminder_text"]);
  });

  it("at most one PayPal reminder per 24 hours, and none without a recipient email", () => {
    expect(s1({ dueDate: "2026-10-01", lastReminderAt: T0 - REMINDER_INTERVAL_MS + 1 }).map((a) => a.kind)).toEqual(["share_reminder_text"]);
    const next = s1({ dueDate: "2026-10-01", lastReminderAt: T0 - REMINDER_INTERVAL_MS });
    expect(next.map((a) => a.kind)).toEqual(["share_reminder_text", "send_reminder"]);
    // A new round binds the last reminder's time: approving one reminder never approves the next.
    expect(next[1]?.args["round"]).toBe(new Date(T0 - REMINDER_INTERVAL_MS).toISOString());
    expect(s1({ dueDate: "2026-10-01" }, { email: false }).map((a) => a.kind)).toEqual(["share_reminder_text"]);
  });

  it("never offers PayPal's reminder without a client email, and says why (the sandbox refuses it, capture of 2026-10-29)", () => {
    for (const twin of [{}, { dueDate: "2026-10-01" }, { sentAt: T0 - REMINDER_AFTER_SENT_MS }, { dueDate: "2026-10-01", lastReminderAt: T0 - 2 * REMINDER_INTERVAL_MS }]) {
      expect(s1(twin, { email: false }).map((a) => [a.kind, a.reasonCode])).toEqual([["share_reminder_text", "share-reminder-no-email"]]);
      expect(s1(twin).map((a) => a.reasonCode)[0]).toBe("share-reminder");
    }
  });
});

describe("chain payments not verified yet", () => {
  it("wait (S5) for 15 minutes of chain time after stateOf's lastPaidAt, then hand off (S0)", () => {
    const at = (age: number) => reconcile({ ...input("SENT", "confirming", "none"), chain: { ...CHAINS.confirming, paidAt: CHAINS.confirming.chainTime - age } });
    expect(at(CONFIRMING_WINDOW_S).situation).toBe("S5");
    expect(at(CONFIRMING_WINDOW_S + 1)).toMatchObject({ situation: "S0", alert: "chain-paid-unverified" });
  });

  it("never light the till", () => {
    expect(reconcile(input("SENT", "confirming", "none")).paidVia).toBeNull();
    expect(reconcile(input("SENT", "unverified", "none")).paidVia).toBeNull();
  });
});

describe("the echo filter inside the table (§10.3)", () => {
  it("a recorded payment id alone is not an echo", () => {
    const forged = { ...ECHO_TX, note: "recorded by PayLink" };
    const result = reconcile({ twin: { ...TWIN, recordedPaymentIds: [forged.paymentId ?? ""] }, paypal: paypal("PAID", { transactions: [forged] }), chain: CHAINS.paid, now: T0 });
    expect(result).toMatchObject({ situation: "S4", alert: "paid-twice", echoes: [] });
  });

  it("an echo of another key, chain or transaction is not an echo", () => {
    for (const note of [ECHO_TX.note?.replace(KEY.slice(2), "cd".repeat(32)), ECHO_TX.note?.replace("eip155:11155111", "eip155:1"), ECHO_TX.note?.replace(PAYMENT.txHash.slice(2), "99".repeat(32))]) {
      const result = reconcile({ ...input("PAID", "paid", "none"), paypal: paypal("PAID", { transactions: [{ ...ECHO_TX, note: note ?? null }] }) });
      expect(result.situation).toBe("S4");
    }
  });

  it("names the echoes it recognised", () => {
    expect(reconcile(input("PAID", "paid", "echo"))).toMatchObject({ situation: "S8", echoes: [ECHO_TX.paymentId], paidVia: "USDC" });
  });
});

describe("the admission rule (the executor's side of the fence)", () => {
  it("admits a tap action only with exactly the fence's values, in any key order", () => {
    const [action] = reconcile(input("SENT", "cancelled", "none")).allowed;
    if (action === undefined) {
      throw new Error("S7 must allow cancel_paypal");
    }
    const reversed = Object.fromEntries(Object.entries(action.args).reverse());
    expect(admits([action], "cancel_paypal", reversed)).toEqual(action);
    expect(admits([action], "cancel_paypal", { ...action.args, amount: "12.00" })).toBeNull();
    expect(admits([action], "cancel_paypal", { ...action.args, extra: "x" })).toBeNull();
    expect(admits([action], "cancel_paylink", action.args)).toBeNull();
  });

  it("never admits an automatic action through an approval, and only automatic ones for code", () => {
    const [record] = reconcile(input("SENT", "paid", "none")).allowed;
    if (record === undefined) {
      throw new Error("S3 must allow the record");
    }
    expect(admits([record], record.kind, record.args)).toBeNull();
    expect(admits([record], record.kind, record.args, { automatic: true })).toEqual(record);
    const [tap] = reconcile(input("SENT", "cancelled", "none")).allowed;
    expect(tap === undefined ? null : admits([tap], tap.kind, tap.args, { automatic: true })).toBeNull();
  });
});

describe("money", () => {
  it("turns base units into PayPal's two-decimal string, refusing sub-cent precision", () => {
    expect(usdFromBase("120000000")).toBe("120.00");
    expect(usdFromBase("1")).toBeNull();
    expect(usdFromBase("10000")).toBe("0.01");
    expect(usdFromBase("0")).toBe("0.00");
    expect(usdFromBase("-1")).toBeNull();
    expect(usdFromBase("1e6")).toBeNull();
    expect(usdFromBase("123456789012345678900000")).toBe("123456789012345678.90");
  });

  it("is pure: the same reads give the same answer at any later time, except the time rules", () => {
    const a = reconcile(input("SHARED", "paid", "none"));
    const b = reconcile({ ...input("SHARED", "paid", "none"), now: T0 + 30 * DAY + HOUR });
    expect(b).toEqual(a);
  });
});
