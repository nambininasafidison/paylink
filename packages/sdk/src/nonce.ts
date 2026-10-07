// SPDX-License-Identifier: MIT
/**
 * The payment binding (invoice spec §8.2): the EIP-3009 token nonce that ties a payer's authorization to
 * exactly one `(key, payer, amount, payerRef, payerSalt)`. The contract recomputes it on-chain
 * (`paymentNonce`), so a relayer that changes anything gets a token-side signature failure (invariant I8).
 */
import { encodeAbiParameters, keccak256 } from "viem";
import type { Hex } from "viem";
import { isBytes32 } from "./bytes.ts";
import { MAX_UINT128, PAYMENT_BINDING_TYPEHASH } from "./constants.ts";
import { assertArgument } from "./errors.ts";
import type { PaymentBinding } from "./types.ts";

const BINDING_PARAMETERS = [
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "address" },
  { type: "uint128" },
  { type: "bytes32" },
  { type: "bytes32" },
] as const;

/**
 * `keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payer, amount, payerRef, payerSalt))`: a struct hash,
 * with no `0x1901` prefix and no domain of its own (`key` already commits to the chain and the deployment).
 */
export function paymentNonce(binding: PaymentBinding): Hex {
  assertArgument(isBytes32(binding.key) && isBytes32(binding.payerRef) && isBytes32(binding.payerSalt), "key, payerRef and payerSalt must be bytes32");
  assertArgument(binding.amount >= 0n && binding.amount <= MAX_UINT128, "amount must be a uint128");
  return keccak256(
    encodeAbiParameters(BINDING_PARAMETERS, [
      PAYMENT_BINDING_TYPEHASH,
      binding.key,
      binding.payer,
      binding.amount,
      binding.payerRef,
      binding.payerSalt,
    ]),
  );
}
