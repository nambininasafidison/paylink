// SPDX-License-Identifier: MIT
/**
 * Amounts by code (invariant AI-5, docs/paypal/SPEC.md §9.2 A1): the model only points at the amount by copying it
 * verbatim (`amount_text`); code checks that the copy is really in the message, finds the currency written next to it,
 * and parses the digits into 6-decimal base units with the SDK's exact parser (`parseAmount`, no floating point).
 *
 * | What the message and the model give | Draft amount | Clarification |
 * |---|---|---|
 * | `amount_text` in the message, next to `$`, `USD`, `US$`, "dollar(s)", "dolara" | the parsed USD amount | none |
 * | the same, and another, different USD amount in the message | the model's choice | `several_amounts` |
 * | `amount_text` next to `€`, "euro(s)", `Ar`, "ariary", `MGA`, `£`, `C$`, … | none (never converted) | `currency_not_usd` |
 * | `amount_text` without any currency next to it | the parsed amount, currency unknown | `amount_ambiguous` |
 * | `amount_text` not found in the message (an invented amount) | none | `amount_ambiguous` |
 * | a grouping that reads two ways (`$1.200`), a `k` suffix, sub-cent digits, zero | none | `amount_ambiguous` |
 * | no `amount_text`, no amount in the message | none | `amount_missing` |
 * | no `amount_text`, amounts in the message | none | `amount_ambiguous` |
 *
 * Owner: AI workstream.
 */
import type { ClarificationCode } from "@paylink/api-contract";
import { parseAmount } from "@paylink/sdk";

export type CurrencyMark = "USD" | "EUR" | "MGA" | "GBP" | "OTHER";

/** One number of the message with a currency written next to it (or none). */
export interface MoneyMention {
  /** The digits as written (`1 200,50`). */
  readonly digits: string;
  /** Offset of the digits in the scanned text. */
  readonly index: number;
  readonly currency: CurrencyMark | null;
  /** USD base units (6 decimals) of the reading code chose; null when the digits cannot be an amount. */
  readonly base: bigint | null;
  /** The digits can be read in two ways, carry a `k`/`m` multiplier, or have more than two decimals. */
  readonly ambiguous: boolean;
}

const SPACE = "[ \\u00A0\\u202F]";
const NUMBER = `\\d{1,3}(?:(?:${SPACE}|[,.'’])\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d+)?`;
const BEFORE: readonly (readonly [RegExp, CurrencyMark])[] = [
  [/(?:US\$|USD|U\.S\.\s?\$)\s?$/iu, "USD"],
  [/(?:[A-Z]{1,3}\$)\s?$/u, "OTHER"],
  [/\$\s?$/u, "USD"],
  [/(?:€|EUR)\s?$/iu, "EUR"],
  [/(?:£|GBP)\s?$/iu, "GBP"],
  [/(?:\bMGA|\bAr\.?)\s?$/u, "MGA"],
];
const AFTER: readonly (readonly [RegExp, CurrencyMark])[] = [
  [/^\s?(?:US\$|USD\b|\$|dollars?\b|dolara\b|bucks\b)/iu, "USD"],
  [/^\s?(?:€|EUR\b|euros?\b)/iu, "EUR"],
  [/^\s?(?:£|GBP\b|pounds?\b)/iu, "GBP"],
  [/^\s?(?:MGA\b|Ar\b|ariary\b)/u, "MGA"],
  [/^\s?ariary\b/iu, "MGA"],
  [/^\s?(?:CAD|AUD|CHF|JPY|CNY|INR|NGN|KES|ZAR|XOF|XAF)\b/u, "OTHER"],
];
/** A multiplier glued to the digits (`1.2k`, `3m`): the amount reads two ways. */
const MULTIPLIER = /^(?:k|K|m|M|mn)\b/u;

/** Reads the digits as an amount: the grouping and decimal separators, and whether another reading exists. */
export function readDigits(digits: string, currency: CurrencyMark | null): { readonly decimal: string | null; readonly ambiguous: boolean } {
  let text = digits.replace(/[ \u00A0\u202F'’]/gu, "");
  let ambiguous = false;
  const dots = (text.match(/\./gu) ?? []).length;
  const commas = (text.match(/,/gu) ?? []).length;
  if (dots > 0 && commas > 0) {
    const decimalSeparator = text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",";
    const grouping = decimalSeparator === "." ? "," : ".";
    text = text.split(grouping).join("").replace(decimalSeparator, ".");
  } else if (dots + commas > 0) {
    const separator = dots > 0 ? "." : ",";
    const parts = text.split(separator);
    const last = parts[parts.length - 1] ?? "";
    if (parts.length > 2) {
      // 1.200.000 or 1,200,000: grouping only.
      text = parts.join("");
    } else if (last.length === 3) {
      // 1,200 or 1.200: thousands in the usual reading; "1,200" with a dollar sign is unambiguous English usage.
      text = parts.join("");
      ambiguous = !(separator === "," && currency === "USD");
    } else {
      text = parts.join(".");
    }
  }
  if (!/^\d+(?:\.\d+)?$/u.test(text)) {
    return { decimal: null, ambiguous: true };
  }
  return { decimal: text, ambiguous };
}

function baseOf(decimal: string | null): { readonly base: bigint | null; readonly subCent: boolean } {
  if (decimal === null) {
    return { base: null, subCent: false };
  }
  const fraction = decimal.split(".")[1] ?? "";
  if (fraction.length > 2) {
    return { base: null, subCent: true };
  }
  try {
    return { base: parseAmount(decimal, 6), subCent: false };
  } catch {
    return { base: null, subCent: false };
  }
}

/** Every number of `text`, with the currency written right before or after it (module table). */
export function scanMoney(text: string): MoneyMention[] {
  const mentions: MoneyMention[] = [];
  const pattern = new RegExp(`(?<![\\d\\w])(?:${NUMBER})`, "gu");
  for (const match of text.matchAll(pattern)) {
    const digits = match[0];
    const index = match.index;
    const before = text.slice(Math.max(0, index - 8), index);
    const after = text.slice(index + digits.length, index + digits.length + 12);
    let currency: CurrencyMark | null = null;
    for (const [re, mark] of BEFORE) {
      if (re.test(before)) {
        currency = mark;
        break;
      }
    }
    if (currency === null) {
      for (const [re, mark] of AFTER) {
        if (re.test(after)) {
          currency = mark;
          break;
        }
      }
    }
    const multiplied = MULTIPLIER.test(after) || /^\s(?:million|millions|thousand|mille)\b/iu.test(after);
    const read = readDigits(digits, currency);
    const { base, subCent } = baseOf(read.decimal);
    mentions.push({ digits, index, currency, base: multiplied ? null : base, ambiguous: read.ambiguous || multiplied || subCent });
  }
  return mentions;
}

export interface AmountDecision {
  readonly amountBase: bigint | null;
  readonly amountText: string | null;
  readonly currency: "USD" | null;
  readonly clarifications: readonly ClarificationCode[];
  /** Why, for logs and tests (never shown). */
  readonly basis: "matched" | "no-amount" | "not-in-text" | "not-usd" | "no-currency" | "ambiguous" | "unparseable";
}

const squash = (s: string): string => s.replace(/[\s\u00A0\u202F]+/gu, " ").trim();

/**
 * Decides the draft's amount from the model's `amount_text` and the message itself (module table). `text` is the text
 * the model was given (placeholders included): the copy must be found there, verbatim but for runs of spaces.
 */
export function decideAmount(text: string, amountText: string | null): AmountDecision {
  const mentions = scanMoney(text);
  const usdValues = new Set(mentions.filter((m) => m.currency === "USD" && m.base !== null).map((m) => m.base?.toString()));
  const several: ClarificationCode[] = usdValues.size > 1 ? ["several_amounts"] : [];
  if (amountText === null || squash(amountText) === "") {
    return { amountBase: null, amountText: null, currency: null, clarifications: [mentions.some((m) => m.currency !== null) ? "amount_ambiguous" : "amount_missing"], basis: "no-amount" };
  }
  const wanted = squash(amountText);
  const haystack = squash(text);
  if (!haystack.includes(wanted) || !/\d/u.test(wanted)) {
    return { amountBase: null, amountText: null, currency: null, clarifications: ["amount_ambiguous"], basis: "not-in-text" };
  }
  // The mentions the copy covers, wherever it occurs (scanned in the squashed text so that offsets agree); a mention
  // with a dollar sign wins over one with another currency, which wins over a bare number.
  const inSquashed = scanMoney(haystack);
  const covered: MoneyMention[] = [];
  for (let at = haystack.indexOf(wanted); at >= 0; at = haystack.indexOf(wanted, at + 1)) {
    covered.push(...inSquashed.filter((m) => m.index < at + wanted.length && at < m.index + m.digits.length));
  }
  const mention = covered.find((m) => m.currency === "USD") ?? covered.find((m) => m.currency !== null) ?? covered[0];
  if (mention === undefined) {
    return { amountBase: null, amountText: wanted, currency: null, clarifications: ["amount_ambiguous"], basis: "unparseable" };
  }
  if (mention.currency !== null && mention.currency !== "USD") {
    return { amountBase: null, amountText: wanted, currency: null, clarifications: ["currency_not_usd"], basis: "not-usd" };
  }
  if (mention.base === null || mention.base === 0n || mention.ambiguous) {
    return { amountBase: null, amountText: wanted, currency: null, clarifications: ["amount_ambiguous", ...several], basis: "ambiguous" };
  }
  if (mention.currency === null) {
    return { amountBase: mention.base, amountText: wanted, currency: null, clarifications: ["amount_ambiguous", ...several], basis: "no-currency" };
  }
  return { amountBase: mention.base, amountText: wanted, currency: "USD", clarifications: several, basis: "matched" };
}
