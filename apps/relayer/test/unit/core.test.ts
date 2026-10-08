// SPDX-License-Identifier: MIT
/** The relayer's small parts: key parsing, the signing choke point, logs, limits, state pruning, policy, problems. */
import { createRegistry, defineLocalChain, monadTestnet, registry } from "@paylink/chains";
import type { ChainDefinition } from "@paylink/chains";
import { cancelBySigCall, payLinkV2Abi, payWithAuthorizationCall } from "@paylink/sdk";
import { encodeFunctionData, zeroHash } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { assertSendable, faucetCall, faucetOf, isRelayable, relayRegistry, SELECTORS } from "../../src/core/chains.ts";
import { parsePrivateKey } from "../../src/core/engine.ts";
import { RequestLimiter, SerialQueue } from "../../src/core/limits.ts";
import { createLogger, errorMessage, requesterTag, silentLogger } from "../../src/core/log.ts";
import { DEFAULT_POLICY, kindBudgetWei, oneCent, requesterBudgetWei, withPolicy } from "../../src/core/policy.ts";
import { problem, PROBLEMS, problemType, secondsUntil } from "../../src/core/problem.ts";
import { adjustBudget, emptyState, memoryStore, prune, restoreState, secondsToMidnight, utcDay } from "../../src/core/state.ts";
import type { PendingTx } from "../../src/core/state.ts";

const SELF: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const CONTRACT: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const FAUCET: Address = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C";
const invoice = { payee: SELF, token: CONTRACT, amount: 1n, validAfter: 0n, validUntil: 0n, maxPayments: 1, salt: zeroHash, memoHash: zeroHash } as const;

function chainWith(patch: Partial<ChainDefinition> = {}): ChainDefinition {
  return {
    ...defineLocalChain({
      chainId: 10143,
      rpcUrl: "http://127.0.0.1:8545",
      tokens: [],
      deployment: { address: CONTRACT, status: "active", release: "2.0.0", method: "CREATE", deployer: SELF, txHash: zeroHash, blockNumber: 1n, initCodeHash: zeroHash, maskedRuntimeHash: zeroHash, runtimeCodeHash: zeroHash },
    }),
    contracts: { ausdFaucet: { address: FAUCET, confidence: "C", gas: { floor: 130_000n, ceiling: 195_000n } } },
    ...patch,
  };
}

describe("RELAYER_PK parsing", () => {
  it.each([
    ["0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", true],
    ["7C852118294E51E653712A81E05800F419141751BE58F605C371E15141B007A6", true],
    ["  0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6\n", true],
    [undefined, false],
    ["", false],
    ["0x1234", false],
    [`0x${"00".repeat(32)}`, false],
    ["0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", false],
    ["0xzz52118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", false],
  ] as const)("%s → valid %s", (raw, valid) => {
    const key = parsePrivateKey(raw);
    expect(key !== null).toBe(valid);
    if (key !== null) {
      expect(key).toMatch(/^0x[0-9a-f]{64}$/u);
    }
  });
});

describe("the signing choke point", () => {
  const chain = chainWith();
  const pay = payWithAuthorizationCall(CONTRACT, invoice, "0x00", { payer: SELF, amount: 1n, payerRef: zeroHash, validAfter: 0n, validBefore: 1n, payerSalt: zeroHash, v: 27, r: zeroHash, s: zeroHash });
  const cancel = cancelBySigCall(CONTRACT, { chainId: 10143, invoice, deadline: 1n, signature: "0x00" });

  it("allows exactly the two relayable entry points, the faucet drip and a void, all with value 0", () => {
    expect(() => {
      assertSendable(chain, SELF, pay);
      assertSendable(chain, SELF, cancel);
      assertSendable(chain, SELF, faucetCall(FAUCET, SELF));
      assertSendable(chain, SELF, { to: SELF, data: "0x", value: 0n });
    }).not.toThrow();
    expect(pay.data.slice(0, 10)).toBe(SELECTORS.payWithAuthorization);
    expect(cancel.data.slice(0, 10)).toBe(SELECTORS.cancelBySig);
    expect(SELECTORS.requestFunds).toBe("0x544c7cf9");
  });

  it.each([
    ["value", { ...pay, value: 1n }, /never sends value/u],
    ["pay() on PayLinkV2", { to: CONTRACT, data: encodeFunctionData({ abi: payLinkV2Abi, functionName: "pay", args: [invoice, "0x00", 1n, zeroHash] }), value: 0n }, /not relayable/u],
    ["cancel() on PayLinkV2", { to: CONTRACT, data: encodeFunctionData({ abi: payLinkV2Abi, functionName: "cancel", args: [invoice] }), value: 0n }, /not relayable/u],
    ["another faucet function", { to: FAUCET, data: "0x12345678", value: 0n }, /not requestFunds/u],
    ["requestFunds with trailing data", { to: FAUCET, data: `${faucetCall(FAUCET, SELF).data}00` as Hex, value: 0n }, /not requestFunds/u],
    ["a token transfer", { to: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", data: "0xa9059cbb", value: 0n }, /neither the canonical deployment nor the faucet/u],
    ["a self-call with data", { to: SELF, data: "0x00", value: 0n }, /neither/u],
  ] as const)("refuses %s", (_name, tx, pattern) => {
    expect(() => {
      assertSendable(chain, SELF, tx);
    }).toThrow(pattern);
  });

  it("refuses everything on a mainnet and on a revoked deployment", () => {
    expect(() => {
      assertSendable({ ...chain, testnet: false }, SELF, pay);
    }).toThrow(/not a testnet/u);
    const revoked = chainWith({ deployment: { ...(chain.deployment ?? (() => { throw new Error("deployment"); })()), status: "revoked" } });
    expect(() => {
      assertSendable(revoked, SELF, pay);
    }).toThrow(/neither/u);
  });

  it("serves enabled v2 testnets only, local ones only when asked", () => {
    expect(relayRegistry(registry, { allowLocal: false }).chains.map((c) => c.chainId).sort()).toEqual([10143, 84532, 421614].filter((id) => isRelayable(registry.getOrThrow(id), false)).sort());
    expect(isRelayable(monadTestnet, false)).toBe(true);
    expect(registry.chains.filter((c) => !c.testnet).every((c) => !isRelayable(c, true))).toBe(true);
    const local = chainWith();
    expect([isRelayable(local, false), isRelayable(local, true)]).toEqual([false, true]);
    expect(relayRegistry(createRegistry([local]), { allowLocal: true }).chains).toHaveLength(1);
  });

  it("finds the registry faucet and its gas bounds", () => {
    expect(faucetOf(monadTestnet)).toEqual({ address: FAUCET, gas: { floor: 130_000n, ceiling: 195_000n } });
    expect(faucetOf(registry.getOrThrow(84532))).toBeNull();
  });
});

describe("logs", () => {
  it("writes one JSON object per line and scrubs secrets in any field, with or without 0x", () => {
    const lines: string[] = [];
    const secret = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
    const logger = createLogger({ sink: (line) => lines.push(line), secrets: [secret, "short"], now: () => 0, base: { service: "relayer" } });
    logger.log("info", "test", { detail: `leak ${secret} and ${secret.slice(2).toUpperCase()}`, nested: ["a"], short: "short" });
    logger.child({ requestId: "r1" }).log("warn", "child", { privateKey: secret, payeeSig: "0x01", r: "0x02", s: "0x03", signature: "0x04", key: "0xabc" });
    logger.log("debug", "dropped");
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toEqual({ ts: "1970-01-01T00:00:00.000Z", level: "info", event: "test", service: "relayer", detail: "leak [redacted] and [redacted]", nested: ["a"], short: "short" });
    expect(second).toEqual({ ts: "1970-01-01T00:00:00.000Z", level: "warn", event: "child", service: "relayer", requestId: "r1", key: "0xabc" });
    expect(lines.join("")).not.toMatch(/7c852118/iu);
  });

  it("tags requesters without revealing them, and bounds error messages", () => {
    expect(requesterTag("ip4:203.0.113.7")).toMatch(/^[0-9a-f]{12}$/u);
    expect(requesterTag("ip4:203.0.113.7")).toBe(requesterTag("ip4:203.0.113.7"));
    expect(requesterTag("ip4:203.0.113.7")).not.toBe(requesterTag("ip4:203.0.113.8"));
    expect(errorMessage(new Error("x".repeat(400)))).toHaveLength(301);
    expect(errorMessage("plain")).toBe("plain");
    silentLogger.child({}).log("error", "nothing");
  });
});

describe("limits", () => {
  it("refills each requester's bucket per minute and bounds the chain", () => {
    const limiter = new RequestLimiter(2, 3, 0);
    expect([limiter.take("a", 0), limiter.take("a", 0), limiter.take("a", 0)]).toEqual([null, null, 30]);
    expect(limiter.take("b", 0)).toBeNull();
    expect(limiter.take("c", 0)).toBe(20); // chain bucket empty
    expect(limiter.take("a", 30_000)).toBeNull(); // one token back after 30 s
    expect(new RequestLimiter(0, 10, 0).take("a", 0)).toBe(60);
  });

  it("forgets the least recently seen requester beyond 10,000", () => {
    const limiter = new RequestLimiter(1, 1_000_000, 0);
    limiter.take("first", 0);
    for (let i = 0; i < 10_000; i += 1) {
      limiter.take(`r${String(i)}`, 0);
    }
    expect(limiter.take("first", 0)).toBeNull(); // forgotten, so a fresh bucket
  });

  it("runs queued tasks one at a time, in order, past failures", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    const slow = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(1);
    });
    const failing = queue.run(() => Promise.reject(new Error("x")));
    const fast = queue.run(() => {
      order.push(3);
      return Promise.resolve(3);
    });
    await expect(failing).rejects.toThrow("x");
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 3]);
  });
});

describe("state", () => {
  const now = 1_791_400_000n;
  it("restores only a state of the same version and chain", () => {
    const state = emptyState(10143, now);
    expect(restoreState(state, 10143, now)).toEqual(state);
    expect(restoreState(state, 84532, now)).toMatchObject({ chainId: 84532, pending: [] });
    expect(restoreState({ ...state, version: 0 }, 10143, now)).not.toBe(state);
    expect(restoreState(null, 10143, now)).toMatchObject({ nextNonce: null });
    expect(restoreState("junk", 10143, now)).toMatchObject({ chainId: 10143 });
  });

  it("restores a state saved before the per-kind budget and the per-party counters, keeping its pending transactions", () => {
    const pending = (kind: PendingTx["kind"], reservedWei: string, nonce: number): PendingTx => ({
      kind, nonce, from: SELF, to: CONTRACT, data: "0x", ticketId: null, dedupeId: null, validThrough: null, simulatedAt: "1", reservedWei, attempts: [], missingPasses: 0, evidenceFailures: 0,
    });
    const day = utcDay(now);
    const old = {
      ...emptyState(10143, now),
      pending: [pending("pay", "5", 1), pending("cancel", "2", 2), pending("onboard", "3", 3)],
      budget: { day, spentWei: "40", reservedWei: "10" },
      counters: { day, relays: 4, onboards: 1, perPayer: { "0xa": 2 }, perAddress: {}, perRequester: {} },
    };
    const restored = restoreState(old, 10143, now);
    expect(restored.pending).toHaveLength(3);
    // Today's spending so far counts against the payments' share; each reservation against its own kind.
    expect(restored.budget.byKind).toEqual({ pay: { spentWei: "40", reservedWei: "5" }, cancel: { spentWei: "0", reservedWei: "2" }, onboard: { spentWei: "0", reservedWei: "3" } });
    expect(restored.counters).toMatchObject({ relays: 4, perPayer: { "0xa": 2 }, perRequesterRelays: {}, perRequesterGasWei: {}, perPayeePays: {}, perPayeeCancels: {} });
  });

  it("adjusts the total and one kind's share together, never below zero", () => {
    const budget = emptyState(10143, now).budget;
    const reserved = adjustBudget(budget, "cancel", 0n, 70n);
    expect(reserved).toMatchObject({ reservedWei: "70", byKind: { cancel: { reservedWei: "70" }, pay: { reservedWei: "0" } } });
    const settled = adjustBudget(reserved, "cancel", 60n, -70n);
    expect(settled).toMatchObject({ spentWei: "60", reservedWei: "0", byKind: { cancel: { spentWei: "60", reservedWei: "0" } } });
    expect(adjustBudget(settled, "pay", 0n, -5n).byKind.pay.reservedWei).toBe("0");
  });

  it("prunes expired bans, windows, recent relays and yesterday's counters, keeping reservations", () => {
    const state = {
      ...emptyState(10143, now - 90_000n),
      ledger: {
        version: 2 as const,
        nextId: 5,
        inFlight: [],
        bans: { "payer:10143:0xa": String(now - 1n), "payer:10143:0xb": String(now + 10n) },
        strikes: { "requester:ip4:1.1.1.1": { count: 1, since: String(now - 90_000n) }, "requester:ip4:2.2.2.2": { count: 1, since: String(now - 10n) } },
        relays: { "requester:ip4:1.1.1.1": { count: 3, since: String(now - 3_600n) }, "requester:ip4:2.2.2.2": { count: 1, since: String(now - 10n) } },
      },
      budget: { day: utcDay(now - 90_000n), spentWei: "50", reservedWei: "7", byKind: { pay: { spentWei: "40", reservedWei: "5" }, cancel: { spentWei: "10", reservedWei: "2" }, onboard: { spentWei: "0", reservedWei: "0" } } },
      counters: { ...emptyState(10143, now - 90_000n).counters, relays: 9, perRequesterRelays: { "ip4:1.1.1.1": 9 }, perRequesterGasWei: { "pay|ip4:1.1.1.1": "99" }, perPayeeCancels: { "0xb": 3 } },
      recent: [
        { id: "old", txHash: zeroHash, at: Number(now - 90_000n) },
        { id: "new", txHash: zeroHash, at: Number(now - 10n) },
      ],
    };
    const pruned = prune(state, now, {});
    expect(Object.keys(pruned.ledger.bans)).toEqual(["payer:10143:0xb"]);
    expect(Object.keys(pruned.ledger.strikes)).toEqual(["requester:ip4:2.2.2.2"]);
    expect(Object.keys(pruned.ledger.relays)).toEqual(["requester:ip4:2.2.2.2"]);
    expect(pruned.recent.map((r) => r.id)).toEqual(["new"]);
    expect(pruned.budget).toEqual({ day: utcDay(now), spentWei: "0", reservedWei: "7", byKind: { pay: { spentWei: "0", reservedWei: "5" }, cancel: { spentWei: "0", reservedWei: "2" }, onboard: { spentWei: "0", reservedWei: "0" } } });
    // Requester identities never outlive their day (THREAT_MODEL T-38).
    expect(pruned.counters).toEqual({ day: utcDay(now), relays: 0, onboards: 0, perPayer: {}, perAddress: {}, perRequester: {}, perRequesterRelays: {}, perRequesterGasWei: {}, perPayeePays: {}, perPayeeCancels: {} });
  });

  it("knows the UTC day and the seconds to midnight", () => {
    expect(utcDay(0n)).toBe("1970-01-01");
    expect(secondsToMidnight(86_399n)).toBe(1);
    expect(secondsToMidnight(86_400n)).toBe(86_400);
  });

  it("round-trips through the memory store", async () => {
    const store = memoryStore();
    expect(await store.load()).toBeUndefined();
    await store.save(emptyState(1, now));
    expect(store.current()).toMatchObject({ chainId: 1 });
    expect(await store.load()).toMatchObject({ chainId: 1 });
  });
});

describe("policy and problems", () => {
  it("relays one cent and up, and knows its chains' limits", () => {
    expect(oneCent({ decimals: 6 })).toBe(10_000n);
    expect(oneCent({ decimals: 18 })).toBe(10n ** 16n);
    expect(oneCent({ decimals: 0 })).toBe(1n);
    expect(DEFAULT_POLICY.limits(monadTestnet)).toMatchObject({ dailyGasBudgetWei: 10n ** 18n, maxOnboardsPerAddressPerDay: 1 });
    expect(DEFAULT_POLICY.limits(registry.getOrThrow(84532)).maxOnboardsPerDay).toBe(0);
    expect(DEFAULT_POLICY.limits({ ...monadTestnet, key: "monad" }).dailyGasBudgetWei).toBe(0n);
    expect(withPolicy({ maxReplacements: 1 })).toMatchObject({ maxReplacements: 1, replaceAfterSeconds: 30, feeBumpPercent: 25 });
  });

  it("splits every chain's daily budget so that no kind and no requester can spend it all (review 2026-10-08)", () => {
    for (const chain of registry.chains) {
      const limits = DEFAULT_POLICY.limits(chain);
      const shares = Object.values(limits.budgetShareBps).reduce((a, b) => a + b, 0);
      expect(shares === 10_000 || limits.dailyGasBudgetWei === 0n, chain.key).toBe(true);
      expect(limits.requesterShareBps, chain.key).toBeLessThanOrEqual(2_000);
      for (const kind of ["pay", "cancel", "onboard"] as const) {
        expect(kindBudgetWei(limits, kind) < limits.dailyGasBudgetWei || limits.dailyGasBudgetWei === 0n, `${chain.key} ${kind}`).toBe(true);
        expect(requesterBudgetWei(limits, kind) * 5n <= kindBudgetWei(limits, kind), `${chain.key} ${kind}`).toBe(true);
      }
      expect(limits.maxCancelsPerPayeePerDay, chain.key).toBeLessThanOrEqual(3);
    }
  });

  it("sizes Monad's onboarding cap to fit its share: every drip at the faucet's gas ceiling and the 102-gwei price", () => {
    const limits = DEFAULT_POLICY.limits(monadTestnet);
    const faucet = faucetOf(monadTestnet);
    expect(faucet).not.toBeNull();
    const drip = (faucet?.gas.ceiling ?? 0n) * 102n * 10n ** 9n;
    expect(BigInt(limits.maxOnboardsPerDay) * drip).toBeLessThanOrEqual(kindBudgetWei(limits, "onboard"));
    expect(kindBudgetWei(limits, "pay")).toBe(6n * 10n ** 17n);
    expect(requesterBudgetWei(limits, "pay")).toBe(12n * 10n ** 16n);
    expect(requesterBudgetWei(limits, "cancel")).toBe(2n * 10n ** 16n);
  });

  it("gives every code a status and a documented type", () => {
    for (const [code, { status }] of Object.entries(PROBLEMS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(problemType(code as keyof typeof PROBLEMS)).toMatch(/README\.md#problem-/u);
    }
    expect(problem("refused", "x", { reason: "in-flight-key" })).toMatchObject({ status: 429, reason: "in-flight-key" });
    expect([secondsUntil(10n, 20n), secondsUntil(30n, 20n), secondsUntil(10n ** 9n, 0n)]).toEqual([1, 10, 604_800]);
  });
});
