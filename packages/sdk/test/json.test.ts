// SPDX-License-Identifier: MIT
/** Canonical JSON forms (invoice spec §11, docs/spec/paylink-invoice-v2.schema.json). */
import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  EMPTY_STRING_HASH,
  isPayLinkError,
  parseCancelAuthorizationJson,
  parseInvoiceJson,
  parseReceiptReferenceJson,
  parseRelayPayRequest,
  parseSignedInvoiceJson,
  signCancel,
  toCancelAuthorizationJson,
  toInvoiceJson,
  toReceiptReferenceJson,
  toRelayPayRequest,
  toSignedInvoiceJson,
} from "../src/index.ts";
import type { Authorization, PayLinkErrorCode } from "../src/index.ts";
import { CHAIN_ID, CONTRACT, payee, payer, registry, signedSample, T0 } from "./helpers.ts";

const code = (run: () => unknown): [PayLinkErrorCode | undefined, string | undefined] => {
  try {
    run();
  } catch (error) {
    return isPayLinkError(error) ? [error.code, error.params["path"]] : [undefined, undefined];
  }
  return [undefined, undefined];
};

const signed = await signedSample();
const authorization: Authorization = {
  payer: payer.address,
  amount: 25_000_000n,
  payerRef: `0x${"00".repeat(32)}`,
  validAfter: 0n,
  validBefore: T0 + 600n,
  payerSalt: `0x${"77".repeat(32)}`,
  v: 27,
  r: `0x${"12".repeat(32)}`,
  s: `0x${"34".repeat(32)}`,
};

describe("serialisers", () => {
  it("write the schema's form: decimal strings, uint53 integers, EIP-55 addresses, lowercase hex", () => {
    const json = toInvoiceJson({ ...signed.invoice, payee: signed.invoice.payee.toLowerCase() as `0x${string}` });
    expect(json).toEqual({
      payee: payee.address,
      token: signed.invoice.token,
      amount: "25000000",
      validAfter: Number(T0),
      validUntil: Number(T0 + 604_800n),
      maxPayments: 1,
      salt: signed.invoice.salt,
      memoHash: signed.invoice.memoHash,
    });
    expect(code(() => toInvoiceJson({ ...signed.invoice, validUntil: 2n ** 53n }))[0]).toBe("E_UINT53_RANGE");
    expect(code(() => toInvoiceJson({ ...signed.invoice, validAfter: -1n }))[0]).toBe("E_UINT53_RANGE");
  });

  it("write a signed invoice with its memo and optional key", () => {
    const json = toSignedInvoiceJson(signed);
    expect(json).toMatchObject({ version: 2, chainId: CHAIN_ID, payeeSig: signed.signature, memo: signed.memo });
    expect("key" in json).toBe(false);
    expect(toSignedInvoiceJson({ ...signed, memo: null }, `0x${"aa".repeat(32)}`)).not.toHaveProperty("memo");
  });

  it("write relayer bodies without the memo, and refuse a bad v", () => {
    const body = toRelayPayRequest(signed, authorization);
    expect(Object.keys(body)).toEqual(["chainId", "invoice", "payeeSig", "authorization"]);
    expect(body.authorization).toMatchObject({ amount: "25000000", validBefore: String(T0 + 600n), v: 27 });
    expect(code(() => toRelayPayRequest(signed, { ...authorization, v: 0 }))).toEqual(["E_INVALID_ARGUMENT", "authorization.v"]);
    expect(toReceiptReferenceJson({ chainId: 1, txHash: `0x${"ab".repeat(32)}`, logIndex: 3 })).toEqual({ chainId: 1, txHash: `0x${"ab".repeat(32)}`, logIndex: 3 });
  });
});

describe("parsers", () => {
  it("round-trip every form", async () => {
    const parsedSigned = parseSignedInvoiceJson(JSON.parse(JSON.stringify(toSignedInvoiceJson(signed))), registry);
    expect(parsedSigned.invoice).toEqual(signed.invoice);
    expect(parsedSigned.memo).toBe(signed.memo);
    const relay = parseRelayPayRequest(JSON.parse(JSON.stringify(toRelayPayRequest(signed, authorization))));
    expect(relay).toEqual({ chainId: CHAIN_ID, invoice: signed.invoice, signature: signed.signature, authorization });
    const cancel = await signCancel({ signer: payee, deployment: { chainId: CHAIN_ID, verifyingContract: CONTRACT }, invoice: signed.invoice, deadline: T0 });
    expect(parseCancelAuthorizationJson(JSON.parse(JSON.stringify(toCancelAuthorizationJson(cancel))))).toEqual(cancel);
    expect(parseReceiptReferenceJson({ chainId: 1, txHash: `0x${"ab".repeat(32)}`, logIndex: 0 })).toEqual({ chainId: 1, txHash: `0x${"ab".repeat(32)}`, logIndex: 0 });
  });

  it("accept all-lowercase addresses and checksum them", () => {
    const json = { ...toInvoiceJson(signed.invoice), payee: payee.address.toLowerCase() };
    expect(parseInvoiceJson(json).payee).toBe(payee.address);
  });

  const invoiceJson = toInvoiceJson(signed.invoice);
  it.each<[string, unknown, string]>([
    ["a non-object", [], "invoice"],
    ["null", null, "invoice"],
    ["an unknown property", { ...invoiceJson, extra: 1 }, "invoice.extra"],
    ["a missing property", { ...invoiceJson, salt: undefined }, "invoice.salt"],
    ["a mis-checksummed payee", { ...invoiceJson, payee: "0x70997970c51812dc3A010C7d01b50e0d17dc79C8" }, "invoice.payee"],
    ["the zero payee", { ...invoiceJson, payee: zeroAddress }, "invoice.payee"],
    ["a short token", { ...invoiceJson, token: "0x1234" }, "invoice.token"],
    ["an amount with a leading zero", { ...invoiceJson, amount: "025" }, "invoice.amount"],
    ["a numeric amount", { ...invoiceJson, amount: 25 }, "invoice.amount"],
    ["an amount above uint128", { ...invoiceJson, amount: (2n ** 128n).toString() }, "invoice.amount"],
    ["a string time", { ...invoiceJson, validAfter: "1" }, "invoice.validAfter"],
    ["a time above 2^53 - 1", { ...invoiceJson, validUntil: 2 ** 53 }, "invoice.validUntil"],
    ["fractional seats", { ...invoiceJson, maxPayments: 1.5 }, "invoice.maxPayments"],
    ["seats above uint32", { ...invoiceJson, maxPayments: 2 ** 32 }, "invoice.maxPayments"],
    ["an uppercase salt", { ...invoiceJson, salt: invoiceJson.salt.toUpperCase().replace("0X", "0x") }, "invoice.salt"],
    ['keccak256("") as memoHash', { ...invoiceJson, memoHash: EMPTY_STRING_HASH }, "invoice.memoHash"],
  ])("refuse an invoice with %s", (_name, value, path) => {
    const cleaned = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) : value;
    expect(code(() => parseInvoiceJson(cleaned))).toEqual(["E_INVALID_ARGUMENT", path]);
  });

  const signedJson = toSignedInvoiceJson(signed);
  it.each<[string, unknown, PayLinkErrorCode]>([
    ["version 1", { ...signedJson, version: 1 }, "E_VERSION_UNSUPPORTED"],
    ["chain 0", { ...signedJson, chainId: 0 }, "E_INVALID_ARGUMENT"],
    ["an unknown chain", { ...signedJson, chainId: 10143 }, "E_CHAIN_UNKNOWN"],
    ["an empty memo", { ...signedJson, memo: "" }, "E_INVALID_ARGUMENT"],
    ["a numeric memo", { ...signedJson, memo: 12 }, "E_INVALID_ARGUMENT"],
    ["a lone surrogate in the memo", { ...signedJson, memo: "Logo \uD800" }, "E_MEMO_UTF8"],
    ["a memo that does not match", { ...signedJson, memo: "Logo design, invoice #13" }, "E_MEMO_HASH"],
    ["no memo despite memoHash", { ...signedJson, memo: undefined }, "E_MEMO_PRESENCE"],
    ["an uppercase signature", { ...signedJson, payeeSig: signed.signature.toUpperCase().replace("0X", "0x") }, "E_INVALID_ARGUMENT"],
    ["a wrong key", { ...signedJson, key: `0x${"00".repeat(32)}` }, "E_INVALID_ARGUMENT"],
    ["a malformed key", { ...signedJson, key: "0x00" }, "E_INVALID_ARGUMENT"],
  ])("refuse a signed invoice with %s", (_name, value, expected) => {
    const cleaned = Object.fromEntries(Object.entries(value as object).filter(([, v]) => v !== undefined));
    expect(code(() => parseSignedInvoiceJson(cleaned, registry))[0]).toBe(expected);
  });

  it("accept the right key", () => {
    const withKey = toSignedInvoiceJson(signed, parseSignedInvoiceJson(signedJson, registry).key);
    expect(parseSignedInvoiceJson(withKey, registry).key).toBe(withKey.key);
  });

  const relayJson = toRelayPayRequest(signed, authorization);
  it.each<[string, unknown, string]>([
    ["v = 0", { ...relayJson, authorization: { ...relayJson.authorization, v: 0 } }, "$.authorization.v"],
    ["a uint256 above range", { ...relayJson, authorization: { ...relayJson.authorization, validBefore: (2n ** 256n).toString() } }, "$.authorization.validBefore"],
    ["an extra memo", { ...relayJson, memo: "x" }, "$.memo"],
    ["a missing authorization", { chainId: CHAIN_ID, invoice: relayJson.invoice, payeeSig: relayJson.payeeSig }, "$.authorization"],
  ])("refuse a relayer body with %s", (_name, value, path) => {
    expect(code(() => parseRelayPayRequest(value))).toEqual(["E_INVALID_ARGUMENT", path]);
  });

  it("refuse bad receipt references and cancellation deadlines", () => {
    expect(code(() => parseReceiptReferenceJson({ chainId: 1, txHash: "0xAB", logIndex: 0 }))).toEqual(["E_INVALID_ARGUMENT", "$.txHash"]);
    expect(code(() => parseReceiptReferenceJson({ chainId: 1, txHash: `0x${"ab".repeat(32)}`, logIndex: -1 }))).toEqual(["E_INVALID_ARGUMENT", "$.logIndex"]);
    const cancelJson = { chainId: CHAIN_ID, invoice: invoiceJson, deadline: "-1", payeeSig: signed.signature };
    expect(code(() => parseCancelAuthorizationJson(cancelJson))).toEqual(["E_INVALID_ARGUMENT", "$.deadline"]);
  });
});
