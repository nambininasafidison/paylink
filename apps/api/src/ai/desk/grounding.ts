// SPDX-License-Identifier: MIT
/**
 * Checks on every text the desk model writes (docs/paypal/SPEC.md §9.2 A2, invariant AI-5): a message is kept with a
 * proposal only if all of these hold, otherwise the proposal carries no model text and the web edition shows its fixed,
 * owner-reviewed i18n text instead.
 *
 * - **Numeric grounding.** Every number in the message appears in the data the read tools returned in this run (an
 *   amount, a date, an invoice number). Numbers are compared as values: `120`, `120.00` and `120,00` are one number; a
 *   grouping that reads two ways (`1,200`) passes if either reading is in the data.
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
import { tokenise } from "../pii.ts";

export const MESSAGE_MAX_CHARS = 400;

const NUMBER = /\d+(?:[.,\u00A0\u202F ]\d+)*/gu;

/** The values a written number can stand for, as canonical decimal strings (`"120"`, `"120.5"`, `"6"`). */
export function readingsOf(written: string): string[] {
  const compact = written.replace(/[\u00A0\u202F]/gu, " ");
  const canonical = (s: string): string | null => {
    if (!/^\d+(?:\.\d+)?$/u.test(s)) {
      return null;
    }
    const [whole = "0", fraction = ""] = s.split(".");
    const w = whole.replace(/^0+(?=\d)/u, "");
    const f = fraction.replace(/0+$/u, "");
    return f === "" ? w : `${w}.${f}`;
  };
  const out = new Set<string>();
  // Spaces between digit groups: either grouping (1 200) or separate numbers (6 11 2026).
  if (compact.includes(" ")) {
    for (const part of compact.split(" ")) {
      for (const r of readingsOf(part)) {
        out.add(r);
      }
    }
    const grouped = canonical(compact.replace(/ /gu, ""));
    if (grouped !== null && /^\d{1,3}(?: \d{3})+$/u.test(compact)) {
      out.add(grouped);
    }
    return [...out];
  }
  const dots = (compact.match(/\./gu) ?? []).length;
  const commas = (compact.match(/,/gu) ?? []).length;
  if (dots + commas === 0) {
    const c = canonical(compact);
    return c === null ? [] : [c];
  }
  if (dots > 0 && commas > 0) {
    const decimal = compact.lastIndexOf(".") > compact.lastIndexOf(",") ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    const c = canonical(compact.split(grouping).join("").replace(decimal, "."));
    return c === null ? [] : [c];
  }
  const separator = dots > 0 ? "." : ",";
  const parts = compact.split(separator);
  if (parts.length > 2) {
    // 1.200.000 is grouping; 06.11.2026 is a date: both readings, and every part.
    const grouped = canonical(parts.join(""));
    if (grouped !== null) {
      out.add(grouped);
    }
    for (const part of parts) {
      const c = canonical(part);
      if (c !== null) {
        out.add(c);
      }
    }
    return [...out];
  }
  const asDecimal = canonical(parts.join("."));
  if (asDecimal !== null) {
    out.add(asDecimal);
  }
  if ((parts[1] ?? "").length === 3) {
    const asGrouped = canonical(parts.join(""));
    if (asGrouped !== null) {
      out.add(asGrouped);
    }
  }
  if (parts.every((part) => part.length <= 2)) {
    // "06.11" or "6,11" as a day and a month: the parts on their own are also numbers of the text.
    for (const part of parts) {
      const c = canonical(part);
      if (c !== null) {
        out.add(c);
      }
    }
  }
  return [...out];
}

/** Every number of a text, each with its readings. */
export function numbersOf(text: string): string[][] {
  return [...text.matchAll(NUMBER)].map((m) => readingsOf(m[0])).filter((r) => r.length > 0);
}

/** The set of values present in the tool data. */
export function groundSet(data: string): ReadonlySet<string> {
  return new Set(numbersOf(data).flat());
}

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
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;

export type GroundingProblem = "empty" | "too-long" | "ungrounded-number" | "link" | "contact-or-address" | "banned-phrase";

export interface GroundingResult {
  readonly text: string;
  readonly grounded: boolean;
  readonly problems: readonly GroundingProblem[];
  /** The numbers of the text that the data does not contain (for logs: values only, never the text). */
  readonly ungrounded: readonly string[];
}

/** Runs every check of the module comment on a model text, against the run's tool data. */
export function checkMessage(raw: string, ground: ReadonlySet<string>): GroundingResult {
  const text = raw.normalize("NFC").replace(CONTROLS, " ").replace(/\s+/gu, " ").trim();
  const problems = new Set<GroundingProblem>();
  if (text === "") {
    problems.add("empty");
  }
  if (text.length > MESSAGE_MAX_CHARS) {
    problems.add("too-long");
  }
  const ungrounded = numbersOf(text)
    .filter((readings) => !readings.some((r) => ground.has(r)))
    .map((readings) => readings[0] ?? "");
  if (ungrounded.length > 0) {
    problems.add("ungrounded-number");
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
