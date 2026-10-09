// SPDX-License-Identifier: MIT
/**
 * Base64url without padding (RFC 4648 §5), strict: the decoder accepts only the canonical encoding of some bytes (no
 * padding, no whitespace, no other alphabet, unused trailing bits zero), so one value has exactly one spelling and an
 * edited file cannot pass as the same bytes.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUES = new Map<string, number>(Array.from({ length: ALPHABET.length }, (_, i) => [ALPHABET.charAt(i), i]));

export function encodeBase64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += (ALPHABET[(n >> 18) & 63] ?? "") + (ALPHABET[(n >> 12) & 63] ?? "") + (ALPHABET[(n >> 6) & 63] ?? "") + (ALPHABET[n & 63] ?? "");
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += (ALPHABET[(n >> 18) & 63] ?? "") + (ALPHABET[(n >> 12) & 63] ?? "");
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += (ALPHABET[(n >> 18) & 63] ?? "") + (ALPHABET[(n >> 12) & 63] ?? "") + (ALPHABET[(n >> 6) & 63] ?? "");
  }
  return out;
}

/** The bytes of a canonical unpadded base64url string, or `null`. */
export function decodeBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) {
    return null;
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = VALUES.get(char);
    if (value === undefined) {
      return null;
    }
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (buffer >> bits) & 0xff;
      o += 1;
    }
  }
  // Canonical: the bits left over after the last whole byte are zero.
  if ((buffer & ((1 << bits) - 1)) !== 0) {
    return null;
  }
  return out;
}
