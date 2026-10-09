// SPDX-License-Identifier: MIT
/**
 * Completeness gate (PAYLINK-V2-SPEC §3.9, §4.1): French and Malagasy carry exactly the English keys, every message
 * keeps the same named placeholders and the same emphasis, no message is empty or holds markup, every key the SDK can
 * produce is translated, and the generated key types are up to date. Feature catalogues (`<feature>.<locale>.json`)
 * are held to the same rules as the core catalogue, and hold only their own keys.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SDK_I18N_KEYS } from "@paylink/sdk";
import { describe, expect, it } from "vitest";
import { FEATURES, render } from "../scripts/generate.ts";
import { placeholders } from "../src/interpolate.ts";
import { LOCALES } from "../src/locales.ts";

const dir = join(import.meta.dirname, "../src/locales");
const load = (name: string): Record<string, string> => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Record<string, string>;
const core = Object.fromEntries(LOCALES.map((locale) => [locale, load(locale)])) as Record<(typeof LOCALES)[number], Record<string, string>>;
const features = Object.fromEntries(FEATURES.map((feature) => [feature, Object.fromEntries(LOCALES.map((locale) => [locale, load(`${feature}.${locale}`)]))])) as Record<
  (typeof FEATURES)[number],
  Record<(typeof LOCALES)[number], Record<string, string>>
>;
/** Each language's whole catalogue: the core one, then each feature's. */
const catalogues = Object.fromEntries(LOCALES.map((locale) => [locale, Object.assign({}, core[locale], ...FEATURES.map((f) => features[f][locale]))])) as Record<(typeof LOCALES)[number], Record<string, string>>;
const en = catalogues.en;
const keys = Object.keys(en);

/** Placeholders the SDK guarantees in its error parameters; messages for SDK keys may use only these. */
const SDK_PLACEHOLDERS: Readonly<Record<string, readonly string[]>> = {
  "error.input.amountPrecision": ["decimals"],
  "error.contract.soldOut": ["maxPayments"],
  "error.token.reverted": ["reason"],
};

describe("catalogues", () => {
  for (const locale of LOCALES) {
    it(`${locale} has exactly the English keys`, () => {
      expect(Object.keys(catalogues[locale]).sort()).toEqual([...keys].sort());
    });

    it(`${locale} keeps every placeholder and emphasis`, () => {
      for (const key of keys) {
        const message = catalogues[locale][key] ?? "";
        expect(placeholders(message).sort(), `${locale} ${key}`).toEqual(placeholders(en[key] ?? "").sort());
        expect(message.split("*").length, `${locale} ${key} emphasis`).toBe((en[key] ?? "").split("*").length);
        expect(message.split("*").length % 2, `${locale} ${key} balanced emphasis`).toBe(1);
      }
    });

    it(`${locale} messages are plain, non-empty sentences`, () => {
      for (const [key, message] of Object.entries(catalogues[locale])) {
        expect(message.trim(), key).not.toBe("");
        expect(message, key).toBe(message.trim());
        expect(message, key).not.toMatch(/[<>]/);
        // Braces only as {name}.
        expect(message.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, ""), key).not.toMatch(/[{}]/);
        expect(message, key).not.toMatch(/\s{2,}/);
      }
    });
  }

  it("translates every key the SDK can produce, with the parameters the SDK guarantees", () => {
    for (const key of SDK_I18N_KEYS) {
      expect(keys, key).toContain(key);
      expect(placeholders(en[key] ?? ""), key).toEqual(SDK_PLACEHOLDERS[key] ?? []);
    }
  });

  it("plural families have `.other` in every language", () => {
    // A family is a base with an `.other` variant in English (the same rule as scripts/generate.ts).
    const families = new Set(keys.filter((k) => k.endsWith(".other")).map((k) => k.slice(0, -".other".length)));
    expect(families.size).toBeGreaterThan(0);
    for (const family of families) {
      for (const locale of LOCALES) {
        expect(catalogues[locale][`${family}.other`], `${locale} ${family}`).toBeDefined();
      }
    }
  });

  it("French uses typographic spaces before high punctuation", () => {
    for (const [key, message] of Object.entries(catalogues.fr)) {
      expect(message, key).not.toMatch(/ [:;?!»]/);
    }
  });

  it("keeps the generated key types in step with en.json and the feature catalogues", () => {
    const generated = readFileSync(join(import.meta.dirname, "../src/generated/messages.ts"), "utf8");
    expect(generated).toBe(render(en, Object.fromEntries(FEATURES.map((f) => [f, Object.keys(features[f].en)]))));
  });

  it("keeps each feature's keys in its own catalogue, in every language, and out of the core one", () => {
    for (const feature of FEATURES) {
      const own = Object.keys(features[feature].en);
      expect(own.length, feature).toBeGreaterThan(0);
      for (const locale of LOCALES) {
        expect(Object.keys(features[feature][locale]).sort(), `${feature}.${locale}`).toEqual([...own].sort());
        for (const key of own) {
          expect(key.startsWith(`${feature}.`), key).toBe(true);
          expect(Object.hasOwn(core[locale], key), `${locale} ${key}`).toBe(false);
        }
      }
    }
  });

  it("lists only existing keys as awaiting the founder's Malagasy review", () => {
    const review = JSON.parse(readFileSync(join(dir, "mg.review.json"), "utf8")) as { pending: string[]; reviewer: string };
    expect(review.reviewer).toBe("nambininasafidison");
    for (const key of review.pending) {
      expect(keys, key).toContain(key);
    }
    expect(new Set(review.pending).size).toBe(review.pending.length);
  });
});
