// SPDX-License-Identifier: MIT
/**
 * Named placeholders: `{name}`, where name is an ASCII identifier. Whole sentences carry their placeholders, so word
 * order is the translator's (spec §3.9: no string concatenation). There is no other syntax: no HTML, no escapes, no
 * nested braces; the completeness test refuses anything else.
 */

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Placeholder names of a message, in order of first appearance, without duplicates. */
export function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ""))];
}

/** A value for a placeholder. Rendered with `String()`: format numbers and amounts before passing them. */
export type ParamValue = string | number | bigint;

/** What a missing placeholder renders as at run time (types prevent it at compile time). */
export const MISSING = "…";

/**
 * Replaces each `{name}` with its value. Missing values render as `…` and are reported to `onMissing` (tests make it
 * throw). The result is plain text: callers set it as `textContent`, never as markup.
 */
export function interpolate(
  message: string,
  params: Readonly<Record<string, ParamValue>> = {},
  onMissing?: (name: string) => void,
): string {
  return message.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) {
      onMissing?.(name);
      return MISSING;
    }
    return String(value);
  });
}
