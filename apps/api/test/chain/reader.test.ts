// SPDX-License-Identifier: MIT
/**
 * The chain reader (src/chain/reader.ts) through a real viem client over a scripted Sepolia RPC: one `eth_call` for any
 * number of twins, states in order (paid, cancelled, expired on chain time, payable), `Paid` events decoded strictly and
 * checked against the twin, retries on pruned history, and explicit failures (`unreadable`, `not-deployed`).
 */
import { createRegistry, registry } from "@paylink/chains";
import { describe, expect, it } from "vitest";
import { createChainReader } from "../../src/chain/factory.ts";
import { MIN_CONFIRMATIONS } from "../../src/chain/reader.ts";
import type { ChainTwin } from "../../src/chain/types.ts";
import { createMemoryStores } from "../../src/store/memory.ts";
import { T0, testRuntime } from "../helpers.ts";
import { KEY, OTHER_KEY, PAYEE, PAYMENT, PYUSD, TX, USDC } from "../reconciler/fixtures.ts";
import { rpcFake } from "./rpc.ts";
import { DEPLOY_BLOCK, fakeChain, fakeReader } from "./sepolia.ts";

const NOW_S = Math.floor(T0 / 1000);
const TWIN: ChainTwin = { key: KEY, payee: PAYEE, token: USDC, rail: "USDC", amountBase: "120000000", validUntil: NOW_S + 86_400, chainPayment: null };
const OTHER: ChainTwin = { ...TWIN, key: OTHER_KEY };

function paidChain(options: { readonly ageS?: number; readonly depth?: number; readonly head?: number } = {}) {
  const chain = fakeChain(NOW_S);
  chain.block = options.head ?? chain.block;
  const age = options.ageS ?? 600;
  // A log `depth` blocks deep (its block counts as one), or where its age puts it.
  const block = options.depth === undefined ? chain.block - Math.floor(age / 12) + 1 : chain.block - options.depth + 1;
  chain.states.set(KEY, { payments: 1, cancelled: false, lastPaidAt: BigInt(NOW_S - age) });
  chain.logs.push({ topic: "paid", key: KEY, payee: PAYEE, token: USDC, amount: 120_000_000n, txHash: TX, block, logIndex: 7 });
  return chain;
}

describe("states", () => {
  it("reads every twin with one eth_call, in order: payable, expired on chain time", async () => {
    const chain = fakeChain(NOW_S);
    const { reader, rpc } = fakeReader(chain);
    const states = await reader.observeMany([TWIN, { ...OTHER, validUntil: NOW_S - 1 }, { ...TWIN, key: `0x${"ef".repeat(32)}`, validUntil: 0 }]);
    expect([...states.values()].map((o) => o.state)).toEqual(["payable", "expired", "payable"]);
    expect(states.get(KEY)).toEqual({ state: "payable", payments: [], paidAt: null, chainTime: NOW_S });
    expect(rpc.calls.map((c) => c.method)).toEqual(["eth_call"]);
    // Expiry is the contract's rule on chain time: `now > validUntil`.
    expect((await reader.observe({ ...TWIN, validUntil: NOW_S })).state).toBe("payable");
  });

  it("finds and verifies the Paid event of a paid twin, with lastPaidAt as its time", async () => {
    const chain = paidChain();
    const { reader, rpc } = fakeReader(chain);
    const observed = await reader.observe(TWIN);
    expect(observed).toMatchObject({ state: "paid", paidAt: NOW_S - 600, chainTime: NOW_S });
    expect(observed.payments).toEqual([{ ...PAYMENT, blockNumber: chain.logs[0]?.block, timestamp: NOW_S - 600 }]);
    expect(rpc.calls.map((c) => c.method)).toEqual(["eth_call", "eth_getLogs"]);
    // The log window starts at most Δt / 12 blocks back (one block per 12-second slot at most).
    const [filter] = rpc.calls[1]?.params as [{ fromBlock: string; toBlock: string }];
    expect(Number(filter.fromBlock)).toBeLessThanOrEqual(chain.logs[0]?.block ?? 0);
    expect(Number(filter.toBlock)).toBe(chain.block);
  });

  it("reuses a verified payment instead of reading logs again", async () => {
    const chain = paidChain();
    const { reader, rpc } = fakeReader(chain);
    const cached = { ...PAYMENT, blockNumber: 1 };
    expect((await reader.observe({ ...TWIN, chainPayment: cached })).payments).toEqual([cached]);
    expect(rpc.calls.map((c) => c.method)).toEqual(["eth_call"]);
  });

  it("leaves a paid twin without a payment while its log is missing or not deep enough", async () => {
    const shallow = paidChain({ depth: MIN_CONFIRMATIONS - 1 });
    expect(await fakeReader(shallow).reader.observe(TWIN)).toMatchObject({ state: "paid", payments: [] });
    expect((await fakeReader(paidChain({ depth: MIN_CONFIRMATIONS })).reader.observe(TWIN)).payments).toHaveLength(1);
    const missing = paidChain();
    missing.logs.length = 0;
    expect(await fakeReader(missing).reader.observe(TWIN)).toMatchObject({ state: "paid", payments: [], paidAt: NOW_S - 600 });
  });

  it("refuses a log for another payee, token, amount or contract (a lying RPC)", async () => {
    for (const change of [{ payee: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const }, { token: PYUSD }, { amount: 1n }, { address: "0x0000000000000000000000000000000000000BAD" as const }]) {
      const chain = paidChain();
      const [log] = chain.logs;
      if (log === undefined) {
        throw new Error("no log");
      }
      chain.logs[0] = { ...log, ...change };
      expect((await fakeReader(chain).reader.observe(TWIN)).payments, Object.keys(change).join()).toEqual([]);
    }
  });

  it("finds an old payment within the registry's 50,000-block log range", async () => {
    const chain = paidChain({ ageS: 5 * 86_400, head: DEPLOY_BLOCK + 100_000 });
    const { reader, rpc } = fakeReader(chain);
    expect((await reader.observe(TWIN)).payments).toHaveLength(1);
    const [filter] = rpc.calls[1]?.params as [{ fromBlock: string; toBlock: string }];
    expect(Number(filter.toBlock) - Number(filter.fromBlock) + 1).toBeLessThanOrEqual(50_000);
    expect(Number(filter.fromBlock)).toBeGreaterThanOrEqual(DEPLOY_BLOCK);
  });

  it("retries pruned history, then reads the twin unreadable rather than unpaid", async () => {
    const chain = paidChain();
    chain.prunedAnswers = 2;
    expect((await fakeReader(chain).reader.observe(TWIN)).payments).toHaveLength(1);
    const stubborn = paidChain();
    stubborn.prunedAnswers = 99;
    expect(await fakeReader(stubborn).reader.observe(TWIN)).toEqual({ state: "unreadable", payments: [], paidAt: null, chainTime: null });
  });

  it("reads a cancelled twin and its InvoiceCancelled transaction", async () => {
    const chain = fakeChain(NOW_S);
    chain.states.set(KEY, { payments: 0, cancelled: true, lastPaidAt: 0n });
    chain.logs.push({ topic: "cancelled", key: KEY, payee: PAYEE, txHash: `0x${"cc".repeat(32)}`, block: chain.block - 3, logIndex: 0 });
    expect(await fakeReader(chain).reader.observe(TWIN)).toEqual({ state: "cancelled", payments: [], paidAt: null, chainTime: NOW_S, cancelTx: `0x${"cc".repeat(32)}` });
  });

  it("spends at most the allowed event lookups per read", async () => {
    const chain = paidChain();
    chain.states.set(OTHER_KEY, { payments: 1, cancelled: false, lastPaidAt: BigInt(NOW_S - 60) });
    const { reader, rpc } = fakeReader(chain);
    const states = await reader.observeMany([TWIN, OTHER], { logLookups: 1 });
    expect(states.get(KEY)?.payments).toHaveLength(1);
    expect(states.get(OTHER_KEY)).toMatchObject({ state: "paid", payments: [] });
    expect(rpc.calls.filter((c) => c.method === "eth_getLogs")).toHaveLength(1);
  });

  it("reads every twin unreadable when the eth_call fails", async () => {
    const chain = fakeChain(NOW_S);
    chain.failCall = true;
    const states = await fakeReader(chain).reader.observeMany([TWIN, OTHER]);
    expect([...states.values()].map((o) => o.state)).toEqual(["unreadable", "unreadable"]);
  });
});

describe("the registry's deployment (decision D-CHAIN)", () => {
  it("reads PayLinkV2 where the shipped registry records it on Sepolia (protocol/deployments/11155111.json)", () => {
    const fake = rpcFake(() => {
      throw new Error("no request expected");
    });
    const reader = createChainReader({ runtime: { ...testRuntime(), fetch: fake.fetch }, stores: createMemoryStores() });
    expect(reader.chainId).toBe(11155111);
    expect(registry.v2Target(11155111)?.deployment).toMatchObject({ address: "0x448eCce9711860502806A3d5B021a4f9Ba715082", blockNumber: 12_017_054n });
    expect(reader.deployed).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("answers not-deployed without any request while the registry records no deployment", async () => {
    const fake = rpcFake(() => {
      throw new Error("no request expected");
    });
    const undeployed = createRegistry(registry.chains.map((chain) => (chain.chainId === 11155111 ? { ...chain, deployment: null } : chain)));
    const reader = createChainReader({ runtime: { ...testRuntime(), fetch: fake.fetch, registry: undeployed }, stores: createMemoryStores() });
    expect(reader.deployed).toBe(false);
    expect(await reader.observe(TWIN)).toEqual({ state: "not-deployed", payments: [], paidAt: null, chainTime: null });
    expect([...(await reader.observeMany([TWIN, OTHER])).values()].map((o) => o.state)).toEqual(["not-deployed", "not-deployed"]);
    expect(fake.calls).toEqual([]);
  });
});
