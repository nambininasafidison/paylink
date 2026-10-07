// SPDX-License-Identifier: MIT
/** Small, strict byte helpers shared by the codec and the verifiers. */
import { bytesToHex } from "viem";
import type { Hex } from "viem";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const LOWER_HEX = /^0x(?:[0-9a-f]{2})*$/;

/** `0x` + 64 lowercase hex digits (the canonical form of bytes32 values in JSON and URLs, spec §11.1). */
export function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && BYTES32.test(value);
}

/** `0x` + an even number of lowercase hex digits. */
export function isLowerHex(value: unknown): value is Hex {
  return typeof value === "string" && LOWER_HEX.test(value);
}

/** Big-endian unsigned integer of `length` bytes. Throws if it does not fit. */
export function uintToBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(length * 8)) {
    throw new RangeError(`${value} does not fit in ${length} bytes`);
  }
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** Big-endian unsigned integer from bytes. */
export function bytesToUint(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/** Lowercase hex of a byte slice. */
export function sliceHex(bytes: Uint8Array, start: number, end: number): Hex {
  return bytesToHex(bytes.subarray(start, end));
}
