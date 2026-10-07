// SPDX-License-Identifier: MIT
/**
 * The canonical JSON forms of invoice spec §11 (docs/spec/paylink-invoice-v2.schema.json): signed invoices
 * for device export and import, relayer request bodies, cancellation authorizations and receipt
 * references. Serialisers write exactly the schema's form (uint128/uint256 as decimal strings, times as
 * uint53 integers, EIP-55 addresses, lowercase hex). Parsers are strict: unknown properties, wrong types,
 * out-of-range numbers and mis-checksummed mixed-case addresses are refused with the offending path, and
 * `parseSignedInvoiceJson` then applies the same registry checks as the URL decoder.
 */
import type { Registry } from "@paylink/chains";
import { getAddress, hexToBytes, isAddress, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { isBytes32 } from "./bytes.ts";
import type { DecodedInvoiceLink } from "./codec/fragment.ts";
import { EMPTY_STRING_HASH, MAX_SIGNATURE_LENGTH, MAX_UINT128, MAX_UINT256, MAX_UINT32, WIRE_VERSION } from "./constants.ts";
import { PayLinkError } from "./errors.ts";
import { memoBytes } from "./memo.ts";
import type { Authorization, CancelAuthorization, Invoice, ReceiptReference, SignedInvoice } from "./types.ts";
import { fail, resolveTarget, validateInvoiceParts } from "./validate.ts";

export interface InvoiceJson {
  readonly payee: string;
  readonly token: string;
  readonly amount: string;
  readonly validAfter: number;
  readonly validUntil: number;
  readonly maxPayments: number;
  readonly salt: string;
  readonly memoHash: string;
}

export interface SignedInvoiceJson {
  readonly version: 2;
  readonly chainId: number;
  readonly invoice: InvoiceJson;
  readonly payeeSig: string;
  readonly memo?: string;
  readonly key?: string;
}

export interface PaymentAuthorizationJson {
  readonly payer: string;
  readonly amount: string;
  readonly payerRef: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly payerSalt: string;
  readonly v: 27 | 28;
  readonly r: string;
  readonly s: string;
}

export interface RelayPayRequestJson {
  readonly chainId: number;
  readonly invoice: InvoiceJson;
  readonly payeeSig: string;
  readonly authorization: PaymentAuthorizationJson;
}

export interface CancelAuthorizationJson {
  readonly chainId: number;
  readonly invoice: InvoiceJson;
  readonly deadline: string;
  readonly payeeSig: string;
}

export interface ReceiptReferenceJson {
  readonly chainId: number;
  readonly txHash: string;
  readonly logIndex: number;
}

// --------------------------------------------------------------------------------- serialisers

function uint53(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("E_UINT53_RANGE", `${field} is outside the uint53 range of the JSON form`, { field });
  }
  return Number(value);
}

export function toInvoiceJson(invoice: Invoice): InvoiceJson {
  return {
    payee: getAddress(invoice.payee),
    token: getAddress(invoice.token),
    amount: invoice.amount.toString(),
    validAfter: uint53(invoice.validAfter, "validAfter"),
    validUntil: uint53(invoice.validUntil, "validUntil"),
    maxPayments: invoice.maxPayments,
    salt: invoice.salt.toLowerCase(),
    memoHash: invoice.memoHash.toLowerCase(),
  };
}

/** The `SignedInvoice` root of the schema, with the optional redundant `key`. */
export function toSignedInvoiceJson(signed: SignedInvoice, key?: Hex): SignedInvoiceJson {
  return {
    version: WIRE_VERSION,
    chainId: signed.chainId,
    invoice: toInvoiceJson(signed.invoice),
    payeeSig: signed.signature.toLowerCase(),
    ...(signed.memo === null ? {} : { memo: signed.memo }),
    ...(key === undefined ? {} : { key }),
  };
}

function toAuthorizationJson(authorization: Authorization): PaymentAuthorizationJson {
  if (authorization.v !== 27 && authorization.v !== 28) {
    throw new PayLinkError("E_INVALID_ARGUMENT", "v must be 27 or 28", { path: "authorization.v" });
  }
  return {
    payer: getAddress(authorization.payer),
    amount: authorization.amount.toString(),
    payerRef: authorization.payerRef,
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    payerSalt: authorization.payerSalt,
    v: authorization.v,
    r: authorization.r,
    s: authorization.s,
  };
}

/** The relayer's `POST /v1/{chainId}/pay` body (§11.2). The memo is never part of it. */
export function toRelayPayRequest(link: Pick<SignedInvoice, "chainId" | "invoice" | "signature">, authorization: Authorization): RelayPayRequestJson {
  return {
    chainId: link.chainId,
    invoice: toInvoiceJson(link.invoice),
    payeeSig: link.signature,
    authorization: toAuthorizationJson(authorization),
  };
}

/** The relayer's `POST /v1/{chainId}/cancel` body (§11.2). */
export function toCancelAuthorizationJson(cancel: CancelAuthorization): CancelAuthorizationJson {
  return { chainId: cancel.chainId, invoice: toInvoiceJson(cancel.invoice), deadline: cancel.deadline.toString(), payeeSig: cancel.signature };
}

export function toReceiptReferenceJson(reference: ReceiptReference): ReceiptReferenceJson {
  return { chainId: reference.chainId, txHash: reference.txHash, logIndex: reference.logIndex };
}

// ------------------------------------------------------------------------------------- parsers

type JsonObject = Readonly<Record<string, unknown>>;

const bad = (path: string, rule: string): never => {
  throw new PayLinkError("E_INVALID_ARGUMENT", `${path}: ${rule}`, { path });
};

function object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad(path, "must be an object");
  }
  const record = value as JsonObject;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      bad(`${path}.${key}`, "unknown property");
    }
  }
  for (const key of required) {
    if (!(key in record)) {
      bad(`${path}.${key}`, "is required");
    }
  }
  return record;
}

function address(value: unknown, path: string): Address {
  // A mixed-case address must carry a valid EIP-55 checksum (§11.1); all-lowercase is accepted.
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || !isAddress(value, { strict: true })) {
    return bad(path, "must be an address with a valid EIP-55 checksum");
  }
  return getAddress(value);
}

function bytes32(value: unknown, path: string): Hex {
  return isBytes32(value) ? value : bad(path, "must be 32 bytes of lowercase hex");
}

function decimal(value: unknown, path: string, max: bigint, digits: number): bigint {
  if (typeof value !== "string" || !new RegExp(`^(?:0|[1-9][0-9]{0,${digits - 1}})$`).test(value) || BigInt(value) > max) {
    return bad(path, "must be a canonical decimal string in range");
  }
  return BigInt(value);
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return bad(path, `must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function signatureHex(value: unknown, path: string): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2}){1,512}$/.test(value)) {
    return bad(path, `must be 1 to ${MAX_SIGNATURE_LENGTH} bytes of lowercase hex`);
  }
  return value as Hex;
}

const chainId = (value: unknown, path: string): number => integer(value, path, 1, Number.MAX_SAFE_INTEGER);

/** Parses the schema's `Invoice` definition. */
export function parseInvoiceJson(value: unknown, path = "invoice"): Invoice {
  const o = object(value, path, ["payee", "token", "amount", "validAfter", "validUntil", "maxPayments", "salt", "memoHash"]);
  const payee = address(o["payee"], `${path}.payee`);
  if (payee === zeroAddress) {
    bad(`${path}.payee`, "must not be the zero address");
  }
  const memoHash = bytes32(o["memoHash"], `${path}.memoHash`);
  if (memoHash === EMPTY_STRING_HASH) {
    bad(`${path}.memoHash`, 'must not be keccak256(""): an empty memo is 32 zero bytes');
  }
  return {
    payee,
    token: address(o["token"], `${path}.token`),
    amount: decimal(o["amount"], `${path}.amount`, MAX_UINT128, 39),
    validAfter: BigInt(integer(o["validAfter"], `${path}.validAfter`, 0, Number.MAX_SAFE_INTEGER)),
    validUntil: BigInt(integer(o["validUntil"], `${path}.validUntil`, 0, Number.MAX_SAFE_INTEGER)),
    maxPayments: integer(o["maxPayments"], `${path}.maxPayments`, 0, Number(MAX_UINT32)),
    salt: bytes32(o["salt"], `${path}.salt`),
    memoHash,
  };
}

/**
 * Parses a signed invoice (device import, §11) and applies the registry checks of the URL decoder: canonical
 * deployment, signature length, memo presence, bytes and hash, shape and token allowlist. A `key`, when
 * present, must equal the key recomputed with the registry's `verifyingContract`.
 */
export function parseSignedInvoiceJson(value: unknown, registry: Registry): DecodedInvoiceLink {
  const o = object(value, "$", ["version", "chainId", "invoice", "payeeSig"], ["memo", "key"]);
  if (o["version"] !== WIRE_VERSION) {
    fail("E_VERSION_UNSUPPORTED", `version ${String(o["version"])} is not supported`);
  }
  const id = chainId(o["chainId"], "$.chainId");
  const invoice = parseInvoiceJson(o["invoice"], "$.invoice");
  const signature = signatureHex(o["payeeSig"], "$.payeeSig");
  let memo: Uint8Array | undefined;
  if ("memo" in o) {
    const text = o["memo"];
    if (typeof text !== "string" || text.length === 0) {
      return bad("$.memo", "must be a non-empty string");
    }
    if (/\p{Surrogate}/u.test(text)) {
      fail("E_MEMO_UTF8", "the memo contains an unpaired surrogate");
    }
    memo = memoBytes(text);
  }
  const target = resolveTarget(id, registry);
  const checked = validateInvoiceParts({
    chainId: id,
    target,
    registry,
    invoice,
    signatureLength: hexToBytes(signature).length,
    memo: { mode: "attached", bytes: memo },
  });
  if ("key" in o && bytes32(o["key"], "$.key") !== checked.key) {
    bad("$.key", "does not match the key recomputed with the registry's verifyingContract");
  }
  return { chainId: id, invoice, signature, memo: checked.memo, key: checked.key, target, token: checked.token };
}

function parseAuthorization(value: unknown, path: string): Authorization {
  const o = object(value, path, ["payer", "amount", "payerRef", "validAfter", "validBefore", "payerSalt", "v", "r", "s"]);
  const v = o["v"];
  if (v !== 27 && v !== 28) {
    return bad(`${path}.v`, "must be 27 or 28");
  }
  return {
    payer: address(o["payer"], `${path}.payer`),
    amount: decimal(o["amount"], `${path}.amount`, MAX_UINT128, 39),
    payerRef: bytes32(o["payerRef"], `${path}.payerRef`),
    validAfter: decimal(o["validAfter"], `${path}.validAfter`, MAX_UINT256, 78),
    validBefore: decimal(o["validBefore"], `${path}.validBefore`, MAX_UINT256, 78),
    payerSalt: bytes32(o["payerSalt"], `${path}.payerSalt`),
    v,
    r: bytes32(o["r"], `${path}.r`),
    s: bytes32(o["s"], `${path}.s`),
  };
}

/** A relayer pay request, structurally parsed. The relayer then applies §13.3 (`validateInvoiceParts`, nonce, simulation). */
export interface RelayPayRequest {
  readonly chainId: number;
  readonly invoice: Invoice;
  readonly signature: Hex;
  readonly authorization: Authorization;
}

export function parseRelayPayRequest(value: unknown): RelayPayRequest {
  const o = object(value, "$", ["chainId", "invoice", "payeeSig", "authorization"]);
  return {
    chainId: chainId(o["chainId"], "$.chainId"),
    invoice: parseInvoiceJson(o["invoice"], "$.invoice"),
    signature: signatureHex(o["payeeSig"], "$.payeeSig"),
    authorization: parseAuthorization(o["authorization"], "$.authorization"),
  };
}

export function parseCancelAuthorizationJson(value: unknown): CancelAuthorization {
  const o = object(value, "$", ["chainId", "invoice", "deadline", "payeeSig"]);
  return {
    chainId: chainId(o["chainId"], "$.chainId"),
    invoice: parseInvoiceJson(o["invoice"], "$.invoice"),
    deadline: decimal(o["deadline"], "$.deadline", MAX_UINT256, 78),
    signature: signatureHex(o["payeeSig"], "$.payeeSig"),
  };
}

export function parseReceiptReferenceJson(value: unknown): ReceiptReference {
  const o = object(value, "$", ["chainId", "txHash", "logIndex"]);
  return {
    chainId: chainId(o["chainId"], "$.chainId"),
    txHash: bytes32(o["txHash"], "$.txHash"),
    logIndex: integer(o["logIndex"], "$.logIndex", 0, Number.MAX_SAFE_INTEGER),
  };
}
