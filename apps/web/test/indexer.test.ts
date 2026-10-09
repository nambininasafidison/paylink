// SPDX-License-Identifier: MIT
/**
 * The history service's client (src/read/indexer.ts) against a scripted GraphQL endpoint: what it asks, how strictly
 * it reads the answer, how each failure is classified, and that payment and receipt code never imports it (ADR 0009:
 * the indexer is a cache, never a source for a payment state or a proof).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IndexerError, indexerClient, indexerFor, parsePayment } from "../src/read/indexer.ts";

const URL_ = "https://indexer.dev.hyperindex.xyz/abc123/v1/graphql";
const PAYEE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAYER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const AUSD = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc";
const KEY = `0x${"ab".repeat(32)}`;
const TX = `0x${"cd".repeat(32)}`;
const config = { indexer: { url: URL_, chains: [10143, 84532] } };

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: { query: string; variables: Record<string, unknown> };
}

/** A GraphQL endpoint that answers `data` (or a whole body / status) and records each request. */
function endpoint(answer: unknown, status = 200): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as Call["body"];
    calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init: init ?? {}, body });
    return Promise.resolve(new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status }));
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const payment = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  chainId: 10143,
  key: KEY,
  payee: PAYEE,
  payer: PAYER,
  token: AUSD,
  amount: "25000000",
  index: 0,
  payerRef: `0x${"00".repeat(32)}`,
  blockNumber: "69400000",
  timestamp: "1791504600",
  txHash: TX,
  logIndex: 3,
  ...overrides,
});

describe("indexerClient", () => {
  it("is absent when /config.json names no history service", () => {
    expect(indexerClient({ indexer: null })).toBeNull();
    expect(indexerFor({ indexer: null })).toBeNull();
  });

  it("is one client per loaded configuration", () => {
    const loaded = { indexer: { url: URL_, chains: [10143] } };
    expect(indexerFor(loaded)).toBe(indexerFor(loaded));
    expect(indexerFor(loaded)?.url).toBe(URL_);
  });

  it("asks only the configured endpoint, by POST, without credentials or referrer", async () => {
    const { fetcher, calls } = endpoint({ data: { Payee: [], PayeeToken: [] } });
    const client = indexerClient(config, fetcher);
    await client?.payee(PAYEE.toUpperCase().replace("0X", "0x") as `0x${string}`, [10143]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(URL_);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.referrerPolicy).toBe("no-referrer");
    expect(call?.init.cache).toBe("no-store");
    expect(new Headers(call?.init.headers).get("content-type")).toBe("application/json");
    // Addresses are sent lowercase: the indexer stores them so (apps/indexer config.yaml address_format).
    expect(call?.body.variables).toEqual({ payee: PAYEE, chains: [10143] });
    expect(call?.body.query).toContain("Payee(where:");
  });

  it("serves only the chains /config.json lists, and asks nothing for the others", async () => {
    const { fetcher, calls } = endpoint({ data: {} });
    const client = indexerClient({ indexer: { url: URL_, chains: [84532] } }, fetcher);
    expect(client?.serves(84532)).toBe(true);
    expect(client?.serves(10143)).toBe(false);
    expect(await client?.payee(PAYEE, [10143])).toEqual([]);
    expect(await client?.payments(PAYEE, [10143], 10)).toEqual([]);
    expect(await client?.firstPayments(10143, [KEY as `0x${string}`])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("reads a payee's totals per chain with its per-token volumes, amounts as strings or exact numbers", async () => {
    const { fetcher } = endpoint({
      data: {
        Payee: [
          { chainId: 10143, payee: PAYEE, payments: 12, links: 7, uniquePayers: 5, cancellations: 1, firstPaidAt: "1791417600", lastPaidAt: 1791504600 },
          { chainId: 84532, payee: PAYEE, payments: 0, links: 0, uniquePayers: 0, cancellations: 2, firstPaidAt: null, lastPaidAt: null },
        ],
        PayeeToken: [{ chainId: 10143, token: AUSD, payments: 12, volume: "340282366920938463463374607431768211455" }],
      },
    });
    const rows = await indexerClient(config, fetcher)?.payee(PAYEE, [10143, 84532]);
    expect(rows).toEqual([
      { chainId: 10143, payee: PAYEE, payments: 12, links: 7, uniquePayers: 5, cancellations: 1, firstPaidAt: 1_791_417_600n, lastPaidAt: 1_791_504_600n, tokens: [{ token: AUSD, payments: 12, volume: 2n ** 128n - 1n }] },
      { chainId: 84532, payee: PAYEE, payments: 0, links: 0, uniquePayers: 0, cancellations: 2, firstPaidAt: null, lastPaidAt: null, tokens: [] },
    ]);
  });

  it("reads payments newest first as asked, capping the page at 100", async () => {
    const { fetcher, calls } = endpoint({ data: { Payment: [payment({ logIndex: 4 }), payment({ amount: 7 })] } });
    const rows = await indexerClient(config, fetcher)?.payments(PAYEE, [10143, 84532, 10143], 500);
    expect(calls[0]?.body.variables).toEqual({ payee: PAYEE, chains: [10143, 84532], limit: 100 });
    expect(calls[0]?.body.query).toMatch(/order_by: \[\{timestamp: desc\}, \{logIndex: desc\}\]/);
    expect(rows?.map((r) => [r.amount, r.logIndex])).toEqual([
      [25_000_000n, 4],
      [7n, 3],
    ]);
    expect(rows?.[0]).toMatchObject({ chainId: 10143, key: KEY, payee: PAYEE, payer: PAYER, token: AUSD, index: 0, blockNumber: 69_400_000n, timestamp: 1_791_504_600n, txHash: TX });
  });

  it("reads first payment times only for the keys it was asked about", async () => {
    const { fetcher, calls } = endpoint({ data: { Invoice: [{ key: KEY, payments: 3, firstPaidAt: "1791417600" }] } });
    const rows = await indexerClient(config, fetcher)?.firstPayments(10143, [KEY.toUpperCase().replace("0X", "0x") as `0x${string}`, KEY as `0x${string}`]);
    expect(calls[0]?.body.variables).toEqual({ chainId: 10143, keys: [KEY] });
    expect(rows).toEqual([{ key: KEY, payments: 3, firstPaidAt: 1_791_417_600n }]);
    const other = endpoint({ data: { Invoice: [{ key: `0x${"ef".repeat(32)}`, payments: 1, firstPaidAt: null }] } });
    await expect(indexerClient(config, other.fetcher)?.firstPayments(10143, [KEY as `0x${string}`])).rejects.toMatchObject({ code: "shape" });
    expect(await indexerClient(config, other.fetcher)?.firstPayments(10143, [])).toEqual([]);
  });

  it("reads the processed block per chain, a chain not started yet as block 0, not ready", async () => {
    const { fetcher } = endpoint({ data: { _meta: [{ chainId: 10143, progressBlock: 69400123, isReady: true }, { chainId: 84532, progressBlock: -1, isReady: false }] } });
    expect(await indexerClient(config, fetcher)?.progress()).toEqual([
      { chainId: 10143, progressBlock: 69_400_123n, ready: true },
      { chainId: 84532, progressBlock: 0n, ready: false },
    ]);
  });

  it.each([
    ["an uppercase address", { Payment: [payment({ payer: PAYER.toUpperCase().replace("0X", "0x") })] }],
    ["a short key", { Payment: [payment({ key: "0xab" })] }],
    ["an amount past 2^53 sent as a JSON number", { Payment: [payment({ amount: 2 ** 60 })] }],
    ["a negative amount", { Payment: [payment({ amount: "-1" })] }],
    ["a fractional log index", { Payment: [payment({ logIndex: 1.5 })] }],
    ["another payee's payment", { Payment: [payment({ payee: PAYER })] }],
    ["a chain it did not ask for", { Payment: [payment({ chainId: 1 })] }],
    ["more rows than the limit", { Payment: [payment(), payment(), payment()] }],
    ["no list at all", { Payment: null }],
    ["a row that is not an object", { Payment: ["0x"] }],
  ])("refuses %s as a malformed answer", async (_name, data) => {
    const { fetcher } = endpoint({ data });
    await expect(indexerClient(config, fetcher)?.payments(PAYEE, [10143], 2)).rejects.toMatchObject({ name: "IndexerError", code: "shape" });
  });

  it("refuses a payee row for another address or chain", async () => {
    const wrong = endpoint({ data: { Payee: [{ chainId: 10143, payee: PAYER, payments: 1, links: 1, uniquePayers: 1, cancellations: 0, firstPaidAt: "1", lastPaidAt: "1" }], PayeeToken: [] } });
    await expect(indexerClient(config, wrong.fetcher)?.payee(PAYEE, [10143])).rejects.toMatchObject({ code: "shape" });
    const token = endpoint({ data: { Payee: [], PayeeToken: [{ chainId: 10143, token: "0x1", payments: 1, volume: "1" }] } });
    await expect(indexerClient(config, token.fetcher)?.payee(PAYEE, [10143])).rejects.toMatchObject({ code: "shape" });
  });

  it("classifies failures: offline, HTTP status, GraphQL errors, non-JSON and oversized answers", async () => {
    const offline = vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    await expect(indexerClient(config, offline)?.progress()).rejects.toMatchObject({ code: "offline" });
    await expect(indexerClient(config, endpoint({ data: {} }, 503).fetcher)?.progress()).rejects.toMatchObject({ code: "http" });
    const refused = await indexerClient(config, endpoint({ errors: [{ message: "field 'Payee' not found in type: 'query_root'" }] }).fetcher)
      ?.progress()
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IndexerError);
    expect(refused).toMatchObject({ code: "graphql", message: expect.stringContaining("query_root") as unknown });
    await expect(indexerClient(config, endpoint("<html>").fetcher)?.progress()).rejects.toMatchObject({ code: "shape" });
    await expect(indexerClient(config, endpoint("[]").fetcher)?.progress()).rejects.toMatchObject({ code: "shape" });
    await expect(indexerClient(config, endpoint({ nothing: true }).fetcher)?.progress()).rejects.toMatchObject({ code: "shape" });
    await expect(indexerClient(config, endpoint(`{"data":{"_meta":[]},"pad":"${"x".repeat(600_000)}"}`).fetcher)?.progress()).rejects.toMatchObject({ code: "shape" });
  });

  it("parses one payment strictly", () => {
    expect(parsePayment(payment()).amount).toBe(25_000_000n);
    expect(() => parsePayment(null)).toThrow(IndexerError);
  });
});

describe("module boundary (ADR 0009)", () => {
  const src = join(import.meta.dirname, "../src");
  const read = (path: string): string => readFileSync(join(src, path), "utf8");
  const historyModules = /read\/(indexer|activity|settle|paid-reader)\.ts|ledger-history\.ts/;

  it("keeps payment rails, the pay view, receipt verification and payability checks away from the history service", () => {
    const guarded = [...readdirSync(join(src, "rails")).map((f) => `rails/${f}`), "pages/pay.ts", "pages/receipt.ts", "app/proof-slip.ts", "read/checks.ts", "app/cancel.ts", "app/payer.ts", "core/relayer.ts"];
    for (const file of guarded) {
      expect(read(file), file).not.toMatch(historyModules);
    }
  });

  it("keeps the history reader free of runtime imports outside it, so a page can load it lazily", () => {
    // A lazily loaded module that imports code a page's first load already has makes the bundler move that code into
    // chunks of its own, which grows the first load (measured on the pay route: +1.2 kB). The SDK's decoder is passed in.
    const own = /^\.\/(history|indexer)\.ts$/;
    for (const file of ["read/activity.ts", "read/indexer.ts", "read/history.ts", "core/duration.ts"]) {
      const runtime = [...read(file).matchAll(/^import (?!type )[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1] ?? "");
      expect(runtime.filter((path) => !own.test(path)), file).toEqual([]);
    }
  });
});
