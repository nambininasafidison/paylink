// SPDX-License-Identifier: MIT
/**
 * The Mezo edition's chain client (editions/mezo/client.ts) on Mezo testnet, whose RPC answers `null` for mined
 * transactions about one lookup in two (docs/research/mezo.md §2, ADR 0017): a receipt lookup is asked again on the
 * registry's schedule before it says "not found"; on a chain without the flag it is asked once.
 */
import { TransactionReceiptNotFoundError } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chainClient } from "../../src/core/clients.ts";
import { mezoClient } from "../../src/editions/mezo/client.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { appRegistry } from "../../src/core/registry.ts";
import { localChain } from "../helpers.ts";

const HASH = `0x${"cd".repeat(32)}` as const;
const RECEIPT = {
  transactionHash: HASH,
  transactionIndex: "0x0",
  blockHash: `0x${"01".repeat(32)}`,
  blockNumber: "0x64",
  from: "0x0000000000000000000000000000000000000001",
  to: "0x0000000000000000000000000000000000000002",
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x92",
  contractAddress: null,
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  type: "0x2",
};

/** An RPC whose first `nulls` receipt lookups answer `null`; counts them. */
function nullFirst(nulls: number): { lookups: () => number } {
  let lookups = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as { id: number; method: string };
      lookups += body.method === "eth_getTransactionReceipt" ? 1 : 0;
      const result = body.method === "eth_getTransactionReceipt" && lookups > nulls ? RECEIPT : null;
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } }));
    }),
  );
  return { lookups: () => lookups };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Mezo edition chain client", () => {
  const mezo = appRegistry("mezo").getOrThrow(31611);

  it("asks Mezo testnet again for a receipt it answered null for", async () => {
    const rpc = nullFirst(2);
    const base = chainClient(mezo, { ...DEFAULT_CONFIG, rpc: { "31611": ["https://mezo-flaky-1.example"] } });
    const client = mezoClient(mezo, base);
    expect(mezoClient(mezo, base)).toBe(client);
    const receipt = await client.getTransactionReceipt({ hash: HASH });
    expect(receipt.status).toBe("success");
    expect(rpc.lookups()).toBe(3);
  });

  it("asks a chain without the flag once", async () => {
    const rpc = nullFirst(2);
    const base = chainClient(localChain(), { ...DEFAULT_CONFIG, rpc: { "31337": ["https://local-once.example"] } });
    const client = mezoClient(localChain(), base);
    expect(client).toBe(base);
    await expect(client.getTransactionReceipt({ hash: HASH })).rejects.toBeInstanceOf(TransactionReceiptNotFoundError);
    expect(rpc.lookups()).toBe(1);
  });
});
