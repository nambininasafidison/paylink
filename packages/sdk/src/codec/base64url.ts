// SPDX-License-Identifier: MIT
/**
 * Strict base64url (RFC 4648 §5, no padding), as invoice spec §10.5 step 6 requires: alphabet
 * `A–Z a–z 0–9 - _` only, no `=`, no length ≡ 1 (mod 4), and canonical (the unused low-order bits of the
 * last character are zero), so every byte string has exactly one encoding.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i += 1) {
  VALUES[ALPHABET.charCodeAt(i)] = i;
}

/** Encodes bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET.charAt(n >>> 18) + ALPHABET.charAt((n >>> 12) & 63) + ALPHABET.charAt((n >>> 6) & 63) + ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += ALPHABET.charAt(n >>> 18) + ALPHABET.charAt((n >>> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += ALPHABET.charAt(n >>> 18) + ALPHABET.charAt((n >>> 12) & 63) + ALPHABET.charAt((n >>> 6) & 63);
  }
  return out;
}

function sextet(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code < 128 ? (VALUES[code] ?? -1) : -1;
}

/**
 * Decodes strict, canonical, unpadded base64url. Returns `null` for anything else: a foreign character,
 * padding, an impossible length or non-zero trailing bits. The empty string decodes to zero bytes.
 */
export function base64UrlDecode(text: string): Uint8Array | null {
  const remainder = text.length % 4;
  if (remainder === 1) {
    return null;
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 4 <= text.length; i += 4) {
    const a = sextet(text, i);
    const b = sextet(text, i + 1);
    const c = sextet(text, i + 2);
    const d = sextet(text, i + 3);
    if ((a | b | c | d) < 0) {
      return null;
    }
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >>> 16;
    out[o++] = (n >>> 8) & 255;
    out[o++] = n & 255;
  }
  if (remainder === 2) {
    const a = sextet(text, i);
    const b = sextet(text, i + 1);
    if ((a | b) < 0 || (b & 0b1111) !== 0) {
      return null;
    }
    out[o] = (a << 2) | (b >>> 4);
  } else if (remainder === 3) {
    const a = sextet(text, i);
    const b = sextet(text, i + 1);
    const c = sextet(text, i + 2);
    if ((a | b | c) < 0 || (c & 0b11) !== 0) {
      return null;
    }
    const n = (a << 18) | (b << 12) | (c << 6);
    out[o++] = n >>> 16;
    out[o] = (n >>> 8) & 255;
  }
  return out;
}
