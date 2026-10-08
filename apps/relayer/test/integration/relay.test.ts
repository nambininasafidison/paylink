// SPDX-License-Identifier: MIT
/**
 * The relayer end to end on anvil (chain 10143, Monad's gas schedule) through its Node adapter: the HTTP app, the
 * ChainSender engine and the SDK checks against the release build of PayLinkV2 and the FiatToken-like Mock3009.
 * Payees and payers sign with the SDK exactly as the web app does; the chain is the judge.
 */
import { createRegistry, defineLocalChain, MONAD_GAS_TABLE } from "@paylink/chains";
import type { ChainDefinition } from "@paylink/chains";
import {
  authorizePayment,
  clampGasLimit,
  decodeInvoiceFragment,
  expiresIn,
  gasBounds,
  issueInvoice,
  payLinkV2Abi,
  payWithAuthorizationCall,
  readLinkState,
  signCancel,
  toCancelAuthorizationJson,
  verifyReceipt,
} from "@paylink/sdk";
import type { DecodedInvoiceLink, PaymentAuthorization, RelayPayRequestJson } from "@paylink/sdk";
import { encodeFunctionData, isAddressEqual, keccak256, toFunctionSelector } from "viem";
import type { Address, Hex, PrivateKeyAccount } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { faucetCall } from "../../src/core/chains.ts";
import { withPolicy } from "../../src/core/policy.ts";
import type { NodeRelayer } from "../../src/node/server.ts";
import { startNodeRelayer } from "../../src/node/server.ts";
import type { LocalChain } from "../fixtures/chain.ts";
import { CHAIN_ID, chainAvailable, KEYS, startChain, tokenEntry } from "../fixtures/chain.ts";
import { call, post } from "../fixtures/http.ts";

const PAY = `/v1/${String(CHAIN_ID)}/pay`;
const CANCEL = `/v1/${String(CHAIN_ID)}/cancel`;
const ONBOARD = `/v1/${String(CHAIN_ID)}/onboard`;
const APP = "https://paylink-mg.pages.dev";

describe.skipIf(!chainAvailable())("relayer on anvil (10143) through the Node adapter", () => {
  let chain: LocalChain;
  let relayer: NodeRelayer;
  let offset = 0;
  const logs: string[] = [];
  const clock = (): number => Date.now() + offset;

  const relayerNonce = async (): Promise<number> => await chain.client.getTransactionCount({ address: chain.accounts.relayer.address });

  const invoice = async (draft: { amount: bigint; maxPayments: number; never?: boolean }): Promise<DecodedInvoiceLink> => {
    const t = await chain.now();
    const issued = await issueInvoice({
      registry: chain.registry,
      chainId: CHAIN_ID,
      draft: {
        payee: chain.accounts.payee.address,
        token: chain.token,
        amount: draft.amount,
        maxPayments: draft.maxPayments,
        validAfter: t - 60n,
        expiry: draft.never === true ? { kind: "never", confirmed: true } : expiresIn(t),
      },
      signer: chain.accounts.payee,
      client: chain.client,
    });
    return decodeInvoiceFragment(issued.fragment, chain.registry);
  };
  const authorize = async (link: DecodedInvoiceLink, payer: PrivateKeyAccount, amount?: bigint): Promise<PaymentAuthorization> =>
    await authorizePayment({ outstanding: null, link, signer: payer, now: await chain.now(), client: chain.client, ...(amount === undefined ? {} : { amount }) });
  const body = (authorized: PaymentAuthorization): RelayPayRequestJson => JSON.parse(JSON.stringify(authorized.request)) as RelayPayRequestJson;

  beforeAll(async () => {
    chain = await startChain();
    relayer = await startNodeRelayer({ registry: chain.registry, privateKey: KEYS.relayer, clock, autoTrack: false, log: (line) => logs.push(line) });
  });

  afterAll(async () => {
    await relayer.close();
    chain.stop();
  });

  it("reports the chain ready in /v1/health, with the relayer's address and the canonical deployment", async () => {
    const health = await call(relayer.url, "/v1/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: "ok", service: "paylink-relayer" });
    const [status] = health.body["chains"] as Record<string, unknown>[];
    expect(status).toMatchObject({
      chainId: CHAIN_ID,
      state: "ready",
      relayer: chain.accounts.relayer.address,
      deployment: chain.payLink,
      operations: { pay: true, cancel: true, onboard: true },
      pending: 0,
      relayMarginSeconds: 120,
    });
  });

  it("relays a real payWithAuthorization: value 0, the clamped gas limit, settled and verified on chain", async () => {
    const link = await invoice({ amount: 25_000_000n, maxPayments: 1 });
    const authorized = await authorize(link, chain.accounts.payer);
    const expected = payWithAuthorizationCall(chain.payLink, link.invoice, link.signature, authorized.authorization);
    const estimate = await chain.client.estimateGas({ account: chain.accounts.relayer.address, to: expected.to, data: expected.data, blockTag: "pending" });
    const payeeBefore = await chain.balanceOf(chain.accounts.payee.address);

    const reply = await post(relayer.url, PAY, body(authorized), { origin: APP });
    expect(reply.status).toBe(202);
    expect(reply.headers.get("access-control-allow-origin")).toBe(APP);
    expect(reply.body).toMatchObject({ status: "submitted", kind: "pay", chainId: CHAIN_ID, duplicate: false, subject: link.key });
    const hash = reply.body["txHash"] as Hex;

    const tx = await chain.client.getTransaction({ hash });
    expect(tx.from.toLowerCase()).toBe(chain.accounts.relayer.address.toLowerCase());
    expect(tx.to).toBe(chain.payLink.toLowerCase());
    expect(tx.value).toBe(0n);
    expect(tx.input.slice(0, 10)).toBe(toFunctionSelector("payWithAuthorization((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32),bytes,(address,uint128,bytes32,uint256,uint256,bytes32,uint8,bytes32,bytes32))"));
    expect(tx.input).toBe(expected.data);
    // Monad charges the limit: exactly clamp(estimate × 1.10, floor, ceiling) from @paylink/chains.
    const bounds = gasBounds(chain.local, "payWithAuthorization");
    expect(tx.gas).toBe(clampGasLimit(estimate, bounds));
    expect(tx.gas).toBeGreaterThanOrEqual(bounds.floor);
    expect(tx.gas).toBeLessThanOrEqual(bounds.ceiling);
    expect(reply.body["gasLimit"]).toBe(tx.gas.toString());

    const receipt = await chain.client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect((await chain.balanceOf(chain.accounts.payee.address)) - payeeBefore).toBe(25_000_000n);
    const paid = receipt.logs.find((log) => isAddressEqual(log.address, chain.payLink));
    const verified = await verifyReceipt({ registry: chain.registry, client: chain.client, reference: { chainId: CHAIN_ID, txHash: hash, logIndex: paid?.logIndex ?? -1 }, paid: link });
    expect(verified).toMatchObject({ valid: true });

    // The tracker sees the receipt and gives the admission ticket back.
    const engine = await relayer.engine(CHAIN_ID);
    expect(engine.snapshot().ledger.inFlight).toHaveLength(1);
    await relayer.tick();
    expect(engine.snapshot()).toMatchObject({ pending: [], ledger: { inFlight: [] } });
    expect(engine.snapshot().recent.map((r) => r.txHash)).toContain(hash);
  });

  it("answers a replay of a settled authorisation with the same transaction, and a fresh relayer refuses it (409)", async () => {
    const link = await invoice({ amount: 0n, maxPayments: 0, never: true });
    const authorized = await authorize(link, chain.accounts.payer, 1_000_000n);
    const first = await post(relayer.url, PAY, body(authorized));
    expect(first.status).toBe(202);
    await chain.client.waitForTransactionReceipt({ hash: first.body["txHash"] as Hex });
    await relayer.tick();
    const nonceBefore = await relayerNonce();

    const replay = await post(relayer.url, PAY, body(authorized));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: "settled", duplicate: true, txHash: first.body["txHash"] });

    // A relayer without that memory (another isolate, a restart): the token says the authorisation is used.
    const fresh = await startNodeRelayer({ registry: chain.registry, privateKey: KEYS.relayer, autoTrack: false });
    try {
      const refused = await post(fresh.url, PAY, body(authorized));
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "already-settled" });
      expect(refused.headers.get("content-type")).toMatch(/^application\/problem\+json/u);
    } finally {
      await fresh.close();
    }
    expect(await relayerNonce()).toBe(nonceBefore);
  });

  it("answers a replay while the relay is pending with the pending transaction, sending nothing new", async () => {
    const link = await invoice({ amount: 2_000_000n, maxPayments: 1 });
    const authorized = await authorize(link, chain.accounts.payer2);
    await chain.automine(false);
    try {
      const first = await post(relayer.url, PAY, body(authorized));
      expect(first.status).toBe(202);
      const again = await post(relayer.url, PAY, body(authorized));
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ status: "pending", duplicate: true, txHash: first.body["txHash"] });
      // Still the pending transaction once the authorisation is inside the relay margin (a fresh request would be refused).
      await chain.rpc("evm_increaseTime", [500]);
      const late = await post(relayer.url, PAY, body(authorized));
      expect(late.body).toMatchObject({ status: "pending", duplicate: true, txHash: first.body["txHash"] });
      const pool = await chain.rpc<{ pending: Record<string, Record<string, unknown>> }>("txpool_content");
      expect(Object.keys(pool.pending[chain.accounts.relayer.address] ?? pool.pending[chain.accounts.relayer.address.toLowerCase()] ?? {})).toHaveLength(1);
      await chain.mine();
      await relayer.tick();
      expect((await relayer.engine(CHAIN_ID)).snapshot().pending).toEqual([]);
    } finally {
      await chain.automine(true);
    }
  });

  it("rejects a tampered amount or reference before spending any gas (422)", async () => {
    const nonceBefore = await relayerNonce();
    // A fixed invoice: the authorised amount must equal the invoice amount.
    const fixed = await invoice({ amount: 5_000_000n, maxPayments: 1 });
    const fixedBody = body(await authorize(fixed, chain.accounts.payer3));
    const wrongAmount = await post(relayer.url, PAY, { ...fixedBody, authorization: { ...fixedBody.authorization, amount: "5000001" } });
    expect(wrongAmount.status).toBe(422);
    expect(wrongAmount.body).toMatchObject({ code: "rejected", rule: "WrongAmount" });

    // A receive card: any amount is valid, but the payer signed a different one (the nonce binds it).
    const card = await invoice({ amount: 0n, maxPayments: 0, never: true });
    const cardBody = body(await authorize(card, chain.accounts.payer3, 1_000_000n));
    const inflated = await post(relayer.url, PAY, { ...cardBody, authorization: { ...cardBody.authorization, amount: "9000000" } });
    expect(inflated.status).toBe(422);
    expect(inflated.body).toMatchObject({ code: "rejected", rule: "E_SIGNATURE_INVALID" });

    // The payer's reference is bound the same way.
    const reference = await post(relayer.url, PAY, { ...cardBody, authorization: { ...cardBody.authorization, payerRef: `0x${"ee".repeat(32)}` } });
    expect(reference.status).toBe(422);
    expect(reference.body).toMatchObject({ code: "rejected", rule: "E_SIGNATURE_INVALID" });

    // Changing the invoice itself breaks the payee's signature.
    const forged = await post(relayer.url, PAY, { ...fixedBody, invoice: { ...fixedBody.invoice, amount: "1" }, authorization: { ...fixedBody.authorization, amount: "1" } });
    expect(forged.status).toBe(422);
    expect(forged.body).toMatchObject({ code: "rejected", rule: "E_SIGNATURE_INVALID" });

    // Redirecting to another chain in the body.
    const elsewhere = await post(relayer.url, PAY, { ...fixedBody, chainId: 84532 });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body).toMatchObject({ code: "invalid-request", rule: "ChainMismatch" });

    expect(await relayerNonce()).toBe(nonceBefore);
  });

  it("refuses amounts below one cent, which only sybils would relay", async () => {
    const card = await invoice({ amount: 0n, maxPayments: 0, never: true });
    const reply = await post(relayer.url, PAY, body(await authorize(card, chain.accounts.payer3, 9_999n)));
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ code: "rejected", rule: "BelowMinimumAmount", fallback: "self-submit" });
  });

  it("keeps one relay in flight per invoice: a second payer of the same card is refused (409), then admitted", async () => {
    const card = await invoice({ amount: 0n, maxPayments: 0, never: true });
    await chain.automine(false);
    try {
      const first = await post(relayer.url, PAY, body(await authorize(card, chain.accounts.payer, 1_000_000n)));
      expect(first.status).toBe(202);
      const second = await post(relayer.url, PAY, body(await authorize(card, chain.accounts.payer2, 1_000_000n)));
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: "refused", reason: "in-flight-key", fallback: "self-submit" });
      await chain.mine();
      await relayer.tick();
    } finally {
      await chain.automine(true);
    }
    const later = await post(relayer.url, PAY, body(await authorize(card, chain.accounts.payer2, 1_000_000n)));
    expect(later.status).toBe(202);
    await chain.client.waitForTransactionReceipt({ hash: later.body["txHash"] as Hex });
    await relayer.tick();
  });

  it("relays cancelBySig; a replay is answered with the same transaction, a fresh relayer says already cancelled", async () => {
    const link = await invoice({ amount: 3_000_000n, maxPayments: 3 });
    const cancel = await signCancel({ signer: chain.accounts.payee, deployment: { chainId: CHAIN_ID, verifyingContract: chain.payLink }, invoice: link.invoice, deadline: (await chain.now()) + 3_600n, client: chain.client });
    const json = toCancelAuthorizationJson(cancel);
    const reply = await post(relayer.url, CANCEL, json, { origin: APP });
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ kind: "cancel", subject: link.key });
    const receipt = await chain.client.waitForTransactionReceipt({ hash: reply.body["txHash"] as Hex });
    expect(receipt.status).toBe("success");
    const tx = await chain.client.getTransaction({ hash: receipt.transactionHash });
    expect(tx.value).toBe(0n);
    expect(tx.gas).toBeLessThanOrEqual(gasBounds(chain.local, "cancelBySig").ceiling);
    expect((await readLinkState(chain.client, chain.payLink, link.key)).cancelled).toBe(true);
    await relayer.tick();

    expect(await post(relayer.url, CANCEL, json)).toMatchObject({ status: 200, body: { status: "settled", duplicate: true } });
    const fresh = await startNodeRelayer({ registry: chain.registry, privateKey: KEYS.relayer, autoTrack: false });
    try {
      expect(await post(fresh.url, CANCEL, json)).toMatchObject({ status: 409, body: { code: "already-cancelled" } });
    } finally {
      await fresh.close();
    }
  });

  it("refuses a cancellation whose deadline falls inside the relay margin (A-04)", async () => {
    const link = await invoice({ amount: 3_000_000n, maxPayments: 1 });
    const cancel = await signCancel({ signer: chain.accounts.payee, deployment: { chainId: CHAIN_ID, verifyingContract: chain.payLink }, invoice: link.invoice, deadline: (await chain.now()) + 30n });
    const reply = await post(relayer.url, CANCEL, toCancelAuthorizationJson(cancel));
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ code: "rejected", rule: "RelayValidityTooShort" });
  });

  it("onboards an address from the faucet, then reports the faucet's global cooldown and the per-address cap", async () => {
    const newcomer = "0x000000000000000000000000000000000000dEaD";
    const drip = faucetCall(chain.faucet, newcomer).data;
    const estimate = await chain.client.estimateGas({ account: chain.accounts.relayer.address, to: chain.faucet, data: drip, blockTag: "pending" });
    const reply = await post(relayer.url, ONBOARD, { chainId: CHAIN_ID, address: newcomer }, { origin: APP });
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ kind: "onboard", subject: newcomer });
    const receipt = await chain.client.waitForTransactionReceipt({ hash: reply.body["txHash"] as Hex });
    expect(receipt.status).toBe("success");
    expect(await chain.balanceOf(newcomer)).toBe(10_000_000_000n);
    const tx = await chain.client.getTransaction({ hash: receipt.transactionHash });
    expect([tx.to, tx.value]).toEqual([chain.faucet.toLowerCase(), 0n]);
    expect(tx.input).toBe(drip);
    // The mock faucet is far cheaper than the real one: estimate × 1.10 is below the registry floor, so the limit is
    // the floor itself (the bounds measured on the real faucet), never the bare estimate.
    const faucetGas = chain.local.contracts.ausdFaucet?.gas;
    expect(faucetGas).toBeDefined();
    expect((estimate * 110n) / 100n).toBeLessThan(faucetGas?.floor ?? 0n);
    expect(tx.gas).toBe(faucetGas?.floor);
    expect(tx.gas).toBe(clampGasLimit(estimate, faucetGas ?? { floor: 0n, ceiling: 0n }));
    await relayer.tick();

    const other = await post(relayer.url, ONBOARD, { chainId: CHAIN_ID, address: chain.accounts.payer3.address });
    expect(other.status).toBe(503);
    expect(other.body).toMatchObject({ code: "faucet-unavailable", retryAfter: 60 });
    expect(other.headers.get("retry-after")).toBe("60");

    await chain.rpc("evm_increaseTime", [61]);
    await chain.mine();
    const again = await post(relayer.url, ONBOARD, { chainId: CHAIN_ID, address: newcomer });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: "refused", reason: "daily-cap" });

    const self = await post(relayer.url, ONBOARD, { chainId: CHAIN_ID, address: chain.accounts.relayer.address });
    expect(self.body).toMatchObject({ code: "invalid-request" });
  });

  it("replaces a stuck transaction with the same nonce and fees x1.25 after 30 s; the replacement settles", async () => {
    const link = await invoice({ amount: 4_000_000n, maxPayments: 1 });
    await chain.automine(false);
    try {
      const reply = await post(relayer.url, PAY, body(await authorize(link, chain.accounts.payer)));
      expect(reply.status).toBe(202);
      const first = await chain.client.getTransaction({ hash: reply.body["txHash"] as Hex });
      offset += 31_000;
      await relayer.tick();
      const [record] = (await relayer.engine(CHAIN_ID)).snapshot().pending;
      expect(record?.attempts).toHaveLength(2);
      const replacement = record?.attempts[1];
      expect(replacement?.void).toBe(false);
      const second = await chain.client.getTransaction({ hash: replacement?.hash ?? "0x" });
      expect(second.nonce).toBe(first.nonce);
      expect(second.input).toBe(first.input);
      expect(second.maxPriorityFeePerGas).toBe(((first.maxPriorityFeePerGas ?? 0n) * 125n + 99n) / 100n);
      expect(second.maxFeePerGas).toBeGreaterThanOrEqual(((first.maxFeePerGas ?? 0n) * 125n + 99n) / 100n);
      await chain.mine();
      await relayer.tick();
      expect((await chain.client.getTransactionReceipt({ hash: second.hash })).status).toBe("success");
      expect((await relayer.engine(CHAIN_ID)).snapshot()).toMatchObject({ pending: [], ledger: { inFlight: [] } });
      expect((await readLinkState(chain.client, chain.payLink, link.key)).payments).toBe(1);
    } finally {
      await chain.automine(true);
    }
  });

  it("voids a stuck relay whose time bounds have passed with a zero-value self-transfer, instead of paying for a revert", async () => {
    const card = await invoice({ amount: 0n, maxPayments: 0, never: true });
    const authorized = await authorizePayment({ outstanding: null, link: card, signer: chain.accounts.payer2, now: await chain.now(), amount: 1_000_000n, ttlSeconds: 200n, client: chain.client });
    await chain.automine(false);
    try {
      const reply = await post(relayer.url, PAY, body(authorized));
      expect(reply.status).toBe(202);
      // Nothing is mined for longer than the authorisation lives.
      await chain.rpc("evm_increaseTime", [300]);
      offset += 31_000;
      await relayer.tick();
      const [record] = (await relayer.engine(CHAIN_ID)).snapshot().pending;
      expect(record?.attempts.at(-1)?.void).toBe(true);
      await chain.mine();
      await relayer.tick();
      const voided = await chain.client.getTransaction({ hash: record?.attempts.at(-1)?.hash ?? "0x" });
      expect([voided.to, voided.value, voided.input]).toEqual([chain.accounts.relayer.address.toLowerCase(), 0n, "0x"]);
      expect(await chain.client.getTransactionReceipt({ hash: reply.body["txHash"] as Hex }).catch(() => null)).toBeNull();
      // Dropped, not reverted: nobody is banned and the card stays relayable.
      expect((await relayer.engine(CHAIN_ID)).snapshot()).toMatchObject({ pending: [], ledger: { inFlight: [], bans: {} } });
    } finally {
      await chain.automine(true);
    }
  });

  it("a payment that lands first by the payer's own submission of the same authorisation costs nobody anything (superseded)", async () => {
    const card = await invoice({ amount: 0n, maxPayments: 0, never: true });
    const authorized = await authorize(card, chain.accounts.payer2, 1_500_000n);
    const payeeBefore = await chain.balanceOf(chain.accounts.payee.address);
    await chain.automine(false);
    let relayHash: Hex;
    try {
      const reply = await post(relayer.url, PAY, body(authorized));
      expect(reply.status).toBe(202);
      relayHash = reply.body["txHash"] as Hex;
      // Spec §8.6: the payer, tired of waiting, submits the very same authorisation with its own gas and a higher tip.
      const own = payWithAuthorizationCall(chain.payLink, card.invoice, card.signature, authorized.authorization);
      const { createWalletClient, http } = await import("viem");
      const payer = chain.accounts.payer2;
      await createWalletClient({ account: payer, transport: http(chain.url) }).sendTransaction({
        account: payer,
        chain: null,
        to: own.to,
        data: own.data,
        maxPriorityFeePerGas: 500_000_000_000n,
        maxFeePerGas: 900_000_000_000n,
        gas: 400_000n,
      });
      await chain.mine();
      expect((await chain.client.getTransactionReceipt({ hash: relayHash })).status).toBe("reverted");
      await relayer.tick();
    } finally {
      await chain.automine(true);
    }
    // Charged once: the payee received the amount once, whichever transaction carried it.
    expect((await chain.balanceOf(chain.accounts.payee.address)) - payeeBefore).toBe(1_500_000n);
    const final = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry["event"] === "tx.final" && entry["txHash"] === relayHash);
    expect(final).toEqual([expect.objectContaining({ outcome: "superseded", banned: [], struck: false })]);
    const snapshot = (await relayer.engine(CHAIN_ID)).snapshot();
    expect(snapshot).toMatchObject({ pending: [], ledger: { inFlight: [], bans: {}, strikes: {} } });
    // The resubmission is answered as settled by the token, and the card stays relayable for the next payer.
    expect(await post(relayer.url, PAY, body(authorized))).toMatchObject({ status: 409, body: { code: "already-settled" } });
    const next = await post(relayer.url, PAY, body(await authorize(card, chain.accounts.payer3, 1_000_000n)));
    expect(next.status).toBe(202);
    await chain.client.waitForTransactionReceipt({ hash: next.body["txHash"] as Hex });
    await relayer.tick();
  });

  it("attributes a post-simulation revert from chain evidence: a payee who cancels under a queued relay is banned with the card (A-02, A-04)", async () => {
    const card = await invoice({ amount: 0n, maxPayments: 0, never: true });
    await chain.automine(false);
    try {
      const reply = await post(relayer.url, PAY, body(await authorize(card, chain.accounts.payer3, 1_000_000n)));
      expect(reply.status).toBe(202);
      // The payee cancels the card with a higher tip, so it is ordered first in the same block.
      const payee = chain.accounts.payee;
      const { createWalletClient, http } = await import("viem");
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
      const receipt = await chain.client.getTransactionReceipt({ hash: reply.body["txHash"] as Hex });
      expect(receipt.status).toBe("reverted");
      await relayer.tick();
    } finally {
      await chain.automine(true);
    }
    const final = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry["event"] === "tx.final" && entry["outcome"] === "payee");
    expect(final.at(-1)).toMatchObject({ detail: "invoice-cancelled", banned: ["key", "payee"], struck: true });
    const banned = await post(relayer.url, PAY, body(await authorize(card, chain.accounts.payer, 1_000_000n)));
    expect(banned.status).toBe(429);
    expect(banned.body).toMatchObject({ code: "refused", reason: "banned-key", fallback: "self-submit" });
    expect(Number(banned.headers.get("retry-after"))).toBeGreaterThan(86_000);
  });

  it("refuses an estimate above the registry ceiling instead of sending a limit that cannot succeed", async () => {
    const tight: ChainDefinition = {
      ...chain.local,
      gas: { ...MONAD_GAS_TABLE, limits: { ...MONAD_GAS_TABLE.limits, payWithAuthorization: { floor: 100_000n, ceiling: 150_000n } } },
    };
    const capped = await startNodeRelayer({ registry: createRegistry([tight]), privateKey: KEYS.relayer, autoTrack: false });
    try {
      const nonceBefore = await relayerNonce();
      const link = await invoice({ amount: 6_000_000n, maxPayments: 1 });
      const reply = await post(capped.url, PAY, body(await authorize(link, chain.accounts.payer)));
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ code: "gas-above-ceiling", rule: "E_GAS_ABOVE_CEILING" });
      expect(await relayerNonce()).toBe(nonceBefore);
      expect((await capped.engine(CHAIN_ID)).snapshot().ledger.inFlight).toEqual([]);
    } finally {
      await capped.close();
    }
  });

  it("stops at the daily gas budget and when it has no valid key", async () => {
    const broke = await startNodeRelayer({
      registry: chain.registry,
      privateKey: KEYS.relayer,
      autoTrack: false,
      policy: withPolicy({ limits: (definition) => ({ ...withPolicy().limits(definition), dailyGasBudgetWei: 1_000n }) }),
    });
    const keyless = await startNodeRelayer({ registry: chain.registry, privateKey: "0x1234", autoTrack: false });
    try {
      const link = await invoice({ amount: 6_000_000n, maxPayments: 1 });
      const authorized = await authorize(link, chain.accounts.payer);
      const reply = await post(broke.url, PAY, body(authorized));
      expect(reply.status).toBe(503);
      expect(reply.body).toMatchObject({ code: "budget-exhausted", fallback: "self-submit" });
      const none = await post(keyless.url, PAY, body(authorized));
      expect(none).toMatchObject({ status: 503, body: { code: "relayer-unavailable" } });
      const health = await call(keyless.url, "/v1/health");
      expect(health.status).toBe(503);
      expect((health.body["chains"] as Record<string, unknown>[])[0]).toMatchObject({ state: "not-configured", relayer: null });
    } finally {
      await broke.close();
      await keyless.close();
    }
  });

  it("rate-limits requests per requester", async () => {
    const limited = await startNodeRelayer({ registry: chain.registry, privateKey: KEYS.relayer, autoTrack: false, policy: withPolicy({ requestsPerMinutePerRequester: 2 }) });
    try {
      const junk = { chainId: CHAIN_ID, address: "0x000000000000000000000000000000000000bEEF" };
      await post(limited.url, ONBOARD, junk);
      await post(limited.url, ONBOARD, junk);
      const third = await post(limited.url, ONBOARD, junk);
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ code: "rate-limited" });
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    } finally {
      await limited.close();
    }
  });

  it("serves local chains only unless told otherwise, and only on a valid local chain", async () => {
    await expect(startNodeRelayer({ registry: createRegistry([{ ...chain.local, local: false, key: "monad-testnet", rpc: [{ url: "https://testnet-rpc.monad.xyz", confidence: "L" }] }]), privateKey: KEYS.relayer })).rejects.toThrow(/local chains only/u);
    const other = defineLocalChain({ chainId: 31_337, rpcUrl: chain.url, tokens: [tokenEntry(chain.token)], deployment: null });
    const idle = await startNodeRelayer({ registry: createRegistry([other]), privateKey: KEYS.relayer, autoTrack: false });
    try {
      const reply = await post(idle.url, "/v1/31337/pay", { chainId: 31_337 });
      expect(reply.status).toBe(400);
      expect(await call(idle.url, "/v1/health")).toMatchObject({ status: 200, body: { status: "degraded" } });
    } finally {
      await idle.close();
    }
  });

  it("never signed value, never called anything but PayLinkV2, the faucet or its own address", async () => {
    const head = await chain.client.getBlockNumber();
    const allowed = [chain.payLink, chain.faucet, chain.accounts.relayer.address].map((a) => a.toLowerCase());
    let relayed = 0;
    for (let n = 0n; n <= head; n += 1n) {
      const block = await chain.client.getBlock({ blockNumber: n, includeTransactions: true });
      for (const tx of block.transactions) {
        if (isAddressEqual(tx.from, chain.accounts.relayer.address)) {
          relayed += 1;
          expect(tx.value).toBe(0n);
          expect(allowed).toContain(tx.to?.toLowerCase());
        }
      }
    }
    expect(relayed).toBeGreaterThanOrEqual(8);
  });

  it("logged JSON lines without the key, signatures or the client's IP", () => {
    expect(logs.length).toBeGreaterThan(20);
    const text = logs.join("\n").toLowerCase();
    expect(text).not.toContain(KEYS.relayer.slice(2).toLowerCase());
    // Requests come from 127.0.0.1 (as does anvil's RPC URL in transport errors): the requester identity never appears.
    expect(text).not.toContain("ip4:127.0.0.1");
    expect(text).not.toContain("payeesig");
    for (const line of logs) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry).toHaveProperty("event");
      expect(Object.keys(entry).some((key) => /signature|^r$|^s$|^ip$|^requester$/iu.test(key))).toBe(false);
    }
    expect(keccak256("0x00")).toMatch(/^0x/u);
  });
});

export type { Address };
