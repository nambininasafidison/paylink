// SPDX-License-Identifier: MIT
/**
 * Invoice and receipt URL fragments (invoice spec §10):
 *
 *   invoice:  2.<chainId>.<inv>.<sig>[.<memo>]
 *   receipt:  2.<chainId>.<txHash>.<logIndex>[.<inv>.<sig>[.<memo>]]
 *
 * Decoding follows the twelve steps of §10.5 **in order** and stops at the first failure with its symbolic
 * code, so the user interface can explain each one. It never fetches anything, never percent-decodes, and
 * does bounded work: the 1,200-character cap is checked before anything else. The contract address is
 * never in the link: `verifyingContract` comes from the registry, by chain ID (§4.2).
 */
import type { Registry, Token, V2Target } from "@paylink/chains";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Hex } from "viem";
import { isLowerHex } from "../bytes.ts";
import { MAX_FRAGMENT_LENGTH, MAX_MEMO_BYTES, MAX_SIGNATURE_LENGTH, MAX_UINT53, PACKED_INVOICE_LENGTH, WIRE_VERSION } from "../constants.ts";
import { fail, validateInvoiceParts } from "../validate.ts";
import { PayLinkError } from "../errors.ts";
import { hasMemo } from "../invoice.ts";
import { memoBytes } from "../memo.ts";
import type { ReceiptReference, SignedInvoice } from "../types.ts";
import { base64UrlDecode, base64UrlEncode } from "./base64url.ts";
import { packInvoice, unpackInvoice } from "./packed.ts";

const CHARSET = /^[A-Za-z0-9._-]*$/;
const CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const LOG_INDEX = /^(?:0|[1-9][0-9]{0,15})$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;

/** A decoded, registry-checked invoice link. Signature and on-chain state are checked afterwards (§13.2). */
export interface DecodedInvoiceLink extends SignedInvoice {
  /** The invoice key computed with the registry's `verifyingContract` for `chainId`. */
  readonly key: Hex;
  /** The chain and its canonical deployment (check `deployment.status` before enabling payment). */
  readonly target: V2Target;
  /** The allowlisted token the invoice is denominated in. */
  readonly token: Token;
}

/** A decoded receipt link: the `(chainId, txHash, logIndex)` triple and the optional invoice tail. */
export interface DecodedReceiptLink extends ReceiptReference {
  readonly target: V2Target;
  readonly invoice: DecodedInvoiceLink | null;
}

/** Steps 1 to 5 of §10.5, shared by invoice and receipt fragments. */
function splitFragment(fragment: string, counts: readonly number[], registry: Registry): { segments: string[]; chainId: number; target: V2Target } {
  if (fragment.length > MAX_FRAGMENT_LENGTH) {
    fail("E_FRAGMENT_TOO_LONG", `fragment is ${fragment.length} characters; the limit is ${MAX_FRAGMENT_LENGTH}`);
  }
  if (!CHARSET.test(fragment)) {
    fail("E_FRAGMENT_CHARSET", "fragment has a character outside [A-Za-z0-9._-]");
  }
  const segments = fragment.split(".");
  if (!counts.includes(segments.length) || segments.includes("")) {
    fail("E_SEGMENT_COUNT", `fragment has ${segments.length} segments or an empty one; expected ${counts.join(", ")}`);
  }
  if (segments[0] !== String(WIRE_VERSION)) {
    fail("E_VERSION_UNSUPPORTED", `version ${segments[0] ?? ""} is not supported`, { version: segments[0] ?? "" });
  }
  const chainText = segments[1] ?? "";
  if (!CHAIN_ID.test(chainText) || BigInt(chainText) > MAX_UINT53) {
    fail("E_CHAIN_ID_FORMAT", "chain ID is not a decimal integer in [1, 2^53 - 1]");
  }
  const chainId = Number(chainText);
  const target = registry.v2Target(chainId);
  if (target === undefined) {
    return fail("E_CHAIN_UNKNOWN", `chain ${chainId} has no canonical PayLink v2 deployment in the registry`, { chainId: chainText });
  }
  return { segments, chainId, target };
}

/** Steps 6 to 12 of §10.5 for the `<inv>.<sig>[.<memo>]` segments. */
function decodeInvoiceSegments(
  chainId: number,
  target: V2Target,
  registry: Registry,
  invText: string,
  sigText: string,
  memoText: string | undefined,
): DecodedInvoiceLink {
  // 6. base64url, strict and canonical.
  const packed = base64UrlDecode(invText);
  const signature = base64UrlDecode(sigText);
  const memo = memoText === undefined ? undefined : base64UrlDecode(memoText);
  if (packed === null || signature === null || memo === null) {
    return fail("E_BASE64URL", "a segment is not strict, canonical, unpadded base64url");
  }
  // 7. Invoice length.
  if (packed.length !== PACKED_INVOICE_LENGTH) {
    fail("E_INVOICE_LENGTH", `the invoice is ${packed.length} bytes; expected ${PACKED_INVOICE_LENGTH}`);
  }
  const invoice = unpackInvoice(packed);
  // 8 to 12.
  const checked = validateInvoiceParts({
    chainId,
    target,
    registry,
    invoice,
    signatureLength: signature.length,
    memo: { mode: "attached", bytes: memo },
  });
  return { chainId, invoice, signature: bytesToHex(signature), memo: checked.memo, key: checked.key, target, token: checked.token };
}

/** Decodes an invoice fragment (without the leading `#`), strictly, against the registry (§10.5). */
export function decodeInvoiceFragment(fragment: string, registry: Registry): DecodedInvoiceLink {
  const { segments, chainId, target } = splitFragment(fragment, [4, 5], registry);
  const [, , inv = "", sig = "", memo] = segments;
  return decodeInvoiceSegments(chainId, target, registry, inv, sig, memo);
}

/** Decodes a receipt fragment (§10.6): 4 segments, or 6–7 with the paid invoice. */
export function decodeReceiptFragment(fragment: string, registry: Registry): DecodedReceiptLink {
  const { segments, chainId, target } = splitFragment(fragment, [4, 6, 7], registry);
  const [, , txHash = "", logIndexText = "", inv, sig, memo] = segments;
  if (!TX_HASH.test(txHash) || !LOG_INDEX.test(logIndexText) || BigInt(logIndexText) > MAX_UINT53) {
    fail("E_RECEIPT_FORMAT", "the transaction hash must be 0x + 64 lowercase hex digits and the log index a decimal uint53");
  }
  const invoice = inv === undefined || sig === undefined ? null : decodeInvoiceSegments(chainId, target, registry, inv, sig, memo);
  return { chainId, txHash: txHash as Hex, logIndex: Number(logIndexText), target, invoice };
}

/** Checks what an issuer must check before sharing (§10.5 steps 5, 8–11, §13.1) and returns the segments. */
function encodeInvoiceSegments(link: SignedInvoice): string[] {
  const { invoice, signature, memo } = link;
  if (!Number.isSafeInteger(link.chainId) || link.chainId < 1) {
    fail("E_CHAIN_ID_FORMAT", "chain ID must be an integer in [1, 2^53 - 1]");
  }
  if (invoice.validAfter > MAX_UINT53 || invoice.validUntil > MAX_UINT53) {
    fail("E_UINT53_RANGE", "validAfter and validUntil must be at most 2^53 - 1");
  }
  if (!isLowerHex(signature) || signature.length < 4 || signature.length > 2 + 2 * MAX_SIGNATURE_LENGTH) {
    fail("E_SIGNATURE_LENGTH", `the signature must be 1 to ${MAX_SIGNATURE_LENGTH} bytes of lowercase hex`);
  }
  if (hasMemo(invoice) !== (memo !== null)) {
    fail("E_MEMO_PRESENCE", "pass the memo exactly when memoHash is not zero");
  }
  const segments = [base64UrlEncode(packInvoice(invoice)), base64UrlEncode(hexToBytes(signature))];
  if (memo !== null) {
    const bytes = memoBytes(memo);
    if (bytes.length < 1 || bytes.length > MAX_MEMO_BYTES) {
      fail("E_MEMO_LENGTH", `the memo is ${bytes.length} bytes; expected 1 to ${MAX_MEMO_BYTES}`);
    }
    if (keccak256(bytes) !== invoice.memoHash) {
      fail("E_MEMO_HASH", "the memo does not hash to memoHash");
    }
    segments.push(base64UrlEncode(bytes));
  }
  return segments;
}

/**
 * Encodes a signed invoice as a URL fragment (without `#`). Throws `E_FRAGMENT_TOO_LONG` above 1,200
 * characters: shorten the memo (§10.3). Registry and signature checks belong to the issuer (`issueInvoice`).
 */
export function encodeInvoiceFragment(link: SignedInvoice): string {
  const fragment = [String(WIRE_VERSION), String(link.chainId), ...encodeInvoiceSegments(link)].join(".");
  if (fragment.length > MAX_FRAGMENT_LENGTH) {
    fail("E_FRAGMENT_TOO_LONG", `fragment is ${fragment.length} characters; the limit is ${MAX_FRAGMENT_LENGTH}`, {
      length: String(fragment.length),
    });
  }
  return fragment;
}

/**
 * Encodes a receipt fragment (§10.6). The paid invoice is appended when given, unless the result would
 * exceed 1,200 characters: then the whole tail is omitted, as the spec requires.
 */
export function encodeReceiptFragment(reference: ReceiptReference, paid?: SignedInvoice): string {
  if (!TX_HASH.test(reference.txHash) || !Number.isSafeInteger(reference.logIndex) || reference.logIndex < 0) {
    fail("E_RECEIPT_FORMAT", "the transaction hash must be 0x + 64 lowercase hex digits and the log index a uint53");
  }
  if (!Number.isSafeInteger(reference.chainId) || reference.chainId < 1) {
    fail("E_CHAIN_ID_FORMAT", "chain ID must be an integer in [1, 2^53 - 1]");
  }
  const head = [String(WIRE_VERSION), String(reference.chainId), reference.txHash, String(reference.logIndex)];
  if (paid !== undefined) {
    if (paid.chainId !== reference.chainId) {
      fail("E_RECEIPT_FORMAT", "the paid invoice is for another chain");
    }
    const full = [...head, ...encodeInvoiceSegments(paid)].join(".");
    if (full.length <= MAX_FRAGMENT_LENGTH) {
      return full;
    }
  }
  return head.join(".");
}

/** The fragment of a URL, verbatim (no percent-decoding, §10.5 step 2), or `""` when there is none. */
export function fragmentOf(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? "" : url.slice(hash + 1);
}

/** `base#fragment`. The base (origin and path) is a deployment choice and is not signed (§10.1). */
export function withFragment(base: string, fragment: string): string {
  if (base.includes("#")) {
    throw new PayLinkError("E_INVALID_ARGUMENT", "the base URL must not already carry a fragment");
  }
  return `${base}#${fragment}`;
}
