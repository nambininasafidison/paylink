// SPDX-License-Identifier: MIT
/** The indexer's arithmetic (src/ledger.ts), without Envio: ids, days, payments, aggregates and cancellations. */
import { describe, expect, it } from "vitest";
import { applyCancelled, applyPaid, cancelledIds, dateOf, dayOf, ids, paidIds } from "../src/ledger.ts";
import type { PaidState, PaidWrites } from "../src/ledger.ts";
import { AUSD, BASE, cancelled, DAY, KEY_A, KEY_B, MONAD, OTHER_TOKEN, paid, PAYEE, PAYEE_2, PAYER, PAYER_2, T0, tx } from "./fixtures.ts";

const EMPTY: PaidState = { invoice: undefined, payee: undefined, payeeToken: undefined, payerPayee: undefined, dailyVolume: undefined, dailyActivity: undefined };

/** Feeds `applyPaid` the rows a previous write produced, the way the handler loads them by id. */
function after(writes: PaidWrites, log: ReturnType<typeof paid>): PaidState {
  const id = paidIds(log);
  const pick = <T extends { readonly id: string }>(row: T): T | undefined => (Object.values(id).includes(row.id) ? row : undefined);
  return {
    invoice: pick(writes.invoice),
    payee: pick(writes.payee),
    payeeToken: pick(writes.payeeToken),
    payerPayee: pick(writes.payerPayee),
    dailyVolume: pick(writes.dailyVolume),
    dailyActivity: pick(writes.dailyActivity),
  };
}

describe("days", () => {
  it("cuts UTC days at midnight", () => {
    expect(dayOf(T0)).toBe(20735);
    expect(dayOf(T0 - 1)).toBe(20734);
    expect(dayOf(T0 + DAY - 1)).toBe(20735);
    expect(dateOf(20735)).toBe("2026-10-09");
    expect(dateOf(0)).toBe("1970-01-01");
  });
});

describe("ids", () => {
  it("prefix the chain and lowercase every hex part", () => {
    expect(ids.invoice(MONAD, KEY_A.toUpperCase().replace("0X", "0x"))).toBe(`10143-${KEY_A}`);
    expect(ids.payment(BASE, tx(7).toUpperCase().replace("0X", "0x"), 3)).toBe(`84532-${tx(7)}-3`);
    expect(ids.payee(MONAD, PAYEE)).toBe(`10143-${PAYEE}`);
    expect(ids.payeeToken(MONAD, PAYEE, AUSD.toUpperCase().replace("0X", "0x"))).toBe(`10143-${PAYEE}-${AUSD}`);
    expect(ids.payerPayee(MONAD, PAYEE, PAYER)).toBe(`10143-${PAYEE}-${PAYER}`);
    expect(ids.dailyVolume(MONAD, AUSD, 20735)).toBe(`10143-${AUSD}-20735`);
    expect(ids.dailyActivity(BASE, 20735)).toBe("84532-20735");
  });

  it("keep the same key on two chains apart", () => {
    expect(ids.invoice(MONAD, KEY_A)).not.toBe(ids.invoice(BASE, KEY_A));
    expect(paidIds(paid()).payee).not.toBe(paidIds(paid({ chainId: BASE })).payee);
  });

  it("name the rows each event touches", () => {
    expect(paidIds(paid())).toEqual({
      invoice: `10143-${KEY_A}`,
      payment: `10143-${tx(1)}-0`,
      payee: `10143-${PAYEE}`,
      payeeToken: `10143-${PAYEE}-${AUSD}`,
      payerPayee: `10143-${PAYEE}-${PAYER}`,
      dailyVolume: `10143-${AUSD}-20735`,
      dailyActivity: "10143-20735",
    });
    expect(cancelledIds(cancelled())).toEqual({ invoice: `10143-${KEY_A}`, payee: `10143-${PAYEE}`, dailyActivity: "10143-20735" });
  });
});

describe("applyPaid", () => {
  it("records a first payment everywhere it counts", () => {
    const w = applyPaid(EMPTY, paid());
    const at = BigInt(T0 + 600);
    expect(w.payment).toEqual({
      id: `10143-${tx(1)}-0`,
      chainId: MONAD,
      invoice_id: `10143-${KEY_A}`,
      key: KEY_A,
      payee: PAYEE,
      payer: PAYER,
      token: AUSD,
      amount: 1_000_000n,
      index: 0,
      payerRef: `0x${"00".repeat(32)}`,
      blockNumber: 69_400_000n,
      timestamp: at,
      txHash: tx(1),
      logIndex: 0,
    });
    expect(w.invoice).toEqual({
      id: `10143-${KEY_A}`,
      chainId: MONAD,
      key: KEY_A,
      payee: PAYEE,
      token: AUSD,
      payments: 1,
      total: 1_000_000n,
      cancelled: false,
      firstPaidAt: at,
      lastPaidAt: at,
      cancelledAt: undefined,
      cancelledTx: undefined,
      lastActivityAt: at,
    });
    expect(w.payee).toEqual({ id: `10143-${PAYEE}`, chainId: MONAD, payee: PAYEE, payments: 1, links: 1, uniquePayers: 1, cancellations: 0, firstPaidAt: at, lastPaidAt: at });
    expect(w.payeeToken).toEqual({ id: `10143-${PAYEE}-${AUSD}`, chainId: MONAD, payee: PAYEE, token: AUSD, stats_id: `10143-${PAYEE}`, payments: 1, volume: 1_000_000n, firstPaidAt: at, lastPaidAt: at });
    expect(w.payerPayee).toEqual({ id: `10143-${PAYEE}-${PAYER}`, chainId: MONAD, payee: PAYEE, payer: PAYER, payments: 1, firstPaidAt: at, lastPaidAt: at });
    expect(w.dailyVolume).toEqual({ id: `10143-${AUSD}-20735`, chainId: MONAD, token: AUSD, day: 20735, date: "2026-10-09", payments: 1, volume: 1_000_000n });
    expect(w.dailyActivity).toEqual({ id: "10143-20735", chainId: MONAD, day: 20735, date: "2026-10-09", payments: 1, cancellations: 0, newPayees: 1 });
  });

  it("lowercases whatever case the log arrives in", () => {
    const up = (hex: string): string => `0x${hex.slice(2).toUpperCase()}`;
    const w = applyPaid(EMPTY, paid({ key: up(KEY_A), payee: up(PAYEE), payer: up(PAYER), token: up(AUSD), payerRef: up(`0x${"ab".repeat(32)}`), txHash: up(tx(10)) }));
    expect(w.payment).toMatchObject({ key: KEY_A, payee: PAYEE, payer: PAYER, token: AUSD, payerRef: `0x${"ab".repeat(32)}`, txHash: tx(10) });
    expect(w.invoice.id).toBe(`10143-${KEY_A}`);
  });

  it("counts a repeat payer on a multi-seat link once among unique payers", () => {
    const first = paid();
    const w1 = applyPaid(EMPTY, first);
    const second = paid({ index: 1n, amount: 2_500_000n, timestamp: T0 + 1200, txHash: tx(2) });
    const w2 = applyPaid(after(w1, second), second);
    expect(w2.invoice).toMatchObject({ payments: 2, total: 3_500_000n, firstPaidAt: BigInt(T0 + 600), lastPaidAt: BigInt(T0 + 1200), lastActivityAt: BigInt(T0 + 1200) });
    expect(w2.payee).toMatchObject({ payments: 2, links: 1, uniquePayers: 1 });
    expect(w2.payerPayee).toMatchObject({ payments: 2, firstPaidAt: BigInt(T0 + 600), lastPaidAt: BigInt(T0 + 1200) });
    expect(w2.payeeToken).toMatchObject({ payments: 2, volume: 3_500_000n });
    expect(w2.dailyVolume).toMatchObject({ payments: 2, volume: 3_500_000n });
    expect(w2.dailyActivity).toMatchObject({ payments: 2, newPayees: 1 });

    const third = paid({ index: 2n, payer: PAYER_2, txHash: tx(3), timestamp: T0 + 1300 });
    const w3 = applyPaid(after(w2, third), third);
    expect(w3.payee).toMatchObject({ payments: 3, links: 1, uniquePayers: 2 });
  });

  it("counts a second link, a second token and a new day separately", () => {
    const w1 = applyPaid(EMPTY, paid());
    const next = paid({ key: KEY_B, token: OTHER_TOKEN, amount: 7n, timestamp: T0 + DAY + 5, txHash: tx(4) });
    const loaded = after(w1, next);
    expect(loaded.invoice).toBeUndefined();
    expect(loaded.payeeToken).toBeUndefined();
    expect(loaded.dailyVolume).toBeUndefined();
    expect(loaded.dailyActivity).toBeUndefined();
    const w2 = applyPaid(loaded, next);
    expect(w2.invoice).toMatchObject({ id: `10143-${KEY_B}`, payments: 1, total: 7n, token: OTHER_TOKEN });
    expect(w2.payee).toMatchObject({ payments: 2, links: 2, uniquePayers: 1, firstPaidAt: BigInt(T0 + 600), lastPaidAt: BigInt(T0 + DAY + 5) });
    expect(w2.payeeToken).toMatchObject({ id: `10143-${PAYEE}-${OTHER_TOKEN}`, payments: 1, volume: 7n });
    expect(w2.dailyVolume).toMatchObject({ day: 20736, date: "2026-10-10", payments: 1, volume: 7n });
    // The payee was already paid on an earlier day: not new on this one.
    expect(w2.dailyActivity).toMatchObject({ day: 20736, payments: 1, newPayees: 0 });
  });

  it("mirrors the contract's payment counter: index + 1, never lower", () => {
    const w1 = applyPaid(EMPTY, paid({ index: 4n }));
    expect(w1.invoice.payments).toBe(5);
    const earlier = paid({ index: 2n, txHash: tx(5) });
    expect(applyPaid(after(w1, earlier), earlier).invoice.payments).toBe(5);
  });

  it("keeps the earliest and latest times whatever order logs arrive in", () => {
    const late = paid({ timestamp: T0 + 5000 });
    const w1 = applyPaid(EMPTY, late);
    const early = paid({ index: 1n, timestamp: T0 + 100, txHash: tx(6) });
    const w2 = applyPaid(after(w1, early), early);
    expect(w2.invoice).toMatchObject({ firstPaidAt: BigInt(T0 + 100), lastPaidAt: BigInt(T0 + 5000), lastActivityAt: BigInt(T0 + 5000) });
    expect(w2.payee).toMatchObject({ firstPaidAt: BigInt(T0 + 100), lastPaidAt: BigInt(T0 + 5000) });
    expect(w2.payeeToken).toMatchObject({ firstPaidAt: BigInt(T0 + 100), lastPaidAt: BigInt(T0 + 5000) });
    expect(w2.payerPayee).toMatchObject({ firstPaidAt: BigInt(T0 + 100), lastPaidAt: BigInt(T0 + 5000) });
  });

  it("handles uint128 amounts without loss", () => {
    const max = 2n ** 128n - 1n;
    const w1 = applyPaid(EMPTY, paid({ amount: max }));
    const again = paid({ index: 1n, amount: max, txHash: tx(8) });
    expect(applyPaid(after(w1, again), again).payeeToken.volume).toBe(max * 2n);
  });

  it("treats a payee whose only history is a cancellation as new on its first payment", () => {
    const c = applyCancelled({ invoice: undefined, payee: undefined, dailyActivity: undefined }, cancelled({ key: KEY_B }));
    expect(c).not.toBeNull();
    const w = applyPaid({ ...EMPTY, payee: c?.payee, dailyActivity: c?.dailyActivity }, paid());
    expect(w.payee).toMatchObject({ payments: 1, links: 1, cancellations: 1, firstPaidAt: BigInt(T0 + 600) });
    expect(w.dailyActivity).toMatchObject({ payments: 1, cancellations: 1, newPayees: 1 });
  });

  it("keeps a second payee's stats apart from the first", () => {
    const w1 = applyPaid(EMPTY, paid());
    const other = paid({ payee: PAYEE_2, key: KEY_B, txHash: tx(9) });
    const loaded = after(w1, other);
    expect(loaded.payee).toBeUndefined();
    const w2 = applyPaid(loaded, other);
    expect(w2.payee).toMatchObject({ id: `10143-${PAYEE_2}`, payments: 1, links: 1, uniquePayers: 1 });
    expect(w2.dailyActivity).toMatchObject({ payments: 2, newPayees: 2 });
  });
});

describe("applyCancelled", () => {
  it("starts the rows of a link cancelled before any payment", () => {
    const c = applyCancelled({ invoice: undefined, payee: undefined, dailyActivity: undefined }, cancelled());
    const at = BigInt(T0 + 900);
    expect(c).toEqual({
      invoice: {
        id: `10143-${KEY_A}`,
        chainId: MONAD,
        key: KEY_A,
        payee: PAYEE,
        token: undefined,
        payments: 0,
        total: 0n,
        cancelled: true,
        firstPaidAt: undefined,
        lastPaidAt: undefined,
        cancelledAt: at,
        cancelledTx: tx(99),
        lastActivityAt: at,
      },
      payee: { id: `10143-${PAYEE}`, chainId: MONAD, payee: PAYEE, payments: 0, links: 0, uniquePayers: 0, cancellations: 1, firstPaidAt: undefined, lastPaidAt: undefined },
      dailyActivity: { id: "10143-20735", chainId: MONAD, day: 20735, date: "2026-10-09", payments: 0, cancellations: 1, newPayees: 0 },
    });
  });

  it("closes a paid link and keeps its payment history", () => {
    const w = applyPaid(EMPTY, paid());
    const c = applyCancelled({ invoice: w.invoice, payee: w.payee, dailyActivity: w.dailyActivity }, cancelled({ txHash: `0x${"CD".repeat(32)}` }));
    expect(c?.invoice).toMatchObject({ token: AUSD, payments: 1, total: 1_000_000n, cancelled: true, firstPaidAt: BigInt(T0 + 600), lastPaidAt: BigInt(T0 + 600), cancelledAt: BigInt(T0 + 900), cancelledTx: `0x${"cd".repeat(32)}`, lastActivityAt: BigInt(T0 + 900) });
    expect(c?.payee).toMatchObject({ payments: 1, links: 1, uniquePayers: 1, cancellations: 1, firstPaidAt: BigInt(T0 + 600) });
    expect(c?.dailyActivity).toMatchObject({ payments: 1, cancellations: 1, newPayees: 1 });
  });

  it("ignores a replay of a cancellation already recorded", () => {
    const c = applyCancelled({ invoice: undefined, payee: undefined, dailyActivity: undefined }, cancelled());
    expect(applyCancelled({ invoice: c?.invoice, payee: c?.payee, dailyActivity: c?.dailyActivity }, cancelled())).toBeNull();
  });
});
