// SPDX-License-Identifier: MIT
/**
 * Every protocol constant is recomputed from its definition, and the generated ABI is checked against the
 * literal selector tables of the invoice spec (§7.6 errors, §17.2 functions) and, when a local build exists,
 * against the Foundry artifact itself.
 */
import { existsSync } from "node:fs";
import { keccak256, stringToHex, toEventSelector, toFunctionSelector } from "viem";
import type { Abi, AbiEvent, AbiFunction } from "viem";

type AbiError = Extract<Abi[number], { type: "error" }>;
import { describe, expect, it } from "vitest";
import { ARTIFACT, readArtifactAbi, renderAbi } from "../scripts/generate-abi.ts";
import {
  CANCEL_AUTHORIZATION_TYPE,
  CANCEL_AUTHORIZATION_TYPEHASH,
  CANCEL_TYPE,
  CANCEL_TYPEHASH,
  DEFAULT_AUTHORIZATION_TTL_SECONDS,
  DEFAULT_CANCEL_TTL_SECONDS,
  DEFAULT_INVOICE_TTL_SECONDS,
  EIP712_DOMAIN_TYPE,
  EIP712_DOMAIN_TYPEHASH,
  EMPTY_STRING_HASH,
  ERC1271_MAGIC_VALUE,
  INVOICE_CANCELLED_TOPIC,
  INVOICE_TYPE,
  INVOICE_TYPEHASH,
  MAX_UINT53,
  PAID_TOPIC,
  PAYMENT_BINDING_TYPE,
  PAYMENT_BINDING_TYPEHASH,
  payLinkV2Abi,
  RECEIVE_WITH_AUTHORIZATION_TYPE,
  RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
  SECP256K1_HALF_ORDER,
} from "../src/index.ts";

const signature = (item: AbiFunction | AbiError | AbiEvent): string => {
  const type = (p: { type: string; components?: readonly { type: string }[] }): string =>
    p.type.startsWith("tuple") ? `(${(p.components ?? []).map(type).join(",")})${p.type.slice(5)}` : p.type;
  return `${item.name}(${item.inputs.map(type).join(",")})`;
};

describe("type hashes and topics (spec §17.1)", () => {
  it.each([
    [EIP712_DOMAIN_TYPE, EIP712_DOMAIN_TYPEHASH],
    [INVOICE_TYPE, INVOICE_TYPEHASH],
    [CANCEL_TYPE, CANCEL_TYPEHASH],
    [PAYMENT_BINDING_TYPE, PAYMENT_BINDING_TYPEHASH],
    [RECEIVE_WITH_AUTHORIZATION_TYPE, RECEIVE_WITH_AUTHORIZATION_TYPEHASH],
    [CANCEL_AUTHORIZATION_TYPE, CANCEL_AUTHORIZATION_TYPEHASH],
    ["Paid(bytes32,address,address,address,uint128,uint32,bytes32)", PAID_TOPIC],
    ["InvoiceCancelled(bytes32,address)", INVOICE_CANCELLED_TOPIC],
    ["", EMPTY_STRING_HASH],
  ])("keccak256(%j)", (text, hash) => {
    expect(keccak256(stringToHex(text))).toBe(hash);
  });

  it("derives the ERC-1271 magic value, the low-s bound and the time defaults", () => {
    expect(toFunctionSelector("isValidSignature(bytes32,bytes)")).toBe(ERC1271_MAGIC_VALUE);
    expect(SECP256K1_HALF_ORDER).toBe(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n / 2n);
    expect(MAX_UINT53).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect([DEFAULT_INVOICE_TTL_SECONDS, DEFAULT_CANCEL_TTL_SECONDS, DEFAULT_AUTHORIZATION_TTL_SECONDS]).toEqual([604_800n, 3_600n, 600n]);
  });
});

describe("ABI (spec §7.6, §17.2)", () => {
  const items = payLinkV2Abi as readonly (AbiFunction | AbiError | AbiEvent | { type: string })[];
  const byType = <T extends AbiFunction | AbiError | AbiEvent>(type: T["type"]): T[] => items.filter((i): i is T => i.type === type);

  it("has exactly the function selectors of §17.2 and the public constants", () => {
    const functions = Object.fromEntries(byType<AbiFunction>("function").map((f) => [signature(f), toFunctionSelector(f)]));
    const invoice = "(address,address,uint128,uint64,uint64,uint32,bytes32,bytes32)";
    expect(functions).toEqual({
      [`payWithAuthorization(${invoice},bytes,(address,uint128,bytes32,uint256,uint256,bytes32,uint8,bytes32,bytes32))`]: "0xa4c514ef",
      [`cancelBySig(${invoice},uint256,bytes)`]: "0x47e6460e",
      [`pay(${invoice},bytes,uint128,bytes32)`]: "0x861df419",
      [`payWithPermit(${invoice},bytes,uint128,bytes32,(uint256,uint8,bytes32,bytes32))`]: "0x7b0a31f7",
      [`payNative(${invoice},bytes,bytes32)`]: "0x19a6b20e",
      [`cancel(${invoice})`]: "0xb7eb2e37",
      [`invoiceKey(${invoice})`]: "0x4eeaa709",
      "paymentNonce(bytes32,address,uint128,bytes32,bytes32)": "0x2ec920ac",
      "stateOf(bytes32)": "0x64482ac4",
      "statesOf(bytes32[])": "0xf8b72a0b",
      "eip712Domain()": "0x84b0196e",
      "INVOICE_TYPEHASH()": "0x4fe1681a",
      "CANCEL_TYPEHASH()": "0x73fca6ea",
      "PAYMENT_BINDING_TYPEHASH()": "0xda66ed9f",
    });
  });

  it("has the error selectors of §7.6, including the inherited OpenZeppelin errors", () => {
    const errors = Object.fromEntries(byType<AbiError>("error").map((e) => [signature(e), toFunctionSelector(signature(e))]));
    expect(errors).toEqual({
      "InvalidInvoice()": "0x93fe191e",
      "InvalidSignature()": "0x8baa579f",
      "SignatureExpired(uint256)": "0xcd21db4f",
      "NotPayee()": "0x56cab67b",
      "Cancelled()": "0x63b95884",
      "NotYetValid(uint64)": "0x2d5d879e",
      "Expired(uint64)": "0x95693653",
      "SoldOut(uint32)": "0x1166dd6e",
      "WrongAmount(uint128,uint128)": "0x96eb4103",
      "WrongPaymentPath()": "0x99c891ea",
      "SelfPayment()": "0x82987a24",
      "ReceivedMismatch(uint256,uint256)": "0x53ee4726",
      "PayeeShortPaid(uint256,uint256)": "0x9de8f254",
      "BatchTooLarge(uint256)": "0xa67b9f9e",
      "ReentrancyGuardReentrantCall()": "0x3ee5aeb5",
      "SafeERC20FailedOperation(address)": "0x5274afe7",
      "InsufficientBalance(uint256,uint256)": "0xcf479181",
      "FailedCall()": "0xd6bda275",
      "InvalidShortString()": "0xb3512b0c",
      "StringTooLong(string)": "0x305a27a9",
    });
  });

  it("has the Paid and InvoiceCancelled events with their topics", () => {
    const events = Object.fromEntries(byType<AbiEvent>("event").map((e) => [e.name, toEventSelector(e)]));
    expect(events["Paid"]).toBe(PAID_TOPIC);
    expect(events["InvoiceCancelled"]).toBe(INVOICE_CANCELLED_TOPIC);
    expect(Object.keys(events).sort()).toEqual(["EIP712DomainChanged", "InvoiceCancelled", "Paid"]);
  });

  it("has receive and fallback, and only payNative is payable", () => {
    expect(items.some((i) => i.type === "receive")).toBe(true);
    expect(items.some((i) => i.type === "fallback")).toBe(true);
    expect(byType<AbiFunction>("function").filter((f) => f.stateMutability === "payable").map((f) => f.name)).toEqual(["payNative"]);
  });

  it("renders deterministically", () => {
    expect(renderAbi(payLinkV2Abi)).toBe(renderAbi(payLinkV2Abi));
    expect(renderAbi([])).toContain("export const payLinkV2Abi = [] as const;");
  });

  // protocol/out is a local build artifact (git-ignored). CI's contracts job builds it; elsewhere this check is
  // skipped and the selector tables above still pin the ABI.
  it.skipIf(!existsSync(ARTIFACT))("equals the Foundry artifact of the release build", () => {
    expect(readArtifactAbi()).toEqual(JSON.parse(JSON.stringify(payLinkV2Abi)));
  });

  it("refuses an artifact without an ABI", () => {
    expect(() => readArtifactAbi(new URL("./fixtures/paylinkv2-runtime-31337.json", import.meta.url).pathname)).toThrow(/no abi array/);
  });
});
