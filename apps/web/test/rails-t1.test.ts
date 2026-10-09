// SPDX-License-Identifier: MIT
/**
 * The T1 rails and the PaymentRouter's inputs:
 * - authorisation rails: one EIP-3009 signature, persisted before it is sent anywhere; a live one is resubmitted and
 *   never re-signed; a used one is the payment it made, found by the token's `AuthorizationUsed(payer, nonce)` inside
 *   the authorisation's window (a relay that landed after the payer gave up), never signed again; the relayer's refusals
 *   carry their fallback; settlement is followed on the chain (the relayer's hash, else the token's authorisation state
 *   and that event);
 * - the EIP-5792 batch rail: exactly `[approve(amount), pay]`, atomic, the `Paid` log read from the registry RPC;
 * - EIP-5792 answers in their 2.0.0 and earlier shapes;
 * - the router's choice for passkey, EOA and smart-account payers, with the relayer up or down.
 */
import { AUTHORIZATION_USED_EVENT, DEFAULT_AUTHORIZATION_TTL_SECONDS, decodePaidLog, gasLimitFor, memoryOutstandingAuthorizationStore, outstandingAuthorizationId, PAID_TOPIC, payLinkV2Abi } from "@paylink/sdk";
import type { OutstandingAuthorization } from "@paylink/sdk";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, erc20Abi, parseAbi } from "viem";
import type { Address, Hex, RpcLog, TransactionReceipt } from "viem";
import { describe, expect, it, vi } from "vitest";
import { parseAtomicCapability, parseCallsStatus } from "../src/accounts/eip6963.ts";
import type { AccountProvider, BatchCall, TransactionRequest } from "../src/accounts/types.ts";
import { choosePath } from "../src/app/payer.ts";
import type { App } from "../src/app/context.ts";
import type { RelayAccepted, RelayerClient } from "../src/core/relayer.ts";
import { RelayerProblem } from "../src/core/relayer.ts";
import { recoverConsumedPayment, relayedAuthorizationRail, RelayFallbackError, selfAuthorizationRail, waitForSettlement } from "../src/rails/authorization.ts";
import { batchRail } from "../src/rails/batch.ts";
import type { PaymentContext, PaymentStep } from "../src/rails/types.ts";
import { walletRail } from "../src/rails/wallet.ts";
import { CONTRACT, fakeChain, issue, localChain, NOW, payer, registry, TOKEN_ADDRESS } from "./helpers.ts";

const TX = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const authorizationAbi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const domainAbi = parseAbi(["function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])"]);
/** ERC-5267: the token's domain, as Mock3009 reports it (the registry states the same name and version). */
const DOMAIN_ANSWER = encodeFunctionResult({ abi: domainAbi, functionName: "eip712Domain", result: ["0x0f", "AUSD", "1", 31337n, TOKEN_ADDRESS, `0x${"00".repeat(32)}`, []] });

function paidLog(key: Hex, payee: Address, from: Address, amount: bigint, logIndex: number, hash: Hex, block = 101n): RpcLog {
  return {
    address: CONTRACT,
    topics: encodeEventTopics({ abi: payLinkV2Abi, eventName: "Paid", args: { key, payee, payer: from } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "bytes32" }], [TOKEN_ADDRESS, amount, 0, `0x${"00".repeat(32)}`]),
    logIndex: `0x${logIndex.toString(16)}`,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: TX(9),
    transactionHash: hash,
    transactionIndex: "0x0",
    removed: false,
  } as RpcLog;
}

/** EIP-3009 `AuthorizationUsed(payer, nonce)`, emitted by the token in the transaction that used the authorisation. */
function usedLog(from: Address, nonce: Hex, logIndex: number, hash: Hex, block = 101n): RpcLog {
  return {
    address: TOKEN_ADDRESS,
    topics: encodeEventTopics({ abi: [AUTHORIZATION_USED_EVENT], eventName: "AuthorizationUsed", args: { authorizer: from, nonce } }),
    data: "0x",
    logIndex: `0x${logIndex.toString(16)}`,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: TX(9),
    transactionHash: hash,
    transactionIndex: "0x0",
    removed: false,
  } as RpcLog;
}

/** The fake chain's clock: block 100 is stamped NOW, two seconds a block; the head is block HEAD. */
const HEAD = 400n;
const stampOf = (block: bigint): bigint => NOW + (block - 100n) * 2n;

function account(kind: AccountProvider["kind"], extra: Partial<AccountProvider> = {}, sent: TransactionRequest[] = []): AccountProvider & { signatures: number } {
  const made = {
    connector: { id: "test", name: "Test", icon: null, layer: kind === "passkey" ? "passkey" : "eip6963" },
    kind,
    address: payer.address,
    signatures: 0,
    chainId: () => Promise.resolve(localChain().chainId),
    switchChain: () => Promise.resolve(),
    signTypedData: async (typed: Parameters<AccountProvider["signTypedData"]>[0]) => {
      made.signatures += 1;
      return await payer.signTypedData(typed);
    },
    sendTransaction: (request: TransactionRequest) => {
      sent.push(request);
      return Promise.resolve(TX(7));
    },
    onChange: () => () => undefined,
    ...extra,
  };
  return made;
}

interface Harness {
  readonly ctx: PaymentContext;
  readonly steps: PaymentStep["kind"][];
  readonly store: ReturnType<typeof memoryOutstandingAuthorizationStore>;
  /** Nonces the token reports used. */
  readonly used: Set<string>;
  readonly receipts: Map<Hex, TransactionReceipt>;
  readonly logs: RpcLog[];
  readonly relayed: unknown[];
  /** Every `eth_getLogs` block range asked for. */
  readonly ranges: [bigint, bigint][];
  account: AccountProvider & { signatures: number };
}

async function harness(options: { relay?: (body: unknown) => Promise<RelayAccepted>; amount?: bigint; account?: AccountProvider & { signatures: number }; open?: boolean } = {}): Promise<Harness & { link: Awaited<ReturnType<typeof issue>>["link"] }> {
  const { link } = await issue(options.open === true ? { amount: 0n, maxPayments: 0 } : {});
  const fake = fakeChain();
  const used = new Set<string>();
  const receipts = new Map<Hex, TransactionReceipt>();
  const logs: RpcLog[] = [];
  const relayed: unknown[] = [];
  const store = memoryOutstandingAuthorizationStore();
  const ranges: [bigint, bigint][] = [];
  const client = {
    ...fake.client,
    getBlockNumber: () => Promise.resolve(HEAD),
    getBlock: (p: { blockNumber: bigint } | { blockTag: "latest" | "finalized" }) => {
      const number = "blockNumber" in p ? p.blockNumber : HEAD;
      return Promise.resolve({ number, timestamp: stampOf(number) });
    },
    call: async (p: Parameters<typeof fake.client.call>[0]) => {
      if (p.to.toLowerCase() === TOKEN_ADDRESS.toLowerCase() && p.data.startsWith("0x84b0196e")) {
        return { data: DOMAIN_ANSWER };
      }
      if (p.to.toLowerCase() === TOKEN_ADDRESS.toLowerCase() && p.data.startsWith("0xe94a0102")) {
        const decoded = decodeFunctionData({ abi: authorizationAbi, data: p.data });
        return { data: encodeFunctionResult({ abi: authorizationAbi, functionName: "authorizationState", result: used.has(decoded.args[1]) }) };
      }
      return await fake.client.call(p);
    },
    getTransactionReceipt: ({ hash }: { hash: Hex }) => {
      const found = receipts.get(hash);
      return found === undefined ? Promise.reject(Object.assign(new Error("not found"), { name: "TransactionReceiptNotFoundError" })) : Promise.resolve(found);
    },
    waitForReceipt: (hash: Hex) => {
      const found = receipts.get(hash);
      return found === undefined ? Promise.reject(new Error("no receipt")) : Promise.resolve(found);
    },
    // Like an RPC: the address, the block range and every topic position that is not null must match.
    getLogs: (filter: { address: Address; fromBlock: bigint; toBlock: bigint; topics: readonly (Hex | null)[] }) => {
      ranges.push([filter.fromBlock, filter.toBlock]);
      return Promise.resolve(
        logs.filter((log) => {
          const block = BigInt(log.blockNumber ?? "0x0");
          return (
            log.address.toLowerCase() === filter.address.toLowerCase() &&
            block >= filter.fromBlock &&
            block <= filter.toBlock &&
            filter.topics.every((topic, i) => topic === null || log.topics[i]?.toLowerCase() === topic.toLowerCase())
          );
        }),
      );
    },
  };
  const relayer: RelayerClient = {
    endpoint: () => "https://relayer.test",
    availability: () => Promise.resolve({ kind: "up", health: { chainId: 31337, state: "ready", operations: { pay: true, cancel: true, onboard: false }, relayer: null } }),
    pay: async (body) => {
      relayed.push(structuredClone(await store.get(outstandingAuthorizationId({ chainId: link.chainId, key: link.key, payer: payer.address }))));
      return await (options.relay ?? (() => Promise.resolve({ status: "submitted", kind: "pay", chainId: 31337, txHash: TX(1), duplicate: false } as const)))(body);
    },
    cancel: () => Promise.reject(new Error("unused")),
    onboard: () => Promise.reject(new Error("unused")),
    invalidate: vi.fn(),
  };
  const steps: PaymentStep["kind"][] = [];
  const acct = options.account ?? account("passkey");
  const ctx: PaymentContext = {
    link,
    chain: localChain(),
    account: acct,
    client,
    amount: options.amount ?? link.invoice.amount,
    payerRef: `0x${"00".repeat(32)}`,
    now: NOW,
    onStep: (step) => steps.push(step.kind),
    registry,
    relayer,
    authorizations: store,
  };
  return { ctx, steps, store, used, receipts, logs, relayed, ranges, account: acct, link };
}

const success = (hash: Hex, logs: RpcLog[]): TransactionReceipt =>
  ({ transactionHash: hash, status: "success", blockNumber: BigInt(logs[0]?.blockNumber ?? "0x65"), logs: logs.map((l) => ({ ...l, logIndex: Number(l.logIndex) })) }) as unknown as TransactionReceipt;

const storeId = (link: { chainId: number; key: Hex }): string => outstandingAuthorizationId({ chainId: link.chainId, key: link.key, payer: payer.address });

/** A payment whose relay timed out: the authorisation is signed and stored, and nothing settled it yet. */
async function gaveUp(options: { open?: boolean; amount?: bigint } = {}): Promise<Harness & { link: Awaited<ReturnType<typeof issue>>["link"]; stored: OutstandingAuthorization }> {
  const h = await harness({ ...options, relay: () => Promise.reject(new RelayerProblem({ code: "offline", status: 0, detail: "timed out", fallback: "retry" })) });
  await expect(relayedAuthorizationRail().execute("relayed-authorization", h.ctx)).rejects.toBeInstanceOf(RelayFallbackError);
  const stored = (await h.store.get(storeId(h.link))) as OutstandingAuthorization;
  return { ...h, stored };
}

/** The late relay lands in `block`: the token marks the nonce used and logs it, next to the invoice's `Paid`. */
function lands(h: Harness & { link: Awaited<ReturnType<typeof issue>>["link"]; stored: OutstandingAuthorization }, block: bigint, hash: Hex, amount = h.link.invoice.amount): RpcLog {
  h.used.add(h.stored.nonce);
  const used = usedLog(payer.address, h.stored.nonce, 6, hash, block);
  const paid = paidLog(h.link.key, h.link.invoice.payee, payer.address, amount, 7, hash, block);
  h.logs.push(used, paid);
  h.receipts.set(hash, success(hash, [used, paid]));
  return paid;
}

describe("relayed authorisation rail", () => {
  it("signs once, stores the authorisation before relaying it, follows the receipt, then forgets it", async () => {
    const h = await harness();
    h.receipts.set(TX(1), success(TX(1), [paidLog(h.link.key, h.link.invoice.payee, payer.address, h.link.invoice.amount, 3, TX(1))]));
    const outcome = await relayedAuthorizationRail().execute("relayed-authorization", h.ctx);
    expect(outcome).toMatchObject({ txHash: TX(1), logIndex: 3 });
    expect(h.account.signatures).toBe(1);
    expect(h.steps).toEqual(["sign-authorization", "relayed", "mined"]);
    // Persisted before the relayer saw it, deleted once the receipt was found.
    expect((h.relayed[0] as OutstandingAuthorization | undefined)?.version).toBe(1);
    expect(await h.store.get(outstandingAuthorizationId({ chainId: h.link.chainId, key: h.link.key, payer: payer.address }))).toBeUndefined();
    expect(await relayedAuthorizationRail().ready(localChain(), h.ctx)).toBe(true);
  });

  it("resubmits a live authorisation without signing again, and refuses one for another amount", async () => {
    const h = await harness({ relay: () => Promise.reject(new RelayerProblem({ code: "offline", status: 0, detail: "x", fallback: "retry" })) });
    await expect(relayedAuthorizationRail().execute("relayed-authorization", h.ctx)).rejects.toBeInstanceOf(RelayFallbackError);
    expect(h.account.signatures).toBe(1);
    const stored = await h.store.get(outstandingAuthorizationId({ chainId: h.link.chainId, key: h.link.key, payer: payer.address }));
    expect(stored).toBeDefined();
    // The retry: same body, no new signature.
    const again = await harness();
    await again.store.put(outstandingAuthorizationId({ chainId: again.link.chainId, key: again.link.key, payer: payer.address }), stored as OutstandingAuthorization);
    const same = { ...again, ctx: { ...again.ctx, link: h.link } };
    same.receipts.set(TX(1), success(TX(1), [paidLog(h.link.key, h.link.invoice.payee, payer.address, h.link.invoice.amount, 0, TX(1))]));
    await same.store.put(outstandingAuthorizationId({ chainId: h.link.chainId, key: h.link.key, payer: payer.address }), stored as OutstandingAuthorization);
    await relayedAuthorizationRail().execute("relayed-authorization", same.ctx);
    expect(same.account.signatures).toBe(0);
    expect(same.steps[0]).toBe("resubmit");
  });

  it("refuses a second payment while an authorisation for another amount is live, and never signs over a used one", async () => {
    const h = await harness({ open: true, amount: 1_000_000n, relay: () => Promise.reject(new RelayerProblem({ code: "offline", status: 0, detail: "x" })) });
    await expect(relayedAuthorizationRail().execute("relayed-authorization", h.ctx)).rejects.toBeInstanceOf(RelayFallbackError);
    await expect(relayedAuthorizationRail().execute("relayed-authorization", { ...h.ctx, amount: 2_000_000n })).rejects.toMatchObject({ key: "pay.error.outstanding" });
    const stored = (await h.store.get(outstandingAuthorizationId({ chainId: h.link.chainId, key: h.link.key, payer: payer.address }))) as OutstandingAuthorization;
    h.used.add(stored.nonce);
    // Used, but no block of its window shows the payment yet: an amber "not visible yet" with its support code, the
    // record kept for the next search, and no new signature.
    await expect(relayedAuthorizationRail().execute("relayed-authorization", h.ctx)).rejects.toMatchObject({ key: "pay.error.consumed", code: "AuthorizationUsed" });
    expect(h.account.signatures).toBe(1);
    expect(await h.store.get(storeId(h.link))).toBeDefined();
  });

  it("relayer slow, then lands: the next press shows the payment the late relay made, from its receipt, and signs nothing", async () => {
    const h = await gaveUp();
    expect(h.account.signatures).toBe(1);
    // The relay the payer gave up on lands 120 blocks later (4 minutes on this clock), far behind the head.
    const paid = lands(h, 220n, TX(42));
    for (const rail of [relayedAuthorizationRail(), selfAuthorizationRail()]) {
      await h.store.put(storeId(h.link), h.stored);
      h.steps.length = 0;
      const outcome = await rail.execute(rail.paths[0] ?? "relayed-authorization", h.ctx);
      expect(outcome).toMatchObject({ txHash: TX(42), logIndex: Number(paid.logIndex), elapsedMs: null });
      expect(h.steps).toEqual(["mined"]);
      expect(h.account.signatures).toBe(1);
      expect(await h.store.get(storeId(h.link))).toBeUndefined();
    }
    // Searched by the token's AuthorizationUsed event, only inside the authorisation's window, in ranges the chain accepts.
    const window = { from: 100n, to: 100n + DEFAULT_AUTHORIZATION_TTL_SECONDS / 2n - 1n };
    expect(h.ranges.every(([from, to]) => from >= window.from && to <= window.to && to - from + 1n <= 100n)).toBe(true);
  });

  it("recovers a used authorisation's payment for the view: found and forgotten, or missing and kept, or nothing to find", async () => {
    const h = await gaveUp({ open: true, amount: 3_000_000n });
    const context = { ...h.ctx, payer: payer.address };
    expect(await recoverConsumedPayment(context)).toEqual({ state: "none" });
    h.used.add(h.stored.nonce);
    expect(await recoverConsumedPayment(context)).toEqual({ state: "missing" });
    expect(await h.store.get(storeId(h.link))).toBeDefined();
    // Another payment of this payer to the same card, same amount, just before this signature: not this payment.
    const before = paidLog(h.link.key, h.link.invoice.payee, payer.address, 3_000_000n, 1, TX(30), 99n);
    h.logs.push(before);
    h.receipts.set(TX(30), success(TX(30), [before]));
    expect(await recoverConsumedPayment(context)).toEqual({ state: "missing" });
    lands(h, 130n, TX(31), 3_000_000n);
    const found = await recoverConsumedPayment(context);
    expect(found).toMatchObject({ state: "found", outcome: { txHash: TX(31), logIndex: 7, elapsedMs: null } });
    expect(await h.store.get(storeId(h.link))).toBeUndefined();
    expect(await recoverConsumedPayment(context)).toEqual({ state: "none" });
  });

  it("finds the payment when the relayer says the authorisation was already used, however far behind the head", async () => {
    const h = await harness({ relay: () => Promise.reject(new RelayerProblem({ code: "already-settled", status: 409, detail: "used" })) });
    const original = h.ctx.relayer.pay.bind(h.ctx.relayer);
    let nonce: Hex | null = null;
    h.ctx.relayer.pay = async (body) => {
      const stored = (await h.store.get(outstandingAuthorizationId({ chainId: h.link.chainId, key: h.link.key, payer: payer.address }))) as OutstandingAuthorization;
      h.used.add(stored.nonce);
      nonce = stored.nonce;
      // It landed 250 blocks before the head: far outside a recent-blocks lookback.
      const used = usedLog(payer.address, stored.nonce, 4, TX(4), 150n);
      const log = paidLog(h.link.key, h.link.invoice.payee, payer.address, h.link.invoice.amount, 5, TX(4), 150n);
      h.logs.push(used, log);
      h.receipts.set(TX(4), success(TX(4), [used, log]));
      return await original(body);
    };
    const outcome = await relayedAuthorizationRail().execute("relayed-authorization", h.ctx);
    expect(outcome).toMatchObject({ txHash: TX(4), logIndex: 5 });
    expect(nonce).not.toBeNull();
    const paid = h.logs[1];
    expect(paid === undefined ? null : decodePaidLog({ ...paid, logIndex: 5 })?.payer).toBe(payer.address);
  });

  it("reports an authorisation that lapsed unused, and a payment still pending at the deadline", async () => {
    const h = await harness();
    h.receipts.clear();
    const stored = await (async () => {
      const failing = await harness({ relay: () => Promise.reject(new RelayerProblem({ code: "offline", status: 0, detail: "x" })) });
      await relayedAuthorizationRail().execute("relayed-authorization", failing.ctx).catch(() => undefined);
      return { checked: (await import("@paylink/sdk")).parseOutstandingAuthorization(await failing.store.get(outstandingAuthorizationId({ chainId: failing.link.chainId, key: failing.link.key, payer: payer.address })), registry), ctx: failing.ctx };
    })();
    await expect(waitForSettlement(stored.ctx, stored.checked, TX(99), 30)).rejects.toMatchObject({ key: "pay.error.pending" });
    const late = { ...stored.ctx, client: { ...stored.ctx.client, getBlock: () => Promise.resolve({ number: 100n, timestamp: NOW + 10_000n }) } };
    await expect(waitForSettlement(late, stored.checked, null, 5_000)).rejects.toMatchObject({ key: "pay.error.notSettled" });
  });

  it("is not ready while the relayer is down, and refuses other paths", async () => {
    const h = await harness();
    const down = { ...h.ctx, relayer: { ...h.ctx.relayer, availability: () => Promise.resolve({ kind: "down", state: "offline" } as const) } };
    expect(await relayedAuthorizationRail().ready(localChain(), down)).toBe(false);
    await expect(relayedAuthorizationRail().execute("permit", h.ctx)).rejects.toThrow(/does not execute/);
    await expect(selfAuthorizationRail().execute("permit", h.ctx)).rejects.toThrow(/does not execute/);
  });
});

describe("own-gas authorisation rail", () => {
  it("sends payWithAuthorization from the payer with the registry's clamped gas limit", async () => {
    const sent: TransactionRequest[] = [];
    const h = await harness({ account: account("injected", {}, sent) });
    h.receipts.set(TX(7), success(TX(7), [paidLog(h.link.key, h.link.invoice.payee, payer.address, h.link.invoice.amount, 1, TX(7))]));
    const outcome = await selfAuthorizationRail().execute("self-authorization", h.ctx);
    expect(outcome.txHash).toBe(TX(7));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.gas).toBe(gasLimitFor(localChain(), "payWithAuthorization", 100_000n));
    expect(sent[0]?.value).toBe(0n);
    expect(decodeFunctionData({ abi: payLinkV2Abi, data: sent[0]?.data ?? "0x" }).functionName).toBe("payWithAuthorization");
    expect(h.steps).toEqual(["sign-authorization", "simulate", "confirm", "sent", "mined"]);
    expect(await selfAuthorizationRail().ready(localChain(), h.ctx)).toBe(true);
  });
});

describe("EIP-5792 batch rail", () => {
  it("sends exactly [approve(amount), pay] atomically and reads the Paid log from the registry RPC", async () => {
    const batches: { chainId: number; calls: readonly BatchCall[] }[] = [];
    const h = await harness({
      account: account("injected", {
        sendCalls: (request) => {
          batches.push(request);
          return Promise.resolve({ status: "confirmed" as const, txHashes: [TX(5)] });
        },
      }),
    });
    h.receipts.set(TX(5), success(TX(5), [paidLog(h.link.key, h.link.invoice.payee, payer.address, h.link.invoice.amount, 2, TX(5))]));
    const outcome = await batchRail().execute("batched-approve-pay", h.ctx);
    expect(outcome).toMatchObject({ txHash: TX(5), logIndex: 2 });
    const calls = batches[0]?.calls ?? [];
    expect(calls.map((c) => c.to)).toEqual([TOKEN_ADDRESS, CONTRACT]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0]?.data ?? "0x" }).args).toEqual([CONTRACT, h.link.invoice.amount]);
    expect(decodeFunctionData({ abi: payLinkV2Abi, data: calls[1]?.data ?? "0x" }).functionName).toBe("pay");
    expect(h.steps).toEqual(["batch", "mined"]);
  });

  it("reports a batch the wallet did not complete, and needs an account that batches", async () => {
    const h = await harness({ account: account("injected", { sendCalls: () => Promise.resolve({ status: "reverted" as const, txHashes: [] }) }) });
    await expect(batchRail().execute("batched-approve-pay", h.ctx)).rejects.toMatchObject({ key: "pay.error.batch" });
    const plain = await harness({ account: account("injected") });
    await expect(batchRail().execute("batched-approve-pay", plain.ctx)).rejects.toThrow(/does not execute/);
  });

  it("reads EIP-5792 capabilities and call status in the final and earlier shapes", () => {
    expect(parseAtomicCapability({ "0x7a69": { atomic: { status: "supported" } } }, 31337)).toBe("supported");
    expect(parseAtomicCapability({ "0x0": { atomic: { status: "ready" } } }, 31337)).toBe("ready");
    expect(parseAtomicCapability({ "0x7a69": { atomicBatch: { supported: true } } }, 31337)).toBe("supported");
    expect(parseAtomicCapability({ "0x7a69": { atomic: { status: "weird" } } }, 31337)).toBe("unsupported");
    expect(parseAtomicCapability(null, 1)).toBe("unsupported");
    expect(parseCallsStatus({ status: 100 })).toBeNull();
    expect(parseCallsStatus({ status: "PENDING" })).toBeNull();
    expect(parseCallsStatus({ status: 200, receipts: [{ transactionHash: TX(1).toUpperCase().replace("0X", "0x") }, { transactionHash: "nope" }] })).toEqual({ status: "confirmed", txHashes: [TX(1)] });
    expect(parseCallsStatus({ status: "CONFIRMED", receipts: [] })).toEqual({ status: "confirmed", txHashes: [] });
    expect(parseCallsStatus({ status: 500 })).toEqual({ status: "reverted", txHashes: [] });
    expect(parseCallsStatus({ status: 400 })).toEqual({ status: "failed", txHashes: [] });
    expect(() => parseCallsStatus("x")).toThrow();
  });
});

describe("PaymentRouter inputs", () => {
  async function appFor(options: { rails: PaymentContext["relayer"] extends never ? never : ReturnType<typeof walletRail>[]; relayerUp: boolean; gas: bigint; code?: Hex }) {
    const h = await harness();
    const fake = h.ctx.client;
    const client = { ...fake, getBalance: () => Promise.resolve(options.gas), getCode: () => Promise.resolve(options.code ?? "0x") };
    const app = {
      registry,
      store: { authorizations: h.store },
      relayer: { ...h.ctx.relayer, availability: () => Promise.resolve(options.relayerUp ? { kind: "up", health: { chainId: 31337, state: "ready", operations: { pay: true, cancel: true, onboard: false }, relayer: null } } : { kind: "down", state: "offline" }) },
      edition: { rails: options.rails },
    } as unknown as App;
    return { app, client, link: h.link };
  }

  it("sends a passkey payer through the relayer, and reports needs-gas when it is down", async () => {
    const rails = [relayedAuthorizationRail(), selfAuthorizationRail(), walletRail()];
    const up = await appFor({ rails, relayerUp: true, gas: 0n });
    const choice = await choosePath(up.app, up.client, account("passkey"), up.link, NOW);
    expect(choice).toMatchObject({ ok: true, path: "relayed-authorization", payerPaysGas: false, resubmit: false });
    const down = await appFor({ rails, relayerUp: false, gas: 0n });
    expect(await choosePath(down.app, down.client, account("passkey"), down.link, NOW)).toMatchObject({ ok: false, reason: "needs-gas" });
    const own = await appFor({ rails, relayerUp: false, gas: 1n });
    expect(await choosePath(own.app, own.client, account("passkey"), own.link, NOW)).toMatchObject({ ok: true, path: "self-authorization", payerPaysGas: true });
  });

  it("gives a smart account (code, or EIP-5792 atomic) the batch, and an EOA the wallet when nothing gasless fits", async () => {
    const base = [relayedAuthorizationRail(), batchRail(), selfAuthorizationRail(), walletRail()];
    const smart = await appFor({ rails: base, relayerUp: true, gas: 1n });
    const batcher = account("injected", { atomicCapability: () => Promise.resolve("supported" as const), sendCalls: () => Promise.resolve({ status: "confirmed" as const, txHashes: [] }) });
    expect(await choosePath(smart.app, smart.client, batcher, smart.link, NOW)).toMatchObject({ ok: true, path: "batched-approve-pay", fallbacks: ["approve-pay"] });
    const coded = await appFor({ rails: base, relayerUp: true, gas: 1n, code: "0x6080" });
    expect(await choosePath(coded.app, coded.client, account("injected"), coded.link, NOW)).toMatchObject({ ok: true, path: "approve-pay" });
    const all = await appFor({ rails: [relayedAuthorizationRail(), walletRail()], relayerUp: false, gas: 1n });
    expect(await choosePath(all.app, all.client, account("injected"), all.link, NOW)).toMatchObject({ ok: true, path: "permit", fallbacks: ["approve-pay"] });
    expect(PAID_TOPIC).toMatch(/^0x/);
  });
});
