// SPDX-License-Identifier: MIT
// @ts-check
/**
 * Number formatting for the deploy page. Display only: amounts are never parsed back.
 * Costs round **up** and balances round **down**, so the page never understates what a deployment needs or overstates
 * what a wallet holds (the v1 rule).
 *
 * @module
 */

/**
 * @param {bigint} value       base units
 * @param {number} decimals
 * @param {number} digits      fraction digits shown
 * @param {"up" | "down"} mode
 * @returns {string}
 */
export function units(value, decimals, digits, mode) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(Math.max(0, decimals - digits));
  let scaled = abs / scale;
  if (mode === "up" && abs % scale !== 0n) {
    scaled += 1n;
  }
  const s = scaled.toString().padStart(digits + 1, "0");
  const whole = s.slice(0, s.length - digits);
  const frac = digits > 0 ? `.${s.slice(s.length - digits)}` : "";
  return `${negative ? "-" : ""}${group(whole)}${frac}`;
}

/**
 * A native amount with enough precision to be useful on testnets: 4 decimals, or 6 below 0.01, or the exact value
 * below 0.000001 (so a nearly empty wallet never reads as zero).
 *
 * @param {bigint} value
 * @param {number} decimals
 * @param {"up" | "down"} mode
 * @returns {string}
 */
export function native(value, decimals, mode) {
  if (value === 0n) {
    return "0";
  }
  const one = 10n ** BigInt(decimals);
  if (value >= one / 100n) {
    return units(value, decimals, 4, mode);
  }
  if (value >= one / 1_000_000n) {
    return units(value, decimals, 6, mode);
  }
  return units(value, decimals, decimals, mode).replace(/0+$/, "");
}

/**
 * Gas price in gwei, up to 3 decimals, trailing zeros dropped.
 * @param {bigint} wei
 * @returns {string}
 */
export function gwei(wei) {
  return units(wei, 9, 3, "up").replace(/\.?0+$/, "");
}

/**
 * @param {bigint | number} n
 * @returns {string}
 */
export function gas(n) {
  return group(BigInt(n).toString());
}

/** @param {string} digits */
function group(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
