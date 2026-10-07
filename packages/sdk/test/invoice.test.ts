// SPDX-License-Identifier: MIT
import { keccak256, stringToHex, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildInvoice,
  DEFAULT_INVOICE_TTL_SECONDS,
  EMPTY_STRING_HASH,
  expiresIn,
  hashMemo,
  hasMemo,
  invoiceKind,
  invoiceShapeIssue,
  isPayLinkError,
  isWithinWireLimits,
  issuerWarnings,
  memoBytes,
  normalizeMemo,
  randomBytes32,
  sanitizeMemoForDisplay,
  ZERO_HASH,
} from "../src/index.ts";
import type { InvoiceDraft, PayLinkErrorCode } from "../src/index.ts";
import { CONTRACT, payee, sampleInvoice, T0, TOKEN } from "./helpers.ts";

const draft: InvoiceDraft = {
  payee: payee.address.toLowerCase(),
  token: TOKEN.toLowerCase(),
  amount: 25_000_000n,
  maxPayments: 1,
  expiry: expiresIn(T0),
  validAfter: T0,
};

const code = (run: () => unknown): PayLinkErrorCode | undefined => {
  try {
    run();
  } catch (error) {
    return isPayLinkError(error) ? error.code : undefined;
  }
  return undefined;
};

describe("buildInvoice", () => {
  it("checksums addresses, draws a CSPRNG salt and defaults the expiry to 7 days", () => {
    const a = buildInvoice(draft);
    const b = buildInvoice(draft);
    expect(a.invoice.payee).toBe(payee.address);
    expect(a.invoice.token).toBe(TOKEN);
    expect(a.invoice.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.invoice.salt).not.toBe(b.invoice.salt);
    expect(a.invoice.validUntil).toBe(T0 + DEFAULT_INVOICE_TTL_SECONDS);
    expect([a.invoice.memoHash, a.memo]).toEqual([ZERO_HASH, null]);
  });

  it("uses an injected random source and a fixed salt when given", () => {
    const fixed = buildInvoice(draft, (n) => new Uint8Array(n).fill(0xab));
    expect(fixed.invoice.salt).toBe(`0x${"ab".repeat(32)}`);
    expect(buildInvoice({ ...draft, salt: `0x${"01".repeat(32)}` }).invoice.salt).toBe(`0x${"01".repeat(32)}`);
  });

  it("normalises the memo to NFC before hashing; an empty memo is no memo", () => {
    const built = buildInvoice({ ...draft, memo: "Café" });
    expect(built.memo).toBe("Café");
    expect(built.invoice.memoHash).toBe(keccak256(stringToHex("Café")));
    expect(buildInvoice({ ...draft, memo: "" }).invoice.memoHash).toBe(ZERO_HASH);
    expect(buildInvoice({ ...draft, memo: null }).memo).toBeNull();
  });

  it("builds receive cards only with an explicit confirmation for no expiry", () => {
    const card = buildInvoice({ ...draft, amount: 0n, maxPayments: 0, expiry: { kind: "never", confirmed: true }, validAfter: 0n });
    expect(card.invoice.validUntil).toBe(0n);
    expect(invoiceKind(card.invoice)).toBe("receive-card");
    const unconfirmed = { kind: "never", confirmed: false } as unknown as InvoiceDraft["expiry"];
    expect(code(() => buildInvoice({ ...draft, expiry: unconfirmed }))).toBe("E_INVALID_ARGUMENT");
    expect(code(() => buildInvoice({ ...draft, expiry: { kind: "at", validUntil: 0n } }))).toBe("E_INVALID_ARGUMENT");
  });

  it.each<[string, Partial<InvoiceDraft>, PayLinkErrorCode]>([
    ["a bad payee", { payee: "0x1234" }, "E_INVALID_ARGUMENT"],
    ["a mis-checksummed payee", { payee: "0x70997970c51812dc3A010C7d01b50e0d17dc79C8" }, "E_INVALID_ARGUMENT"],
    ["the zero payee", { payee: zeroAddress }, "E_INVALID_ARGUMENT"],
    ["a bad token", { token: "token" }, "E_INVALID_ARGUMENT"],
    ["a negative amount", { amount: -1n }, "E_INVALID_ARGUMENT"],
    ["an amount above uint128", { amount: 2n ** 128n }, "E_INVALID_ARGUMENT"],
    ["fractional seats", { maxPayments: 1.5 }, "E_INVALID_ARGUMENT"],
    ["negative seats", { maxPayments: -1 }, "E_INVALID_ARGUMENT"],
    ["seats above uint32", { maxPayments: 2 ** 32 }, "E_INVALID_ARGUMENT"],
    ["validAfter above 2^53 - 1", { validAfter: 2n ** 53n }, "E_UINT53_RANGE"],
    ["a negative validAfter", { validAfter: -1n }, "E_UINT53_RANGE"],
    ["validUntil above 2^53 - 1", { expiry: { kind: "at", validUntil: 2n ** 53n } }, "E_UINT53_RANGE"],
    ["an inverted window", { expiry: { kind: "at", validUntil: T0 - 1n } }, "E_INVALID_ARGUMENT"],
    ["an uppercase salt", { salt: `0x${"AB".repeat(32)}` }, "E_INVALID_ARGUMENT"],
    ["a memo above 280 bytes", { memo: "é".repeat(141) }, "E_MEMO_LENGTH"],
  ])("refuses %s", (_name, patch, expected) => {
    expect(code(() => buildInvoice({ ...draft, ...patch }))).toBe(expected);
  });

  it("refuses a non-positive validity", () => {
    expect(code(() => expiresIn(T0, 0n))).toBe("E_INVALID_ARGUMENT");
    expect(expiresIn(T0, 60n)).toEqual({ kind: "at", validUntil: T0 + 60n });
  });
});

describe("shape, kinds and warnings", () => {
  const { invoice } = sampleInvoice();

  it("reports the first broken shape rule (spec §7.2 #1)", () => {
    expect(invoiceShapeIssue(invoice, CONTRACT)).toBeNull();
    expect(invoiceShapeIssue({ ...invoice, payee: zeroAddress }, CONTRACT)).toBe("payee-zero");
    expect(invoiceShapeIssue({ ...invoice, payee: CONTRACT }, CONTRACT.toLowerCase() as `0x${string}`)).toBe("payee-is-deployment");
    expect(invoiceShapeIssue({ ...invoice, token: CONTRACT }, CONTRACT)).toBe("token-is-deployment");
    expect(invoiceShapeIssue({ ...invoice, validUntil: invoice.validAfter - 1n }, CONTRACT)).toBe("window-inverted");
    expect(invoiceShapeIssue({ ...invoice, validUntil: 0n }, CONTRACT)).toBeNull();
  });

  it("checks the uint53 wire limits", () => {
    expect(isWithinWireLimits(invoice)).toBe(true);
    expect(isWithinWireLimits({ ...invoice, validAfter: 2n ** 53n })).toBe(false);
    expect(isWithinWireLimits({ ...invoice, validUntil: 2n ** 53n })).toBe(false);
  });

  it.each([
    [25n, 1, "one-off"],
    [25n, 3, "seats"],
    [25n, 0, "fixed-unlimited"],
    [0n, 1, "open-single"],
    [0n, 3, "open-seats"],
    [0n, 0, "receive-card"],
  ] as const)("amount %s with %i payments is a %s", (amount, maxPayments, kind) => {
    expect(invoiceKind({ ...invoice, amount, maxPayments })).toBe(kind);
  });

  it("warns about single-use open amounts (O-1), no expiry and unlimited payments", () => {
    expect(issuerWarnings(invoice)).toEqual([]);
    expect(issuerWarnings({ ...invoice, amount: 0n })).toEqual(["open-amount-single-use"]);
    expect(issuerWarnings({ ...invoice, amount: 0n, maxPayments: 0, validUntil: 0n })).toEqual(["no-expiry", "unlimited-payments"]);
  });

  it("knows whether a memo travels with the link", () => {
    expect(hasMemo(invoice)).toBe(true);
    expect(hasMemo({ ...invoice, memoHash: ZERO_HASH })).toBe(false);
  });
});

describe("memo", () => {
  it("hashes exact UTF-8 bytes and never produces keccak256('')", () => {
    expect(hashMemo(null)).toBe(ZERO_HASH);
    expect(hashMemo("")).toBe(ZERO_HASH);
    expect(hashMemo("")).not.toBe(EMPTY_STRING_HASH);
    expect(hashMemo("x".repeat(280))).toBe(keccak256(stringToHex("x".repeat(280))));
    expect(code(() => hashMemo("x".repeat(281)))).toBe("E_MEMO_LENGTH");
    expect(memoBytes("€")).toEqual(new Uint8Array([0xe2, 0x82, 0xac]));
    expect(normalizeMemo("Å")).toBe("Å");
  });

  it("removes bidi controls and control characters for display (spec §13.2)", () => {
    const hostile = "Pay‮evil‬ to⁦ me⁩‎‏؜\u0000\u0007\u001B[31m\u007F\u0085x";
    expect(sanitizeMemoForDisplay(hostile)).toBe("Payevil to me[31m x");
    expect(sanitizeMemoForDisplay("line 1\nline 2\r\n\tend")).toBe("line 1 line 2 end");
    expect(sanitizeMemoForDisplay("a\u2028b\u2029c")).toBe("a b c");
    expect(sanitizeMemoForDisplay("Saran'ny sakafo — Antananarivo ✓")).toBe("Saran'ny sakafo — Antananarivo ✓");
  });
});

describe("random", () => {
  it("draws 32 bytes and refuses a short source", () => {
    expect(randomBytes32()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => randomBytes32(() => new Uint8Array(31))).toThrow(RangeError);
  });
});
