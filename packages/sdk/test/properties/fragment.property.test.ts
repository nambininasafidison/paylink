// SPDX-License-Identifier: MIT
/**
 * Property tests (fast-check, invoice spec §10.5): "Encoding the decoded value again MUST give back the input
 * byte for byte", decoding is injective (no two strings decode to the same link), and arbitrary input only
 * ever fails with a typed PayLinkError.
 */
import fc from "fast-check";
import { bytesToHex, getAddress, zeroAddress } from "viem";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { decodeInvoiceFragment, decodeReceiptFragment, encodeInvoiceFragment, hashMemo, isPayLinkError, MAX_FRAGMENT_LENGTH, MAX_UINT128, MAX_UINT53 } from "../../src/index.ts";
import type { SignedInvoice } from "../../src/index.ts";
import { CHAIN_ID, CONTRACT, PERMIT_TOKEN, registry, TOKEN } from "../helpers.ts";

const address = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => getAddress(bytesToHex(b)));
const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => bytesToHex(b));
const time = fc.bigInt({ min: 0n, max: MAX_UINT53 });
const memo = fc.option(
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 120 }).filter((m) => {
    const size = new TextEncoder().encode(m).length;
    return size >= 1 && size <= 280;
  }),
  { nil: null },
);

/** Valid signed invoices for the test registry (allowlisted token, valid shape, wire limits). */
const signedInvoice: fc.Arbitrary<SignedInvoice> = fc
  .record({
    payee: address.filter((a) => a !== zeroAddress && a !== CONTRACT),
    token: fc.constantFrom<Address>(TOKEN, PERMIT_TOKEN, zeroAddress),
    amount: fc.bigInt({ min: 0n, max: MAX_UINT128 }),
    validAfter: time,
    validUntil: time,
    maxPayments: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
    salt: bytes32,
    memo,
    signature: fc.uint8Array({ minLength: 1, maxLength: 300 }).map((b) => bytesToHex(b)),
  })
  .map(({ memo: text, signature, validAfter, validUntil, ...fields }) => ({
    chainId: CHAIN_ID,
    invoice: { ...fields, validAfter, validUntil: validUntil === 0n || validUntil >= validAfter ? validUntil : validAfter, memoHash: hashMemo(text) },
    signature,
    memo: text,
  }));

describe("invoice fragment properties", () => {
  it("encode → decode → encode is the identity, and the decoded link equals the input", () => {
    fc.assert(
      fc.property(signedInvoice, (link) => {
        const fragment = encodeInvoiceFragment(link);
        expect(fragment.length).toBeLessThanOrEqual(MAX_FRAGMENT_LENGTH);
        const decoded = decodeInvoiceFragment(fragment, registry);
        expect(decoded.invoice).toEqual(link.invoice);
        expect([decoded.signature, decoded.memo, decoded.chainId]).toEqual([link.signature, link.memo, link.chainId]);
        expect(encodeInvoiceFragment(decoded)).toBe(fragment);
      }),
      { numRuns: 1000 },
    );
  });

  it("is injective: changing any character either fails or yields a different link", () => {
    const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.";
    fc.assert(
      fc.property(signedInvoice, fc.nat(), fc.constantFrom(...CHARSET.split("")), (link, position, replacement) => {
        const fragment = encodeInvoiceFragment(link);
        const at = position % fragment.length;
        fc.pre(fragment[at] !== replacement);
        const mutated = `${fragment.slice(0, at)}${replacement}${fragment.slice(at + 1)}`;
        try {
          const decoded = decodeInvoiceFragment(mutated, registry);
          expect(encodeInvoiceFragment(decoded)).toBe(mutated);
          expect(encodeInvoiceFragment(decoded)).not.toBe(fragment);
        } catch (error) {
          expect(isPayLinkError(error)).toBe(true);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it("fails only with a typed PayLinkError on arbitrary input (invoice and receipt decoders)", () => {
    const fragmentish = fc.oneof(
      fc.string({ maxLength: 1300 }),
      fc.array(fc.oneof(fc.constant("2"), fc.constant(String(CHAIN_ID)), fc.string({ maxLength: 200 }), fc.base64String({ maxLength: 200 })), { maxLength: 8 }).map((s) => s.join(".")),
    );
    fc.assert(
      fc.property(fragmentish, (text) => {
        for (const decode of [decodeInvoiceFragment, decodeReceiptFragment]) {
          try {
            decode(text, registry);
          } catch (error) {
            expect(isPayLinkError(error)).toBe(true);
          }
        }
      }),
      { numRuns: 3000 },
    );
  });
});
