// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's words (ADR 0008, ADR 0018): its catalogue (`@paylink/i18n` edition catalogue `paypal`) is merged
 * into the core one, so its pages can say `paypal.*` keys. `PAYPAL_COPY` rewords the core sentences that would be untrue
 * or silent about PayPal in this edition, as the Mezo edition does: the home leads with "one invoice, paid on PayPal or
 * in dollars on chain"; the pay page, the printed card and the till name both rails; the ledger's totals say they are
 * the chain's; Status says its PayPal rows are the API's latest reads, not live ones (test/paypal/pages.test.ts).
 *
 * Only the PayPal build calls this (boot.ts, behind the build-time edition constant), so the other editions neither load
 * the catalogue nor carry this code.
 *
 * Owner: web edition workstream.
 */
import { createTranslator, EN, loadEditionMessages } from "@paylink/i18n";
import type { EditionKey, EditionMessages, Locale, MessageKey, Messages, Translator } from "@paylink/i18n";

/** Core keys the PayPal edition rewords: core key → PayPal key, with the same placeholders. */
export const PAYPAL_COPY = {
  "create.kicker": "paypal.copy.createKicker",
  "create.h1a": "paypal.copy.createH1a",
  "create.h1b": "paypal.copy.createH1b",
  "create.lede": "paypal.copy.createLede",
  "create.step3.text": "paypal.copy.createStep3",
  "pay.voice.bill.lede": "paypal.copy.payBillLede",
  "pay.step2.text": "paypal.copy.payStep2",
  "pay.step2.pending": "paypal.copy.payStep2",
  "ticket.scanSub": "paypal.copy.ticketScanSub",
  "till.lede": "paypal.copy.tillLede",
  "status.lede": "paypal.copy.statusLede",
  "ledger.lede": "paypal.copy.ledgerLede",
  "ledger.tally": "paypal.copy.ledgerTally",
  "ledger.footing": "paypal.copy.ledgerFooting",
} as const satisfies Partial<Record<MessageKey, EditionKey>>;

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
