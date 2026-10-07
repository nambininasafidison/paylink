// SPDX-License-Identifier: MIT
/** The EIP-2612 path (`payWithPermit`), plus small edge cases of shared helpers. */
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, hashTypedData, toFunctionSelector, zeroAddress } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { bytesToUint, uintToBytes } from "../src/bytes.ts";
import {
  decodeInvoiceFragment,
  expiresIn,
  isPayLinkError,
  issueInvoice,
  payLinkV2Abi,
  PERMIT_TYPEHASH,
  PERMIT_TYPES,
  preparePermitPayment,
  readLinkState,
  readPermitNonce,
  recoverEcdsaSigner,
  resolveTarget,
  signPermit,
  ZERO_HASH,
} from "../src/index.ts";
import type { Eip712Domain, PayLinkErrorCode, TypedDataSigner } from "../src/index.ts";
import { CHAIN_ID, CONTRACT, PERMIT_TOKEN, payee, payer, registry, T0, TOKEN } from "./helpers.ts";
import { mockClient } from "./mock-client.ts";

async function expectCode(run: () => Promise<unknown>, code: PayLinkErrorCode): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(isPayLinkError(error) ? error.code : error).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

const NONCES = toFunctionSelector("nonces(address)");
const EIP712_DOMAIN = toFunctionSelector("eip712Domain()");
const uint = (value: bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [value]);
const permitDomain = encodeAbiParameters(
  [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
  ["0x0f", "Mezo USD", "1", BigInt(CHAIN_ID), PERMIT_TOKEN, ZERO_HASH, []],
);

describe("signPermit", () => {
  const tokenDomain: Eip712Domain = { name: "Mezo USD", version: "1", chainId: CHAIN_ID, verifyingContract: PERMIT_TOKEN };

  it("signs Permit(owner, PayLinkV2, value, nonce, deadline) and verifies it", async () => {
    const permit = await signPermit({ signer: payer, tokenDomain, spender: CONTRACT, value: 5n, nonce: 3n, deadline: T0 });
    const digest = hashTypedData({ domain: tokenDomain, types: PERMIT_TYPES, primaryType: "Permit", message: { owner: payer.address, spender: CONTRACT, value: 5n, nonce: 3n, deadline: T0 } });
    const signature: Hex = `0x${permit.r.slice(2)}${permit.s.slice(2)}${permit.v.toString(16)}`;
    expect(await recoverEcdsaSigner(digest, signature)).toEqual({ signer: payer.address });
    expect(permit.deadline).toBe(T0);
    expect(PERMIT_TYPEHASH).toBe("0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9");
  });

  it("refuses a zero or oversized value, bad nonce or deadline, and a signer that does not sign as the owner", async () => {
    const base = { signer: payer, tokenDomain, spender: CONTRACT, value: 1n, nonce: 0n, deadline: T0 };
    await expectCode(() => signPermit({ ...base, value: 0n }), "E_INVALID_ARGUMENT");
    await expectCode(() => signPermit({ ...base, value: 2n ** 256n }), "E_INVALID_ARGUMENT");
    await expectCode(() => signPermit({ ...base, nonce: -1n }), "E_INVALID_ARGUMENT");
    await expectCode(() => signPermit({ ...base, deadline: 2n ** 256n }), "E_INVALID_ARGUMENT");
    const impostor: TypedDataSigner = { address: payer.address, signTypedData: (t) => payee.signTypedData(t) };
    await expectCode(() => signPermit({ ...base, signer: impostor }), "E_SIGNATURE_INVALID");
  });

  it("reads the owner's nonce", async () => {
    expect(await readPermitNonce(mockClient({ answers: { [NONCES]: uint(7n) } }), PERMIT_TOKEN, payer.address)).toBe(7n);
  });
});

describe("preparePermitPayment", () => {
  const issue = async (token = PERMIT_TOKEN, amount = 2n * 10n ** 18n) => {
    const issued = await issueInvoice({ registry, chainId: CHAIN_ID, draft: { payee: payee.address, token, amount, maxPayments: 1, validAfter: T0, expiry: expiresIn(T0) }, signer: payee });
    return decodeInvoiceFragment(issued.fragment, registry);
  };
  const client = mockClient({ answers: { [NONCES]: uint(0n), [EIP712_DOMAIN]: permitDomain } });

  it("builds a payWithPermit for exactly the invoice amount, reading the nonce and the token's domain", async () => {
    const link = await issue();
    const { permit, call } = await preparePermitPayment({ link, signer: payer, client, deadline: T0 + 3600n, payerRef: `0x${"07".repeat(32)}` });
    expect(call).toMatchObject({ to: CONTRACT, value: 0n });
    const { functionName, args } = decodeFunctionData({ abi: payLinkV2Abi, data: call.data });
    expect(functionName).toBe("payWithPermit");
    expect(args).toEqual([link.invoice, link.signature, 2n * 10n ** 18n, `0x${"07".repeat(32)}`, permit]);
  });

  it("refuses tokens without EIP-2612, a wrong amount and self-payment", async () => {
    await expectCode(async () => await preparePermitPayment({ link: await issue(zeroAddress, 1n), signer: payer, client, deadline: T0 }), "E_TOKEN_NOT_EIP2612");
    const link = await issue();
    await expectCode(() => preparePermitPayment({ link, signer: payer, client, deadline: T0, amount: 1n }), "E_INVALID_ARGUMENT");
    await expectCode(() => preparePermitPayment({ link, signer: payee, client, deadline: T0 }), "E_INVALID_ARGUMENT");
    const usdcLink = await issue(TOKEN, 25n);
    const usdcClient = mockClient({ answers: { [NONCES]: uint(0n), [EIP712_DOMAIN]: encodeAbiParameters(
      [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
      ["0x0f", "USDC", "2", BigInt(CHAIN_ID), TOKEN, ZERO_HASH, []],
    ) } });
    const open = { ...usdcLink, invoice: { ...usdcLink.invoice, amount: 0n } };
    expect((await preparePermitPayment({ link: open, signer: payer, client: usdcClient, deadline: T0, amount: 9n })).permit.deadline).toBe(T0);
  });
});

describe("shared helpers: edges", () => {
  it("refuses integers that do not fit and reads big-endian bytes", () => {
    expect(() => uintToBytes(256n, 1)).toThrow(RangeError);
    expect(() => uintToBytes(-1n, 1)).toThrow(RangeError);
    expect(bytesToUint(uintToBytes(65_535n, 2))).toBe(65_535n);
  });

  it("refuses chain IDs outside uint53 before looking them up", () => {
    for (const id of [0, 1.5, 2 ** 53]) {
      try {
        resolveTarget(id, registry);
        expect.unreachable();
      } catch (error) {
        expect(isPayLinkError(error, "E_CHAIN_ID_FORMAT")).toBe(true);
      }
    }
  });

  it("surfaces a node that returns no data as a decoding error", async () => {
    await expect(readLinkState(mockClient({}), CONTRACT, ZERO_HASH)).rejects.toThrow();
    const encoded = encodeFunctionResult({ abi: payLinkV2Abi, functionName: "stateOf", result: { payments: 0, cancelled: false, lastPaidAt: 0n, total: 0n } });
    expect(encoded).toMatch(/^0x0+$/);
  });
});
