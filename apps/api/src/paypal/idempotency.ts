// SPDX-License-Identifier: MIT
/**
 * `PayPal-Request-Id` values for writes. A write the API may repeat in a later run (the executor after a timeout, the cron
 * after a crash) uses a deterministic id derived from what makes it unique, so that if PayPal deduplicates on the header
 * (documented for other PayPal APIs, UNVERIFIED for Invoicing and Webhooks, src/paypal/client.ts) the repetition is
 * recognised. The read-before-retry rule stays the guarantee either way.
 *
 * Format: `pl-<kind>-<parts>`, each part the first 24 hex digits of a `0x` value (96 bits) or a PayPal id as is; at most
 * 64 characters of `[A-Za-z0-9_-]` (the client refuses anything else).
 *
 * Owner: PayPal spine workstream.
 */

/** The write kinds PayLink makes. */
export type WriteKind = "create" | "send" | "record" | "undo" | "cancel" | "remind" | "subscribe";

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** A deterministic request id for `kind` over `parts` (hex values or PayPal ids). Throws if the result is not a valid id. */
export function requestIdFor(kind: WriteKind, ...parts: readonly string[]): string {
  const id = ["pl", kind, ...parts.map((part) => (/^0x[0-9a-fA-F]+$/u.test(part) ? part.slice(2, 26).toLowerCase() : part))].join("-");
  if (!REQUEST_ID_PATTERN.test(id)) {
    throw new RangeError(`not a valid PayPal-Request-Id: ${String(id.length)} characters`);
  }
  return id;
}

/** A random request id for a one-off write (128 bits). */
export function randomRequestId(random: (bytes: number) => Uint8Array): string {
  return `pl-${[...random(16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
