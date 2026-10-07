// SPDX-License-Identifier: MIT
/**
 * The 140-byte packed invoice (invoice spec §10.4): the eight fields in declaration order, big-endian, no
 * padding, no length prefixes. A transport encoding only: the key is always computed from the decoded
 * fields with `abi.encode` (§5).
 *
 * | offset | 0     | 20    | 40     | 56         | 64         | 72          | 76   | 108      |
 * | length | 20    | 20    | 16     | 8          | 8          | 4           | 32   | 32       |
 * | field  | payee | token | amount | validAfter | validUntil | maxPayments | salt | memoHash |
 */
import { getAddress, hexToBytes } from "viem";
import { bytesToUint, isBytes32, sliceHex, uintToBytes } from "../bytes.ts";
import { MAX_UINT128, MAX_UINT32, MAX_UINT64, PACKED_INVOICE_LENGTH } from "../constants.ts";
import { assertArgument } from "../errors.ts";
import type { Invoice } from "../types.ts";

/** Packs an invoice into its 140-byte transport form. Throws `E_INVALID_ARGUMENT` for out-of-range fields. */
export function packInvoice(invoice: Invoice): Uint8Array {
  assertArgument(invoice.amount >= 0n && invoice.amount <= MAX_UINT128, "amount must be a uint128");
  assertArgument(invoice.validAfter >= 0n && invoice.validAfter <= MAX_UINT64, "validAfter must be a uint64");
  assertArgument(invoice.validUntil >= 0n && invoice.validUntil <= MAX_UINT64, "validUntil must be a uint64");
  assertArgument(Number.isInteger(invoice.maxPayments) && invoice.maxPayments >= 0 && BigInt(invoice.maxPayments) <= MAX_UINT32, "maxPayments must be a uint32");
  assertArgument(isBytes32(invoice.salt) && isBytes32(invoice.memoHash), "salt and memoHash must be 32 bytes of lowercase hex");
  const out = new Uint8Array(PACKED_INVOICE_LENGTH);
  out.set(hexToBytes(getAddress(invoice.payee)), 0);
  out.set(hexToBytes(getAddress(invoice.token)), 20);
  out.set(uintToBytes(invoice.amount, 16), 40);
  out.set(uintToBytes(invoice.validAfter, 8), 56);
  out.set(uintToBytes(invoice.validUntil, 8), 64);
  out.set(uintToBytes(BigInt(invoice.maxPayments), 4), 72);
  out.set(hexToBytes(invoice.salt), 76);
  out.set(hexToBytes(invoice.memoHash), 108);
  return out;
}

/** Unpacks exactly 140 bytes. Addresses come back EIP-55 checksummed, hashes as lowercase hex. */
export function unpackInvoice(bytes: Uint8Array): Invoice {
  assertArgument(bytes.length === PACKED_INVOICE_LENGTH, `a packed invoice is ${PACKED_INVOICE_LENGTH} bytes`);
  return {
    payee: getAddress(sliceHex(bytes, 0, 20)),
    token: getAddress(sliceHex(bytes, 20, 40)),
    amount: bytesToUint(bytes.subarray(40, 56)),
    validAfter: bytesToUint(bytes.subarray(56, 64)),
    validUntil: bytesToUint(bytes.subarray(64, 72)),
    maxPayments: Number(bytesToUint(bytes.subarray(72, 76))),
    salt: sliceHex(bytes, 76, 108),
    memoHash: sliceHex(bytes, 108, 140),
  };
}
