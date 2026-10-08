// SPDX-License-Identifier: MIT
/**
 * The ChainSender when things go wrong, on anvil (10143) through the Node adapter: a node that refuses or loses a
 * broadcast, an RPC that fails, receipts that never show, evidence that cannot be read, an unfunded or delegated
 * relayer account, fee spikes, revoked deployments and daily caps. Faults are injected by a transport that wraps
 * viem's own http transport, so every other call (and every error class) is exactly what production sees.
 */
import { createRegistry } from "@paylink/chains";
import type { ChainDefinition } from "@paylink/chains";
import { authorizePayment, decodeInvoiceFragment, expiresIn, gasBounds, issueInvoice, payLinkV2Abi, signCancel, toCancelAuthorizationJson } from "@paylink/sdk";
import type { DecodedInvoiceLink, PaymentAuthorization } from "@paylink/sdk";
import { createWalletClient, custom, encodeFunctionData, http, HttpRequestError, RpcRequestError } from "viem";
import type { EIP1193RequestFn, Hex, PrivateKeyAccount, Transport } from "viem";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../src/core/engine.ts";
import { requesterBudgetWei, withPolicy } from "../../src/core/policy.ts";
import type { RelayerPolicy } from "../../src/core/policy.ts";
import type { NodeRelayer } from "../../src/node/server.ts";
import { startNodeRelayer } from "../../src/node/server.ts";
import type { LocalChain } from "../fixtures/chain.ts";
import { CHAIN_ID, chainAvailable, KEYS, startChain } from "../fixtures/chain.ts";
import { call, post } from "../fixtures/http.ts";

const PAY = `/v1/${String(CHAIN_ID)}/pay`;

/** What a fault does with one call: `undefined` lets it through to anvil. */
type Fault = (params: unknown, count: number) => unknown;

describe.skipIf(!chainAvailable())("relayer faults on anvil (10143)", () => {
  let chain: LocalChain;
  const faults = new Map<string, Fault>();
  const counts = new Map<string, number>();
  const running: NodeRelayer[] = [];
  let offset = 0;
  const lines: string[] = [];

  /** viem's http transport to anvil, behind the fault table. */
  const transport = (): Transport => {
    const inner = http(chain.url, { retryCount: 0 });
    return custom(
      {
        request: (async (args: { method: string; params?: unknown }) => {
          const count = (counts.get(args.method) ?? 0) + 1;
          counts.set(args.method, count);
          const fault = faults.get(args.method);
          const injected: unknown = fault?.(args.params, count);
          if (injected !== undefined) {
            if (injected instanceof Error) {
              throw injected;
            }
            return injected === "null" ? null : injected;
          }
          return await inner({ chain: undefined, retryCount: 0 }).request(args as never);
        }) as EIP1193RequestFn,
      },
      { retryCount: 0 },
    );
  };
  const rpcError = (message: string): Error => new RpcRequestError({ body: {}, url: chain.url, error: { code: -32000, message } });
  const start = async (options: { registry?: ReturnType<typeof createRegistry>; policy?: RelayerPolicy } = {}): Promise<NodeRelayer> => {
    const relayer = await startNodeRelayer({
      registry: options.registry ?? chain.registry,
      privateKey: KEYS.relayer,
      autoTrack: false,
      clock: () => Date.now() + offset,
      transport: () => transport(),
      log: (line) => lines.push(line),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    });
    running.push(relayer);
    return relayer;
  };
  const invoice = async (amount: bigint, maxPayments: number): Promise<DecodedInvoiceLink> => {
    const t = await chain.now();
    const issued = await issueInvoice({
      registry: chain.registry,
      chainId: CHAIN_ID,
      draft: { payee: chain.accounts.payee.address, token: chain.token, amount, maxPayments, validAfter: t - 60n, expiry: amount === 0n ? { kind: "never", confirmed: true } : expiresIn(t) },
      signer: chain.accounts.payee,
      client: chain.client,
    });
    return decodeInvoiceFragment(issued.fragment, chain.registry);
  };
  const authorize = async (link: DecodedInvoiceLink, payer: PrivateKeyAccount, amount?: bigint): Promise<PaymentAuthorization> =>
    await authorizePayment({ outstanding: null, link, signer: payer, now: await chain.now(), client: chain.client, ...(amount === undefined ? {} : { amount }) });
  const body = (authorized: PaymentAuthorization): unknown => JSON.parse(JSON.stringify(authorized.request));
  const relayerNonce = async (): Promise<number> => await chain.client.getTransactionCount({ address: chain.accounts.relayer.address });
  const withChain = (patch: Partial<ChainDefinition>): ReturnType<typeof createRegistry> => createRegistry([{ ...chain.local, ...patch }]);

  beforeAll(async () => {
    chain = await startChain();
  });
  afterEach(async () => {
    faults.clear();
    counts.clear();
    for (const relayer of running.splice(0)) {
      await relayer.close();
    }
    await chain.automine(true);
  });
  afterAll(() => {
    chain.stop();
  });

  it("re-reads the nonce and retries once when the node says 'nonce too low'", async () => {
    const relayer = await start();
    faults.set("eth_sendRawTransaction", (_params, count) => (count === 1 ? rpcError("nonce too low") : undefined));
    const reply = await post(relayer.url, PAY, body(await authorize(await invoice(1_000_000n, 1), chain.accounts.payer)));
    expect(reply.status).toBe(202);
    await chain.client.waitForTransactionReceipt({ hash: reply.body["txHash"] as Hex });
    expect(lines.some((line) => line.includes('"event":"tx.nonce-resync"'))).toBe(true);
  });

  it.each([
    ["insufficient funds for gas * price + value", 503, "relayer-unavailable"],
    ["replacement transaction underpriced", 502, "upstream-error"],
  ] as const)("forgets a broadcast the node refuses (%s) and gives the ticket back", async (message, httpStatus, code) => {
    const relayer = await start();
    faults.set("eth_sendRawTransaction", () => rpcError(message));
    const nonce = await relayerNonce();
    const reply = await post(relayer.url, PAY, body(await authorize(await invoice(1_000_000n, 1), chain.accounts.payer2)));
    expect(reply).toMatchObject({ status: httpStatus, body: { code } });
    expect((await relayer.engine(CHAIN_ID)).snapshot()).toMatchObject({ pending: [], ledger: { inFlight: [] }, budget: { reservedWei: "0" } });
    expect(await relayerNonce()).toBe(nonce);
  });

  it("keeps a broadcast whose transport failed, and re-sends it when it never lands", async () => {
    const relayer = await start();
    faults.set("eth_sendRawTransaction", (_params, count) => (count === 1 ? new HttpRequestError({ url: chain.url, details: "socket hang up" }) : undefined));
    const link = await invoice(1_500_000n, 1);
    const reply = await post(relayer.url, PAY, body(await authorize(link, chain.accounts.payer3)));
    expect(reply.status).toBe(202);
    expect(await chain.client.getTransaction({ hash: reply.body["txHash"] as Hex }).catch(() => null)).toBeNull();
    await relayer.tick(); // nothing yet: no receipt, nonce unused, not stuck long enough
    offset += 31_000;
    await relayer.tick(); // replacement: the same call, same nonce, fees x1.25
    const [record] = (await relayer.engine(CHAIN_ID)).snapshot().pending;
    expect(record?.attempts).toHaveLength(2);
    await chain.client.waitForTransactionReceipt({ hash: record?.attempts[1]?.hash ?? "0x" });
    await relayer.tick();
    expect((await relayer.engine(CHAIN_ID)).snapshot()).toMatchObject({ pending: [], ledger: { inFlight: [] } });
  });

  it("calls a nonce dropped when it is used but no receipt of ours ever shows", async () => {
    const relayer = await start();
    const reply = await post(relayer.url, PAY, body(await authorize(await invoice(1_000_000n, 1), chain.accounts.payer)));
    await chain.client.waitForTransactionReceipt({ hash: reply.body["txHash"] as Hex });
    faults.set("eth_getTransactionReceipt", () => "null");
    for (let pass = 0; pass < 4; pass += 1) {
      await relayer.tick();
      expect((await relayer.engine(CHAIN_ID)).snapshot().pending).toHaveLength(1);
    }
    await relayer.tick();
    expect((await relayer.engine(CHAIN_ID)).snapshot()).toMatchObject({ pending: [], ledger: { inFlight: [], bans: {} } });
  });

  it("retries attribution while evidence cannot be read, then rules the revert unattributed", async () => {
    const relayer = await start({ policy: withPolicy({ maxEvidenceAttempts: 2 }) });
    const card = await invoice(0n, 0);
    await chain.automine(false);
    const reply = await post(relayer.url, PAY, body(await authorize(card, chain.accounts.payer2, 1_000_000n)));
    expect(reply.status).toBe(202);
    const payee = chain.accounts.payee;
    await createWalletClient({ account: payee, transport: http(chain.url) }).sendTransaction({
      account: payee,
      chain: null,
      to: chain.payLink,
      data: encodeFunctionData({ abi: payLinkV2Abi, functionName: "cancel", args: [{ ...card.invoice }] }),
      maxPriorityFeePerGas: 500_000_000_000n,
      maxFeePerGas: 900_000_000_000n,
      gas: 200_000n,
    });
    await chain.mine();
    // Reads at a past block (the evidence) fail; the replay of the revert data too.
    faults.set("eth_call", (params) => (Array.isArray(params) && params[1] !== "latest" && params[1] !== "pending" ? new HttpRequestError({ url: chain.url, details: "state unavailable" }) : undefined));
    await relayer.tick();
    expect((await relayer.engine(CHAIN_ID)).snapshot().pending[0]?.evidenceFailures).toBe(1);
    await relayer.tick();
    expect((await relayer.engine(CHAIN_ID)).snapshot()).toMatchObject({ pending: [], ledger: { inFlight: [] } });
    const final = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry["event"] === "tx.final").at(-1);
    expect(final).toMatchObject({ outcome: "unattributed", detail: "evidence-unavailable", banned: ["key"], struck: true });
  });

  it("answers 502 when the RPC fails, and health reports rpc-error", async () => {
    const relayer = await start();
    faults.set("eth_getBlockByNumber", () => new HttpRequestError({ url: chain.url, details: "connection refused" }));
    const reply = await post(relayer.url, PAY, body(await authorize(await invoice(1_000_000n, 1), chain.accounts.payer)));
    expect(reply).toMatchObject({ status: 502, body: { code: "upstream-error", retryAfter: 5 } });
    const health = await call(relayer.url, "/v1/health");
    expect(health.status).toBe(503);
    expect((health.body["chains"] as Record<string, unknown>[])[0]).toMatchObject({ state: "rpc-error" });
  });

  it("refuses to sign when fees exceed the cap", async () => {
    const relayer = await start({ policy: withPolicy({ limits: (c) => ({ ...withPolicy().limits(c), maxFeePerGasWei: 1n }) }) });
    const reply = await post(relayer.url, PAY, body(await authorize(await invoice(1_000_000n, 1), chain.accounts.payer)));
    expect(reply).toMatchObject({ status: 503, body: { code: "fees-too-high" } });
    expect((await relayer.engine(CHAIN_ID)).snapshot().ledger.inFlight).toEqual([]);
  });

  it("refuses to sign from an unfunded account, and from an account with code (an EIP-7702 delegation)", async () => {
    const address = chain.accounts.relayer.address;
    const funds = await chain.client.getBalance({ address });
    await chain.rpc("anvil_setBalance", [address, "0x3b9aca00"]);
    try {
      const relayer = await start();
      const reply = await post(relayer.url, PAY, body(await authorize(await invoice(1_000_000n, 1), chain.accounts.payer)));
      expect(reply).toMatchObject({ status: 503, body: { code: "relayer-unavailable" } });
      expect(((await call(relayer.url, "/v1/health")).body["chains"] as Record<string, unknown>[])[0]).toMatchObject({ state: "unfunded" });
    } finally {
      await chain.rpc("anvil_setBalance", [address, `0x${funds.toString(16)}`]);
    }
    await chain.rpc("anvil_setCode", [address, `0xef0100${chain.payLink.slice(2)}`]);
    try {
      const relayer = await start();
      const reply = await post(relayer.url, PAY, body(await authorize(await invoice(1_000_000n, 1), chain.accounts.payer)));
      expect(reply).toMatchObject({ status: 503, body: { code: "relayer-unavailable" } });
      expect(String(reply.body["detail"])).toMatch(/has code/u);
    } finally {
      await chain.rpc("anvil_setCode", [address, "0x"]);
    }
  });

  it("does not relay for a revoked deployment, nor onboard where the registry lists no faucet", async () => {
    const deployment = chain.local.deployment;
    if (deployment === null) {
      throw new Error("deployment");
    }
    const revoked = await start({ registry: withChain({ deployment: { ...deployment, status: "revoked" }, contracts: {} }) });
    const link = await invoice(1_000_000n, 1);
    expect(await post(revoked.url, PAY, body(await authorize(link, chain.accounts.payer)))).toMatchObject({ status: 503, body: { code: "chain-not-ready" } });
    const cancel = await signCancel({ signer: chain.accounts.payee, deployment: { chainId: CHAIN_ID, verifyingContract: chain.payLink }, invoice: link.invoice, deadline: (await chain.now()) + 3_600n });
    expect(await post(revoked.url, `/v1/${String(CHAIN_ID)}/cancel`, toCancelAuthorizationJson(cancel))).toMatchObject({ status: 503, body: { code: "chain-not-ready" } });
    expect(await post(revoked.url, `/v1/${String(CHAIN_ID)}/onboard`, { chainId: CHAIN_ID, address: chain.accounts.payer.address })).toMatchObject({ status: 404, body: { code: "onboarding-unavailable" } });
    const health = await call(revoked.url, "/v1/health");
    expect((health.body["chains"] as Record<string, unknown>[])[0]).toMatchObject({ state: "awaiting-deployment", deployment: null, operations: { pay: false, cancel: false, onboard: false } });
  });

  it("caps relays per payer per day, and refuses a mis-checksummed onboarding address", async () => {
    const relayer = await start({ policy: withPolicy({ limits: (c) => ({ ...withPolicy().limits(c), maxRelaysPerPayerPerDay: 1 }) }) });
    const first = await post(relayer.url, PAY, body(await authorize(await invoice(1_000_000n, 1), chain.accounts.payer3)));
    expect(first.status).toBe(202);
    await chain.client.waitForTransactionReceipt({ hash: first.body["txHash"] as Hex });
    await relayer.tick();
    const second = await post(relayer.url, PAY, body(await authorize(await invoice(1_000_000n, 1), chain.accounts.payer3)));
    expect(second).toMatchObject({ status: 429, body: { code: "refused", reason: "daily-cap" } });
    const bad = await post(relayer.url, `/v1/${String(CHAIN_ID)}/onboard`, { chainId: CHAIN_ID, address: "0x000000000000000000000000000000000000DEad" });
    expect(bad).toMatchObject({ status: 400, body: { code: "invalid-request", rule: "Address" } });
  });

  it("one requester relaying payments and cancellations that all succeed cannot spend the day's budget: others still pay (T-03)", async () => {
    // Monad's price level: a 100-gwei tip, so each relay is charged about `gasLimit × 101 gwei`, as Monad charges.
    const tip = 100n * 10n ** 9n;
    faults.set("eth_maxPriorityFeePerGas", () => `0x${tip.toString(16)}`);
    // Monad's shares and caps (policy.ts), on a day whose payments' share holds about twelve relays at the gas ceiling.
    const perPay = gasBounds(chain.local, "payWithAuthorization").ceiling * (tip + 2n * 10n ** 9n);
    const relayer = await start({
      policy: withPolicy({
        limits: (c) => ({
          ...withPolicy().limits(c),
          dailyGasBudgetWei: perPay * 20n,
          budgetShareBps: { pay: 6_000, cancel: 1_000, onboard: 3_000 },
          requesterShareBps: 2_000,
          maxRelaysPerRequesterPerDay: 10,
          maxPaysPerPayeePerDay: 20,
          maxCancelsPerPayeePerDay: 3,
        }),
      }),
    });
    const engine = await relayer.engine(CHAIN_ID);
    const limits = engine.policy.limits(engine.chain);
    const attacker = "ip4:198.51.100.7";
    let request = 0;
    const settle = async (result: EngineResult): Promise<void> => {
      if (result.ok) {
        await chain.client.waitForTransactionReceipt({ hash: result.body.txHash });
        await relayer.tick();
      }
    };
    const refusal = (result: EngineResult): string | undefined => (result.ok ? undefined : (result.problem.reason ?? result.problem.code));

    // Self-dealing payments: the attacker pays their own payee one cent at a time, every relay settles.
    let paid = 0;
    let stopped: string | undefined;
    for (let i = 0; i < 10 && stopped === undefined; i += 1) {
      const result = await engine.pay({ body: body(await authorize(await invoice(10_000n, 1), chain.accounts.payer3)), requester: attacker, requestId: `pay-${String((request += 1))}` });
      stopped = refusal(result);
      paid += result.ok ? 1 : 0;
      await settle(result);
    }
    expect(stopped).toBe("requester-budget");
    expect(paid).toBeGreaterThanOrEqual(1);
    const charged = BigInt(engine.snapshot().counters.perRequesterGasWei[`pay|${attacker}`] ?? "0");
    expect(charged).toBeLessThanOrEqual(requesterBudgetWei(limits, "pay"));

    // Gasless cancellations of throwaway invoices, from the same requester: its part of the cancellations' share.
    let cancelled = 0;
    stopped = undefined;
    for (let i = 0; i < 10 && stopped === undefined; i += 1) {
      const link = await invoice(1_000_000n, 1);
      const cancel = toCancelAuthorizationJson(await signCancel({ signer: chain.accounts.payee, deployment: { chainId: CHAIN_ID, verifyingContract: chain.payLink }, invoice: link.invoice, deadline: (await chain.now()) + 3_600n }));
      const result = await engine.cancel({ body: cancel, requester: attacker, requestId: `cancel-${String((request += 1))}` });
      stopped = refusal(result);
      cancelled += result.ok ? 1 : 0;
      await settle(result);
    }
    expect(stopped).toBe("requester-budget");
    expect(cancelled).toBeGreaterThanOrEqual(1);
    // From many networks, a payee's own cancellations stop at three a day.
    stopped = undefined;
    for (let i = 0; i < 6 && stopped === undefined; i += 1) {
      const link = await invoice(1_000_000n, 1);
      const cancel = toCancelAuthorizationJson(await signCancel({ signer: chain.accounts.payee, deployment: { chainId: CHAIN_ID, verifyingContract: chain.payLink }, invoice: link.invoice, deadline: (await chain.now()) + 3_600n }));
      const result = await engine.cancel({ body: cancel, requester: `ip4:203.0.113.${String(10 + i)}`, requestId: `cancel-${String((request += 1))}` });
      stopped = refusal(result);
      cancelled += result.ok ? 1 : 0;
      await settle(result);
    }
    expect(stopped).toBe("daily-cap");
    expect(cancelled).toBe(3);

    // The payments' share is mostly untouched: another requester's payer is relayed.
    const budget = engine.snapshot().budget;
    expect(BigInt(budget.byKind.pay.spentWei)).toBeLessThanOrEqual(requesterBudgetWei(limits, "pay"));
    const other = await engine.pay({ body: body(await authorize(await invoice(2_000_000n, 1), chain.accounts.payer2)), requester: "ip4:192.0.2.44", requestId: "other" });
    expect(other).toMatchObject({ ok: true, httpStatus: 202, body: { status: "submitted", kind: "pay" } });
    await settle(other);
  });

  it("incident levers (docs/security/incident-response.md §4): no payer allowance stops payments and keeps cancellations; no budget stops both", async () => {
    const payFreeze = await start({ policy: withPolicy({ limits: (c) => ({ ...withPolicy().limits(c), maxRelaysPerPayerPerDay: 0 }) }) });
    const link = await invoice(1_000_000n, 1);
    expect(await post(payFreeze.url, PAY, body(await authorize(link, chain.accounts.payer2)))).toMatchObject({ status: 429, body: { code: "refused", reason: "daily-cap", fallback: "self-submit" } });
    const cancel = toCancelAuthorizationJson(await signCancel({ signer: chain.accounts.payee, deployment: { chainId: CHAIN_ID, verifyingContract: chain.payLink }, invoice: link.invoice, deadline: (await chain.now()) + 3_600n }));
    const cancelled = await post(payFreeze.url, `/v1/${String(CHAIN_ID)}/cancel`, cancel);
    expect(cancelled.status).toBe(202);
    await chain.client.waitForTransactionReceipt({ hash: cancelled.body["txHash"] as Hex });
    await payFreeze.tick();

    const stopped = await start({ policy: withPolicy({ limits: (c) => ({ ...withPolicy().limits(c), dailyGasBudgetWei: 0n }) }) });
    const other = await invoice(1_000_000n, 1);
    expect(await post(stopped.url, PAY, body(await authorize(other, chain.accounts.payer2)))).toMatchObject({ status: 503, body: { code: "budget-exhausted", fallback: "self-submit" } });
    const otherCancel = toCancelAuthorizationJson(await signCancel({ signer: chain.accounts.payee, deployment: { chainId: CHAIN_ID, verifyingContract: chain.payLink }, invoice: other.invoice, deadline: (await chain.now()) + 3_600n }));
    expect(await post(stopped.url, `/v1/${String(CHAIN_ID)}/cancel`, otherCancel)).toMatchObject({ status: 503, body: { code: "budget-exhausted" } });
  });

  it("answers 409 invoice-closed when the invoice was paid by someone else first", async () => {
    const relayer = await start();
    const link = await invoice(2_000_000n, 1);
    const first = await post(relayer.url, PAY, body(await authorize(link, chain.accounts.payer)));
    await chain.client.waitForTransactionReceipt({ hash: first.body["txHash"] as Hex });
    await relayer.tick();
    const late = await post(relayer.url, PAY, body(await authorize(link, chain.accounts.payer2)));
    expect(late).toMatchObject({ status: 409, body: { code: "invoice-closed", error: { name: "SoldOut", source: "contract", i18nKey: "error.contract.soldOut" } } });
  });
});
