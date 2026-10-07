// SPDX-License-Identifier: MIT
/** Property tests (fast-check, spec §4.1): exact amounts at 6 and 18 decimals, never a float. */
import fc from "fast-check";
import { formatUnits, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { convertDecimals, formatAmount, formatAmountLocale, MAX_UINT128, parseAmount } from "../../src/index.ts";

const value = fc.oneof(fc.bigInt({ min: 0n, max: MAX_UINT128 }), fc.bigInt({ min: 0n, max: 10n ** 9n }));
const decimals = fc.constantFrom(6, 18);

describe("amount properties at 6 and 18 decimals", () => {
  it("parse(format(v)) = v for every uint128, with any minimum of fraction digits", () => {
    fc.assert(
      fc.property(value, decimals, fc.integer({ min: 0, max: 18 }), (v, d, min) => {
        expect(parseAmount(formatAmount(v, d, { minFractionDigits: min }), d)).toBe(v);
      }),
      { numRuns: 3000 },
    );
  });

  it("agrees with viem's formatUnits and parseUnits", () => {
    fc.assert(
      fc.property(value, decimals, (v, d) => {
        const text = formatAmount(v, d, { minFractionDigits: 0 });
        expect(text).toBe(formatUnits(v, d));
        expect(parseAmount(text, d)).toBe(parseUnits(text, d));
      }),
      { numRuns: 3000 },
    );
  });

  it("formats exactly in a locale (Intl with a decimal string, no rounding)", () => {
    fc.assert(
      fc.property(value, decimals, (v, d) => {
        const english = formatAmountLocale(v, d, "en-US").replaceAll(",", "");
        expect(english).toBe(formatAmount(v, d));
        const french = formatAmountLocale(v, d, "fr-FR").replace(/[\s\u202F\u00A0]/gu, "").replace(",", ".");
        expect(french).toBe(formatAmount(v, d));
      }),
      { numRuns: 1000 },
    );
  });

  it("accepts a comma separator where the user typed one", () => {
    fc.assert(
      fc.property(value, decimals, (v, d) => {
        expect(parseAmount(formatAmount(v, d).replace(".", ","), d, { decimalSeparator: "," })).toBe(v);
      }),
      { numRuns: 1000 },
    );
  });

  it("converts 6 ↔ 18 decimals without loss, and refuses lossy conversions", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 100n }), (v) => {
        expect(convertDecimals(convertDecimals(v, 6, 18), 18, 6)).toBe(v);
        const wei = v * 10n ** 12n + 1n;
        expect(() => convertDecimals(wei, 18, 6)).toThrow(/E_AMOUNT_PRECISION/);
      }),
      { numRuns: 1000 },
    );
  });

  it("refuses more fraction digits than the token has, instead of rounding", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), decimals, fc.integer({ min: 1, max: 9 }), (v, d, extra) => {
        const text = `${formatAmount(v, d, { minFractionDigits: d })}${String(extra)}`;
        expect(() => parseAmount(text, d)).toThrow(/E_AMOUNT_PRECISION/);
      }),
      { numRuns: 500 },
    );
  });
});
