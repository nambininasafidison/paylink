// SPDX-License-Identifier: MIT
/**
 * Feature catalogues (`src/locales/<feature>.<locale>.json`): keys that only some pages use. Each is a chunk of its
 * own in every language, English included, loaded by those pages through `featureTranslator`, so the catalogue every
 * page carries does not grow with them and the pages that do not use them, the pay route first (PAYLINK-V2-SPEC §4.4:
 * 110 kB of gzipped JavaScript), never download them. This module is separate from `messages.ts` so that its code,
 * too, is only in the bundles of the pages that use it.
 */
import type { Feature, FeatureKey } from "./generated/messages.ts";
import type { Locale } from "./locales.ts";
import { EN, loadMessages } from "./messages.ts";
import { createTranslator } from "./translator.ts";
import type { Translator, TranslatorOptions } from "./translator.ts";

/** A feature catalogue in one language. */
export type FeatureMessages = Readonly<Partial<Record<FeatureKey, string>>>;

/** Each feature catalogue in each language: a chunk of its own. */
const FEATURE_CHUNKS: Readonly<Record<Feature, Readonly<Record<Locale, () => Promise<{ readonly default: FeatureMessages }>>>>> = {
  books: {
    en: async () => await import("./locales/books.en.json", { with: { type: "json" } }),
    fr: async () => await import("./locales/books.fr.json", { with: { type: "json" } }),
    mg: async () => await import("./locales/books.mg.json", { with: { type: "json" } }),
  },
  history: {
    en: async () => await import("./locales/history.en.json", { with: { type: "json" } }),
    fr: async () => await import("./locales/history.fr.json", { with: { type: "json" } }),
    mg: async () => await import("./locales/history.mg.json", { with: { type: "json" } }),
  },
};

/** A feature's catalogue in one language. */
export async function loadFeature(feature: Feature, locale: Locale): Promise<FeatureMessages> {
  return (await FEATURE_CHUNKS[feature][locale]()).default;
}

/**
 * The translator of a page that uses `feature`: the language's messages and the feature's, with English (core and
 * feature) for anything a translation lacks.
 */
export async function featureTranslator(locale: Locale, feature: Feature, options: Omit<TranslatorOptions, "fallback"> = {}): Promise<Translator> {
  const [messages, own, ownEnglish] = await Promise.all([loadMessages(locale), loadFeature(feature, locale), loadFeature(feature, "en")]);
  return createTranslator(locale, { ...messages, ...own }, { ...options, fallback: { ...EN, ...ownEnglish } });
}
