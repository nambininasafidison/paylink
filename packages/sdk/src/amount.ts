// SPDX-License-Identifier: MIT
/**
 * Exact amount math for 6-decimal (USDC, AUSD) and 18-decimal (MUSD, native coins) tokens. Amounts are
 * `bigint` base units end to end; no floating point is ever involved, and nothing is rounded silently:
 * input with more decimals than the token has is refused (`E_AMOUNT_PRECISION`), not truncated.
 */
import { MAX_UINT128 } from "./constants.ts";
import { assertArgument, PayLinkError } from "./errors.ts";

const AMOUNT = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

function checkDecimals(decimals: number): void {
  assertArgument(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36, "decimals must be an integer in [0, 36]");
}

export interface ParseAmountOptions {
  /** Decimal separator the user typed: `.` (default) or `,` (French and Malagasy keyboards). */
  readonly decimalSeparator?: "." | ",";
}

/**
 * Parses a human amount ("25", "25.5", "0.000001", ".5") into base units. Refuses signs, exponents, grouping,
 * spaces, more fraction digits than `decimals` (`E_AMOUNT_PRECISION`) and values above uint128
 * (`E_AMOUNT_RANGE`). Leading and trailing whitespace is ignored.
 */
export function parseAmount(input: string, decimals: number, options: ParseAmountOptions = {}): bigint {
  checkDecimals(decimals);
  const separator = options.decimalSeparator ?? ".";
  let text = input.trim();
  if (separator === ",") {
    if (text.includes(".")) {
      throw new PayLinkError("E_AMOUNT_FORMAT", "use a comma as the decimal separator");
    }
    text = text.replace(",", ".");
  }
  const match = AMOUNT.exec(text);
  if (match === null) {
    throw new PayLinkError("E_AMOUNT_FORMAT", "an amount is digits with at most one decimal separator");
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  if (fraction.length > decimals) {
    throw new PayLinkError("E_AMOUNT_PRECISION", `at most ${decimals} decimals`, { decimals: String(decimals) });
  }
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (value > MAX_UINT128) {
    throw new PayLinkError("E_AMOUNT_RANGE", "the amount is too large");
  }
  return value;
}

export interface FormatAmountOptions {
  /** Fraction digits always shown (default 2, as on the v1 receipts: "25.50"). Capped at `decimals`. */
  readonly minFractionDigits?: number;
}

/**
 * Formats base units as an exact decimal string with `.` and no grouping ("25.50", "0.000001",
 * "1.5"). Never rounds: every significant fraction digit is kept. For display in a locale, see
 * `formatAmountLocale`.
 */
export function formatAmount(value: bigint, decimals: number, options: FormatAmountOptions = {}): string {
  checkDecimals(decimals);
  assertArgument(value >= 0n, "amounts are unsigned");
  const minFraction = Math.min(options.minFractionDigits ?? 2, decimals);
  assertArgument(Number.isInteger(minFraction) && minFraction >= 0, "minFractionDigits must be a non-negative integer");
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toString();
  let fraction = decimals === 0 ? "" : (value % scale).toString().padStart(decimals, "0");
  while (fraction.length > minFraction && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * Formats base units for a locale with `Intl.NumberFormat` (spec §3.9), exactly: the value is passed as a
 * decimal string, which Intl formats without converting to a binary float, and the maximum fraction
 * digits equal `decimals`, so nothing is rounded.
 */
export function formatAmountLocale(value: bigint, decimals: number, locale: string, options: FormatAmountOptions = {}): string {
  const exact = formatAmount(value, decimals, { minFractionDigits: decimals });
  const minimumFractionDigits = Math.min(options.minFractionDigits ?? 2, decimals);
  const format = new Intl.NumberFormat(locale, {
    minimumFractionDigits,
    maximumFractionDigits: decimals,
    useGrouping: true,
  });
  return format.format(exact as `${number}`);
}

/**
 * Converts base units between decimal scales (for example Arc's 18-decimal native USDC and its 6-decimal
 * ERC-20 view). Refuses a conversion that would lose precision (`E_AMOUNT_PRECISION`).
 */
export function convertDecimals(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  checkDecimals(fromDecimals);
  checkDecimals(toDecimals);
  assertArgument(value >= 0n, "amounts are unsigned");
  if (toDecimals >= fromDecimals) {
    return value * 10n ** BigInt(toDecimals - fromDecimals);
  }
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  if (value % divisor !== 0n) {
    throw new PayLinkError("E_AMOUNT_PRECISION", `the amount has more than ${toDecimals} decimals`, { decimals: String(toDecimals) });
  }
  return value / divisor;
}
