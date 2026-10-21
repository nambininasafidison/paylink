// SPDX-License-Identifier: MIT
/**
 * Edition catalogues (`src/locales/<edition>.<locale>.json`, ADR 0008): the copy of one edition, such as the Mezo
 * edition's words for MUSD and its BTC network fee, or the PayPal edition's desk (ADR 0018). Each catalogue is a chunk of its own in every language, English
 * included, and only the edition's own build calls `loadEditionMessages` (behind its build-time constant), so the other
 * editions neither download these chunks nor change by a byte. This module is separate from `features.ts` for the same
 * reason: pages of other editions that load a feature catalogue never carry this code.
 */
import type { EditionCatalogue, EditionKey } from "./generated/messages.ts";
import type { Locale } from "./locales.ts";

/** An edition catalogue in one language. */
export type EditionMessages = Readonly<Partial<Record<EditionKey, string>>>;

/** Each edition catalogue in each language: a chunk of its own. */
const EDITION_CHUNKS: Readonly<Record<EditionCatalogue, Readonly<Record<Locale, () => Promise<{ readonly default: EditionMessages }>>>>> = {
  mezo: {
    en: async () => await import("./locales/mezo.en.json", { with: { type: "json" } }),
    fr: async () => await import("./locales/mezo.fr.json", { with: { type: "json" } }),
    mg: async () => await import("./locales/mezo.mg.json", { with: { type: "json" } }),
  },
  paypal: {
    en: async () => await import("./locales/paypal.en.json", { with: { type: "json" } }),
    fr: async () => await import("./locales/paypal.fr.json", { with: { type: "json" } }),
    mg: async () => await import("./locales/paypal.mg.json", { with: { type: "json" } }),
  },
};

/** An edition's catalogue in one language. */
export async function loadEditionMessages(edition: EditionCatalogue, locale: Locale): Promise<EditionMessages> {
  return (await EDITION_CHUNKS[edition][locale]()).default;
}
