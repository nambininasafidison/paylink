// SPDX-License-Identifier: MIT
/**
 * Message catalogues. English ships with the code (it is also the fallback); French and Malagasy are separate chunks
 * loaded when chosen. The JSON files are the source translators edit; `src/generated/messages.ts` derives the key and
 * placeholder types from en.json (`pnpm --filter @paylink/i18n run generate`).
 */
import en from "./locales/en.json" with { type: "json" };
import type { Locale } from "./locales.ts";
import type { Messages } from "./translator.ts";

export const EN: Messages = en;

/** The catalogue of a language. */
export async function loadMessages(locale: Locale): Promise<Messages> {
  switch (locale) {
    case "en":
      return EN;
    case "fr":
      return (await import("./locales/fr.json", { with: { type: "json" } })).default;
    case "mg":
      return (await import("./locales/mg.json", { with: { type: "json" } })).default;
  }
}
