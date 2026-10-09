// SPDX-License-Identifier: MIT
/**
 * The registered handlers (src/handlers/PayLinkV2.ts) run by Envio's own test indexer (`createTestIndexer`, envio
 * 3.12.1) over simulated logs: the real config.yaml, schema, codegen and handler loading, with no network (every chain
 * passed to `process` carries `simulate`, so nothing is fetched from HyperSync or RPC).
 */
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { AUSD, BASE, DAY, KEY_A, KEY_B, MONAD, PAYEE, PAYER, PAYER_2, REF, T0, tx } from "./fixtures.ts";

type Hex = `0x${string}`;
const hex = (value: string): Hex => value as Hex;
const KEY_C = `0x${"c3".repeat(32)}`;

interface PaidInput {
  readonly key?: string;
  readonly payer?: string;
  readonly amount?: bigint;
  readonly index?: bigint;
  readonly block: number;
  readonly time: number;
  readonly hash: string;
  readonly logIndex?: number;
}

function paidItem(input: PaidInput) {
  return {
    contract: "PayLinkV2" as const,
    event: "Paid" as const,
    params: {
      key: input.key ?? KEY_A,
      payee: hex(PAYEE),
      payer: hex(input.payer ?? PAYER),
      token: hex(AUSD),
      amount: input.amount ?? 1_000_000n,
      index: input.index ?? 0n,
      payerRef: REF,
    },
    block: { number: input.block, timestamp: input.time },
    transaction: { hash: input.hash },
    ...(input.logIndex === undefined ? {} : { logIndex: input.logIndex }),
  };
}

function cancelItem(key: string, block: number, time: number, hash: string) {
  return {
    contract: "PayLinkV2" as const,
    event: "InvoiceCancelled" as const,
    params: { key, payee: hex(PAYEE) },
    block: { number: block, timestamp: time },
    transaction: { hash },
  };
}

describe("PayLinkV2 handlers on the Envio test indexer", () => {
  it("build history, payee stats and daily aggregates on two chains", async () => {
    const indexer = createTestIndexer();
    const result = await indexer.process({
      chains: {
        [MONAD]: {
          simulate: [
            paidItem({ index: 0n, block: 69_400_000, time: T0 + 60, hash: tx(1) }),
            paidItem({ index: 1n, amount: 2_000_000n, block: 69_400_010, time: T0 + 120, hash: tx(2) }),
            paidItem({ key: KEY_B, payer: PAYER_2, amount: 500_000n, block: 69_400_020, time: T0 + DAY + 30, hash: tx(3) }),
            cancelItem(KEY_B, 69_400_030, T0 + DAY + 60, tx(4)),
            cancelItem(KEY_C, 69_400_040, T0 + DAY + 90, tx(5)),
          ],
        },
        [BASE]: {
          simulate: [paidItem({ amount: 9n, block: 47_900_000, time: T0 + 300, hash: tx(6) })],
        },
      },
    });

    expect(result.changes.reduce((n, change) => n + change.eventsProcessed, 0)).toBe(6);

    const linkA = await indexer.Invoice.getOrThrow(`${String(MONAD)}-${KEY_A}`);
    expect(linkA).toMatchObject({ chainId: MONAD, key: KEY_A, payee: PAYEE, token: AUSD, payments: 2, total: 3_000_000n, cancelled: false, firstPaidAt: BigInt(T0 + 60), lastPaidAt: BigInt(T0 + 120) });
    expect(await indexer.Invoice.getOrThrow(`${String(MONAD)}-${KEY_B}`)).toMatchObject({ payments: 1, total: 500_000n, cancelled: true, cancelledAt: BigInt(T0 + DAY + 60), cancelledTx: tx(4) });
    expect(await indexer.Invoice.getOrThrow(`${String(MONAD)}-${KEY_C}`)).toMatchObject({ payments: 0, total: 0n, token: undefined, cancelled: true });
    // The same key on Base is its own link.
    expect(await indexer.Invoice.getOrThrow(`${String(BASE)}-${KEY_A}`)).toMatchObject({ chainId: BASE, payments: 1, total: 9n });

    expect(await indexer.Payee.getOrThrow(`${String(MONAD)}-${PAYEE}`)).toMatchObject({ payments: 3, links: 2, uniquePayers: 2, cancellations: 2, firstPaidAt: BigInt(T0 + 60), lastPaidAt: BigInt(T0 + DAY + 30) });
    expect(await indexer.Payee.getOrThrow(`${String(BASE)}-${PAYEE}`)).toMatchObject({ payments: 1, links: 1, uniquePayers: 1, cancellations: 0 });
    expect(await indexer.PayeeToken.getOrThrow(`${String(MONAD)}-${PAYEE}-${AUSD}`)).toMatchObject({ payments: 3, volume: 3_500_000n, stats_id: `${String(MONAD)}-${PAYEE}` });
    expect(await indexer.PayerPayee.getOrThrow(`${String(MONAD)}-${PAYEE}-${PAYER}`)).toMatchObject({ payments: 2 });

    const payments = (await indexer.Payment.getAll()).filter((p) => p.chainId === MONAD).sort((a, b) => a.index - b.index || Number(a.timestamp - b.timestamp));
    expect(payments.map((p) => [p.key, p.index, p.amount, p.txHash])).toEqual([
      [KEY_A, 0, 1_000_000n, tx(1)],
      [KEY_B, 0, 500_000n, tx(3)],
      [KEY_A, 1, 2_000_000n, tx(2)],
    ]);
    expect(payments.every((p) => p.id === `${String(MONAD)}-${p.txHash}-${String(p.logIndex)}` && p.invoice_id === `${String(MONAD)}-${p.key}`)).toBe(true);

    expect(await indexer.DailyVolume.getOrThrow(`${String(MONAD)}-${AUSD}-20735`)).toMatchObject({ date: "2026-10-09", payments: 2, volume: 3_000_000n });
    expect(await indexer.DailyVolume.getOrThrow(`${String(MONAD)}-${AUSD}-20736`)).toMatchObject({ date: "2026-10-10", payments: 1, volume: 500_000n });
    expect(await indexer.DailyActivity.getOrThrow(`${String(MONAD)}-20735`)).toMatchObject({ payments: 2, cancellations: 0, newPayees: 1 });
    expect(await indexer.DailyActivity.getOrThrow(`${String(MONAD)}-20736`)).toMatchObject({ payments: 1, cancellations: 2, newPayees: 0 });
  });

  it("never counts a payment twice", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [MONAD]: { simulate: [paidItem({ block: 69_400_000, time: T0, hash: tx(1), logIndex: 0 })] } } });
    // The same transaction hash and log index again (a replay) leaves every aggregate as it was.
    await indexer.process({ chains: { [MONAD]: { simulate: [paidItem({ block: 69_400_001, time: T0 + 1, hash: tx(1), logIndex: 0 })] } } });
    expect(await indexer.Payment.getAll()).toHaveLength(1);
    expect(await indexer.Invoice.getOrThrow(`${String(MONAD)}-${KEY_A}`)).toMatchObject({ payments: 1, total: 1_000_000n });
    expect(await indexer.Payee.getOrThrow(`${String(MONAD)}-${PAYEE}`)).toMatchObject({ payments: 1, uniquePayers: 1 });
  });

  it("never counts a cancellation twice", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [MONAD]: { simulate: [cancelItem(KEY_C, 69_400_000, T0, tx(1))] } } });
    await indexer.process({ chains: { [MONAD]: { simulate: [cancelItem(KEY_C, 69_400_001, T0 + 1, tx(2))] } } });
    expect(await indexer.Payee.getOrThrow(`${String(MONAD)}-${PAYEE}`)).toMatchObject({ cancellations: 1, payments: 0, firstPaidAt: undefined });
    expect(await indexer.Invoice.getOrThrow(`${String(MONAD)}-${KEY_C}`)).toMatchObject({ cancelledTx: tx(1) });
  });
});
