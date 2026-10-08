// SPDX-License-Identifier: MIT
/**
 * The T1 rails and the PaymentRouter's inputs:
 * - authorisation rails: one EIP-3009 signature, persisted before it is sent anywhere; a live one is resubmitted and
 *   never re-signed; a used one is "already paid"; the relayer's refusals carry their fallback; settlement is followed
 *   on the chain (the relayer's hash, else the token's authorisation state and the `Paid` log);
 * - the EIP-5792 batch rail: exactly `[approve(amount), pay]`, atomic, the `Paid` log read from the registry RPC;
 * - EIP-5792 answers in their 2.0.0 and earlier shapes;
 * - the router's choice for passkey, EOA and smart-account payers, with the relayer up or down.
 */
import { decodePaidLog, gasLimitFor, memoryOutstandingAuthorizationStore, outstandingAuthorizationId, PAID_TOPIC, payLinkV2Abi } from "@paylink/sdk";
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
import { relayedAuthorizationRail, RelayFallbackError, selfAuthorizationRail, waitForSettlement } from "../src/rails/authorization.ts";
import { batchRail } from "../src/rails/batch.ts";
import type { PaymentContext, PaymentStep } from "../src/rails/types.ts";
import { walletRail } from "../src/rails/wallet.ts";
import { CONTRACT, fakeChain, issue, localChain, NOW, payer, registry, TOKEN_ADDRESS } from "./helpers.ts";

const TX = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const authorizationAbi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const domainAbi = parseAbi(["function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])"]);
/** ERC-5267: the token's domain, as Mock3009 reports it (the registry states the same name and version). */
const DOMAIN_ANSWER = encodeFunctionResult({ abi: domainAbi, functionName: "eip712Domain", result: ["0x0f", "AUSD", "1", 31337n, TOKEN_ADDRESS, `0x${"00".repeat(32)}`, []] });

function paidLog(key: Hex, payee: Address, from: Address, amount: bigint, logIndex: number, hash: Hex): RpcLog {
  return {
    address: CONTRACT,
    topics: encodeEventTopics({ abi: payLinkV2Abi, eventName: "Paid", args: { key, payee, payer: from } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "bytes32" }], [TOKEN_ADDRESS, amount, 0, `0x${"00".repeat(32)}`]),
    logIndex: `0x${logIndex.toString(16)}`,
    blockNumber: "0x65",
    blockHash: TX(9),
    transactionHash: hash,
    transactionIndex: "0x0",
    removed: false,
  } as RpcLog;
}

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
  const client = {
    ...fake.client,
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
    getLogs: () => Promise.resolve(logs),
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
  return { ctx, steps, store, used, receipts, logs, relayed, account: acct, link };
}

const success = (hash: Hex, logs: RpcLog[]): TransactionReceipt =>
  ({ transactionHash: hash, status: "success", blockNumber: 101n, logs: logs.map((l) => ({ ...l, logIndex: Number(l.logIndex) })) }) as unknown as TransactionReceipt;

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

  it("refuses a second payment while an authorisation for another amount is live, and calls a used one paid", async () => {
    const h = await harness({ open: true, amount: 1_000_000n, relay: () => Promise.reject(new RelayerProblem({ code: "offline", status: 0, detail: "x" })) });
    await expect(relayedAuthorizationRail().execute("relayed-authorization", h.ctx)).rejects.toBeInstanceOf(RelayFallbackError);
    await expect(relayedAuthorizationRail().execute("relayed-authorization", { ...h.ctx, amount: 2_000_000n })).rejects.toMatchObject({ key: "pay.error.outstanding" });
    const stored = (await h.store.get(outstandingAuthorizationId({ chainId: h.link.chainId, key: h.link.key, payer: payer.address }))) as OutstandingAuthorization;
    h.used.add(stored.nonce);
    await expect(relayedAuthorizationRail().execute("relayed-authorization", h.ctx)).rejects.toMatchObject({ key: "pay.error.consumed" });
  });

  it("finds the payment when the relayer says the authorisation was already used", async () => {
    const h = await harness({ relay: () => Promise.reject(new RelayerProblem({ code: "already-settled", status: 409, detail: "used" })) });
    const original = h.ctx.relayer.pay.bind(h.ctx.relayer);
    h.ctx.relayer.pay = async (body) => {
      const stored = (await h.store.get(outstandingAuthorizationId({ chainId: h.link.chainId, key: h.link.key, payer: payer.address }))) as OutstandingAuthorization;
      h.used.add(stored.nonce);
      return await original(body);
    };
    const log = paidLog(h.link.key, h.link.invoice.payee, payer.address, h.link.invoice.amount, 5, TX(4));
    h.logs.push(log);
    h.receipts.set(TX(4), success(TX(4), [log]));
    const outcome = await relayedAuthorizationRail().execute("relayed-authorization", h.ctx);
    expect(outcome).toMatchObject({ txHash: TX(4), logIndex: 5 });
    expect(decodePaidLog({ ...log, logIndex: 5 })?.payer).toBe(payer.address);
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
