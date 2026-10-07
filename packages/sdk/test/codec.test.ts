// SPDX-License-Identifier: MIT
/**
 * URL codec (invoice spec §10): every rejection code of §10.5, in order, plus receipts (§10.6) and encoding.
 */
import { bytesToHex, hexToBytes, keccak256, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  decodeInvoiceFragment,
  decodeReceiptFragment,
  encodeInvoiceFragment,
  encodeReceiptFragment,
  fragmentOf,
  isPayLinkError,
  MAX_FRAGMENT_LENGTH,
  packInvoice,
  unpackInvoice,
  withFragment,
  ZERO_HASH,
} from "../src/index.ts";
import type { Invoice, LinkErrorCode, PayLinkErrorCode } from "../src/index.ts";
import { CHAIN_ID, CONTRACT, DENIED, deploymentAt, registry, sampleInvoice, signedSample, testRegistry } from "./helpers.ts";

/** Asserts that `run` throws a PayLinkError with exactly `code`. */
function expectCode(run: () => unknown, code: PayLinkErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(isPayLinkError(error) ? error.code : error).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

const b64 = (bytes: Uint8Array): string => base64UrlEncode(bytes);
const signed = await signedSample();
const [, , inv = "", sig = "", memo = ""] = signed.fragment.split(".");
const fragment = (...segments: string[]): string => segments.join(".");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** The same segment with a non-zero unused low-order bit in its last character. */
const nonCanonical = (segment: string): string => {
  const last = ALPHABET.indexOf(segment.slice(-1));
  return `${segment.slice(0, -1)}${ALPHABET.charAt(last | 1)}`;
};

describe("base64url (RFC 4648 §5, strict)", () => {
  it("encodes every remainder length", () => {
    expect(b64(new Uint8Array([]))).toBe("");
    expect(b64(new Uint8Array([0xfb]))).toBe("-w");
    expect(b64(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(b64(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
    expect(b64(new TextEncoder().encode("Logo design, invoice #12"))).toBe("TG9nbyBkZXNpZ24sIGludm9pY2UgIzEy");
  });

  it("decodes canonical input and refuses everything else", () => {
    expect(base64UrlDecode("")).toEqual(new Uint8Array([]));
    expect(base64UrlDecode("-w")).toEqual(new Uint8Array([0xfb]));
    expect(base64UrlDecode("-_8")).toEqual(new Uint8Array([0xfb, 0xff]));
    for (const bad of ["A", "-x", "-_9", "+/8=", "-w==", "TG9n=", "TG 9", "TG9né", "\u{1F600}AA", "A\u0000AA"]) {
      expect(base64UrlDecode(bad), bad).toBeNull();
    }
  });
});

describe("packed invoice (§10.4)", () => {
  const { invoice } = sampleInvoice();

  it("round-trips 140 bytes and checksums addresses", () => {
    const packed = packInvoice(invoice);
    expect(packed).toHaveLength(140);
    expect(unpackInvoice(packed)).toEqual(invoice);
  });

  it.each<[string, Partial<Invoice>]>([
    ["amount", { amount: 2n ** 128n }],
    ["negative amount", { amount: -1n }],
    ["validAfter", { validAfter: 2n ** 64n }],
    ["negative validAfter", { validAfter: -1n }],
    ["validUntil", { validUntil: 2n ** 64n }],
    ["negative validUntil", { validUntil: -1n }],
    ["maxPayments", { maxPayments: 2 ** 32 }],
    ["fractional maxPayments", { maxPayments: 1.5 }],
    ["negative maxPayments", { maxPayments: -1 }],
    ["salt", { salt: "0x1234" }],
    ["memoHash", { memoHash: `0x${"AB".repeat(32)}` }],
  ])("refuses an out-of-range %s", (_field, patch) => {
    expectCode(() => packInvoice({ ...invoice, ...patch }), "E_INVALID_ARGUMENT");
  });

  it("refuses a wrong length", () => {
    expectCode(() => unpackInvoice(new Uint8Array(139)), "E_INVALID_ARGUMENT");
  });
});

describe("invoice fragment: strict decoding in the order of §10.5", () => {
  it("decodes a valid fragment", () => {
    const decoded = decodeInvoiceFragment(signed.fragment, registry);
    expect(decoded.invoice).toEqual(signed.invoice);
    expect([decoded.signature, decoded.memo, decoded.chainId, decoded.token.symbol]).toEqual([signed.signature, signed.memo, CHAIN_ID, "USDC"]);
    expect(decoded.target.deployment.address).toBe(CONTRACT);
  });

  const cases: [string, string, LinkErrorCode][] = [
    ["1. too long, checked before anything else", `!${"A".repeat(MAX_FRAGMENT_LENGTH)}`, "E_FRAGMENT_TOO_LONG"],
    ["2. a percent-encoded character", signed.fragment.replace("2.", "2%2E"), "E_FRAGMENT_CHARSET"],
    ["2. whitespace", ` ${signed.fragment}`, "E_FRAGMENT_CHARSET"],
    ["2. a leading #", `#${signed.fragment}`, "E_FRAGMENT_CHARSET"],
    ["3. too few segments", fragment("2", String(CHAIN_ID), inv), "E_SEGMENT_COUNT"],
    ["3. too many segments", `${signed.fragment}.AA`, "E_SEGMENT_COUNT"],
    ["3. an empty segment", fragment("2", String(CHAIN_ID), inv, "", memo), "E_SEGMENT_COUNT"],
    ["3. empty", "", "E_SEGMENT_COUNT"],
    ["4. version 3", fragment("3", String(CHAIN_ID), inv, sig, memo), "E_VERSION_UNSUPPORTED"],
    ["4. version 02", fragment("02", String(CHAIN_ID), inv, sig, memo), "E_VERSION_UNSUPPORTED"],
    ["5. a leading zero", fragment("2", `0${CHAIN_ID}`, inv, sig, memo), "E_CHAIN_ID_FORMAT"],
    ["5. zero", fragment("2", "0", inv, sig, memo), "E_CHAIN_ID_FORMAT"],
    ["5. above 2^53 - 1", fragment("2", "9007199254740992", inv, sig, memo), "E_CHAIN_ID_FORMAT"],
    ["5. 17 digits", fragment("2", "12345678901234567", inv, sig, memo), "E_CHAIN_ID_FORMAT"],
    ["5. hex", fragment("2", "0x7a69", inv, sig, memo), "E_CHAIN_ID_FORMAT"],
    ["5. a chain without deployment", fragment("2", "10143", inv, sig, memo), "E_CHAIN_UNKNOWN"],
    ["2. base64 padding", fragment("2", String(CHAIN_ID), inv, `${sig}=`, memo), "E_FRAGMENT_CHARSET"],
    ["6. a truncated segment", fragment("2", String(CHAIN_ID), inv, sig.slice(0, -2), memo), "E_BASE64URL"],
    ["6. non-canonical trailing bits", fragment("2", String(CHAIN_ID), inv, nonCanonical(sig), memo), "E_BASE64URL"],
    ["6. length 1 mod 4", fragment("2", String(CHAIN_ID), inv, sig, `${memo}A`), "E_BASE64URL"],
    ["7. a 139-byte invoice", fragment("2", String(CHAIN_ID), b64(packInvoice(signed.invoice).subarray(0, 139)), sig, memo), "E_INVOICE_LENGTH"],
    ["7. a 141-byte invoice", fragment("2", String(CHAIN_ID), b64(new Uint8Array([...packInvoice(signed.invoice), 0])), sig, memo), "E_INVOICE_LENGTH"],
    ["8. a 513-byte signature", fragment("2", String(CHAIN_ID), inv, b64(new Uint8Array(513)), memo), "E_SIGNATURE_LENGTH"],
    ["9. memo missing", fragment("2", String(CHAIN_ID), inv, sig), "E_MEMO_PRESENCE"],
  ];

  it.each(cases)("%s", (_name, text, code) => {
    expectCode(() => decodeInvoiceFragment(text, registry), code);
  });

  it("8. accepts a 512-byte ERC-1271 signature (only EOAs need 65 bytes)", () => {
    const long = fragment("2", String(CHAIN_ID), inv, b64(new Uint8Array(512).fill(1)), memo);
    expect(decodeInvoiceFragment(long, registry).signature).toHaveLength(2 + 1024);
  });

  it("9. memo present without memoHash", async () => {
    const plain = await signedSample({}, null);
    expectCode(() => decodeInvoiceFragment(`${plain.fragment}.${memo}`, registry), "E_MEMO_PRESENCE");
  });

  it("10. memo too long, not UTF-8, or not hashing to memoHash", () => {
    const withHash = (bytes: Uint8Array): string => b64(packInvoice({ ...signed.invoice, memoHash: keccak256(bytes) }));
    const long = new Uint8Array(281).fill(0x41);
    expectCode(() => decodeInvoiceFragment(fragment("2", String(CHAIN_ID), withHash(long), sig, b64(long)), registry), "E_MEMO_LENGTH");
    const badUtf8 = new Uint8Array([0x41, 0xc3, 0x28]);
    expectCode(() => decodeInvoiceFragment(fragment("2", String(CHAIN_ID), withHash(badUtf8), sig, b64(badUtf8)), registry), "E_MEMO_UTF8");
    const surrogate = new Uint8Array([0xed, 0xa0, 0x80]);
    expectCode(() => decodeInvoiceFragment(fragment("2", String(CHAIN_ID), withHash(surrogate), sig, b64(surrogate)), registry), "E_MEMO_UTF8");
    expectCode(() => decodeInvoiceFragment(fragment("2", String(CHAIN_ID), inv, sig, b64(new TextEncoder().encode("Logo design, invoice #13"))), registry), "E_MEMO_HASH");
  });

  it("10. hashes the exact bytes: an NFD memo does not match an NFC hash, and a BOM is kept", () => {
    const nfd = new TextEncoder().encode("Café");
    const nfcHash = keccak256(new TextEncoder().encode("Café"));
    expectCode(() => decodeInvoiceFragment(fragment("2", String(CHAIN_ID), b64(packInvoice({ ...signed.invoice, memoHash: nfcHash })), sig, b64(nfd)), registry), "E_MEMO_HASH");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    const decoded = decodeInvoiceFragment(fragment("2", String(CHAIN_ID), b64(packInvoice({ ...signed.invoice, memoHash: keccak256(bom) })), sig, b64(bom)), registry);
    expect(decoded.memo).toBe("﻿A");
  });

  const shape = (patch: Partial<Invoice>, text = memo): string =>
    fragment("2", String(CHAIN_ID), b64(packInvoice({ ...signed.invoice, ...patch })), sig, ...(text === "" ? [] : [text]));

  it.each<[string, Partial<Invoice>, LinkErrorCode]>([
    ["11. validAfter above 2^53 - 1", { validAfter: 2n ** 53n, validUntil: 0n }, "E_UINT53_RANGE"],
    ["11. validUntil above 2^53 - 1", { validUntil: 2n ** 53n }, "E_UINT53_RANGE"],
    ["11. zero payee", { payee: zeroAddress }, "E_INVOICE_SHAPE"],
    ["11. payee is the deployment", { payee: CONTRACT }, "E_INVOICE_SHAPE"],
    ["11. token is the deployment", { token: CONTRACT }, "E_INVOICE_SHAPE"],
    ["11. validUntil before validAfter", { validUntil: 1n }, "E_INVOICE_SHAPE"],
    ["12. a token off the allowlist", { token: "0x0000000000000000000000000000000000000001" }, "E_TOKEN_UNKNOWN"],
    ["12. a denied token", { token: DENIED }, "E_TOKEN_UNKNOWN"],
  ])("%s", (_name, patch, code) => {
    expectCode(() => decodeInvoiceFragment(shape(patch), registry), code);
  });

  it("12. flags denied tokens in the error parameters", () => {
    try {
      decodeInvoiceFragment(shape({ token: DENIED }), registry);
    } catch (error) {
      expect(isPayLinkError(error) && error.params).toEqual({ token: DENIED, denied: "true" });
    }
  });

  it("accepts native invoices where the chain lists its coin", () => {
    expect(decodeInvoiceFragment(shape({ token: zeroAddress }), registry).token.kind).toBe("native");
  });

  it("resolves verifyingContract from the registry, never from the link", () => {
    const elsewhere = testRegistry({ deployment: deploymentAt("0x8464135c8F25Da09e49BC8782676a84730C318bC") });
    const decoded = decodeInvoiceFragment(signed.fragment, elsewhere);
    expect(decoded.key).not.toBe(decodeInvoiceFragment(signed.fragment, registry).key);
  });
});

describe("invoice fragment: encoding (§10.2, §13.1)", () => {
  it("encodes what decodes", () => {
    expect(encodeInvoiceFragment(signed)).toBe(signed.fragment);
    expect(signed.fragment.split(".")).toHaveLength(5);
  });

  it.each<[string, Partial<typeof signed>, PayLinkErrorCode]>([
    ["chain 0", { chainId: 0 }, "E_CHAIN_ID_FORMAT"],
    ["chain 2^53", { chainId: 2 ** 53 }, "E_CHAIN_ID_FORMAT"],
    ["uppercase signature", { signature: signed.signature.toUpperCase().replace("0X", "0x") as `0x${string}` }, "E_SIGNATURE_LENGTH"],
    ["empty signature", { signature: "0x" }, "E_SIGNATURE_LENGTH"],
    ["513-byte signature", { signature: bytesToHex(new Uint8Array(513)) }, "E_SIGNATURE_LENGTH"],
    ["memo missing", { memo: null }, "E_MEMO_PRESENCE"],
    ["memo that does not match", { memo: "other" }, "E_MEMO_HASH"],
  ])("refuses %s", (_name, patch, code) => {
    expectCode(() => encodeInvoiceFragment({ ...signed, ...patch }), code);
  });

  it("refuses times above the wire limit, an empty or oversize memo, and fragments above 1,200 characters", () => {
    expectCode(() => encodeInvoiceFragment({ ...signed, invoice: { ...signed.invoice, validUntil: 2n ** 53n } }), "E_UINT53_RANGE");
    expectCode(() => encodeInvoiceFragment({ ...signed, invoice: { ...signed.invoice, memoHash: keccak256(new Uint8Array()) }, memo: "" }), "E_MEMO_LENGTH");
    const long = "x".repeat(281);
    expectCode(() => encodeInvoiceFragment({ ...signed, invoice: { ...signed.invoice, memoHash: keccak256(new TextEncoder().encode(long)) }, memo: long }), "E_MEMO_LENGTH");
    const memo280 = "y".repeat(280);
    const big = { ...signed, signature: bytesToHex(new Uint8Array(512).fill(7)), invoice: { ...signed.invoice, memoHash: keccak256(new TextEncoder().encode(memo280)) }, memo: memo280 };
    expectCode(() => encodeInvoiceFragment(big), "E_FRAGMENT_TOO_LONG");
  });
});

describe("receipt fragment (§10.6)", () => {
  const txHash = `0x${"ab".repeat(32)}` as const;

  it("round-trips the bare triple and the triple with the paid invoice", () => {
    const bare = encodeReceiptFragment({ chainId: CHAIN_ID, txHash, logIndex: 0 });
    expect(bare).toBe(`2.${CHAIN_ID}.${txHash}.0`);
    expect(decodeReceiptFragment(bare, registry)).toMatchObject({ chainId: CHAIN_ID, txHash, logIndex: 0, invoice: null });
    const full = encodeReceiptFragment({ chainId: CHAIN_ID, txHash, logIndex: 7 }, signed);
    expect(full.split(".")).toHaveLength(9 - 2);
    const decoded = decodeReceiptFragment(full, registry);
    expect(decoded.logIndex).toBe(7);
    expect(decoded.invoice?.invoice).toEqual(signed.invoice);
    const plain = { ...signed, invoice: { ...signed.invoice, memoHash: ZERO_HASH }, memo: null };
    expect(encodeReceiptFragment({ chainId: CHAIN_ID, txHash, logIndex: 1 }, plain).split(".")).toHaveLength(6);
  });

  it("omits the whole tail when it would exceed 1,200 characters", () => {
    const memo280 = "z".repeat(280);
    const big = { ...signed, signature: bytesToHex(new Uint8Array(512).fill(9)), invoice: { ...signed.invoice, memoHash: keccak256(new TextEncoder().encode(memo280)) }, memo: memo280 };
    expect(encodeReceiptFragment({ chainId: CHAIN_ID, txHash, logIndex: 3 }, big)).toBe(`2.${CHAIN_ID}.${txHash}.3`);
  });

  it.each<[string, string, PayLinkErrorCode]>([
    ["5 segments", `2.${CHAIN_ID}.${txHash}.0.${inv}`, "E_SEGMENT_COUNT"],
    ["uppercase hash", `2.${CHAIN_ID}.0x${"AB".repeat(32)}.0`, "E_RECEIPT_FORMAT"],
    ["short hash", `2.${CHAIN_ID}.0x${"ab".repeat(31)}.0`, "E_RECEIPT_FORMAT"],
    ["log index 01", `2.${CHAIN_ID}.${txHash}.01`, "E_RECEIPT_FORMAT"],
    ["log index above 2^53 - 1", `2.${CHAIN_ID}.${txHash}.9007199254740992`, "E_RECEIPT_FORMAT"],
    ["unknown chain", `2.10143.${txHash}.0`, "E_CHAIN_UNKNOWN"],
    ["bad tail", `2.${CHAIN_ID}.${txHash}.0.${inv}.${sig}`, "E_MEMO_PRESENCE"],
  ])("refuses %s", (_name, text, code) => {
    expectCode(() => decodeReceiptFragment(text, registry), code);
  });

  it("refuses bad references and a paid invoice for another chain", () => {
    expectCode(() => encodeReceiptFragment({ chainId: CHAIN_ID, txHash: "0xAB", logIndex: 0 }), "E_RECEIPT_FORMAT");
    expectCode(() => encodeReceiptFragment({ chainId: CHAIN_ID, txHash, logIndex: -1 }), "E_RECEIPT_FORMAT");
    expectCode(() => encodeReceiptFragment({ chainId: 0, txHash, logIndex: 0 }), "E_CHAIN_ID_FORMAT");
    expectCode(() => encodeReceiptFragment({ chainId: 10143, txHash, logIndex: 0 }, signed), "E_RECEIPT_FORMAT");
  });
});

describe("URL helpers", () => {
  it("takes the fragment verbatim and refuses a base that already has one", () => {
    expect(fragmentOf(`https://paylink.example/base/pay/#${signed.fragment}`)).toBe(signed.fragment);
    expect(fragmentOf("https://paylink.example/pay/#a%2Eb")).toBe("a%2Eb");
    expect(fragmentOf("https://paylink.example/pay/")).toBe("");
    expect(withFragment("https://paylink.example/base/pay/", "2.1.x")).toBe("https://paylink.example/base/pay/#2.1.x");
    expectCode(() => withFragment("https://paylink.example/#x", "y"), "E_INVALID_ARGUMENT");
  });

  it("decodes what the URL helpers produce", () => {
    const url = withFragment("https://paylink.example/base/pay/", signed.fragment);
    expect(decodeInvoiceFragment(fragmentOf(url), registry).invoice).toEqual(signed.invoice);
  });

  it("packs exact bytes for the invoice", () => {
    expect(hexToBytes(bytesToHex(packInvoice(signed.invoice)))).toEqual(packInvoice(signed.invoice));
  });
});
