// SPDX-License-Identifier: MIT
/**
 * Checks on every text the desk model writes (docs/paypal/SPEC.md §9.2 A2, invariant AI-5): a message is kept with a
 * proposal only if all of these hold, otherwise the proposal carries no model text and the web edition shows its fixed,
 * owner-reviewed i18n text instead.
 *
 * - **Grounding by type, against the proposal's own twin.** The facts a message may state are typed values of that one
 *   twin, read by code from its record (`factsOfTwin`): its amount and paid amount, its due date, the day it was shared
 *   and the day of PayPal's last reminder, and its invoice number as one whole token. Identifiers and timestamps
 *   (the PayLink key, transaction hashes, PayPal ids, the chain id, `checked_at`) and every other twin's values are never
 *   facts. In the message:
 *   - every `PL-…` token is that twin's invoice number;
 *   - every date (ISO, `06/11/2026`, `6 November 2026`, `le 6 novembre`, `6 novambra`, `Nov 6`, `November 2026`) is one
 *     of that twin's dates (a numeric date that reads two ways passes if either reading is);
 *   - every other number, whether written next to a currency mark, as a decimal or bare, is that twin's amount in US
 *     dollars, read by the A1 amount reader (`scanMoney`: `120`, `120.00`, `120,00`, `$120`, `1,200 USD` are values, a
 *     grouping that reads two ways is refused); a number next to another currency is refused;
 *   - digits inside words (`USD47`, `x12`) and digits of other scripts are numbers too.
 *   So a reminder for invoice A that states 12.00, 47 or invoice B's amount is dropped, whatever the tool data held.
 * - **No contact or payment details.** No link, email address, phone number or `0x` address (the client receives this
 *   text: it must not carry anything a payer could act on but the invoice itself).
 * - **No threats, legal claims or credential talk** (EN, FR, MG word lists; E).
 * - **Short.** At most 400 characters, after control characters are removed.
 *
 * Numbers written in words ("one hundred") escape the numeric check; the banned-phrase list and the payee's review
 * before sharing are the remaining defences (E).
 *
 * Owner: AI workstream.
 */
import type { IsoDate } from "@paylink/api-contract";
import { parseAmount } from "@paylink/sdk";
import type { TwinRecord } from "../../store/types.ts";
import { scanMoney } from "../amounts.ts";
import { MONTH_OF } from "../dates.ts";
import { tokenise } from "../pii.ts";

export const MESSAGE_MAX_CHARS = 400;

/** The typed values a message about one twin may state (module comment). */
export interface GroundFacts {
  /** USD amounts in 6-decimal base units, as decimal strings (`"120000000"`). */
  readonly amounts: ReadonlySet<string>;
  readonly dates: ReadonlySet<IsoDate>;
  /** Invoice numbers, lower case. */
  readonly invoiceNumbers: ReadonlySet<string>;
}

/** No facts: every number, date and invoice number is ungrounded (a message written before the twin was read). */
export const NO_FACTS: GroundFacts = { amounts: new Set(), dates: new Set(), invoiceNumbers: new Set() };

const utcDay = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

/** The facts of one twin, from named fields of its record only (never identifiers or timestamps). */
export function factsOfTwin(twin: TwinRecord): GroundFacts {
  const amounts = new Set<string>([BigInt(twin.amountBase).toString()]);
  if (twin.paidAmount !== null) {
    try {
      amounts.add(parseAmount(twin.paidAmount, 6).toString());
    } catch {
      // A paid amount PayPal wrote in a shape the parser refuses is no fact.
    }
  }
  const dates = new Set<IsoDate>();
  if (twin.dueDate !== null) {
    dates.add(twin.dueDate);
  }
  if (twin.sentAt !== null) {
    dates.add(utcDay(twin.sentAt));
  }
  if (twin.lastReminderAt !== null) {
    dates.add(utcDay(twin.lastReminderAt));
  }
  return { amounts, dates, invoiceNumbers: new Set([twin.invoiceNumber.toLowerCase()]) };
}

/** The union of several twins' facts (the run summary, which no client receives). */
export function unionFacts(list: readonly GroundFacts[]): GroundFacts {
  return {
    amounts: new Set(list.flatMap((f) => [...f.amounts])),
    dates: new Set(list.flatMap((f) => [...f.dates])),
    invoiceNumbers: new Set(list.flatMap((f) => [...f.invoiceNumbers])),
  };
}

// ------------------------------------------------------------------------------------------ dates

const MONTH_RE = [...MONTH_OF.keys()].sort((a, b) => b.length - a.length).join("|");

interface DateReading {
  readonly y: number | null;
  readonly m: number;
  readonly d: number | null;
}

const year = (written: string | undefined): number | null => (written === undefined ? null : written.length === 2 ? 2000 + Number(written) : Number(written));

/** Date patterns, in the order they are looked for (each found date is masked before the next pattern runs). */
const DATE_PATTERNS: readonly (readonly [RegExp, (m: RegExpExecArray) => DateReading[]])[] = [
  [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/gu, (m) => [{ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }]],
  [
    /\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})\b/gu,
    (m) => [
      { y: year(m[4]), m: Number(m[3]), d: Number(m[1]) },
      { y: year(m[4]), m: Number(m[1]), d: Number(m[3]) },
    ],
  ],
  [
    /\b(\d{1,2})\/(\d{1,2})\b/gu,
    (m) => [
      { y: null, m: Number(m[2]), d: Number(m[1]) },
      { y: null, m: Number(m[1]), d: Number(m[2]) },
    ],
  ],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(?:of\\s+|de\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4}))?`, "gu"), (m) => [{ y: year(m[3]), m: MONTH_OF.get(m[2] ?? "") ?? 0, d: Number(m[1]) }]],
  [new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gu"), (m) => [{ y: year(m[3]), m: MONTH_OF.get(m[1] ?? "") ?? 0, d: Number(m[2]) }]],
  [new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{4})\\b`, "gu"), (m) => [{ y: year(m[2]), m: MONTH_OF.get(m[1] ?? "") ?? 0, d: null }]],
];

const matchesDate = (r: DateReading, iso: IsoDate): boolean => {
  const [y, m, d] = iso.split("-").map(Number);
  return r.m === m && (r.d === null || r.d === d) && (r.y === null || r.y === y);
};

/** Lower case and without accents, character for character (UTF-16 offsets stay those of `text`). */
function fold(text: string): string {
  let out = "";
  for (const c of text) {
    const f = c.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
    out += f.length === c.length ? f : c;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ the checks

const BANNED: readonly RegExp[] = [
  // Threats and legal claims.
  /\b(?:lawyers?|attorneys?|legal action|lawsuit|sue|suing|court|police|debt collectors?|collection agency|blacklist(?:ed)?|report you|consequences)\b/iu,
  /\b(?:avocats?|poursuites?|tribunal|justice|plainte|huissiers?|mise en demeure|contentieux|gendarmerie)\b/iu,
  /\b(?:mpisolovava|fitsarana|polisy|zandary|fitoriana)\b/iu,
  // Credentials and payment redirection.
  /\b(?:password|passcode|seed phrase|private key|recovery phrase|gift ?cards?|wallet address|send (?:it )?to (?:this|my|the following))\b/iu,
  /\b(?:mot de passe|cl[eé] priv[eé]e|phrase de r[eé]cup[eé]ration|cartes? cadeaux?)\b/iu,
];
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|me|app|xyz|link|ly|co|info|biz|top|click|page|site|online|mg|fr)\b/iu;
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩‎‏؜]/gu;
const INVOICE_NUMBER = /\bPL-[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*/giu;
const OTHER_DIGITS = /(?![0-9])\p{N}/u;

export type GroundingProblem = "empty" | "too-long" | "ungrounded-number" | "ungrounded-date" | "ungrounded-invoice-number" | "link" | "contact-or-address" | "banned-phrase";

export interface GroundingResult {
  readonly text: string;
  readonly grounded: boolean;
  readonly problems: readonly GroundingProblem[];
  /** The values of the text that are not the twin's (for logs: values only, never the text). */
  readonly ungrounded: readonly string[];
}

/** `base` (6-decimal units) as a plain decimal (`"120"`, `"0.5"`), for logs. */
const decimalOf = (base: bigint): string => {
  const whole = base / 1_000_000n;
  const fraction = (base % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
};

/** Runs every check of the module comment on a model text, against the facts of the twin it is about. */
export function checkMessage(raw: string, facts: GroundFacts): GroundingResult {
  const text = raw.normalize("NFC").replace(CONTROLS, " ").replace(/\s+/gu, " ").trim();
  const problems = new Set<GroundingProblem>();
  const ungrounded: string[] = [];
  if (text === "") {
    problems.add("empty");
  }
  if (text.length > MESSAGE_MAX_CHARS) {
    problems.add("too-long");
  }
  // UTF-16 units, so that offsets of every regular expression below index this array.
  const chars = text.split("");
  const mask = (from: number, length: number): void => {
    for (let i = from; i < from + length; i += 1) {
      chars[i] = " ";
    }
  };
  // 1. Invoice numbers: whole tokens, the twin's own.
  for (const m of text.matchAll(INVOICE_NUMBER)) {
    if (!facts.invoiceNumbers.has(m[0].toLowerCase())) {
      problems.add("ungrounded-invoice-number");
      ungrounded.push("invoice-number");
    }
    mask(m.index, m[0].length);
  }
  // 2. Dates: each one of the twin's dates.
  for (const [pattern, readings] of DATE_PATTERNS) {
    const folded = fold(chars.join(""));
    for (const m of folded.matchAll(pattern)) {
      const options = readings(m);
      if (!options.some((r) => [...facts.dates].some((iso) => matchesDate(r, iso)))) {
        problems.add("ungrounded-date");
        const first = options[0];
        ungrounded.push(first === undefined ? "date" : `date:${String(first.y ?? "")}-${String(first.m)}-${String(first.d ?? "")}`);
      }
      mask(m.index, m[0].length);
    }
  }
  // 3. Every other number: the twin's amount in US dollars.
  const rest = chars.join("").replace(/(\p{L})(?=\d)/gu, "$1 ").replace(/(\d)(?=\p{L})/gu, "$1 ");
  if (OTHER_DIGITS.test(rest)) {
    problems.add("ungrounded-number");
    ungrounded.push("other-script-digits");
  }
  const covered = new Set<number>();
  for (const mention of scanMoney(rest)) {
    for (let i = mention.index; i < mention.index + mention.digits.length; i += 1) {
      covered.add(i);
    }
    const fine = (mention.currency === null || mention.currency === "USD") && mention.base !== null && !mention.ambiguous && facts.amounts.has(mention.base.toString());
    if (!fine) {
      problems.add("ungrounded-number");
      ungrounded.push(mention.base === null ? mention.digits.replace(/[^\d.,]/gu, "") : decimalOf(mention.base));
    }
  }
  for (const m of rest.matchAll(/\d+/gu)) {
    let whole = true;
    for (let i = m.index; i < m.index + m[0].length; i += 1) {
      whole &&= covered.has(i);
    }
    if (!whole) {
      problems.add("ungrounded-number");
      ungrounded.push(m[0]);
    }
  }
  if (LINK.test(text)) {
    problems.add("link");
  }
  const pii = tokenise(text).counts;
  if (pii.EMAIL + pii.PHONE + pii.ADDRESS + pii.HEX > 0 || /0x[0-9a-f]{6,}/iu.test(text)) {
    problems.add("contact-or-address");
  }
  if (BANNED.some((re) => re.test(text))) {
    problems.add("banned-phrase");
  }
  return { text, grounded: problems.size === 0, problems: [...problems], ungrounded };
}
