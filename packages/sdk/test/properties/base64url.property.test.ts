// SPDX-License-Identifier: MIT
/** Property tests (fast-check, spec §4.1): strict base64url is a bijection between bytes and canonical strings. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../../src/index.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const b64Char = fc.constantFrom(...ALPHABET.split(""));

describe("base64url properties", () => {
  it("decode(encode(bytes)) = bytes, with the RFC 4648 §5 alphabet and no padding (agrees with Node)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 700 }), (bytes) => {
        const text = base64UrlEncode(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(text.length).toBe(Math.ceil((bytes.length * 4) / 3));
        expect(text).toBe(Buffer.from(bytes).toString("base64url"));
        expect(base64UrlDecode(text)).toEqual(bytes);
      }),
      { numRuns: 2000 },
    );
  });

  it("every accepted string is the unique encoding of its bytes (no malleable encodings)", () => {
    fc.assert(
      fc.property(fc.array(b64Char, { maxLength: 64 }), (chars) => {
        const text = chars.join("");
        const bytes = base64UrlDecode(text);
        if (bytes !== null) {
          expect(base64UrlEncode(bytes)).toBe(text);
        } else {
          expect(text.length % 4 === 1 || Buffer.from(Buffer.from(text, "base64url")).toString("base64url") !== text).toBe(true);
        }
      }),
      { numRuns: 5000 },
    );
  });

  it("never accepts a character outside the alphabet", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.integer({ min: 0, max: 39 }), fc.string({ minLength: 1, maxLength: 1 }), (base, at, ch) => {
        fc.pre(!ALPHABET.includes(ch));
        const text = `${base.slice(0, at)}${ch}${base.slice(at)}`;
        expect(base64UrlDecode(text)).toBeNull();
      }),
      { numRuns: 2000 },
    );
  });
});
