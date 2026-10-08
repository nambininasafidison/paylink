// SPDX-License-Identifier: MIT
/**
 * Read clients (read model rank 1): the registry's RPCs in fallback order, preferred RPCs from /config.json first,
 * exactly the reads the app makes, and chain time from the latest block (never the device clock).
 */
import { registry as shipped } from "@paylink/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chainClient, chainTime, pollingIntervalFor } from "../src/core/clients.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { CONTRACT, localChain, payer, TOKEN_ADDRESS } from "./helpers.ts";

const HASH = `0x${"ab".repeat(32)}` as const;
const BLOCK = {
  number: "0x64",
  hash: `0x${"01".repeat(32)}`,
  parentHash: `0x${"02".repeat(32)}`,
  timestamp: "0x6a74a800",
  transactions: [],
  logsBloom: `0x${"00".repeat(256)}`,
  gasLimit: "0x1c9c380",
  gasUsed: "0x0",
  baseFeePerGas: "0x3b9aca00",
  miner: "0x0000000000000000000000000000000000000000",
  extraData: "0x",
  difficulty: "0x0",
  totalDifficulty: "0x0",
  size: "0x0",
  nonce: "0x0000000000000000",
  sha3Uncles: `0x${"00".repeat(32)}`,
  stateRoot: `0x${"00".repeat(32)}`,
  receiptsRoot: `0x${"00".repeat(32)}`,
  transactionsRoot: `0x${"00".repeat(32)}`,
  mixHash: `0x${"00".repeat(32)}`,
  uncles: [],
};
const RECEIPT = {
  transactionHash: HASH,
  transactionIndex: "0x0",
  blockHash: BLOCK.hash,
  blockNumber: "0x64",
  from: payer.address,
  to: CONTRACT,
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x3b9aca00",
  contractAddress: null,
  logs: [],
  logsBloom: BLOCK.logsBloom,
  status: "0x1",
  type: "0x2",
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly params: unknown[];
}

function rpcServer(answers: (method: string, params: unknown[], url: string) => unknown): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
      const one = (request: { id: number; method: string; params: unknown[] }) => {
        seen.push({ url, method: request.method, params: request.params });
        const result = answers(request.method, request.params, url);
        if (result instanceof Error) {
          throw result;
        }
        return { jsonrpc: "2.0", id: request.id, result };
      };
      try {
        return Promise.resolve(new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } }));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("rpc failure"));
      }
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chainClient", () => {
  it("makes each read the app needs over JSON-RPC", async () => {
    let receiptCalls = 0;
    const seen = rpcServer((method) => {
      switch (method) {
        case "eth_chainId":
          return "0x7a69";
        case "eth_call":
          return `0x${"00".repeat(31)}2a`;
        case "eth_getCode":
          return "0x6000";
        case "eth_getBlockByNumber":
          return BLOCK;
        case "eth_blockNumber":
          return "0x64";
        case "eth_getTransactionReceipt":
          receiptCalls += 1;
          return receiptCalls < 2 ? null : RECEIPT;
        case "eth_estimateGas":
          return "0x1d4c0";
        case "eth_getBalance":
          return "0xde0b6b3a7640000";
        case "eth_getLogs":
          return [];
        default:
          return new Error(`unexpected ${method}`);
      }
    });
    const client = chainClient(localChain(), { ...DEFAULT_CONFIG, rpc: { "31337": ["https://preferred.example"] } });
    expect(await client.getCode({ address: CONTRACT })).toBe("0x6000");
    expect((await client.call({ to: CONTRACT, data: "0x12345678", account: payer.address, value: 0n, gas: 50_000n, blockNumber: 99n })).data).toBe(`0x${"00".repeat(31)}2a`);
    expect(await client.getBlockNumber()).toBe(100n);
    expect(await client.getBlock({ blockTag: "latest" })).toEqual({ number: 100n, timestamp: 0x6a74a800n });
    expect(await client.getBlock({ blockNumber: 100n })).toEqual({ number: 100n, timestamp: 0x6a74a800n });
    expect(await chainTime(client)).toBe(0x6a74a800n);
    expect(await client.estimateGas({ from: payer.address, to: CONTRACT, data: "0x", value: 1n })).toBe(120_000n);
    expect(await client.getBalance(payer.address)).toBe(10n ** 18n);
    expect(await client.erc20(TOKEN_ADDRESS, "balanceOf", [payer.address])).toBe(42n);
    expect(await client.erc20(TOKEN_ADDRESS, "allowance", [payer.address, CONTRACT])).toBe(42n);
    expect(await client.getLogs({ address: CONTRACT, fromBlock: 90n, toBlock: 100n, topics: [HASH, null] })).toEqual([]);
    const receipt = await client.waitForReceipt(HASH, { pollingMs: 1, timeoutMs: 5_000 });
    expect(receipt.status).toBe("success");
    // The preferred RPC from /config.json is tried first.
    expect(new Set(seen.map((s) => new URL(s.url).origin))).toEqual(new Set(["https://preferred.example"]));
    const logs = seen.find((s) => s.method === "eth_getLogs");
    expect(logs?.params).toEqual([{ address: CONTRACT, fromBlock: "0x5a", toBlock: "0x64", topics: [HASH, null] }]);
    const estimate = seen.find((s) => s.method === "eth_estimateGas");
    expect(estimate?.params).toEqual([{ from: payer.address, to: CONTRACT, data: "0x", value: "0x1" }]);
  });

  it("falls back to the registry's RPC when the preferred one fails", async () => {
    const seen = rpcServer((method, _params, url) => (url.includes("preferred") ? new Error("down") : method === "eth_getCode" ? "0x" : null));
    const client = chainClient(localChain(), { ...DEFAULT_CONFIG, rpc: { "31337": ["https://preferred-down.example"] } });
    expect(await client.getCode({ address: CONTRACT })).toBeUndefined();
    expect(seen.map((s) => new URL(s.url).origin)).toEqual(["https://preferred-down.example", "https://preferred-down.example", "http://127.0.0.1:8545"]);
  });

  it("caches one client per chain and RPC list", () => {
    const a = chainClient(localChain(), DEFAULT_CONFIG);
    expect(chainClient(localChain(), DEFAULT_CONFIG)).toBe(a);
    expect(chainClient(localChain(), { ...DEFAULT_CONFIG, rpc: { "31337": ["https://other.example"] } })).not.toBe(a);
  });

  it("gives up waiting for a receipt after its timeout", async () => {
    rpcServer((method) => (method === "eth_getTransactionReceipt" ? null : "0x"));
    const client = chainClient(localChain(), { ...DEFAULT_CONFIG, rpc: { "31337": ["https://slow.example"] } });
    await expect(client.waitForReceipt(HASH, { pollingMs: 1, timeoutMs: 20 })).rejects.toThrow();
  });

  it("polls about once a block", () => {
    expect(pollingIntervalFor(shipped.getOrThrow(10143))).toBe(400);
    expect(pollingIntervalFor(shipped.getOrThrow(84532))).toBe(1000);
    expect(pollingIntervalFor(localChain())).toBe(250);
  });
});
