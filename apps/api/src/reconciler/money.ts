// SPDX-License-Identifier: MIT
/**
 * Money and dates exactly as the reconciler compares them. Code, never a model, turns a signed amount into PayPal's
 * two-decimal USD string and compares PayPal's strings with it (invariant AI-5).
 *
 * - PayPal's `money.value` matches `^((-?[0-9]+)|(-?([0-9]+)?[.][0-9]+))$`, at most 32 characters (V, `invoicing_v2.json`
 *   at 90e8041); PayLink only ever accepts a non-negative value with at most two significant decimals.
 * - USDC and PYUSD on Ethereum Sepolia have 6 decimals (packages/chains/src/chains/ethereum-sepolia.ts, read on chain).
 *
 * Owner: reconciler workstream.
 */

const PAYPAL_VALUE = /^(?<whole>[0-9]{0,30})(?:\.(?<fraction>[0-9]{1,30}))?$/u;
const BASE_UNITS = /^(?:0|[1-9][0-9]{0,38})$/u;

/** The value in cents, or null when it is not a non-negative amount with at most two significant decimals. */
export function centsOf(value: string | null | undefined): bigint | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) {
    return null;
  }
  const match = PAYPAL_VALUE.exec(value);
  const whole = match?.groups?.["whole"] ?? "";
  const fraction = (match?.groups?.["fraction"] ?? "").replace(/0+$/u, "");
  if (match === null || (whole === "" && match.groups?.["fraction"] === undefined) || fraction.length > 2) {
    return null;
  }
  return BigInt(whole === "" ? "0" : whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/** Two PayPal values denote the same amount (both well formed). */
export function sameMoney(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = centsOf(a);
  return x !== null && x === centsOf(b);
}

/**
 * A 6-decimal base-unit amount as PayPal's USD string with exactly two decimals (`"120.00"`), or null when it has
 * sub-cent precision or is not a base-unit string (`E_TWIN_PRECISION`, docs/paypal/SPEC.md §7.2).
 */
export function usdFromBase(base: string, decimals = 6): string | null {
  if (!BASE_UNITS.test(base) || decimals < 2) {
    return null;
  }
  const units = BigInt(base);
  const perCent = 10n ** BigInt(decimals - 2);
  if (units % perCent !== 0n) {
    return null;
  }
  const cents = units / perCent;
  return `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** The UTC calendar day of an instant, `YYYY-MM-DD`: quotas, budgets, due dates and P6's `payment_date`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Milliseconds until the next UTC midnight (a daily quota's `Retry-After`). */
export function msUntilNextUtcDay(ms: number): number {
  const day = new Date(ms);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1) - ms;
}

/** Whether `due` (`YYYY-MM-DD`) is today or past, in UTC (E: PayPal's own timezone handling is not documented). */
export function isDue(due: string | null, now: number): boolean {
  return due !== null && /^\d{4}-\d{2}-\d{2}$/u.test(due) && utcDay(now) >= due;
}
