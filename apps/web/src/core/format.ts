// SPDX-License-Identifier: MIT
/**
 * Display formatting: exact amounts (SDK `formatAmountLocale`: bigint in, Intl out, nothing rounded), addresses and
 * hashes grouped by four (spec §3.10), and amount entry that accepts both decimal separators.
 */
import type { Token } from "@paylink/chains";
import { formatAmount, formatAmountLocale, parseAmount } from "@paylink/sdk";
import { LOCALE_INFO } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";
import type { Address, Hex } from "viem";

/** "25.50" / "25,50" / "1 200,00": at least two decimals, every significant digit kept. */
export function displayAmount(value: bigint, token: Pick<Token, "decimals">, locale: Locale): string {
  return formatAmountLocale(value, token.decimals, LOCALE_INFO[locale].numberLocale, { minFractionDigits: Math.min(2, token.decimals) });
}

/** The exact decimal with a dot and no grouping ("25.5"): for CSV, wallets and the clipboard. */
export function plainAmount(value: bigint, token: Pick<Token, "decimals">): string {
  return formatAmount(value, token.decimals, { minFractionDigits: 0 });
}

/**
 * Parses what a person typed: digits with one `.` or `,` as the decimal separator, spaces (including no-break spaces)
 * ignored. A second separator, a sign or an exponent is refused by the SDK (`E_AMOUNT_FORMAT`); more decimals than the
 * token has is refused, never rounded (`E_AMOUNT_PRECISION`).
 */
export function parseTypedAmount(input: string, token: Pick<Token, "decimals">): bigint {
  const compact = input.replace(/[\s\u00a0\u202f]/g, "");
  return compact.includes(",") ? parseAmount(compact, token.decimals, { decimalSeparator: "," }) : parseAmount(compact, token.decimals);
}

/** `0x` + groups of four: the address split the way the payer compares it ("0x90F8 bf6A 479f … c9C1"). */
export function addressGroups(address: Address): string[] {
  return [address.slice(0, 6), ...(address.slice(6).match(/.{1,4}/g) ?? [])];
}

/** What a screen reader says for an address: the groups, separated by pauses. */
export function spokenAddress(address: Address): string {
  return addressGroups(address).join(", ");
}

/** "0x90F8…c9C1". */
export function shortHex(value: Hex, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Number of characters an amount occupies, for the `--n` sizing variable of instrument numerals. */
export function figureWidth(text: string): string {
  return String(Math.max(4, text.length));
}
