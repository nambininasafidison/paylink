// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { formatAriary, formatCount, formatDateTime, formatRelative, formatSeconds, LOCALE_INFO, negotiateLocale } from "../src/index.ts";

/** Intl uses narrow and ordinary no-break spaces; compare their visible form. */
const visible = (s: string): string => s.replace(/[\u00a0\u202f]/g, " ");

describe("formatting", () => {
  it("writes ariary the Malagasy way in every language", () => {
    expect(visible(formatAriary(540_000))).toBe("540 000 Ar");
    expect(visible(formatAriary("1234567.6"))).toBe("1 234 568 Ar");
    expect(visible(formatAriary(12n))).toBe("12 Ar");
  });

  it("groups counts per language, Malagasy as in Madagascar", () => {
    expect(formatCount("en", 1234)).toBe("1,234");
    expect(visible(formatCount("fr", 1234))).toBe("1 234");
    expect(visible(formatCount("mg", 1234n))).toBe("1 234");
  });

  it("formats dates, relative times and seconds", () => {
    const options = { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" } as const;
    expect(formatDateTime("en", 1_760_000_000, options)).toBe("Oct 9, 2025, 8:53 AM");
    expect(visible(formatDateTime("fr", 1_760_000_000n, options))).toBe("9 oct. 2025, 08:53");
    // Malagasy: the same output on every runtime (Chromium has no `mg` date data and fell back to US English).
    expect(visible(formatDateTime("mg", 1_760_000_000, options))).toBe("9 Okt 2025, 08:53");
    expect(visible(formatDateTime("mg", 1_760_000_000, { dateStyle: "long", timeZone: "UTC" }))).toBe("9 Oktobra 2025");
    expect(visible(formatDateTime("mg", 1_760_000_000, { dateStyle: "full", timeZone: "UTC" }))).toBe("Alakamisy 9 Oktobra 2025");
    expect(formatDateTime("mg", 1_760_000_000, { timeStyle: "medium", timeZone: "UTC" })).toBe("08:53:20");
    expect(formatDateTime("mg", 1_760_000_000, { dateStyle: "short", timeZone: "UTC" })).toBe("09/10/2025");
    // Every month name, at the first of each month of 2026 (UTC).
    const firsts = Array.from({ length: 12 }, (_, m) => Date.UTC(2026, m, 1) / 1000);
    expect(firsts.map((t) => formatDateTime("mg", t, { dateStyle: "medium", timeZone: "UTC" }).split(" ")[1])).toEqual(["Jan", "Feb", "Mar", "Apr", "Mey", "Jon", "Jol", "Aog", "Sep", "Okt", "Nov", "Des"]);
    // A week from Sunday 4 January 2026.
    const week = Array.from({ length: 7 }, (_, d) => Date.UTC(2026, 0, 4 + d) / 1000);
    expect(week.map((t) => formatDateTime("mg", t, { dateStyle: "full", timeZone: "UTC" }).split(" ")[0])).toEqual(["Alahady", "Alatsinainy", "Talata", "Alarobia", "Alakamisy", "Zoma", "Asabotsy"]);
    expect(formatDateTime("mg", 1_760_000_000, options)).not.toMatch(/AM|PM|Oct/);
    expect(formatDateTime("en", 0, { dateStyle: "short", timeZone: "UTC" })).toBe("1/1/70");
    expect(formatRelative("en", 1000 + 7 * 86_400, 1000)).toBe("in 7 days");
    expect(formatRelative("en", 1000 - 2 * 3600, 1000)).toBe("2 hours ago");
    expect(formatRelative("en", 1300, 1000)).toBe("in 5 minutes");
    expect(formatRelative("en", 1010, 1000)).toBe("in 10 seconds");
    expect(formatRelative("mg", 1000 + 7 * 86_400, 1000)).toBe("afaka 7 andro");
    expect(formatRelative("mg", 1000 - 2 * 3600, 1000)).toBe("2 ora lasa");
    expect(visible(formatRelative("fr", 1000 + 7 * 86_400, 1000))).toBe("dans 7 jours");
    expect(visible(formatSeconds("en", 0.84))).toBe("0.8 s");
    expect(visible(formatSeconds("fr", 1.26))).toBe("1,3 s");
  });

  it("negotiates the language by primary subtag", () => {
    expect(negotiateLocale(["mg-MG", "fr-FR"])).toBe("mg");
    expect(negotiateLocale(["de-DE", "fr_CA"])).toBe("fr");
    expect(negotiateLocale(["de"])).toBe("en");
    expect(negotiateLocale([])).toBe("en");
    expect(LOCALE_INFO.mg.numberLocale).toBe("fr-MG");
  });
});
