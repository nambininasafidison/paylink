// SPDX-License-Identifier: MIT
/** Randomness for salts (invoice spec §3.1, §14.6) and payer salts (§8.2): always a CSPRNG. */
import { bytesToHex } from "viem";
import type { Hex } from "viem";

/** Fills `length` bytes with cryptographically secure random values. Injected in tests only. */
export type RandomSource = (length: number) => Uint8Array;

/** Web Crypto `getRandomValues`: present in browsers, Cloudflare Workers and Node >= 19. */
export const cryptoRandom: RandomSource = (length) => crypto.getRandomValues(new Uint8Array(length));

/** 32 random bytes as lowercase hex, for an invoice salt or a payer salt. */
export function randomBytes32(random: RandomSource = cryptoRandom): Hex {
  const bytes = random(32);
  if (bytes.length !== 32) {
    throw new RangeError("the random source must return exactly the requested number of bytes");
  }
  return bytesToHex(bytes);
}
