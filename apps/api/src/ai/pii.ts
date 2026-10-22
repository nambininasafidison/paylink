// SPDX-License-Identifier: MIT
/**
 * Personal data out of the prompt (docs/paypal/SPEC.md §9.2 A1, §9.4): before a pasted text goes to the model, code
 * replaces email addresses, phone numbers and `0x` addresses with placeholders (`[EMAIL_1]`, `[PHONE_1]`,
 * `[ADDRESS_1]`, `[HEX_1]`). The model sees only the placeholders; code maps back the one it may return (the client's
 * email token) and nothing else. The vault never leaves the request: it is not stored and not logged.
 *
 * Patterns (deterministic, E): emails per the usual local@domain.tld shape; phones only in shapes that cannot be an
 * amount (an international `+` prefix, Malagasy mobiles `03x xx xxx xx`, French `0x xx xx xx xx`, North American
 * `(xxx) xxx-xxxx`); `0x` followed by exactly 40 hex digits (an address, which the draft never uses as the payee) or by
 * 16 or more (a key or hash). A placeholder-looking text already in the input is neutralised first, so a message cannot
 * smuggle in a placeholder that code would map back.
 *
 * Owner: AI workstream.
 */

export type PiiKind = "EMAIL" | "PHONE" | "ADDRESS" | "HEX";

export interface Tokenised {
  /** The text the model may see. */
  readonly text: string;
  /** Placeholder → original value. */
  readonly vault: ReadonlyMap<string, { readonly kind: PiiKind; readonly value: string }>;
  /** How many of each kind were replaced. */
  readonly counts: Readonly<Record<PiiKind, number>>;
}

const PLACEHOLDER = /\[(?:EMAIL|PHONE|ADDRESS|HEX)_\d+\]/gu;

const PATTERNS: readonly (readonly [PiiKind, RegExp])[] = [
  ["EMAIL", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu],
  ["ADDRESS", /\b0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/gu],
  ["HEX", /\b0x[0-9a-fA-F]{16,}(?![0-9a-fA-F])/gu],
  [
    "PHONE",
    /(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){2,4}|\b0(?:32|33|34|37|38)[\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{2}\b|\b0[1-9](?:[\s.-]?\d{2}){4}\b|\(\d{3}\)\s?\d{3}[\s.-]\d{4}\b|\b\d{3}[.-]\d{3}[.-]\d{4}\b)/gu,
  ],
];

/** Replaces personal data with placeholders (module comment). The same value always gets the same placeholder. */
export function tokenise(input: string): Tokenised {
  let text = input.replace(PLACEHOLDER, "(placeholder)");
  const vault = new Map<string, { readonly kind: PiiKind; readonly value: string }>();
  const byValue = new Map<string, string>();
  const counts: Record<PiiKind, number> = { EMAIL: 0, PHONE: 0, ADDRESS: 0, HEX: 0 };
  for (const [kind, pattern] of PATTERNS) {
    text = text.replace(pattern, (match) => {
      const value = match.trim();
      const known = byValue.get(`${kind}:${value.toLowerCase()}`);
      if (known !== undefined) {
        return known;
      }
      counts[kind] += 1;
      const token = `[${kind}_${String(counts[kind])}]`;
      vault.set(token, { kind, value });
      byValue.set(`${kind}:${value.toLowerCase()}`, token);
      return token;
    });
  }
  return { text, vault, counts };
}

/** The original value of a placeholder of the given kind, or null (unknown, or another kind). */
export function restore(tokenised: Tokenised, token: string | null, kind: PiiKind): string | null {
  if (token === null) {
    return null;
  }
  const entry = tokenised.vault.get(token.trim());
  return entry?.kind === kind ? entry.value : null;
}

/** A model text with every placeholder removed (a description or a name never carries personal data). */
export function withoutPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER, "").replace(/\s{2,}/gu, " ").trim();
}
