// SPDX-License-Identifier: MIT
/** Relayer-side checks (invoice spec §13.3): every rejection before anything is simulated or sent. */
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, toFunctionSelector, zeroAddress } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  assertRelayWindow,
  authorizePayment,
  DEFAULT_AUTHORIZATION_TTL_SECONDS,
  DEFAULT_CANCEL_TTL_SECONDS,
  checkRelayCancelRequest,
  checkRelayPayRequest,
  decodeInvoiceFragment,
  describeAccountCode,
  ERC1271_MAGIC_VALUE,
  receiveWithAuthorizationDigest,
  expiresIn,
  isPayLinkError,
  issueInvoice,
  parseCancelAuthorizationJson,
  parseRelayPayRequest,
  paymentValidThrough,
  payLinkV2Abi,
  relayMargin,
  signCancel,
  toCancelAuthorizationJson,
  ZERO_HASH,
} from "../src/index.ts";
import type { Expiry, PayLinkErrorCode, RelayPayRequest } from "../src/index.ts";
import { createRegistry, defineLocalChain, registry as shippedRegistry } from "@paylink/chains";
import { CHAIN_ID, CONTRACT, deploymentAt, PERMIT_TOKEN, payee, payer, registry, T0, testRegistry, token3009, TOKEN } from "./helpers.ts";
import { mockClient } from "./mock-client.ts";

async function expectRule(run: () => Promise<unknown>, code: PayLinkErrorCode, rule?: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(isPayLinkError(error) ? [error.code, error.params["rule"]] : error).toEqual([code, rule]);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

/** The relayer's chain: payees are EOAs, and the token answers ERC-5267 with USDC/2. */
const client = mockClient({
  answers: {
    [toFunctionSelector("eip712Domain()")]: encodeAbiParameters(
      [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
      ["0x0f", "USDC", "2", BigInt(CHAIN_ID), TOKEN, ZERO_HASH, []],
    ),
  },
});

async function payRequest(overrides: { amount?: bigint; token?: `0x${string}` } = {}): Promise<RelayPayRequest> {
  const issued = await issueInvoice({
    registry,
    chainId: CHAIN_ID,
    draft: { payee: payee.address, token: overrides.token ?? TOKEN, amount: overrides.amount ?? 25_000_000n, maxPayments: 1, validAfter: T0, expiry: expiresIn(T0), memo: "not for the relayer" },
    signer: payee,
  });
  const link = decodeInvoiceFragment(issued.fragment, registry);
  const amount = (overrides.amount ?? 25_000_000n) === 0n ? 5n : undefined;
  const { request } = await authorizePayment({ outstanding: null, link, signer: payer, now: T0, ...(amount === undefined ? {} : { amount }) });
  return parseRelayPayRequest(JSON.parse(JSON.stringify(request)));
}

describe("checkRelayPayRequest", () => {
  it("accepts a genuine request and builds the only call it may send", async () => {
    const request = await payRequest();
    const checked = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request, client, now: T0 + 10n });
    expect(checked.call).toMatchObject({ to: CONTRACT, value: 0n });
    expect(decodeFunctionData({ abi: payLinkV2Abi, data: checked.call.data }).functionName).toBe("payWithAuthorization");
    expect(checked.token.symbol).toBe("USDC");
    expect((await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: await payRequest({ amount: 0n }), client, now: T0 })).key).toMatch(/^0x/);
  });

  it("refuses a path/body chain mismatch, a revoked deployment and a non-3009 token", async () => {
    const request = await payRequest();
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: 10143, request, client, now: T0 }), "E_INVALID_ARGUMENT", "ChainMismatch");
    await expectRule(() => checkRelayPayRequest({ registry: testRegistry({ status: "revoked" }), pathChainId: CHAIN_ID, request, client, now: T0 }), "E_DEPLOYMENT_INACTIVE");
    expect((await checkRelayPayRequest({ registry: testRegistry({ status: "deprecated" }), pathChainId: CHAIN_ID, request, client, now: T0 })).call.to).toBe(CONTRACT);
    const permitOnly = { ...request, invoice: { ...request.invoice, token: PERMIT_TOKEN } };
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: permitOnly, client, now: T0 }), "E_TOKEN_NOT_EIP3009");
    const native = { ...request, invoice: { ...request.invoice, token: zeroAddress } };
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: native, client, now: T0 }), "E_TOKEN_NOT_EIP3009");
  });

  it("refuses amounts, self-payment and windows the contract or the token would refuse", async () => {
    const request = await payRequest();
    const authorization = request.authorization;
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: { ...request, authorization: { ...authorization, amount: 1n } }, client, now: T0 }), "E_INVALID_ARGUMENT", "WrongAmount");
    const open = await payRequest({ amount: 0n });
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: { ...open, authorization: { ...open.authorization, amount: 0n } }, client, now: T0 }), "E_INVALID_ARGUMENT", "WrongAmount");
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: { ...request, authorization: { ...authorization, payer: payee.address } }, client, now: T0 }), "E_INVALID_ARGUMENT", "SelfPayment");
    for (const now of [0n, T0 + 600n, T0 + 601n]) {
      await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request, client, now }), "E_INVALID_ARGUMENT", "AuthorizationWindow");
    }
  });

  it("refuses a forged payee signature and a redirected authorization (I8)", async () => {
    const request = await payRequest();
    const forgedSignature: Hex = `0x${"11".repeat(65)}`;
    const forged = { ...request, signature: forgedSignature };
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: forged, client, now: T0 }), "E_SIGNATURE_INVALID");
    const otherRef: Hex = `0x${"ee".repeat(32)}`;
    const redirected = { ...request, authorization: { ...request.authorization, payerRef: otherRef } };
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: redirected, client, now: T0 }), "E_SIGNATURE_INVALID");
    const otherInvoice = await payRequest({ amount: 25_000_000n });
    const swapped = { ...otherInvoice, authorization: request.authorization };
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: swapped, client, now: T0 }), "E_SIGNATURE_INVALID");
    const zeroR: Hex = `0x${"00".repeat(32)}`;
    const malformed = { ...request, authorization: { ...request.authorization, r: zeroR } };
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: malformed, client, now: T0 }), "E_SIGNATURE_INVALID");
  });
});

describe("checkRelayPayRequest and checkRelayCancelRequest: minimum remaining validity (audit finding A-04)", () => {
  /** A request for an open receive card or a fixed invoice, with the payer's own authorization window. */
  async function timedRequest(options: { expiry: Expiry; ttlSeconds?: bigint; validAfter?: bigint }): Promise<RelayPayRequest> {
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token: TOKEN, amount: 0n, maxPayments: 0, validAfter: options.validAfter ?? T0 - 60n, expiry: options.expiry },
      signer: payee,
    });
    const link = decodeInvoiceFragment(issued.fragment, registry);
    const { request } = await authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 1n, ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }) });
    return parseRelayPayRequest(request);
  }
  const card: Expiry = { kind: "never", confirmed: true };
  const check = (request: RelayPayRequest, now = T0) => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request, client, now });

  it("refuses a payer-chosen validBefore inside the 120 s margin, before any gas is spent, exactly at the boundary", async () => {
    // The A-04 attack: a sybil payer signs validBefore = now + 1; it would pass eth_call and revert one block later.
    await expectRule(async () => await check(await timedRequest({ expiry: card, ttlSeconds: 1n })), "E_INVALID_ARGUMENT", "RelayValidityTooShort");
    // validBefore - 1 must reach now + 120: 120 s of TTL is one second short, 121 s is enough.
    await expectRule(async () => await check(await timedRequest({ expiry: card, ttlSeconds: 120n })), "E_INVALID_ARGUMENT", "RelayValidityTooShort");
    const checked = await check(await timedRequest({ expiry: card, ttlSeconds: 121n }));
    expect([checked.validThrough, checked.minRemainingSeconds]).toEqual([T0 + 120n, 120n]);
    // The SDK's default 600 s window stays relayable for its first 480 s.
    const standard = await timedRequest({ expiry: card });
    expect((await check(standard, T0 + 479n)).validThrough).toBe(T0 + 599n);
    await expectRule(async () => await check(standard, T0 + 480n), "E_INVALID_ARGUMENT", "RelayValidityTooShort");
  });

  it("refuses an invoice in its last minutes, and one outside its own window", async () => {
    // The requester picks the invoice's last seconds: validUntil inside the margin.
    await expectRule(async () => await check(await timedRequest({ expiry: { kind: "at", validUntil: T0 + 119n } })), "E_INVALID_ARGUMENT", "RelayValidityTooShort");
    expect((await check(await timedRequest({ expiry: { kind: "at", validUntil: T0 + 120n } }))).validThrough).toBe(T0 + 120n);
    // An invoice without expiry leaves the authorization's bound.
    expect((await check(await timedRequest({ expiry: card }))).validThrough).toBe(T0 + 599n);
    const expiring = await timedRequest({ expiry: { kind: "at", validUntil: T0 + 200n } });
    await expectRule(async () => await check(expiring, T0 + 201n), "E_INVALID_ARGUMENT", "Expired");
    await expectRule(async () => await check(await timedRequest({ expiry: card, validAfter: T0 + 1n })), "E_INVALID_ARGUMENT", "NotYetValid");
  });

  it("applies the margin of the request's chain from the registry", async () => {
    const fast = createRegistry([
      defineLocalChain({ chainId: CHAIN_ID, rpcUrl: "http://127.0.0.1:8545", tokens: [token3009], deployment: deploymentAt(), relay: { minRemainingSeconds: 30, provisional: false, basis: "test" } }),
    ]);
    const request = await timedRequest({ expiry: card, ttlSeconds: 31n });
    expect((await checkRelayPayRequest({ registry: fast, pathChainId: CHAIN_ID, request, client, now: T0 })).minRemainingSeconds).toBe(30n);
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request, client, now: T0 }), "E_INVALID_ARGUMENT", "RelayValidityTooShort");
    const target = fast.v2Target(CHAIN_ID);
    if (target === undefined) {
      throw new Error("expected a target");
    }
    expect(relayMargin(target)).toBe(30n);
    let caught: unknown;
    try {
      relayMargin({ ...target, chain: { ...target.chain, relay: null } });
    } catch (error) {
      caught = error;
    }
    expect(isPayLinkError(caught) ? caught.params["rule"] : caught).toBe("RelayTiming");
  });

  it("keeps the SDK's default authorization and cancellation windows well above every shipped chain's margin", () => {
    const margins = shippedRegistry.chains.flatMap((chain) => (chain.relay === null ? [] : [BigInt(chain.relay.minRemainingSeconds)]));
    expect(margins.length).toBeGreaterThan(0);
    for (const margin of margins) {
      // At least three quarters of a default window remain for the request to reach the relayer.
      expect(DEFAULT_AUTHORIZATION_TTL_SECONDS).toBeGreaterThanOrEqual(4n * margin);
      expect(DEFAULT_CANCEL_TTL_SECONDS).toBeGreaterThanOrEqual(4n * margin);
    }
  });

  it("exposes the window arithmetic for the pre-broadcast re-check", () => {
    expect(paymentValidThrough({ validUntil: 0n }, { validBefore: T0 + 600n })).toBe(T0 + 599n);
    expect(paymentValidThrough({ validUntil: T0 + 100n }, { validBefore: T0 + 600n })).toBe(T0 + 100n);
    expect(paymentValidThrough({ validUntil: T0 + 599n }, { validBefore: T0 + 600n })).toBe(T0 + 599n);
    expect(paymentValidThrough({ validUntil: T0 + 900n }, { validBefore: T0 + 600n })).toBe(T0 + 599n);
    expect(() => {
      assertRelayWindow({ validThrough: T0 + 120n, minRemainingSeconds: 120n }, T0);
    }).not.toThrow();
    let caught: unknown;
    try {
      assertRelayWindow({ validThrough: T0 + 120n, minRemainingSeconds: 120n }, T0 + 1n);
    } catch (error) {
      caught = error;
    }
    expect(isPayLinkError(caught) ? caught.params : caught).toEqual({ rule: "RelayValidityTooShort", validThrough: (T0 + 120n).toString(), required: (T0 + 121n).toString() });
  });
});

describe("checkRelayPayRequest: the payer's signature with the token's dispatch (audit finding A-03)", () => {
  const DOMAIN_ANSWER = encodeAbiParameters(
    [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
    ["0x0f", "USDC", "2", BigInt(CHAIN_ID), TOKEN, ZERO_HASH, []],
  );
  const IS_VALID = toFunctionSelector("isValidSignature(bytes32,bytes)");
  const delegation: Hex = `0xef0100${"de".repeat(20)}`;
  const word = (value: Hex): Hex => `${value}${"0".repeat(56)}` as Hex;
  const withPayerCode = (code: Hex, answer: Hex | Error) =>
    mockClient({ code: { [payer.address.toLowerCase()]: code }, answers: { [toFunctionSelector("eip712Domain()")]: DOMAIN_ANSWER, [IS_VALID]: answer } });

  it("refuses a delegated payer whose delegate rejects the ECDSA signature, although ecrecover would accept it", async () => {
    const request = await payRequest();
    // Local ECDSA alone (the pre-fix check) accepts the request: the payer signed it.
    expect((await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request, client, now: T0 })).payerCode).toEqual({ kind: "none", codeHash: null });
    // FiatToken asks a payer with code through ERC-1271: the delegate's answer decides.
    const rejecting = withPayerCode(delegation, word("0xffffffff"));
    await expectRule(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request, client: rejecting, now: T0 }), "E_SIGNATURE_INVALID");
    const reverting = withPayerCode(delegation, new Error("not a revert"));
    await expect(checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request, client: reverting, now: T0 })).rejects.toThrow("not a revert");
  });

  it("accepts a payer with code only through ERC-1271, with r ‖ s ‖ v over the token's digest, and reports the code", async () => {
    const request = await payRequest();
    const accepting = withPayerCode(delegation, word(ERC1271_MAGIC_VALUE));
    const checked = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request, client: accepting, now: T0 });
    expect(checked.payerCode).toEqual({ kind: "delegated", codeHash: keccak256(delegation) });
    expect(checked.payeeCode).toEqual({ kind: "none", codeHash: null });
    expect([checked.payer, checked.payee]).toEqual([payer.address, request.invoice.payee]);
    const call = accepting.calls.find((c) => c.data.startsWith(IS_VALID));
    expect(call?.to).toBe(payer.address);
    const [digest, signature] = decodeFunctionData({ abi: parseAbi(["function isValidSignature(bytes32, bytes) view returns (bytes4)"]), data: call?.data ?? "0x" }).args;
    const { authorization } = request;
    expect(digest).toBe(
      receiveWithAuthorizationDigest(
        { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKEN },
        { from: payer.address, to: CONTRACT, value: authorization.amount, validAfter: authorization.validAfter, validBefore: authorization.validBefore, nonce: checked.nonce },
      ),
    );
    expect(signature).toBe(`0x${authorization.r.slice(2)}${authorization.s.slice(2)}${authorization.v.toString(16)}`);
    const contract = withPayerCode("0x6080604052", word(ERC1271_MAGIC_VALUE));
    expect((await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request, client: contract, now: T0 })).payerCode.kind).toBe("contract");
  });

  it("classifies code", () => {
    expect(describeAccountCode(undefined)).toEqual({ kind: "none", codeHash: null });
    expect(describeAccountCode("0x")).toEqual({ kind: "none", codeHash: null });
    expect(describeAccountCode("0xEF0100aa")).toEqual({ kind: "delegated", codeHash: keccak256("0xEF0100aa") });
    expect(describeAccountCode("0x60")).toEqual({ kind: "contract", codeHash: keccak256("0x60") });
  });
});

describe("checkRelayCancelRequest", () => {
  const deployment = { chainId: CHAIN_ID, verifyingContract: CONTRACT };

  it("accepts a payee-signed cancellation and refuses expired, foreign or forged ones", async () => {
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token: TOKEN, amount: 1n, maxPayments: 1, validAfter: T0, expiry: expiresIn(T0) },
      signer: payee,
    });
    const cancel = await signCancel({ signer: payee, deployment, invoice: issued.signed.invoice, deadline: T0 + 3600n });
    const request = parseCancelAuthorizationJson(JSON.parse(JSON.stringify(toCancelAuthorizationJson(cancel))));
    // The last admissible second leaves exactly the chain's relay margin (120 s) before the deadline.
    const checked = await checkRelayCancelRequest({ registry, pathChainId: CHAIN_ID, request, client, now: T0 + 3600n - 120n });
    expect(decodeFunctionData({ abi: payLinkV2Abi, data: checked.call.data }).functionName).toBe("cancelBySig");
    expect(checked.call.value).toBe(0n);
    expect([checked.validThrough, checked.minRemainingSeconds]).toEqual([T0 + 3600n, 120n]);
    await expectRule(() => checkRelayCancelRequest({ registry, pathChainId: CHAIN_ID, request, client, now: T0 + 3600n - 119n }), "E_INVALID_ARGUMENT", "RelayValidityTooShort");
    await expectRule(() => checkRelayCancelRequest({ registry, pathChainId: CHAIN_ID, request, client, now: T0 + 3601n }), "E_INVALID_ARGUMENT", "SignatureExpired");
    await expectRule(() => checkRelayCancelRequest({ registry, pathChainId: 1, request, client, now: T0 }), "E_INVALID_ARGUMENT", "ChainMismatch");
    await expectRule(() => checkRelayCancelRequest({ registry, pathChainId: CHAIN_ID, request: { ...request, deadline: T0 + 7200n }, client, now: T0 }), "E_SIGNATURE_INVALID");
    const byPayer = await signCancel({ signer: payee, deployment, invoice: issued.signed.invoice, deadline: T0 + 3600n }).then((c) => ({ ...c, invoice: { ...c.invoice, payee: payer.address } }));
    await expectRule(() => checkRelayCancelRequest({ registry, pathChainId: CHAIN_ID, request: byPayer, client, now: T0 }), "E_SIGNATURE_INVALID");
  });
});
