// SPDX-License-Identifier: MIT
/**
 * Memo rules (invoice spec §3.3, §10.5 step 10, §13.2): at most 280 bytes of UTF-8, hashed exactly as
 * received, normalised to NFC only by issuers, and displayed only after removing bidirectional and control
 * characters.
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { MAX_MEMO_BYTES, ZERO_HASH } from "./constants.ts";
import { PayLinkError } from "./errors.ts";

const encoder = new TextEncoder();

/** The exact UTF-8 bytes of a memo. */
export function memoBytes(memo: string): Uint8Array {
  return encoder.encode(memo);
}

/** Issuers normalise to Unicode NFC before hashing (spec §3.3); verifiers never do. */
export function normalizeMemo(memo: string): string {
  return memo.normalize("NFC");
}

/**
 * `memoHash` of a memo: `keccak256(UTF-8 bytes)`, or 32 zero bytes for no memo. An empty memo counts as no
 * memo and is never hashed (`keccak256("")` is forbidden, spec §3.1). Throws `E_MEMO_LENGTH` above 280 bytes.
 */
export function hashMemo(memo: string | null): Hex {
  if (memo === null || memo === "") {
    return ZERO_HASH;
  }
  const bytes = memoBytes(memo);
  if (bytes.length > MAX_MEMO_BYTES) {
    throw new PayLinkError("E_MEMO_LENGTH", `memo is ${bytes.length} bytes; the limit is ${MAX_MEMO_BYTES}`, {
      bytes: String(bytes.length),
      max: String(MAX_MEMO_BYTES),
    });
  }
  return keccak256(bytes);
}

// U+202A–U+202E and U+2066–U+2069 (embeddings, overrides, isolates), U+200E/U+200F (marks), U+061C (ALM).
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏؜]/gu;
// Line breaks and whitespace-like C0/C1 controls (and U+2028/U+2029) become one space so words do not run together;
// other controls are removed.
const SPACING_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]+/gu;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const OTHER_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/gu;

/**
 * Memo text safe to display as a note from the sender (spec §13.2): bidirectional controls and C0/C1
 * control characters removed. Render the result as text, never as markup; it stays untrusted.
 */
export function sanitizeMemoForDisplay(memo: string): string {
  return memo.replace(BIDI_CONTROLS, "").replace(SPACING_CONTROLS, " ").replace(OTHER_CONTROLS, "");
}
