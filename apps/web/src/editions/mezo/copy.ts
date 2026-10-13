// SPDX-License-Identifier: MIT
/**
 * The Mezo edition's words (ADR 0008): its catalogue (`@paylink/i18n` edition catalogue `mezo`) is merged into the
 * core one, and the core sentences that would be untrue on Mezo are reworded from it: the dollar is MUSD, and the
 * payer's wallet always pays the network fee, in BTC (no relayer can carry a MUSD payment, docs/research/mezo.md §11).
 *
 * Only the Mezo build calls this (boot.ts, behind the build-time edition constant), so the other editions neither load
 * the catalogue nor carry this code.
 */
import { createTranslator, EN, loadEditionMessages } from "@paylink/i18n";
import type { EditionKey, EditionMessages, Locale, MessageKey, Messages, Translator } from "@paylink/i18n";

/** Core keys the Mezo edition rewords: core key → Mezo key, with the same placeholders (test/mezo.test.ts). */
export const MEZO_COPY = {
  "create.kicker": "mezo.create.kicker",
  "create.h1b": "mezo.create.h1b",
  "create.lede": "mezo.create.lede",
  "create.step3.text": "mezo.create.step3",
  "pay.voice.bill.lede": "mezo.pay.billLede",
  "pay.voice.open.lede": "mezo.pay.openLede",
  "pay.step2.text": "mezo.pay.step2",
  "pay.step2.pending": "mezo.pay.step2",
  "pay.assure": "mezo.pay.assure",
  "pay.assurePending": "mezo.pay.assure",
  "pay.route.needsGas": "mezo.pay.needsBtc",
  "pay.waitRelayer": "mezo.pay.waitBtc",
  "pay.retryRelayer": "mezo.pay.checkBtc",
  "ledger.cancel.noGas": "mezo.ledger.cancelNoGas",
  "wallet.pick.lede": "mezo.wallet.lede",
  "wallet.pick.none": "mezo.wallet.none",
} as const satisfies Partial<Record<MessageKey, EditionKey>>;

/** The Mezo catalogue of one language and of English (the fallback), loaded together. */
export interface MezoCatalogues {
  readonly own: EditionMessages;
  readonly english: EditionMessages;
}

/** Starts loading the Mezo catalogue (two small same-origin chunks), alongside the core one. */
export async function loadMezoCopy(locale: Locale): Promise<MezoCatalogues> {
  const [own, english] = await Promise.all([loadEditionMessages("mezo", locale), loadEditionMessages("mezo", "en")]);
  return { own, english };
}

/** `messages` with the Mezo catalogue added and the core sentences of `MEZO_COPY` reworded from it. */
export function withMezoCopy(messages: Messages, own: EditionMessages): Messages {
  const reworded: Record<string, string> = {};
  for (const [core, key] of Object.entries(MEZO_COPY)) {
    const text = own[key];
    if (text !== undefined) {
      reworded[core] = text;
    }
  }
  return { ...messages, ...own, ...reworded };
}

/** The Mezo edition's translator: the language's messages and English, each with the Mezo copy. */
export function mezoTranslator(locale: Locale, messages: Messages, copy: MezoCatalogues): Translator {
  return createTranslator(locale, withMezoCopy(messages, copy.own), { fallback: withMezoCopy(EN, copy.english) });
}
