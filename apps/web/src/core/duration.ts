// SPDX-License-Identifier: MIT
/**
 * A coarse duration in words ("7 minutes", "2 hours", "3 days") in the page's language, for history windows and the
 * ledger's time to get paid. One unit, rounded: these are orders of magnitude, never amounts. The words are in the
 * `history` feature catalogue: pass the page's `featureTranslator(locale, "history")`.
 */
import type { Translator } from "@paylink/i18n";

export function durationText(i18n: Pick<Translator, "plural">, seconds: bigint | number): string {
  const s = Math.max(0, Number(seconds));
  if (s < 90) {
    return i18n.plural("history.duration.seconds", Math.round(s), {});
  }
  if (s < 90 * 60) {
    return i18n.plural("history.duration.minutes", Math.round(s / 60), {});
  }
  if (s < 48 * 3600) {
    return i18n.plural("history.duration.hours", Math.round(s / 3600), {});
  }
  return i18n.plural("history.duration.days", Math.round(s / 86_400), {});
}
