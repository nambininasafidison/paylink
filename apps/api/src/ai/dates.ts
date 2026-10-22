// SPDX-License-Identifier: MIT
/**
 * Due dates by code (invariant AI-5, docs/paypal/SPEC.md §9.2 A1): the model copies the phrase that gives the due date
 * (`due_text`, verbatim); code checks the copy is in the message and resolves it against today in Antananarivo (UTC+3,
 * no daylight saving). The model's own reading (`due_date_iso`) is never used as the date: it is only logged when it
 * differs. A phrase code cannot resolve, or that reads two ways, gives no date and the clarification `due_date_unclear`;
 * a date before today gives `due_date_past`, one more than 365 days ahead `due_date_too_far` (and no date).
 *
 * Phrases resolved (EN, FR, MG; case and accents ignored): ISO dates; today, tomorrow, the day after; "in N days /
 * weeks / months", "dans N jours / semaines / mois", "afaka N andro / herinandro / volana" (digits or the words one to
 * ten); "net 30"; "on receipt"; end of the month, end of a named month; weekdays (the coming one; English "next Friday"
 * reads two ways); "6 Nov", "November 6th", "le 6 novembre", "6 novambra", with or without a year; numeric dates
 * (day first in French and Malagasy; in English only when one part is above 12); "the 30th", "le 30", "avant le 30".
 *
 * Owner: AI workstream.
 */
import type { ClarificationCode, IsoDate, Locale } from "@paylink/api-contract";

const DAY_MS = 86_400_000;
/** Antananarivo is UTC+3 all year (no daylight saving). */
const ANTANANARIVO_OFFSET_MS = 3 * 60 * 60 * 1000;

export function antananarivoToday(now: number): IsoDate {
  return new Date(now + ANTANANARIVO_OFFSET_MS).toISOString().slice(0, 10);
}

const toDate = (iso: IsoDate): Date => new Date(`${iso}T00:00:00.000Z`);
const toIso = (d: Date): IsoDate => d.toISOString().slice(0, 10);
const addDays = (iso: IsoDate, days: number): IsoDate => toIso(new Date(toDate(iso).getTime() + days * DAY_MS));

function validYmd(y: number, m: number, d: number): IsoDate | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? toIso(date) : null;
}

const lastDayOf = (y: number, m: number): IsoDate => toIso(new Date(Date.UTC(y, m, 0)));

function addMonths(iso: IsoDate, months: number): IsoDate {
  const d = toDate(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toIso(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))));
}

/** The first date on or after today with this month and day (this year or the next). */
function nextMonthDay(today: IsoDate, month: number, day: number): IsoDate | null {
  const year = toDate(today).getUTCFullYear();
  for (const y of [year, year + 1]) {
    const date = validYmd(y, month, day);
    if (date !== null && date >= today) {
      return date;
    }
  }
  return null;
}

/** The first date on or after today with this day of the month. */
function nextDayOfMonth(today: IsoDate, day: number): IsoDate | null {
  const d = toDate(today);
  for (let i = 0; i < 3; i += 1) {
    const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1));
    const date = validYmd(month.getUTCFullYear(), month.getUTCMonth() + 1, day);
    if (date !== null && date >= today) {
      return date;
    }
  }
  return null;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, thirty: 30,
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10, quinze: 15, trente: 30,
  iray: 1, roa: 2, telo: 3, efatra: 4, dimy: 5, enina: 6, fito: 7, valo: 8, sivy: 9, folo: 10,
};

const MONTHS: readonly (readonly string[])[] = [
  ["january", "jan", "janvier", "janv", "janoary"],
  ["february", "feb", "fevrier", "fevr", "fev", "febroary"],
  ["march", "mar", "mars", "martsa"],
  ["april", "apr", "avril", "avr", "aprily"],
  ["may", "mai", "mey"],
  ["june", "jun", "juin", "jona"],
  ["july", "jul", "juillet", "juil", "jolay"],
  ["august", "aug", "aout", "aogositra"],
  ["september", "sept", "sep", "septembre", "septambra"],
  ["october", "oct", "octobre", "oktobra"],
  ["november", "nov", "novembre", "novambra"],
  ["december", "dec", "decembre", "desambra"],
];
const MONTH_OF = new Map<string, number>(MONTHS.flatMap((names, i) => names.map((n) => [n, i + 1] as const)));
const MONTH_RE = [...MONTH_OF.keys()].sort((a, b) => b.length - a.length).join("|");

/** Sunday = 0 (as `getUTCDay`). */
const WEEKDAYS: readonly (readonly string[])[] = [
  ["sunday", "dimanche", "alahady"],
  ["monday", "lundi", "alatsinainy"],
  ["tuesday", "mardi", "talata"],
  ["wednesday", "mercredi", "alarobia"],
  ["thursday", "jeudi", "alakamisy"],
  ["friday", "vendredi", "zoma"],
  ["saturday", "samedi", "sabotsy"],
];
const WEEKDAY_OF = new Map<string, number>(WEEKDAYS.flatMap((names, i) => names.map((n) => [n, i] as const)));
const WEEKDAY_RE = [...WEEKDAY_OF.keys()].join("|");

const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})`;

export type DueResolution = { readonly kind: "date"; readonly date: IsoDate } | { readonly kind: "ambiguous" } | { readonly kind: "unknown" };

const numberOf = (word: string): number => NUMBER_WORDS[word] ?? Number(word);

/** Lower case, accents removed, apostrophes straightened, spaces squashed. */
export function normalisePhrase(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/gu, "")
    .toLowerCase()
    .replace(/[’`]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Resolves a due-date phrase against `today` (module comment). */
export function resolveDuePhrase(phrase: string, today: IsoDate, language: Locale): DueResolution {
  const p = normalisePhrase(phrase);
  const date = (iso: IsoDate | null): DueResolution => (iso === null ? { kind: "unknown" } : { kind: "date", date: iso });
  const year = toDate(today).getUTCFullYear();

  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/u.exec(p);
  if (m !== null) {
    return date(validYmd(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  if (/\b(?:on|upon) receipt\b|\b(?:a|des|a la) reception\b|\bvoarainy\b/u.test(p)) {
    return date(today);
  }
  if (/\bday after tomorrow\b|\bapres[- ]demain\b|\brahafakampitso\b/u.test(p)) {
    return date(addDays(today, 2));
  }
  if (/\b(?:today|tonight|aujourd'hui|ce soir|androany|anio)\b/u.test(p)) {
    return date(today);
  }
  if (/\b(?:tomorrow|demain|rahampitso)\b/u.test(p)) {
    return date(addDays(today, 1));
  }
  m = new RegExp(`\\b(?:in|within|dans|sous|d'ici|afaka|ao anatin'ny)?\\s*${NUM}\\s+(days?|weeks?|months?|jours?|semaines?|mois|andro|herinandro|volana)\\b`, "u").exec(p);
  if (m !== null && /\b(?:in|within|dans|sous|d'ici|afaka|ao anatin'ny)\b/u.test(p)) {
    const n = numberOf(m[1] ?? "");
    const unit = m[2] ?? "";
    if (!Number.isInteger(n) || n <= 0) {
      return { kind: "unknown" };
    }
    if (/^(?:days?|jours?|andro)$/u.test(unit)) {
      return date(addDays(today, n));
    }
    if (/^(?:weeks?|semaines?|herinandro)$/u.test(unit)) {
      return date(addDays(today, 7 * n));
    }
    return date(addMonths(today, n));
  }
  m = /\bnet\s?(\d{1,3})\b/u.exec(p);
  if (m !== null) {
    return date(addDays(today, Number(m[1])));
  }
  if (/\bnext week\b|\bsemaine prochaine\b|\bherinandro (?:ho avy|manaraka)\b/u.test(p)) {
    return { kind: "ambiguous" };
  }
  m = new RegExp(`\\b(?:end of|fin(?: de| du)?|faran'ny(?: volana)?)\\s+(${MONTH_RE})\\b`, "u").exec(p);
  if (m !== null) {
    const month = MONTH_OF.get(m[1] ?? "") ?? 0;
    const thisYear = lastDayOf(year, month);
    return date(thisYear >= today ? thisYear : lastDayOf(year + 1, month));
  }
  if (/\bend of (?:the |this )?month\b|\bfin (?:du|de|de ce) mois\b|\bfaran'ny volana\b/u.test(p)) {
    const d = toDate(today);
    return date(lastDayOf(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }
  // "6 Nov", "6th of November", "le 6 novembre", "6 novambra 2026".
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(?:of\\s+|de\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4}))?`, "u").exec(p);
  if (m !== null) {
    const month = MONTH_OF.get(m[2] ?? "") ?? 0;
    return date(m[3] === undefined ? nextMonthDay(today, month, Number(m[1])) : validYmd(Number(m[3]), month, Number(m[1])));
  }
  // "Nov 6", "November 6th, 2026".
  m = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "u").exec(p);
  if (m !== null) {
    const month = MONTH_OF.get(m[1] ?? "") ?? 0;
    return date(m[3] === undefined ? nextMonthDay(today, month, Number(m[2])) : validYmd(Number(m[3]), month, Number(m[2])));
  }
  // Numeric dates: 06/11, 06/11/2026, 6.11.26.
  m = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/u.exec(p);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = m[3] === undefined ? null : Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    let order: "dm" | "md";
    if (a > 12) {
      order = "dm";
    } else if (b > 12) {
      order = "md";
    } else if (a === b || language !== "en") {
      order = "dm";
    } else {
      return { kind: "ambiguous" };
    }
    const [day, month] = order === "dm" ? [a, b] : [b, a];
    return date(y === null ? nextMonthDay(today, month, day) : validYmd(y, month, day));
  }
  // Weekdays: the coming one. English "next Friday" reads two ways.
  m = new RegExp(`\\b(next\\s+)?(${WEEKDAY_RE})\\b`, "u").exec(p);
  if (m !== null) {
    if (m[1] !== undefined) {
      return { kind: "ambiguous" };
    }
    const target = WEEKDAY_OF.get(m[2] ?? "") ?? 0;
    const ahead = (target - toDate(today).getUTCDay() + 7) % 7;
    return ahead === 0 ? { kind: "ambiguous" } : date(addDays(today, ahead));
  }
  // A day of the month alone: "the 30th", "le 30", "avant le 30", "hatramin'ny 30".
  m = /\b(?:the|le|avant le|before the|by the|until the|jusqu'au|hatramin'ny|ny)\s+(\d{1,2})(?:st|nd|rd|th|er)?\b/u.exec(p);
  if (m !== null) {
    return date(nextDayOfMonth(today, Number(m[1])));
  }
  return { kind: "unknown" };
}

export interface DueDecision {
  readonly dueDate: IsoDate | null;
  readonly clarifications: readonly ClarificationCode[];
  /** Why, for logs and tests (never shown). */
  readonly basis: "none" | "resolved" | "not-in-text" | "unresolved" | "ambiguous" | "past" | "too-far" | "no-phrase";
  /** The model's own reading differed from code's (logged, never used). */
  readonly disagreed: boolean;
}

/** Longest horizon of a due date (§9.2 A1: at most 365 days ahead). */
export const MAX_DUE_DAYS = 365;

/** Decides the draft's due date from the model's `due_text` and the message (module comment). */
export function decideDueDate(text: string, dueText: string | null, dueIso: string | null, today: IsoDate, language: Locale): DueDecision {
  const none = (basis: DueDecision["basis"], clarification: ClarificationCode | null): DueDecision => ({ dueDate: null, clarifications: clarification === null ? [] : [clarification], basis, disagreed: false });
  if (dueText === null || dueText.trim() === "") {
    return dueIso === null ? none("none", null) : none("no-phrase", "due_date_unclear");
  }
  if (!normalisePhrase(text).includes(normalisePhrase(dueText))) {
    return none("not-in-text", "due_date_unclear");
  }
  const resolved = resolveDuePhrase(dueText, today, language);
  if (resolved.kind === "unknown") {
    return none("unresolved", "due_date_unclear");
  }
  if (resolved.kind === "ambiguous") {
    return none("ambiguous", "due_date_unclear");
  }
  if (resolved.date < today) {
    return none("past", "due_date_past");
  }
  if (resolved.date > addDays(today, MAX_DUE_DAYS)) {
    return none("too-far", "due_date_too_far");
  }
  return { dueDate: resolved.date, clarifications: [], basis: "resolved", disagreed: dueIso !== null && dueIso !== resolved.date };
}
