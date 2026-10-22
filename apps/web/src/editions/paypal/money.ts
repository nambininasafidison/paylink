// SPDX-License-Identifier: MIT
/**
 * Exact conversions between a signed amount (token base units) and PayPal's USD decimals (docs/paypal/SPEC.md §7.2),
 * and ISO instants as unix seconds. No import: the pay page's rail chooser uses these without pulling shared code into
 * its own chunk (the pay route's 110 kB budget).
 *
 * Owner: web edition workstream.
 */

/** PayPal's two-decimal USD for a base amount, or `null` when it holds a fraction of a cent (or is not positive). */
export function usdFromBase(amount: bigint, decimals: number): string | null {
  if (amount <= 0n || decimals < 2) {
    return null;
  }
  const unit = 10n ** BigInt(decimals - 2);
  if (amount % unit !== 0n) {
    return null;
  }
  const cents = amount / unit;
  return `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Base units for a PayPal decimal string ("120.00", "7.5"), or `null` when it is not an exact non-negative amount. */
export function baseFromDecimal(value: string, decimals: number): bigint | null {
  const match = /^(\d{1,30})(?:\.(\d{1,30}))?$/.exec(value);
  if (match === null) {
    return null;
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    return null;
  }
  return BigInt(match[1] ?? "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** An ISO instant as unix seconds (for `formatDateTime`), or `null`. */
export function seconds(isoInstant: string | null): number | null {
  if (isoInstant === null) {
    return null;
  }
  const ms = Date.parse(isoInstant);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
