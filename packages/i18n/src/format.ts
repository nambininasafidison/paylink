// SPDX-License-Identifier: MIT
/**
 * Locale formatting with `Intl` (spec §3.9). Amounts of digital dollars are formatted exactly by the SDK
 * (`formatAmountLocale`, bigint in, no float); these helpers cover counts, dates and the Malagasy ariary label.
 */
import { LOCALE_INFO } from "./locales.ts";
import type { Locale } from "./locales.ts";

/** "1 234" / "1,234": an integer count in the locale's grouping. */
export function formatCount(locale: Locale, value: number | bigint): string {
  return new Intl.NumberFormat(LOCALE_INFO[locale].numberLocale, { maximumFractionDigits: 0 }).format(value);
}

/**
 * Malagasy ariary, display only: "540 000 Ar" in every language (the format, never a rate; spec §3.9). MGA has no
 * minor unit in use, so the value is rounded to whole ariary. Accepts a decimal string to avoid binary floats.
 */
export function formatAriary(value: number | bigint | `${number}`): string {
  // Grouped the Malagasy way (spaces) whatever the interface language, then "Ar" after a no-break space: it is how
  // prices are written in Madagascar.
  const digits = new Intl.NumberFormat("fr-MG", { maximumFractionDigits: 0, useGrouping: true }).format(value as Intl.StringNumericLiteral);
  return `${digits}\u00a0Ar`;
}

export interface DateOptions {
  /** `medium` date and `short` time by default. */
  readonly dateStyle?: "full" | "long" | "medium" | "short";
  readonly timeStyle?: "full" | "long" | "medium" | "short";
  /** IANA zone; the device's own by default (tests pin "UTC"). */
  readonly timeZone?: string;
}

/** A unix time in seconds, as a date and time in the locale. */
export function formatDateTime(locale: Locale, unixSeconds: number | bigint, options: DateOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Intl.DateTimeFormat(LOCALE_INFO[locale].dateLocale, options).format(new Date(Number(unixSeconds) * 1000));
}

/** "in 7 days", "2 hours ago": the largest unit that is at least 1, from `now` (both unix seconds). */
export function formatRelative(locale: Locale, unixSeconds: number | bigint, now: number | bigint): string {
  const delta = Number(unixSeconds) - Number(now);
  const abs = Math.abs(delta);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(LOCALE_INFO[locale].dateLocale, { numeric: "auto" });
  for (const [unit, seconds] of units) {
    if (abs >= seconds) {
      return format.format(Math.trunc(delta / seconds), unit);
    }
  }
  return format.format(Math.trunc(delta), "second");
}

/** A duration in seconds with one decimal, "0.8 s" / "0,8 s": the till's "settled in N.N s". */
export function formatSeconds(locale: Locale, seconds: number): string {
  const n = new Intl.NumberFormat(LOCALE_INFO[locale].numberLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(seconds);
  return `${n}\u00a0s`;
}
