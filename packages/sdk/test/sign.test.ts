// SPDX-License-Identifier: MIT
/** Signing and the issuer/payer flows (invoice spec §6, §8.3, §9.2, §13.1, §13.2). */
import { concat, encodeAbiParameters, encodeFunctionResult, HttpRequestError, numberToHex, RawContractError, toFunctionSelector, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  authorizePayment,
  decodeInvoiceFragment,
  ERC1271_MAGIC_VALUE,
  expiresIn,
  invoiceKey,
  isPayLinkError,
  issueInvoice,
  paymentNonce,
  readTokenDomain,
  receiveWithAuthorizationDigest,
  recoverEcdsaSigner,
  resolveTokenDomain,
  signCancel,
  signInvoice,
  signReceiveAuthorization,
  verifySignature,
  ZERO_HASH,
} from "../src/index.ts";
import type { Eip712Domain, PayLinkErrorCode, TypedDataSigner } from "../src/index.ts";
import { CHAIN_ID, CONTRACT, PERMIT_TOKEN, payee, payer, registry, sampleInvoice, T0, testRegistry, TOKEN, token3009, tokenPermit } from "./helpers.ts";
import { mockClient } from "./mock-client.ts";

const deployment = { chainId: CHAIN_ID, verifyingContract: CONTRACT };
const IS_VALID = toFunctionSelector("isValidSignature(bytes32,bytes)");
const MAGIC = concat([ERC1271_MAGIC_VALUE, `0x${"00".repeat(28)}`]);
const SMART = "0x8464135c8F25Da09e49BC8782676a84730C318bC";

async function expectCode(run: () => Promise<unknown>, code: PayLinkErrorCode): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(isPayLinkError(error) ? error.code : error).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

/** A signer that returns `v` in {0, 1}, as some hardware wallets and libraries do. */
const zeroOneSigner: TypedDataSigner = {
  address: payee.address,
  signTypedData: async (typed) => {
    const sig = await payee.signTypedData(typed);
    return concat([`0x${sig.slice(2, 130)}`, numberToHex(Number.parseInt(sig.slice(130), 16) - 27, { size: 1 })]);
  },
};

/** A smart-account signer: opaque ERC-1271 bytes. */
const smartSigner = (bytes: number): TypedDataSigner => ({
  address: SMART,
  signTypedData: (): Promise<Hex> => {
    const opaque: Hex = `0x${"ab".repeat(bytes)}`;
    return Promise.resolve(opaque);
  },
});
const smartClient = (answer: Hex | Error = MAGIC) => mockClient({ code: { [SMART.toLowerCase()]: "0x6080" }, answers: { [IS_VALID]: answer } });

describe("signInvoice", () => {
  const { invoice } = sampleInvoice();

  it("signs, normalises v and verifies before returning", async () => {
    const direct = await signInvoice({ signer: payee, deployment, invoice });
    const normalised = await signInvoice({ signer: zeroOneSigner, deployment, invoice });
    expect(normalised.signature).toBe(direct.signature);
    expect(direct.verification).toMatchObject({ valid: true, method: "ecdsa", codeChecked: false });
  });

  it("refuses a signer that is not the payee, and a signature that does not verify", async () => {
    await expectCode(() => signInvoice({ signer: payer, deployment, invoice }), "E_SIGNER_NOT_PAYEE");
    const liar: TypedDataSigner = { address: payee.address, signTypedData: () => payer.signTypedData({ ...sampleTypedData() }) };
    await expectCode(() => signInvoice({ signer: liar, deployment, invoice }), "E_SIGNATURE_INVALID");
  });

  it("verifies ERC-1271 payees through the client", async () => {
    const smartInvoice = { ...invoice, payee: SMART as Address };
    const result = await signInvoice({ signer: smartSigner(100), deployment, invoice: smartInvoice, client: smartClient() });
    expect(result.verification).toMatchObject({ valid: true, method: "erc1271" });
    // A counterfactual smart account (no code yet) cannot be a payee: its signature fails the ECDSA rule.
    await expectCode(() => signInvoice({ signer: smartSigner(100), deployment, invoice: smartInvoice, client: mockClient({}) }), "E_SIGNATURE_INVALID");
  });
});

function sampleTypedData() {
  return {
    domain: { name: "X", version: "1", chainId: 1, verifyingContract: CONTRACT },
    types: { Mail: [{ name: "x", type: "uint256" }] },
    primaryType: "Mail" as const,
    message: { x: 1n },
  };
}

describe("signCancel", () => {
  const { invoice } = sampleInvoice();

  it("signs Cancel(key, deadline) and verifies it", async () => {
    const cancel = await signCancel({ signer: payee, deployment, invoice, deadline: T0 + 3600n });
    expect(cancel).toMatchObject({ chainId: CHAIN_ID, deadline: T0 + 3600n });
    const viaZeroOne = await signCancel({ signer: zeroOneSigner, deployment, invoice, deadline: T0 + 3600n });
    expect(viaZeroOne.signature).toBe(cancel.signature);
  });

  it("refuses a bad deadline and a signer that is not the payee", async () => {
    await expectCode(() => signCancel({ signer: payee, deployment, invoice, deadline: -1n }), "E_INVALID_ARGUMENT");
    await expectCode(() => signCancel({ signer: payee, deployment, invoice, deadline: 2n ** 256n }), "E_INVALID_ARGUMENT");
    await expectCode(() => signCancel({ signer: payer, deployment, invoice, deadline: 1n }), "E_SIGNER_NOT_PAYEE");
  });
});

describe("signReceiveAuthorization", () => {
  const tokenDomain: Eip712Domain = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKEN };
  const key = invoiceKey(deployment, sampleInvoice().invoice);

  it("binds the nonce to the payment, defaults payerRef and draws a fresh payer salt", async () => {
    const a = await signReceiveAuthorization({ signer: payer, tokenDomain, verifyingContract: CONTRACT, key, amount: 25_000_000n, validBefore: T0 + 600n });
    const b = await signReceiveAuthorization({ signer: payer, tokenDomain, verifyingContract: CONTRACT, key, amount: 25_000_000n, validBefore: T0 + 600n });
    expect(a.authorization.payerRef).toBe(ZERO_HASH);
    expect(a.authorization.payerSalt).not.toBe(b.authorization.payerSalt);
    expect(a.nonce).toBe(paymentNonce({ key, payer: payer.address, amount: 25_000_000n, payerRef: ZERO_HASH, payerSalt: a.authorization.payerSalt }));
    expect(a.authorization.validAfter).toBe(0n);
    const message = { from: payer.address, to: CONTRACT, value: 25_000_000n, validAfter: 0n, validBefore: T0 + 600n, nonce: a.nonce };
    expect(a.digest).toBe(receiveWithAuthorizationDigest(tokenDomain, message));
    const signature = concat([a.authorization.r, a.authorization.s, numberToHex(a.authorization.v, { size: 1 })]);
    expect(await recoverEcdsaSigner(a.digest, signature)).toEqual({ signer: payer.address });
  });

  it("refuses a zero amount, an empty window and a non-ECDSA signer", async () => {
    const base = { signer: payer, tokenDomain, verifyingContract: CONTRACT, key, amount: 1n, validBefore: 10n };
    await expectCode(() => signReceiveAuthorization({ ...base, amount: 0n }), "E_INVALID_ARGUMENT");
    await expectCode(() => signReceiveAuthorization({ ...base, validAfter: 10n }), "E_INVALID_ARGUMENT");
    await expectCode(() => signReceiveAuthorization({ ...base, validAfter: -1n }), "E_INVALID_ARGUMENT");
    await expectCode(() => signReceiveAuthorization({ ...base, validBefore: 2n ** 256n }), "E_INVALID_ARGUMENT");
    await expectCode(() => signReceiveAuthorization({ ...base, signer: smartSigner(65) }), "E_SIGNATURE_INVALID");
    const impostor: TypedDataSigner = { address: payer.address, signTypedData: (t) => payee.signTypedData(t) };
    await expectCode(() => signReceiveAuthorization({ ...base, signer: impostor }), "E_SIGNATURE_INVALID");
  });
});

describe("issueInvoice", () => {
  const draft = { payee: payee.address, token: TOKEN, amount: 25_000_000n, maxPayments: 1, validAfter: T0, expiry: expiresIn(T0), memo: "Logo" };

  it("issues a link that decodes to the same invoice, with warnings and the payee kind", async () => {
    const issued = await issueInvoice({ registry, chainId: CHAIN_ID, draft, signer: payee });
    expect(issued.fragment.length).toBeLessThanOrEqual(1200);
    expect(issued.payeeAccount).toBe("unchecked");
    expect(issued.warnings).toEqual([]);
    const decoded = decodeInvoiceFragment(issued.fragment, registry);
    expect(decoded.invoice).toEqual(issued.signed.invoice);
    expect(decoded.key).toBe(issued.key);
    const checked = await issueInvoice({ registry, chainId: CHAIN_ID, draft: { ...draft, amount: 0n }, signer: payee, client: mockClient({}) });
    expect(checked.payeeAccount).toBe("eoa");
    expect(checked.warnings).toEqual(["open-amount-single-use"]);
  });

  it("reports contract and EIP-7702 payees", async () => {
    const smartDraft = { ...draft, payee: SMART };
    expect((await issueInvoice({ registry, chainId: CHAIN_ID, draft: smartDraft, signer: smartSigner(80), client: smartClient() })).payeeAccount).toBe("contract");
    const delegatedClient = mockClient({ code: { [payee.address.toLowerCase()]: `0xef0100${"cd".repeat(20)}` }, answers: { [IS_VALID]: MAGIC } });
    expect((await issueInvoice({ registry, chainId: CHAIN_ID, draft, signer: payee, client: delegatedClient })).payeeAccount).toBe("delegated");
  });

  it.each<[string, Parameters<typeof issueInvoice>[0], PayLinkErrorCode]>([
    ["an unknown chain", { registry, chainId: 10143, draft, signer: payee }, "E_CHAIN_UNKNOWN"],
    ["a chain without deployment", { registry: testRegistry({ deployment: null }), chainId: CHAIN_ID, draft, signer: payee }, "E_CHAIN_UNKNOWN"],
    ["a deprecated deployment", { registry: testRegistry({ status: "deprecated" }), chainId: CHAIN_ID, draft, signer: payee }, "E_DEPLOYMENT_INACTIVE"],
    ["a revoked deployment", { registry: testRegistry({ status: "revoked" }), chainId: CHAIN_ID, draft, signer: payee }, "E_DEPLOYMENT_INACTIVE"],
    ["a token off the allowlist", { registry, chainId: CHAIN_ID, draft: { ...draft, token: CONTRACT }, signer: payee }, "E_TOKEN_UNKNOWN"],
    ["the deployment as payee", { registry, chainId: CHAIN_ID, draft: { ...draft, payee: CONTRACT }, signer: payee }, "E_INVOICE_SHAPE"],
    ["another signer", { registry, chainId: CHAIN_ID, draft, signer: payer }, "E_SIGNER_NOT_PAYEE"],
  ])("refuses %s", async (_name, parameters, code) => {
    await expectCode(() => issueInvoice(parameters), code);
  });

  it("refuses a link above 1,200 characters (long ERC-1271 signature and memo)", async () => {
    const parameters = { registry, chainId: CHAIN_ID, draft: { ...draft, payee: SMART, memo: "m".repeat(280) }, signer: smartSigner(512), client: smartClient() };
    await expectCode(() => issueInvoice(parameters), "E_FRAGMENT_TOO_LONG");
  });
});

describe("authorizePayment", () => {
  const issue = async (overrides: Partial<{ token: Address; amount: bigint }> = {}) => {
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token: TOKEN, amount: 25_000_000n, maxPayments: 1, validAfter: T0, expiry: expiresIn(T0), ...overrides },
      signer: payee,
    });
    return decodeInvoiceFragment(issued.fragment, registry);
  };

  it("signs a bound EIP-3009 authorization and the relayer body (without memo)", async () => {
    const link = await issue();
    const result = await authorizePayment({ outstanding: null, link, signer: payer, now: T0 + 10n, payerRef: `0x${"01".repeat(32)}` });
    expect(result.authorization).toMatchObject({ payer: payer.address, amount: 25_000_000n, validAfter: 0n, validBefore: T0 + 610n, payerRef: `0x${"01".repeat(32)}` });
    expect(result.request.chainId).toBe(CHAIN_ID);
    expect(result.request.payeeSig).toBe(link.signature);
    expect("memo" in result.request).toBe(false);
    expect(result.request.authorization.amount).toBe("25000000");
    expect(result.nonce).toBe(
      paymentNonce({ key: link.key, payer: payer.address, amount: 25_000_000n, payerRef: `0x${"01".repeat(32)}`, payerSalt: result.authorization.payerSalt }),
    );
    const custom = await authorizePayment({ outstanding: null, link, signer: payer, now: T0, ttlSeconds: 60n, random: (n) => new Uint8Array(n).fill(3) });
    expect(custom.authorization.validBefore).toBe(T0 + 60n);
    expect(custom.authorization.payerSalt).toBe(`0x${"03".repeat(32)}`);
  });

  it("takes the payer's amount for open invoices", async () => {
    const link = await issue({ amount: 0n });
    expect((await authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 7n })).authorization.amount).toBe(7n);
    await expectCode(() => authorizePayment({ outstanding: null, link, signer: payer, now: T0 }), "E_INVALID_ARGUMENT");
  });

  it("refuses non-3009 tokens, a wrong amount, self-payment and an empty window", async () => {
    await expectCode(async () => await authorizePayment({ outstanding: null, link: await issue({ token: PERMIT_TOKEN }), signer: payer, now: T0 }), "E_TOKEN_NOT_EIP3009");
    await expectCode(async () => await authorizePayment({ outstanding: null, link: await issue({ token: zeroAddress }), signer: payer, now: T0 }), "E_TOKEN_NOT_EIP3009");
    const link = await issue();
    await expectCode(() => authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 1n }), "E_INVALID_ARGUMENT");
    await expectCode(() => authorizePayment({ outstanding: null, link, signer: payee, now: T0 }), "E_INVALID_ARGUMENT");
    await expectCode(() => authorizePayment({ outstanding: null, link, signer: payer, now: T0, ttlSeconds: 0n }), "E_INVALID_ARGUMENT");
  });

  it("reads the token domain from the chain when the registry does not state it", async () => {
    const link = await issue();
    const unstated = { ...link, token: { ...token3009, eip712Domain: null } };
    await expectCode(() => authorizePayment({ outstanding: null, link: unstated, signer: payer, now: T0 }), "E_TOKEN_DOMAIN_UNKNOWN");
    const client = mockClient({ answers: { [toFunctionSelector("eip712Domain()")]: domainResult({ name: "Mock USD", version: "7" }) } });
    const result = await authorizePayment({ outstanding: null, link: unstated, signer: payer, now: T0, client });
    const expected = receiveWithAuthorizationDigest(
      { name: "Mock USD", version: "7", chainId: CHAIN_ID, verifyingContract: TOKEN },
      { from: payer.address, to: CONTRACT, value: 25_000_000n, validAfter: 0n, validBefore: T0 + 600n, nonce: result.nonce },
    );
    expect(result.digest).toBe(expected);
  });
});

/** ABI-encoded `eip712Domain()` return data. */
function domainResult(overrides: Partial<{ fields: Hex; name: string; version: string; chainId: bigint; verifyingContract: Address; extensions: bigint[] }> = {}): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes1" },
      { type: "string" },
      { type: "string" },
      { type: "uint256" },
      { type: "address" },
      { type: "bytes32" },
      { type: "uint256[]" },
    ],
    [
      overrides.fields ?? "0x0f",
      overrides.name ?? "USDC",
      overrides.version ?? "2",
      overrides.chainId ?? BigInt(CHAIN_ID),
      overrides.verifyingContract ?? TOKEN,
      ZERO_HASH,
      overrides.extensions ?? [],
    ],
  );
}

describe("token domain (spec §8.3)", () => {
  const EIP712_DOMAIN = toFunctionSelector("eip712Domain()");
  const NAME = toFunctionSelector("name()");
  const VERSION = toFunctionSelector("version()");
  const stringResult = (value: string): Hex =>
    encodeFunctionResult({ abi: [{ type: "function", name: "f", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }], functionName: "f", result: value });

  it("reads ERC-5267 when implemented", async () => {
    const client = mockClient({ answers: { [EIP712_DOMAIN]: domainResult() } });
    expect(await readTokenDomain(client, CHAIN_ID, TOKEN)).toEqual({ name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKEN });
  });

  it("falls back to name() and version() when eip712Domain() returns nothing or garbage", async () => {
    for (const answer of ["0x", "0x1234"] as const) {
      const client = mockClient({ answers: { [EIP712_DOMAIN]: answer, [NAME]: stringResult("USDC"), [VERSION]: stringResult("2") } });
      expect((await readTokenDomain(client, CHAIN_ID, TOKEN)).name).toBe("USDC");
    }
    const silent = mockClient({ answers: { [NAME]: stringResult("USDC"), [VERSION]: stringResult("2") } });
    expect((await readTokenDomain(silent, CHAIN_ID, TOKEN)).version).toBe("2");
  });

  it("falls back to name() and version() when eip712Domain() reverts (FiatToken v2)", async () => {
    const client = mockClient({ answers: { [EIP712_DOMAIN]: new RawContractError({ data: "0x" }), [NAME]: stringResult("USDC"), [VERSION]: stringResult("2") } });
    expect(await readTokenDomain(client, CHAIN_ID, TOKEN)).toEqual({ name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKEN });
  });

  it("refuses domains PayLink cannot sign for, and rethrows transport failures", async () => {
    for (const result of [domainResult({ fields: "0x1f" }), domainResult({ chainId: 1n }), domainResult({ verifyingContract: CONTRACT }), domainResult({ extensions: [1n] })]) {
      await expectCode(() => readTokenDomain(mockClient({ answers: { [EIP712_DOMAIN]: result } }), CHAIN_ID, TOKEN), "E_TOKEN_DOMAIN_MISMATCH");
    }
    const down = mockClient({ answers: { "*": new HttpRequestError({ url: "https://rpc.example" }) } });
    await expect(readTokenDomain(down, CHAIN_ID, TOKEN)).rejects.toBeInstanceOf(HttpRequestError);
  });

  it("checks the chain against the registry", async () => {
    expect(await resolveTokenDomain({ chainId: CHAIN_ID, token: token3009 })).toEqual({ name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKEN });
    await expectCode(() => resolveTokenDomain({ chainId: CHAIN_ID, token: tokenPermit }), "E_TOKEN_DOMAIN_UNKNOWN");
    const other = mockClient({ answers: { [EIP712_DOMAIN]: domainResult({ name: "USD Coin" }) } });
    await expectCode(() => resolveTokenDomain({ chainId: CHAIN_ID, token: token3009, client: other }), "E_TOKEN_DOMAIN_MISMATCH");
    const otherVersion = mockClient({ answers: { [EIP712_DOMAIN]: domainResult({ version: "1" }) } });
    await expectCode(() => resolveTokenDomain({ chainId: CHAIN_ID, token: token3009, client: otherVersion }), "E_TOKEN_DOMAIN_MISMATCH");
    const same = mockClient({ answers: { [EIP712_DOMAIN]: domainResult() } });
    expect((await resolveTokenDomain({ chainId: CHAIN_ID, token: token3009, client: same })).name).toBe("USDC");
    const permitDomain = mockClient({ answers: { [EIP712_DOMAIN]: domainResult({ name: "Mezo USD", version: "1", verifyingContract: PERMIT_TOKEN }) } });
    expect((await resolveTokenDomain({ chainId: CHAIN_ID, token: tokenPermit, client: permitDomain })).name).toBe("Mezo USD");
  });

  it("verifies a payee signature end to end with the issued key", async () => {
    const { invoice } = sampleInvoice();
    const { signature } = await signInvoice({ signer: payee, deployment, invoice });
    expect((await verifySignature({ signer: payee.address, digest: invoiceKey(deployment, invoice), signature, client: mockClient({}) })).valid).toBe(true);
  });
});
