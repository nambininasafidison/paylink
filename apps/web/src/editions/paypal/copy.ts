// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's words (ADR 0008, ADR 0018): its catalogue (`@paylink/i18n` edition catalogue `paypal`) is merged
 * into the core one, so its pages can say `paypal.*` keys. `PAYPAL_COPY` rewords core sentences that would be untrue in
 * this edition, as the Mezo edition does; it is empty until the web edition workstream writes the edition's copy.
 *
 * Only the PayPal build calls this (boot.ts, behind the build-time edition constant), so the other editions neither load
 * the catalogue nor carry this code.
 *
 * Owner: web edition workstream.
 */
import { createTranslator, EN, loadEditionMessages } from "@paylink/i18n";
import type { EditionKey, EditionMessages, Locale, MessageKey, Messages, Translator } from "@paylink/i18n";

/** Core keys the PayPal edition rewords: core key → PayPal key, with the same placeholders. */
export const PAYPAL_COPY = {} as const satisfies Partial<Record<MessageKey, EditionKey>>;

/** The PayPal catalogue of one language and of English (the fallback), loaded together. */
export interface PaypalCatalogues {
  readonly own: EditionMessages;
  readonly english: EditionMessages;
}

/** Starts loading the PayPal catalogue (two small same-origin chunks), alongside the core one. */
export async function loadPaypalCopy(locale: Locale): Promise<PaypalCatalogues> {
  const [own, english] = await Promise.all([loadEditionMessages("paypal", locale), loadEditionMessages("paypal", "en")]);
  return { own, english };
}

/** `messages` with the PayPal catalogue added and the core sentences of `PAYPAL_COPY` reworded from it. */
export function withPaypalCopy(messages: Messages, own: EditionMessages): Messages {
  const reworded: Record<string, string> = {};
  for (const [core, key] of Object.entries<EditionKey>(PAYPAL_COPY)) {
    const text = own[key];
    if (text !== undefined) {
      reworded[core] = text;
    }
  }
  return { ...messages, ...own, ...reworded };
}

/** The PayPal edition's translator: the language's messages and English, each with the PayPal copy. */
export function paypalTranslator(locale: Locale, messages: Messages, copy: PaypalCatalogues): Translator {
  return createTranslator(locale, withPaypalCopy(messages, copy.own), { fallback: withPaypalCopy(EN, copy.english) });
}
