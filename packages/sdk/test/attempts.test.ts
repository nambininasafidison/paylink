// SPDX-License-Identifier: MIT
/**
 * Retry safety (invoice spec §8.6; audit finding A-01). Regression tests for the double charge: a client that
 * retries a slow relayed payment by re-signing with a fresh salt, or by falling back to permit, pays twice on any
 * link with `maxPayments != 1` once the first authorization lands late. The on-chain half of the story (no
 * cross-authorization deduplication; resubmitting the same authorization is idempotent; `cancelAuthorization`
 * kills a stale one) is pinned by protocol/test/audit/A01_RetryDoublePay.t.sol and by the anvil suite.
 */
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, hashTypedData, keccak256, pad, parseAbi, recoverAddress, toFunctionSelector } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  assessOutstanding,
  assessOutstandingAuthorization,
  AUTHORIZATION_CANCELED_TOPIC,
  authorizePayment,
  CANCEL_AUTHORIZATION_TYPEHASH,
  cancelAuthorizationTypedData,
  decodeInvoiceFragment,
  expiresIn,
  isAuthorizationDead,
  isPayLinkError,
  issueInvoice,
  memoryOutstandingAuthorizationStore,
  outstandingAuthorizationId,
  parseOutstandingAuthorization,
  payWithAuthorizationCall,
  prepareAuthorizationCancel,
  readAuthorizationState,
  recordOutstandingAuthorization,
  resubmissionCall,
  selectPaymentPath,
  withCancellation,
} from "../src/index.ts";
import type { AuthorizationAssessment, DecodedInvoiceLink, OutstandingAuthorization, PayLinkErrorCode } from "../src/index.ts";
import { CHAIN_ID, CONTRACT, PERMIT_TOKEN, payee, payer, registry, T0, TOKEN } from "./helpers.ts";
import { mockClient } from "./mock-client.ts";

const TOKEN_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
const AUTHORIZATION_STATE = toFunctionSelector("authorizationState(address,bytes32)");

async function expectCode(run: () => Promise<unknown>, code: PayLinkErrorCode): Promise<Readonly<Record<string, string>>> {
  try {
    await run();
  } catch (error) {
    expect(isPayLinkError(error) ? error.code : error).toBe(code);
    return isPayLinkError(error) ? error.params : {};
  }
  return expect.unreachable(`expected ${code}`);
}

/** A receive card: open amount, unlimited payments, no expiry. The links where a double charge can happen. */
async function receiveCard(): Promise<DecodedInvoiceLink> {
  const issued = await issueInvoice({
    registry,
    chainId: CHAIN_ID,
    draft: { payee: payee.address, token: TOKEN, amount: 0n, maxPayments: 0, validAfter: T0, expiry: { kind: "never", confirmed: true } },
    signer: payee,
  });
  return decodeInvoiceFragment(issued.fragment, registry);
}

/** A mined receipt of the payer's `cancelAuthorization`, with the token's event (or `logs` to override it). */
const cancelReceipt = (nonce: Hex, overrides: { status?: "success" | "reverted"; address?: Hex; payer?: Hex; nonce?: Hex } = {}) => ({
  status: overrides.status ?? ("success" as const),
  logs: [
    {
      address: overrides.address ?? TOKEN,
      topics: [AUTHORIZATION_CANCELED_TOPIC, pad(overrides.payer ?? payer.address.toLowerCase() as Hex), overrides.nonce ?? nonce],
      data: "0x" as Hex,
      logIndex: 0,
    },
  ],
});

/** The token answers `authorizationState` with `consumed`. */
const chain = (consumed: boolean) => mockClient({ answers: { [AUTHORIZATION_STATE]: encodeFunctionResult({ abi: TOKEN_ABI, functionName: "authorizationState", result: consumed }) } });

describe("retry safety: the slow-relayer double charge (A-01)", () => {
  it("persists the signed body, survives a reload, and makes every retry resubmit it byte for byte", async () => {
    const link = await receiveCard();
    const store = memoryOutstandingAuthorizationStore();
    const id = outstandingAuthorizationId({ chainId: CHAIN_ID, key: link.key, payer: payer.address });
    expect(id).toBe(`paylink.v2.authorization/${String(CHAIN_ID)}/${link.key}/${payer.address.toLowerCase()}`);

    // Attempt 1: sign, persist *before* posting to the relayer.
    const first = await authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 12_340_000n });
    await store.put(id, recordOutstandingAuthorization(link, first));

    // 30 s later the relayer has not landed it; the page reloads; the client looks before it signs.
    const checked = parseOutstandingAuthorization(await store.get(id), registry);
    const assessment = await assessOutstanding({ client: chain(false), checked, now: T0 + 30n });
    expect(assessment).toEqual({ state: "live", validBefore: T0 + 600n });

    // Re-signing is refused (a fresh salt would be a second payment on this card)...
    const params = await expectCode(() => authorizePayment({ outstanding: assessment, link, signer: payer, now: T0 + 30n, amount: 12_340_000n }), "E_AUTHORIZATION_OUTSTANDING");
    expect(params).toEqual({ validBefore: String(T0 + 600n) });
    // ...even when the user insists it is a new payment: one outstanding authorization per link and payer.
    await expectCode(() => authorizePayment({ outstanding: assessment, link, signer: payer, now: T0 + 30n, amount: 12_340_000n, newPayment: true }), "E_AUTHORIZATION_OUTSTANDING");

    // ...the router offers only resubmission of the stored authorization, never permit or approve-and-pay...
    const route = selectPaymentPath({ capabilities: link.token.capabilities, account: "eoa", relayerHealthy: false, outstanding: assessment });
    expect(route).toEqual({
      available: true,
      path: "self-authorization",
      fallbacks: [],
      payerPaysGas: true,
      resubmit: { validBefore: T0 + 600n, withheld: ["permit", "batched-approve-pay", "approve-pay"] },
    });

    // ...and "pay with your own gas" sends exactly the authorization the relayer holds: whichever lands first wins,
    // the other reverts in the token ("authorization is used"), and the payer is charged once.
    const resubmitted = resubmissionCall(checked);
    expect(resubmitted).toEqual(payWithAuthorizationCall(CONTRACT, link.invoice, link.signature, first.authorization));
    expect(checked.outstanding).toEqual(recordOutstandingAuthorization(link, first));
  });

  it("treats a consumed authorization as paid: no new signature unless the user starts a new payment", async () => {
    const link = await receiveCard();
    const first = await authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 5n });
    const checked = parseOutstandingAuthorization(JSON.parse(JSON.stringify(recordOutstandingAuthorization(link, first))), registry);
    const consumed = await assessOutstanding({ client: chain(true), checked, now: T0 + 30n });
    expect(consumed).toEqual({ state: "consumed" });
    expect(selectPaymentPath({ capabilities: link.token.capabilities, account: "passkey", relayerHealthy: true, outstanding: consumed })).toEqual({
      available: false,
      reason: "authorization-consumed",
    });
    await expectCode(() => authorizePayment({ outstanding: consumed, link, signer: payer, now: T0 + 30n, amount: 5n }), "E_AUTHORIZATION_CONSUMED");
    const second = await authorizePayment({ outstanding: consumed, link, signer: payer, now: T0 + 30n, amount: 5n, newPayment: true });
    expect(second.nonce).not.toBe(first.nonce);
  });

  it("unlocks a fresh signature and the other paths only once the authorization is dead", async () => {
    const link = await receiveCard();
    const first = await authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 5n });
    const record = recordOutstandingAuthorization(link, first);

    // Expired: chain time at validBefore, never used. FiatToken requires now < validBefore, and time never goes back.
    const expired = assessOutstandingAuthorization({ outstanding: record, now: T0 + 600n, consumed: false });
    expect(expired).toEqual({ state: "expired" });
    expect(assessOutstandingAuthorization({ outstanding: record, now: T0 + 599n, consumed: false })).toEqual({ state: "live", validBefore: T0 + 600n });

    // Cancelled: the payer's cancelAuthorization was mined and the token agrees the nonce is spent.
    const txHash: Hex = `0x${"c4".repeat(32)}`;
    const checked = parseOutstandingAuthorization(record, registry);
    const withCancel = withCancellation(checked, txHash, cancelReceipt(first.nonce));
    expect(withCancel.cancelTxHash).toBe(txHash);
    const cancelled = assessOutstandingAuthorization({ outstanding: withCancel, now: T0 + 30n, consumed: true });
    expect(cancelled).toEqual({ state: "cancelled" });
    // A recorded cancellation the chain does not confirm (a reorg) counts for nothing.
    expect(assessOutstandingAuthorization({ outstanding: withCancel, now: T0 + 30n, consumed: false })).toEqual({ state: "live", validBefore: T0 + 600n });
    // A cancel that lost the race to the relayer reverted: recording it would invite a second payment.
    for (const receipt of [
      cancelReceipt(first.nonce, { status: "reverted" }),
      cancelReceipt(first.nonce, { address: PERMIT_TOKEN }),
      cancelReceipt(first.nonce, { payer: payee.address.toLowerCase() as Hex }),
      cancelReceipt(first.nonce, { nonce: `0x${"00".repeat(32)}` }),
      { status: "success" as const, logs: [] },
    ]) {
      expect(() => withCancellation(checked, txHash, receipt)).toThrow(/did not cancel/);
    }

    for (const dead of [expired, cancelled] as const) {
      expect(isAuthorizationDead(dead)).toBe(true);
      const route = selectPaymentPath({ capabilities: link.token.capabilities, account: "eoa", relayerHealthy: false, outstanding: dead });
      expect(route).toMatchObject({ available: true, path: "self-authorization", fallbacks: ["permit", "approve-pay"], resubmit: null });
      expect((await authorizePayment({ outstanding: dead, link, signer: payer, now: T0 + 700n, amount: 5n })).nonce).not.toBe(first.nonce);
    }
    expect(isAuthorizationDead(null)).toBe(true);
    expect(isAuthorizationDead({ state: "consumed" })).toBe(false);
    expect(isAuthorizationDead({ state: "live", validBefore: 1n })).toBe(false);
    expect(() => withCancellation(checked, "0x1234", cancelReceipt(first.nonce))).toThrow(/transaction hash/);
  });

  it("routes a live authorization to the relayer first, and waits for it when the payer has no gas", () => {
    const live: AuthorizationAssessment = { state: "live", validBefore: T0 + 600n };
    const capabilities = { eip3009: true, eip2612: false, native: false };
    expect(selectPaymentPath({ capabilities, account: "passkey", relayerHealthy: true, payerHasGas: false, outstanding: live })).toEqual({
      available: true,
      path: "relayed-authorization",
      fallbacks: [],
      payerPaysGas: false,
      resubmit: { validBefore: T0 + 600n, withheld: ["batched-approve-pay", "approve-pay"] },
    });
    expect(selectPaymentPath({ capabilities, account: "passkey", relayerHealthy: false, payerHasGas: false, outstanding: live })).toEqual({
      available: false,
      reason: "needs-gas",
      whenRelayerReturns: "relayed-authorization",
      resubmit: { validBefore: T0 + 600n, withheld: ["batched-approve-pay", "approve-pay"] },
    });
    expect(selectPaymentPath({ capabilities, account: "eoa", relayerHealthy: true, outstanding: live })).toMatchObject({
      path: "relayed-authorization",
      fallbacks: ["self-authorization"],
    });
  });
});

describe("cancelAuthorization: the way out of a live authorization", () => {
  it("signs CancelAuthorization under the token's domain and builds the payer's call to the token", async () => {
    const link = await receiveCard();
    const first = await authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 5n });
    const checked = parseOutstandingAuthorization(recordOutstandingAuthorization(link, first), registry);
    const { call, digest } = await prepareAuthorizationCancel({ checked, signer: payer });
    expect(call).toMatchObject({ to: TOKEN, value: 0n });
    const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: call.data });
    expect(decoded.functionName).toBe("cancelAuthorization");
    const [authorizer, nonce, v, r, s] = decoded.args as readonly [string, Hex, number, Hex, Hex];
    expect([authorizer, nonce]).toEqual([payer.address, first.nonce]);
    // The digest is the EIP-712 hash FiatToken checks: CANCEL_AUTHORIZATION_TYPEHASH over (authorizer, nonce).
    const domain = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKEN };
    expect(digest).toBe(hashTypedData(cancelAuthorizationTypedData(domain, payer.address, first.nonce)));
    const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [CANCEL_AUTHORIZATION_TYPEHASH, payer.address, first.nonce]));
    expect(hashTypedData({ ...cancelAuthorizationTypedData(domain, payer.address, first.nonce) })).toBe(
      keccak256(`0x1901${keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }], [
        "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
        keccak256(new TextEncoder().encode("USDC")),
        keccak256(new TextEncoder().encode("2")),
        BigInt(CHAIN_ID),
        TOKEN,
      ])).slice(2)}${structHash.slice(2)}`),
    );
    expect(await recoverAddress({ hash: digest, signature: `0x${r.slice(2)}${s.slice(2)}${v.toString(16)}` })).toBe(payer.address);
  });

  it("refuses a signer other than the payer", async () => {
    const link = await receiveCard();
    const first = await authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 5n });
    const checked = parseOutstandingAuthorization(recordOutstandingAuthorization(link, first), registry);
    await expectCode(() => prepareAuthorizationCancel({ checked, signer: payee }), "E_INVALID_ARGUMENT");
    const lying = { address: payer.address, signTypedData: payee.signTypedData };
    await expectCode(() => prepareAuthorizationCancel({ checked, signer: lying }), "E_SIGNATURE_INVALID");
  });
});

describe("stored records are untrusted input", () => {
  const stored = async (): Promise<OutstandingAuthorization> => {
    const link = await receiveCard();
    return recordOutstandingAuthorization(link, await authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 5n }));
  };

  it("round-trips through JSON and the in-memory store", async () => {
    const record = await stored();
    const store = memoryOutstandingAuthorizationStore();
    expect(await store.get("missing")).toBeUndefined();
    await store.put("a", record);
    expect(await store.get("a")).toEqual(record);
    await store.delete("a");
    expect(await store.get("a")).toBeUndefined();
    const cancelled = withCancellation(parseOutstandingAuthorization(record, registry), `0x${"ab".repeat(32)}`, cancelReceipt(record.nonce));
    expect(parseOutstandingAuthorization(JSON.parse(JSON.stringify(cancelled)), registry).outstanding).toEqual(cancelled);
  });

  it("refuses tampered, foreign or malformed records", async () => {
    const record = await stored();
    const bad = async (value: unknown, code: PayLinkErrorCode = "E_INVALID_ARGUMENT"): Promise<void> => {
      await expectCode(() => Promise.resolve(parseOutstandingAuthorization(value, registry)), code);
    };
    await bad(null);
    await bad([record]);
    await bad({ ...record, version: 2 });
    await bad({ ...record, extra: true });
    await bad({ ...record, cancelTxHash: "0x12" });
    await bad({ ...record, key: `0x${"00".repeat(32)}` });
    await bad({ ...record, nonce: `0x${"00".repeat(32)}` });
    // A redirected request recomputes to another nonce: the stored nonce no longer matches.
    await bad({ ...record, request: { ...record.request, authorization: { ...record.request.authorization, payerRef: `0x${"ee".repeat(32)}` } } });
    await bad({ ...record, request: { ...record.request, invoice: { ...record.request.invoice, token: PERMIT_TOKEN } } }, "E_TOKEN_NOT_EIP3009");
    await bad({ ...record, request: { ...record.request, chainId: 10143 } }, "E_CHAIN_UNKNOWN");
  });
});

describe("readAuthorizationState", () => {
  it("decodes the token's answer and refuses a token that does not implement it", async () => {
    const nonce: Hex = `0x${"0a".repeat(32)}`;
    expect(await readAuthorizationState({ client: chain(true), token: TOKEN, payer: payer.address, nonce })).toBe(true);
    expect(await readAuthorizationState({ client: chain(false), token: TOKEN, payer: payer.address, nonce })).toBe(false);
    const silent = mockClient({});
    await expectCode(() => readAuthorizationState({ client: silent, token: TOKEN, payer: payer.address, nonce }), "E_TOKEN_NOT_EIP3009");
    const client = chain(false);
    await readAuthorizationState({ client, token: TOKEN, payer: payer.address, nonce });
    expect(decodeFunctionData({ abi: TOKEN_ABI, data: client.calls[0]?.data ?? "0x" }).args).toEqual([payer.address, nonce]);
  });
});

describe("authorizePayment keeps working for a first payment", () => {
  it("signs when the device holds nothing, and its record recomputes from the registry", async () => {
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token: TOKEN, amount: 1n, maxPayments: 1, validAfter: T0, expiry: expiresIn(T0) },
      signer: payee,
    });
    const link = decodeInvoiceFragment(issued.fragment, registry);
    const payment = await authorizePayment({ outstanding: null, link, signer: payer, now: T0 });
    const checked = parseOutstandingAuthorization(recordOutstandingAuthorization(link, payment), registry);
    expect(checked.verifyingContract).toBe(CONTRACT);
    expect(checked.token.address).toBe(TOKEN);
    expect(checked.request.authorization).toEqual(payment.authorization);
  });
});
