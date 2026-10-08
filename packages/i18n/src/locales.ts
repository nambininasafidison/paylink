// SPDX-License-Identifier: MIT
/**
 * The three interface languages (PAYLINK-V2-SPEC §3.9) and how they map to `Intl` locales.
 *
 * Malagasy has CLDR plural rules and month names, but no Malagasy number symbols in CLDR (Intl falls back to the
 * root's "540,000"). Madagascar writes numbers the French way ("540 000 Ar", "25,50"), so Malagasy numbers are
 * formatted with `fr-MG` while plurals use `mg`. Dates do not go through `dateLocale` for Malagasy: Chromium ships no
 * `mg` date data and would answer in US English, so `format.ts` writes them on `fr-MG` patterns with Malagasy names.
 */

export const LOCALES = ["en", "fr", "mg"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export interface LocaleInfo {
  /** The language's own name, shown in the language switch. */
  readonly nativeName: string;
  /** Two-letter label for the compact switch. */
  readonly short: string;
  /** BCP 47 tag for `lang` attributes. */
  readonly tag: string;
  /** `Intl` locale for numbers and amounts. */
  readonly numberLocale: string;
  /** `Intl` locale for dates, times and plural rules. */
  readonly dateLocale: string;
  /** The decimal separator people type (amount inputs accept both, this one is suggested). */
  readonly decimalSeparator: "." | ",";
}

export const LOCALE_INFO: Readonly<Record<Locale, LocaleInfo>> = {
  en: { nativeName: "English", short: "EN", tag: "en", numberLocale: "en", dateLocale: "en", decimalSeparator: "." },
  fr: { nativeName: "Français", short: "FR", tag: "fr", numberLocale: "fr-MG", dateLocale: "fr-MG", decimalSeparator: "," },
  mg: { nativeName: "Malagasy", short: "MG", tag: "mg", numberLocale: "fr-MG", dateLocale: "mg", decimalSeparator: "," },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The first supported language in the user's preference list (`navigator.languages`), by primary subtag:
 * `fr-CA` → `fr`, `mg-MG` → `mg`. English when nothing matches.
 */
export function negotiateLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    const primary = preference.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) {
      return primary;
    }
  }
  return DEFAULT_LOCALE;
}
