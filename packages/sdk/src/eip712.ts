// SPDX-License-Identifier: MIT
/**
 * EIP-712 domain, types and hashes of PayLink v2 (invoice spec §4, §5, §9) and of the token's EIP-3009
 * `ReceiveWithAuthorization` (§8.3). Every function is pure; golden vectors from the Solidity side
 * (protocol/test/vectors) pin the results byte for byte.
 */
import { hashDomain, hashStruct, hashTypedData } from "viem";
import type { Address, Hex } from "viem";
import { DOMAIN_NAME, DOMAIN_VERSION } from "./constants.ts";
import type { Invoice } from "./types.ts";

/** `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`; there is no salt. */
export const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export const INVOICE_TYPES = {
  Invoice: [
    { name: "payee", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint128" },
    { name: "validAfter", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "maxPayments", type: "uint32" },
    { name: "salt", type: "bytes32" },
    { name: "memoHash", type: "bytes32" },
  ],
} as const;

export const CANCEL_TYPES = {
  Cancel: [
    { name: "key", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** A complete EIP-712 domain with the four fields PayLink and EIP-3009 tokens use. */
export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

/** Where a PayLink signature is valid: one deployment on one chain. */
export interface PayLinkDeployment {
  readonly chainId: number;
  readonly verifyingContract: Address;
}

/** The PayLink domain `{name: "PayLink", version: "2", chainId, verifyingContract}` (§4.1). */
export function payLinkDomain({ chainId, verifyingContract }: PayLinkDeployment): Eip712Domain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract };
}

/** `domainSeparator = hashStruct(EIP712Domain)` of any four-field domain. */
export function domainSeparator(domain: Eip712Domain): Hex {
  return hashDomain({ domain: { ...domain, chainId: BigInt(domain.chainId) }, types: { EIP712Domain: EIP712_DOMAIN_FIELDS } });
}

/** `hashStruct(Invoice)`: the struct hash, independent of chain and deployment. */
export function invoiceStructHash(invoice: Invoice): Hex {
  return hashStruct({ data: { ...invoice }, primaryType: "Invoice", types: INVOICE_TYPES });
}

/** EIP-712 typed data ready for `eth_signTypedData_v4` or viem's `signTypedData`. */
export interface TypedDataPayload<PrimaryType extends string, Types, Message> {
  readonly domain: Eip712Domain;
  readonly types: Types;
  readonly primaryType: PrimaryType;
  readonly message: Message;
}

export type InvoiceTypedData = TypedDataPayload<"Invoice", typeof INVOICE_TYPES, Invoice>;
export type CancelTypedData = TypedDataPayload<"Cancel", typeof CANCEL_TYPES, { readonly key: Hex; readonly deadline: bigint }>;

/** The typed data a payee signs for an invoice (`eth_signTypedData_v4`, primaryType `Invoice`). */
export function invoiceTypedData(deployment: PayLinkDeployment, invoice: Invoice): InvoiceTypedData {
  return {
    domain: payLinkDomain(deployment),
    types: INVOICE_TYPES,
    primaryType: "Invoice" as const,
    message: { ...invoice },
  };
}

/**
 * The invoice key: the EIP-712 digest of the invoice under the deployment's domain (§5.1). It is the link id
 * on-chain, in events and in every index; it commits to the chain and the deployment.
 */
export function invoiceKey(deployment: PayLinkDeployment, invoice: Invoice): Hex {
  return hashTypedData(invoiceTypedData(deployment, invoice));
}

/** `hashStruct(Cancel{key, deadline})`. */
export function cancelStructHash(key: Hex, deadline: bigint): Hex {
  return hashStruct({ data: { key, deadline }, primaryType: "Cancel", types: CANCEL_TYPES });
}

/** The typed data a payee signs to cancel through `cancelBySig` (§9.2). */
export function cancelTypedData(deployment: PayLinkDeployment, key: Hex, deadline: bigint): CancelTypedData {
  return {
    domain: payLinkDomain(deployment),
    types: CANCEL_TYPES,
    primaryType: "Cancel" as const,
    message: { key, deadline },
  };
}

/** `cancelDigest = keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(Cancel))` (§9.2). */
export function cancelDigest(deployment: PayLinkDeployment, key: Hex, deadline: bigint): Hex {
  return hashTypedData(cancelTypedData(deployment, key, deadline));
}

/** The token's EIP-3009 `ReceiveWithAuthorization` message for one payment (§8.3). */
export interface ReceiveWithAuthorizationMessage {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
}

export type ReceiveWithAuthorizationTypedData = TypedDataPayload<
  "ReceiveWithAuthorization",
  typeof RECEIVE_WITH_AUTHORIZATION_TYPES,
  ReceiveWithAuthorizationMessage
>;

/** Typed data for the token's `ReceiveWithAuthorization`, under the **token's** domain. */
export function receiveWithAuthorizationTypedData(
  tokenDomain: Eip712Domain,
  message: ReceiveWithAuthorizationMessage,
): ReceiveWithAuthorizationTypedData {
  return {
    domain: { ...tokenDomain },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: { ...message },
  };
}

/** The digest the payer's EIP-3009 signature covers. */
export function receiveWithAuthorizationDigest(tokenDomain: Eip712Domain, message: ReceiveWithAuthorizationMessage): Hex {
  return hashTypedData(receiveWithAuthorizationTypedData(tokenDomain, message));
}
