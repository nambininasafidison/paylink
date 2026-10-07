// SPDX-License-Identifier: MIT
/**
 * Transaction requests for every PayLinkV2 entry point (spec §3.3.2, §7.4), ready for a wallet's
 * `eth_sendTransaction`, an EIP-5792 `wallet_sendCalls` batch, or the relayer. Only `payNative` carries
 * value; the relayer only ever sends `payWithAuthorization` and `cancelBySig`, with `value = 0` (§13.3).
 */
import { encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import { erc20ApproveAbi, payLinkV2Abi } from "./abi.ts";
import { ZERO_HASH } from "./constants.ts";
import { assertArgument } from "./errors.ts";
import type { Authorization, CancelAuthorization, Invoice, Permit } from "./types.ts";

/** A call: target, calldata and value in wei. */
export interface CallRequest {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

const call = (to: Address, data: Hex, value = 0n): CallRequest => ({ to, data, value });

export function payWithAuthorizationCall(contract: Address, invoice: Invoice, payeeSig: Hex, authorization: Authorization): CallRequest {
  return call(
    contract,
    encodeFunctionData({ abi: payLinkV2Abi, functionName: "payWithAuthorization", args: [{ ...invoice }, payeeSig, { ...authorization }] }),
  );
}

export function payCall(contract: Address, invoice: Invoice, payeeSig: Hex, amount: bigint, payerRef: Hex = ZERO_HASH): CallRequest {
  return call(contract, encodeFunctionData({ abi: payLinkV2Abi, functionName: "pay", args: [{ ...invoice }, payeeSig, amount, payerRef] }));
}

export function payWithPermitCall(contract: Address, invoice: Invoice, payeeSig: Hex, amount: bigint, permit: Permit, payerRef: Hex = ZERO_HASH): CallRequest {
  return call(
    contract,
    encodeFunctionData({ abi: payLinkV2Abi, functionName: "payWithPermit", args: [{ ...invoice }, payeeSig, amount, payerRef, { ...permit }] }),
  );
}

/** `payNative`: the amount is the call's value (`msg.value`). */
export function payNativeCall(contract: Address, invoice: Invoice, payeeSig: Hex, amount: bigint, payerRef: Hex = ZERO_HASH): CallRequest {
  assertArgument(amount > 0n, "a native payment needs a positive value");
  return call(contract, encodeFunctionData({ abi: payLinkV2Abi, functionName: "payNative", args: [{ ...invoice }, payeeSig, payerRef] }), amount);
}

/** `cancel(inv)`, sent by the payee itself. */
export function cancelCall(contract: Address, invoice: Invoice): CallRequest {
  return call(contract, encodeFunctionData({ abi: payLinkV2Abi, functionName: "cancel", args: [{ ...invoice }] }));
}

/** `cancelBySig(inv, deadline, sig)`, relayable by anyone. */
export function cancelBySigCall(contract: Address, cancel: CancelAuthorization): CallRequest {
  return call(contract, encodeFunctionData({ abi: payLinkV2Abi, functionName: "cancelBySig", args: [{ ...cancel.invoice }, cancel.deadline, cancel.signature] }));
}

/** ERC-20 `approve(PayLinkV2, amount)`, for exactly the payment amount, never unlimited (§13.2). */
export function approveCall(token: Address, contract: Address, amount: bigint): CallRequest {
  assertArgument(amount > 0n, "approve exactly the positive payment amount");
  return call(token, encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [contract, amount] }));
}
