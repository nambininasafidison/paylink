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

/*
 * Malagasy dates. Chromium's ICU (Chrome, Android WebView) ships no `mg` date data: `Intl.DateTimeFormat("mg")` falls
 * back to US English ("Oct 15, 2026, 9:04 PM"), while Node's full ICU answers in Malagasy, so a Node test cannot see
 * the problem. Malagasy dates are therefore written the same way on every runtime: the order, separators and 24-hour
 * clock of `fr-MG` (how dates are written in Madagascar), with the Malagasy month and weekday names of CLDR `mg`.
 * The names below await the founder's review with the catalogue (mg.review.json, `pendingFormats`).
 */
const MG_MONTHS = ["Janoary", "Febroary", "Martsa", "Aprily", "Mey", "Jona", "Jolay", "Aogositra", "Septambra", "Oktobra", "Novambra", "Desambra"] as const;
const MG_MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mey", "Jon", "Jol", "Aog", "Sep", "Okt", "Nov", "Des"] as const;
const MG_WEEKDAYS = ["Alahady", "Alatsinainy", "Talata", "Alarobia", "Alakamisy", "Zoma", "Asabotsy"] as const;
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function malagasyDateTime(date: Date, options: DateOptions): string {
  const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone };
  const month = Number(new Intl.DateTimeFormat("en-US", { ...zone, month: "numeric" }).format(date)) - 1;
  const weekday = EN_WEEKDAYS.indexOf(new Intl.DateTimeFormat("en-US", { ...zone, weekday: "short" }).format(date) as (typeof EN_WEEKDAYS)[number]);
  return new Intl.DateTimeFormat("fr-MG", options)
    .formatToParts(date)
    .map((part) => {
      if (part.type === "month" && !/^\d+$/.test(part.value)) {
        return (options.dateStyle === "medium" ? MG_MONTHS_SHORT : MG_MONTHS)[month] ?? part.value;
      }
      if (part.type === "weekday") {
        return MG_WEEKDAYS[weekday] ?? part.value;
      }
      return part.value;
    })
    .join("");
}

/** A unix time in seconds, as a date and time in the locale. */
export function formatDateTime(locale: Locale, unixSeconds: number | bigint, options: DateOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (locale === "mg") {
    return malagasyDateTime(date, options);
  }
  return new Intl.DateTimeFormat(LOCALE_INFO[locale].dateLocale, options).format(date);
}

/** Malagasy relative times ("afaka 7 andro", "2 ora lasa"): no runtime ships them (Chromium has no `mg` data). */
const MG_UNITS: Readonly<Record<"day" | "hour" | "minute" | "second", string>> = { day: "andro", hour: "ora", minute: "minitra", second: "segondra" };

/** "in 7 days", "2 hours ago": the largest unit that is at least 1, from `now` (both unix seconds). */
export function formatRelative(locale: Locale, unixSeconds: number | bigint, now: number | bigint): string {
  const delta = Number(unixSeconds) - Number(now);
  const abs = Math.abs(delta);
  const units: ["day" | "hour" | "minute", number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  let unit: "day" | "hour" | "minute" | "second" = "second";
  let value = Math.trunc(delta);
  for (const [name, seconds] of units) {
    if (abs >= seconds) {
      unit = name;
      value = Math.trunc(delta / seconds);
      break;
    }
  }
  if (locale === "mg") {
    const count = formatCount("mg", Math.abs(value));
    return value >= 0 ? `afaka ${count} ${MG_UNITS[unit]}` : `${count} ${MG_UNITS[unit]} lasa`;
  }
  return new Intl.RelativeTimeFormat(LOCALE_INFO[locale].dateLocale, { numeric: "auto" }).format(value, unit);
}

/** A duration in seconds with one decimal, "0.8 s" / "0,8 s": the till's "settled in N.N s". */
export function formatSeconds(locale: Locale, seconds: number): string {
  const n = new Intl.NumberFormat(LOCALE_INFO[locale].numberLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(seconds);
  return `${n}\u00a0s`;
}
