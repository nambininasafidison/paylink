// SPDX-License-Identifier: MIT
/**
 * "Paste the client's message" on the Mezo create terminal (Wave 2): the amount and how long the link stays valid,
 * read from a client's message by fixed rules, so a freelancer does not retype them. No model reads the message (the
 * PayPal edition's AI drafting assistant runs on its API Worker, which only answers that edition's origins and
 * Sepolia sessions; see docs/submissions/mezo.md, Wave 2). Nothing is signed or sent: the form is filled, the
 * freelancer checks it and signs as before.
 *
 * - Amount: the first amount in MUSD or dollars (MUSD is a dollar), with the same number rules as "Was I really
 *   paid?" (`verify.ts`). An amount in BTC, euros or ariary is not converted: the notice says so and nothing is filled.
 * - Due date: an ISO date, a day/month(/year) date (day first, as written in Madagascar and France), a day and a month
 *   name in English, French or Malagasy, "in N days/weeks/months" (EN, FR, MG), tomorrow, a weekday's name ("by
 *   Friday", "vendredi", "zoma": its next occurrence after today, 1 to 7 days away, "next Friday" included), next week,
 *   today. The link's validity becomes the shortest choice that covers it (1, 7 or 30 days); a date further away or
 *   past is left alone.
 */
import { LOCALE_INFO } from "@paylink/i18n";
import { formatDateTime } from "@paylink/i18n";
import type { App } from "../../app/context.ts";
import { h } from "../../ui/h.ts";
import { claimedAmounts, CHECK_MAX_TEXT } from "./verify.ts";
import type { ClaimedAmount } from "./verify.ts";

export type ValidityChoice = "1d" | "7d" | "30d";

export interface MessageDraft {
  /** The amount to invoice, in MUSD (from MUSD or dollars), or `null`. */
  readonly amount: ClaimedAmount | null;
  /** An amount the terminal cannot invoice as is (BTC, euros, ariary), as written, when no MUSD amount was found. */
  readonly unsupported: string | null;
  /** The due date (UTC midnight) and the whole days from today to it. */
  readonly due: { readonly date: Date; readonly days: number } | null;
  /** The validity that covers the due date, or `null` (none found, past, or beyond 30 days). */
  readonly validity: ValidityChoice | null;
}

const DAY = 86_400_000;

const MONTHS: Readonly<Record<string, number>> = Object.fromEntries(
  [
    ["january jan janvier janv janoary", 0],
    ["february feb février fevrier févr fevr febroary", 1],
    ["march mar mars martsa", 2],
    ["april apr avril avr aprily", 3],
    ["may mai mey", 4],
    ["june jun juin jona", 5],
    ["july jul juillet juil jolay", 6],
    ["august aug août aout aogositra", 7],
    ["september sep sept septembre septambra", 8],
    ["october oct octobre oktobra", 9],
    ["november nov novembre novambra", 10],
    ["december dec décembre decembre déc desambra", 11],
  ].flatMap(([names, month]) => String(names).split(" ").map((name) => [name, Number(month)] as const)),
);
const MONTH = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");
const ISO = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/u;
const NUMERIC = /(?<![\d.,/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])|(?<![\d.,])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/u;
const DAY_MONTH = new RegExp(String.raw`(?<![\p{L}\p{N}])(\d{1,2})(?:st|nd|rd|th|er)?\s+(?:of\s+)?(${MONTH})\.?(?:\s+(\d{4}))?(?![\p{L}])`, "iu");
const MONTH_DAY = new RegExp(String.raw`(?<![\p{L}\p{N}])(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\p{L}\p{N}])`, "iu");
const RELATIVE = /(?<![\p{L}])(?:in|within|dans|sous|d['’]ici|afaka|ao\s+anatin['’]ny)\s+(\d{1,3}|an?|one|une?|iray)\s+(days?|jours?|andro|weeks?|semaines?|herinandro|months?|mois|volana)(?![\p{L}])/iu;
const TOMORROW = /(?<![\p{L}])(?:tomorrow|demain|rahampitso)(?![\p{L}])/iu;
const NEXT_WEEK = /(?<![\p{L}])(?:next\s+week|semaine\s+prochaine|herinandro\s+(?:ho\s+avy|manaraka))(?![\p{L}])/iu;
const TODAY = /(?<![\p{L}])(?:today|aujourd['’]hui|androany|anio)(?![\p{L}])/iu;
/** Weekday names in full (no abbreviation: "sat", "mar" or "sun" are other words too), 0 = Sunday as in `getUTCDay`. */
const WEEKDAYS: Readonly<Record<string, number>> = Object.fromEntries(
  [
    ["sunday dimanche alahady", 0],
    ["monday lundi alatsinainy", 1],
    ["tuesday mardi talata", 2],
    ["wednesday mercredi alarobia", 3],
    ["thursday jeudi alakamisy", 4],
    ["friday vendredi zoma", 5],
    ["saturday samedi sabotsy", 6],
  ].flatMap(([names, weekday]) => String(names).split(" ").map((name) => [name, Number(weekday)] as const)),
);
const WEEKDAY = new RegExp(String.raw`(?<![\p{L}])(${Object.keys(WEEKDAYS).join("|")})(?![\p{L}])`, "iu");
const NUM = String.raw`\d{1,3}(?:[, \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const OTHER_CURRENCY = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:(?:€|eur|ar|mga)\s?(?:${NUM})|(?:${NUM})\s?(?:€|eur|euros?|ar|ariary|mga))(?![\p{L}\p{N}])`, "iu");

function utcDay(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

/** A date without a year: this year's, or next year's when this year's has passed. */
function nextOccurrence(today: Date, month: number, day: number, year: number | null): Date | null {
  if (year !== null) {
    return utcDay(year, month, day);
  }
  const thisYear = utcDay(today.getUTCFullYear(), month, day);
  return thisYear !== null && thisYear.getTime() >= today.getTime() ? thisYear : utcDay(today.getUTCFullYear() + 1, month, day);
}

const fullYear = (text: string | undefined): number | null => (text === undefined ? null : text.length === 2 ? 2000 + Number(text) : Number(text));

/** The due date a text names (module comment), at UTC midnight, or `null`. */
export function dueDateOf(text: string, now: Date): Date | null {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const iso = ISO.exec(text);
  if (iso !== null) {
    return utcDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }
  const numeric = NUMERIC.exec(text);
  if (numeric !== null) {
    const [day, month, year] = numeric[1] !== undefined ? [numeric[1], numeric[2], numeric[3]] : [numeric[4], numeric[5], numeric[6]];
    const found = nextOccurrence(today, Number(month) - 1, Number(day), fullYear(year));
    if (found !== null) {
      return found;
    }
  }
  const dayMonth = DAY_MONTH.exec(text);
  if (dayMonth !== null) {
    return nextOccurrence(today, MONTHS[(dayMonth[2] ?? "").toLowerCase()] ?? -1, Number(dayMonth[1]), fullYear(dayMonth[3]));
  }
  const monthDay = MONTH_DAY.exec(text);
  if (monthDay !== null) {
    return nextOccurrence(today, MONTHS[(monthDay[1] ?? "").toLowerCase()] ?? -1, Number(monthDay[2]), fullYear(monthDay[3]));
  }
  const relative = RELATIVE.exec(text);
  if (relative !== null) {
    const count = /^\d+$/u.test(relative[1] ?? "") ? Number(relative[1]) : 1;
    const unit = (relative[2] ?? "").toLowerCase();
    if (/^(?:months?|mois|volana)$/u.test(unit)) {
      return utcDay(today.getUTCFullYear(), today.getUTCMonth() + count, today.getUTCDate()) ?? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + count + 1, 0));
    }
    return new Date(today.getTime() + count * (/^(?:weeks?|semaines?|herinandro)$/u.test(unit) ? 7 : 1) * DAY);
  }
  if (TOMORROW.test(text)) {
    return new Date(today.getTime() + DAY);
  }
  const weekday = WEEKDAY.exec(text);
  if (weekday !== null) {
    const target = WEEKDAYS[(weekday[1] ?? "").toLowerCase()] ?? today.getUTCDay();
    // Its next occurrence after today: "by Friday" said on a Friday is a week away.
    return new Date(today.getTime() + ((target - today.getUTCDay() + 6) % 7 + 1) * DAY);
  }
  if (NEXT_WEEK.test(text)) {
    return new Date(today.getTime() + 7 * DAY);
  }
  if (TODAY.test(text)) {
    return today;
  }
  return null;
}

/** The shortest validity that covers `days` from today, or `null` when past or beyond 30 days. */
export function validityFor(days: number): ValidityChoice | null {
  return days < 0 ? null : days <= 1 ? "1d" : days <= 7 ? "7d" : days <= 30 ? "30d" : null;
}

/** What a client's message gives the create form (module comment). */
export function readMessage(text: string, now: Date): MessageDraft {
  const slice = text.slice(0, CHECK_MAX_TEXT);
  const amounts = claimedAmounts(slice);
  const amount = amounts.find((a) => a.unit !== "BTC") ?? null;
  const btc = amounts.find((a) => a.unit === "BTC");
  const unsupported = amount !== null ? null : btc !== undefined ? `${btc.value} BTC` : (OTHER_CURRENCY.exec(slice)?.[0].trim() ?? null);
  const date = dueDateOf(slice, now);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const due = date === null ? null : { date, days: Math.round((date.getTime() - today) / DAY) };
  return { amount, unsupported, due, validity: due === null ? null : validityFor(due.days) };
}

const VALIDITY_KEY = { "1d": "create.expiry.1d", "7d": "create.expiry.7d", "30d": "create.expiry.30d" } as const;

/** What the form takes from the helper. */
export interface PasteTarget {
  /** Puts `amount` (typed as the language writes it) in the amount field. */
  setAmount(amount: string): void;
  /** Selects a validity choice. */
  setValidity(choice: ValidityChoice): void;
}

/**
 * The helper on the Mezo create terminal: a disclosure with a text area and a key; what was filled, and what was not
 * and why, is said under it (a live region).
 */
export function pasteHelper(app: App, target: PasteTarget): HTMLElement {
  const { t } = app.i18n;
  const input = h("textarea", { attrs: { id: "paste-text", rows: "3", maxlength: String(CHECK_MAX_TEXT), spellcheck: "false", "aria-describedby": "paste-hint" } });
  const out = h("ul", { class: "note-list paste-out", attrs: { "aria-live": "polite" } });
  const fill = (): void => {
    const draft = readMessage(input.value, new Date());
    const lines: string[] = [];
    if (draft.amount !== null) {
      const typed = draft.amount.value.replace(".", LOCALE_INFO[app.locale].decimalSeparator);
      target.setAmount(typed);
      lines.push(t("mezo.paste.amount", { amount: typed }));
    } else if (draft.unsupported !== null) {
      lines.push(t("mezo.paste.unsupported", { said: draft.unsupported }));
    } else {
      lines.push(t("mezo.paste.noAmount"));
    }
    if (draft.due !== null) {
      const date = formatDateTime(app.locale, Math.floor(draft.due.date.getTime() / 1000), { dateStyle: "medium", timeZone: "UTC" });
      if (draft.validity !== null) {
        target.setValidity(draft.validity);
        lines.push(t("mezo.paste.due", { date, validity: t(VALIDITY_KEY[draft.validity]) }));
      } else {
        lines.push(t(draft.due.days < 0 ? "mezo.paste.duePast" : "mezo.paste.dueLate", { date }));
      }
    } else {
      lines.push(t("mezo.paste.noDue"));
    }
    out.replaceChildren(...lines.map((line) => h("li", null, line)));
  };
  return h(
    "details",
    { class: "details paste" },
    h("summary", null, t("mezo.paste.title")),
    h(
      "div",
      { class: "field" },
      h("label", { attrs: { for: "paste-text" } }, t("mezo.paste.label")),
      input,
      h("p", { class: "field-hint", attrs: { id: "paste-hint" } }, t("mezo.paste.hint")),
    ),
    h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: fill } }, t("mezo.paste.key")),
    out,
  );
}
