// SPDX-License-Identifier: MIT
/**
 * The local-currency estimate under dollar amounts (PAYLINK-V2-SPEC §2.1 T1 "MGA estimate label", §3.8 item 4):
 * "≈ 113 568 Ar · estimate · rate of 8 Oct 2026". Display only: the rate never enters an amount, a signature or a
 * comparison. It comes from the same-origin `/fx.json` snapshot (scripts/fx.ts: fawazahmed0/exchange-api, CC0-1.0),
 * validated on read; a missing or malformed file simply hides the label.
 *
 * Only tokens that are digital US dollars carry the estimate; the arithmetic is integer (bigint) so no binary float
 * ever touches an amount.
 */
import type { Token } from "@paylink/chains";
import { formatAriary, formatDateTime } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";

export interface FxSnapshot {
  readonly date: string;
  /** Ariary per US dollar, exact decimal string. */
  readonly mga: string;
  readonly source: string;
}

/** Digital-dollar tokens of the registry (USD stablecoins): the only ones an ariary estimate makes sense for. */
const DOLLAR_SYMBOLS = new Set(["USDC", "AUSD", "MUSD"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^(0|[1-9]\d{0,9})(\.\d{1,12})?$/;

export function parseFx(value: unknown): FxSnapshot | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as { version?: unknown; base?: unknown; date?: unknown; rates?: { MGA?: unknown } | null; source?: { name?: unknown; license?: unknown } | null };
  const mga = v.rates?.MGA;
  const name = v.source?.name;
  if (v.version !== 1 || v.base !== "USD" || typeof v.date !== "string" || !DATE.test(v.date) || typeof mga !== "string" || !RATE.test(mga) || /^0(\.0*)?$/.test(mga)) {
    return null;
  }
  if (typeof name !== "string" || name.length > 80 || v.source?.license !== "CC0-1.0") {
    return null;
  }
  return { date: v.date, mga, source: name };
}

/** Fetches `/fx.json` (same origin, never cached by the service worker); `null` when absent or malformed. */
export async function loadFx(fetcher: typeof fetch = (...args) => fetch(...args)): Promise<FxSnapshot | null> {
  try {
    const response = await fetcher("/fx.json", { cache: "no-cache", credentials: "same-origin", headers: { accept: "application/json" } });
    return response.ok ? parseFx(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Whole ariary for `amount` base units of a dollar token, rounded half up; `null` for other tokens. */
export function ariaryOf(amount: bigint, token: Pick<Token, "symbol" | "decimals">, fx: FxSnapshot): bigint | null {
  if (!DOLLAR_SYMBOLS.has(token.symbol) || amount < 0n) {
    return null;
  }
  const [whole = "0", fraction = ""] = fx.mga.split(".");
  const rate = BigInt(`${whole}${fraction}`);
  const denominator = 10n ** BigInt(token.decimals + fraction.length);
  return (amount * rate * 2n + denominator) / (2n * denominator);
}

/** The label text, e.g. "≈ 113 568 Ar · estimate · rate of 8 Oct 2026", or `null` when no estimate applies. */
export function ariaryLabel(
  amount: bigint,
  token: Pick<Token, "symbol" | "decimals">,
  fx: FxSnapshot | null,
  locale: Locale,
  phrase: (params: { amount: string; date: string }) => string,
): string | null {
  if (fx === null || amount === 0n) {
    return null;
  }
  const ariary = ariaryOf(amount, token, fx);
  if (ariary === null) {
    return null;
  }
  const date = formatDateTime(locale, Date.parse(`${fx.date}T00:00:00Z`) / 1000, { dateStyle: "medium", timeZone: "UTC" });
  return phrase({ amount: formatAriary(ariary), date });
}
