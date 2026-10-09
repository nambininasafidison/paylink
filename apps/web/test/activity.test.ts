// SPDX-License-Identifier: MIT
/**
 * A payee's history and record (src/read/activity.ts), on both paths of the read model (ADR 0009):
 * - the history service answers: its payments and totals, labelled as the indexer's;
 * - it is absent, fails or does not serve a chain: the chains' own RPCs, scanned over a bounded number of log ranges
 *   (never more than CHAIN_SCAN_REQUESTS `eth_getLogs` of the chain's cap), decoded strictly;
 * - both fail: "none", and the caller says history is unavailable.
 * Also the ledger's time to get paid (src/read/settle.ts) and coarse durations (src/core/duration.ts).
 */
import { featureTranslator } from "@paylink/i18n";
import { PAID_TOPIC } from "@paylink/sdk";
import { encodeAbiParameters, pad, toHex } from "viem";
import type { Address, Hex, RpcLog } from "viem";
import { describe, expect, it, vi } from "vitest";
import { durationText } from "../src/core/duration.ts";
import { activitySource, CHAIN_SCAN_REQUESTS, newestFirst, readPayeeActivity, scanRecentPayments, trustFigures } from "../src/read/activity.ts";
import type { ActivitySource } from "../src/read/activity.ts";
import { INDEXER_TIMEOUT_MS, indexerClient } from "../src/read/indexer.ts";
import type { IndexedPayee } from "../src/read/indexer.ts";
import type { LedgerRow } from "../src/read/ledger.ts";
import { paidLogReader } from "../src/read/paid-reader.ts";
import { firstPaidKey, medianSettleTime } from "../src/read/settle.ts";
import { CHAIN_ID, CONTRACT, issue, localChain, registry, TOKEN_ADDRESS } from "./helpers.ts";

const PAYEE: Address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OTHER: Address = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const PAYER: Address = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const KEY: Hex = `0x${"ab".repeat(32)}`;
const HEAD = 5_000n;
/** Block time of the fake chain: 2 s blocks from 2026-10-09T00:00:00Z. */
const T0 = 1_791_504_000n;
const timeOf = (block: bigint): bigint => T0 + block * 2n;

function paidLog(options: { block: bigint; logIndex?: number; payee?: Address; amount?: bigint; address?: Address; data?: Hex; tx?: number }): RpcLog {
  const data = options.data ?? encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "bytes32" }], [TOKEN_ADDRESS, options.amount ?? 1_000_000n, 0, `0x${"00".repeat(32)}`]);
  return {
    address: options.address ?? CONTRACT,
    topics: [PAID_TOPIC, KEY, pad(options.payee ?? PAYEE, { size: 32 }), pad(PAYER, { size: 32 })],
    data,
    blockNumber: toHex(options.block),
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: toHex(options.tx ?? Number(options.block), { size: 32 }),
    transactionIndex: "0x0",
    logIndex: toHex(options.logIndex ?? 0),
    removed: false,
  };
}

/** A chain whose `eth_getLogs` filters the given logs by range and topics, recording each request. */
function chainWith(logs: readonly RpcLog[], options: { down?: boolean } = {}) {
  const requests: { from: bigint; to: bigint }[] = [];
  const fail = (): never => {
    throw new Error("HTTP request failed");
  };
  const client = {
    getBlockNumber: vi.fn(() => (options.down === true ? Promise.reject(new Error("down")) : Promise.resolve(HEAD))),
    getBlock: vi.fn(({ blockNumber }: { blockNumber: bigint }) => Promise.resolve({ number: blockNumber, timestamp: timeOf(blockNumber) })),
    getLogs: vi.fn((filter: { fromBlock: bigint; toBlock: bigint; topics: readonly (Hex | null)[] }) => {
      if (options.down === true) {
        fail();
      }
      requests.push({ from: filter.fromBlock, to: filter.toBlock });
      return Promise.resolve(
        logs.filter((log) => {
          const block = BigInt(log.blockNumber ?? "0x0");
          return block >= filter.fromBlock && block <= filter.toBlock && filter.topics.every((topic, i) => topic === null || log.topics[i]?.toLowerCase() === topic.toLowerCase());
        }),
      );
    }),
  };
  return { client, requests };
}

const sourceOf = (client: ReturnType<typeof chainWith>["client"], indexer: ActivitySource["indexer"] = null): ActivitySource => ({ indexer, paid: paidLogReader, chains: [{ chain: localChain(), client, contract: CONTRACT }] });

/** A history service answering every query from fixed rows. */
function serviceAnswering(data: Record<string, unknown> | null, chains: readonly number[] = [CHAIN_ID]) {
  const fetcher = vi.fn(() => (data === null ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 })))) as unknown as typeof fetch;
  return { indexer: indexerClient({ indexer: { url: "https://indexer.example/v1/graphql", chains: [...chains] } }, fetcher), fetcher };
}

const indexedPayee: Record<string, unknown> = { chainId: CHAIN_ID, payee: PAYEE, payments: 3, links: 2, uniquePayers: 2, cancellations: 0, firstPaidAt: String(T0), lastPaidAt: String(T0 + 600n) };
const indexedPayment = (logIndex: number): Record<string, unknown> => ({
  chainId: CHAIN_ID,
  key: KEY,
  payee: PAYEE,
  payer: PAYER,
  token: TOKEN_ADDRESS.toLowerCase(),
  amount: "1000000",
  index: 0,
  payerRef: `0x${"00".repeat(32)}`,
  blockNumber: "4000",
  timestamp: String(T0 + 600n),
  txHash: `0x${"cd".repeat(32)}`,
  logIndex,
});

describe("readPayeeActivity: history service first", () => {
  it("takes payments and totals from the history service when it serves every chain", async () => {
    const { client } = chainWith([]);
    const { indexer } = serviceAnswering({ Payee: [indexedPayee], PayeeToken: [{ chainId: CHAIN_ID, token: TOKEN_ADDRESS.toLowerCase(), payments: 3, volume: "3000000" }], Payment: [indexedPayment(1), indexedPayment(0)] });
    const activity = await readPayeeActivity(sourceOf(client, indexer), PAYEE);
    expect(activity.source).toBe("indexer");
    if (activity.source !== "indexer") {
      return;
    }
    expect(activity.payments.map((p) => [p.logIndex, p.amount, p.timestamp])).toEqual([
      [1, 1_000_000n, T0 + 600n],
      [0, 1_000_000n, T0 + 600n],
    ]);
    expect(activity.summaries[0]?.tokens).toEqual([{ token: TOKEN_ADDRESS.toLowerCase(), payments: 3, volume: 3_000_000n }]);
    // The chain was not scanned.
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it("falls back to the chain when the history service fails, and says how it failed", async () => {
    const { client } = chainWith([paidLog({ block: 4_990n })]);
    const { indexer } = serviceAnswering(null);
    const activity = await readPayeeActivity(sourceOf(client, indexer), PAYEE);
    expect(activity).toMatchObject({ source: "chain", indexerProblem: "offline" });
  });

  it("falls back to the chain when the history service sends its headers, then never finishes its body", async () => {
    vi.useFakeTimers();
    try {
      const { client } = chainWith([paidLog({ block: 4_990n })]);
      // Each query gets its headers at once and a body that never ends (the stream errors when the request aborts).
      const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":{"Payment":['));
            init?.signal?.addEventListener("abort", () => {
              controller.error(init.signal?.reason);
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }) as unknown as typeof fetch;
      const indexer = indexerClient({ indexer: { url: "https://indexer.example/v1/graphql", chains: [CHAIN_ID] } }, fetcher);
      let activity: Awaited<ReturnType<typeof readPayeeActivity>> | null = null;
      const reading = readPayeeActivity(sourceOf(client, indexer), PAYEE).then((result) => {
        activity = result;
      });
      await vi.advanceTimersByTimeAsync(INDEXER_TIMEOUT_MS - 1);
      expect(activity).toBeNull();
      expect(client.getLogs).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await reading;
      expect(activity).toMatchObject({ source: "chain", indexerProblem: "offline", payments: [{ blockNumber: 4_990n }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the chain, without a problem, when the history service does not serve the chain", async () => {
    const { client } = chainWith([]);
    const { indexer, fetcher } = serviceAnswering({}, [10143]);
    expect(await readPayeeActivity(sourceOf(client, indexer), PAYEE)).toMatchObject({ source: "chain", indexerProblem: null, payments: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports nothing when both the history service and the chain fail", async () => {
    const { client } = chainWith([], { down: true });
    const { indexer } = serviceAnswering(null);
    expect(await readPayeeActivity(sourceOf(client, indexer), PAYEE)).toEqual({ source: "none", indexerProblem: "offline" });
    expect(await readPayeeActivity({ indexer: null, paid: paidLogReader, chains: [] }, PAYEE)).toEqual({ source: "none", indexerProblem: null });
  });
});

describe("scanRecentPayments: the bounded chain fallback", () => {
  it("scans at most CHAIN_SCAN_REQUESTS log ranges back from the head, each within the chain's cap", async () => {
    const { client, requests } = chainWith([]);
    const { payments, windows } = await scanRecentPayments(sourceOf(client), PAYEE);
    expect(payments).toEqual([]);
    expect(requests).toHaveLength(CHAIN_SCAN_REQUESTS);
    expect(requests.every((r) => r.to - r.from + 1n <= 100n)).toBe(true);
    expect(requests[0]).toEqual({ from: HEAD - 99n, to: HEAD });
    expect(windows).toEqual([{ chainId: CHAIN_ID, fromBlock: HEAD - 999n, toBlock: HEAD, seconds: 999n * 2n }]);
  });

  it("decodes the payee's Paid logs newest first, with block times, and ignores anything else", async () => {
    const logs = [
      paidLog({ block: 4_100n, amount: 1n }),
      paidLog({ block: 4_900n, amount: 2n, logIndex: 1 }),
      paidLog({ block: 4_900n, amount: 3n, logIndex: 2, tx: 77 }),
      paidLog({ block: 4_950n, payee: OTHER }),
      paidLog({ block: 4_960n, address: "0x0000000000000000000000000000000000000001" }),
      paidLog({ block: 4_970n, data: "0x1234" }),
      paidLog({ block: 3_000n, amount: 9n }),
    ];
    const { client } = chainWith(logs);
    const { payments } = await scanRecentPayments(sourceOf(client), PAYEE);
    expect(payments.map((p) => [p.blockNumber, p.logIndex, p.amount])).toEqual([
      [4_900n, 2, 3n],
      [4_900n, 1, 2n],
      [4_100n, 0, 1n],
    ]);
    expect(payments[0]).toMatchObject({ chainId: CHAIN_ID, key: KEY, payer: PAYER, token: TOKEN_ADDRESS.toLowerCase(), timestamp: timeOf(4_900n), txHash: toHex(77, { size: 32 }) });
  });

  it("stops early once it has enough payments", async () => {
    const logs = Array.from({ length: 5 }, (_, i) => paidLog({ block: HEAD - BigInt(i) }));
    const { client, requests } = chainWith(logs);
    const { payments } = await scanRecentPayments(sourceOf(client), PAYEE, 3);
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.timestamp === timeOf(p.blockNumber))).toBe(true);
    expect(requests).toHaveLength(1);
  });
});

describe("the payee's record", () => {
  it("sums the history service's figures across chains, since the earliest first payment", () => {
    const summary = (chainId: number, payments: number, payers: number, first: bigint | null): IndexedPayee => ({ chainId, payee: PAYEE, payments, links: 1, uniquePayers: payers, cancellations: 0, firstPaidAt: first, lastPaidAt: first, tokens: [] });
    expect(trustFigures([summary(10143, 4, 3, 200n), summary(84532, 2, 1, 100n), summary(1, 0, 0, null)])).toEqual({ payments: 6, payers: 4, since: 100n });
    expect(trustFigures([])).toEqual({ payments: 0, payers: 0, since: null });
  });

  it("orders payments without a block time after those with one", () => {
    const base = { chainId: 1, key: KEY, payer: PAYER, token: PAYER, amount: 1n, index: 0, txHash: KEY };
    const sorted = newestFirst([
      { ...base, timestamp: null, blockNumber: 9n, logIndex: 0 },
      { ...base, timestamp: 5n, blockNumber: 2n, logIndex: 0 },
      { ...base, timestamp: 5n, blockNumber: 3n, logIndex: 0 },
      { ...base, timestamp: 5n, blockNumber: 3n, logIndex: 1 },
    ]);
    expect(sorted.map((p) => [p.timestamp, p.blockNumber, p.logIndex])).toEqual([
      [5n, 3n, 1],
      [5n, 3n, 0],
      [5n, 2n, 0],
      [null, 9n, 0],
    ]);
  });

  it("reads only the edition's deployed chains, or the ones asked for", () => {
    const app = { config: { indexer: null }, registry, client: () => chainWith([]).client };
    expect(activitySource(app as never, paidLogReader).chains.map((c) => c.chain.chainId)).toEqual([CHAIN_ID]);
    expect(activitySource(app as never, paidLogReader, [10143]).chains).toEqual([]);
    expect(activitySource(app as never, paidLogReader).indexer).toBeNull();
  });
});

describe("time to get paid", () => {
  const row = async (options: { createdAt: number; maxPayments?: number; payments: number; lastPaidAt: bigint }): Promise<Pick<LedgerRow, "record" | "link" | "state">> => {
    const issued = await issue({ createdAt: options.createdAt, ...(options.maxPayments === undefined ? {} : { maxPayments: options.maxPayments }) });
    return { record: issued.record, link: issued.link, state: { payments: options.payments, cancelled: false, lastPaidAt: options.lastPaidAt, total: 1n } };
  };

  it("uses the chain's payment time for one-off invoices and the median over the device's invoices", async () => {
    const rows = await Promise.all([
      row({ createdAt: 1_000_000, payments: 1, lastPaidAt: 1_060n }), // 60 s
      row({ createdAt: 2_000_000, payments: 1, lastPaidAt: 2_300n }), // 300 s
      row({ createdAt: 3_000_000, payments: 1, lastPaidAt: 3_120n }), // 120 s
      row({ createdAt: 4_000_000, payments: 0, lastPaidAt: 0n }), // unpaid
    ]);
    expect(medianSettleTime(rows)).toEqual({ median: 120, count: 3 });
    expect(medianSettleTime(rows.slice(0, 2))).toEqual({ median: 180, count: 2 });
  });

  it("needs the history service's first payment for a multi-payment link, and skips a device clock ahead of the chain", async () => {
    const seats = await row({ createdAt: 1_000_000, maxPayments: 5, payments: 3, lastPaidAt: 9_000n });
    expect(medianSettleTime([seats])).toBeNull();
    expect(medianSettleTime([seats], new Map([[firstPaidKey(seats.link.chainId, seats.link.key), 1_030n]]))).toEqual({ median: 30, count: 1 });
    const ahead = await row({ createdAt: 5_000_000, payments: 1, lastPaidAt: 4_000n });
    expect(medianSettleTime([ahead])).toBeNull();
    expect(medianSettleTime([{ ...ahead, state: null }])).toBeNull();
  });

  it("words a duration in one rounded unit", async () => {
    // The words are in the `history` feature catalogue (src/core/duration.ts).
    const i18n = await featureTranslator("en", "history");
    expect(durationText(i18n, 1)).toBe("1 second");
    expect(durationText(i18n, 45)).toBe("45 seconds");
    expect(durationText(i18n, 420)).toBe("7 minutes");
    expect(durationText(i18n, 2 * 3600)).toBe("2 hours");
    expect(durationText(i18n, 3n * 86_400n)).toBe("3 days");
    expect(durationText(i18n, -5)).toBe("0 seconds");
  });
});
