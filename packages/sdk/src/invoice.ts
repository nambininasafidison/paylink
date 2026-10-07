// SPDX-License-Identifier: MIT
/**
 * Building invoices (invoice spec §3, §13.1) and the rules every invoice must satisfy before it is signed,
 * encoded or paid. The contract checks the same shape rules (`InvalidInvoice`); the uint53 rule is the
 * client-side wire limit (§3.1).
 */
import { getAddress, isAddress, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { isBytes32 } from "./bytes.ts";
import { DEFAULT_INVOICE_TTL_SECONDS, MAX_UINT128, MAX_UINT32, MAX_UINT53, ZERO_HASH } from "./constants.ts";
import { assertArgument, PayLinkError } from "./errors.ts";
import { hashMemo, normalizeMemo } from "./memo.ts";
import { cryptoRandom, randomBytes32 } from "./random.ts";
import type { RandomSource } from "./random.ts";
import type { Invoice } from "./types.ts";

/**
 * When an invoice stops being payable. `never` (validUntil = 0) requires an explicit confirmation from the
 * payee (spec §13.1), which the type makes impossible to forget.
 */
export type Expiry = { readonly kind: "at"; readonly validUntil: bigint } | { readonly kind: "never"; readonly confirmed: true };

/** Expiry `seconds` after `now` (chain time preferred, spec §2.3). The default is 7 days. */
export function expiresIn(now: bigint, seconds: bigint = DEFAULT_INVOICE_TTL_SECONDS): Expiry {
  assertArgument(seconds > 0n, "the validity must be positive");
  return { kind: "at", validUntil: now + seconds };
}

/** What an issuer fills in. Addresses may be in any case; they are checksummed. */
export interface InvoiceDraft {
  readonly payee: string;
  /** ERC-20 address, or the zero address for the native coin. */
  readonly token: string;
  /** Base units; 0n for an open amount. */
  readonly amount: bigint;
  readonly maxPayments: number;
  readonly expiry: Expiry;
  /** Default 0 (payable immediately). */
  readonly validAfter?: bigint;
  /** Free text, at most 280 UTF-8 bytes after NFC normalisation. Empty means no memo. */
  readonly memo?: string | null;
  /** Fixed salt, for tests and vectors only. Real invoices use a fresh CSPRNG salt (spec §14.6). */
  readonly salt?: Hex;
}

export interface BuiltInvoice {
  readonly invoice: Invoice;
  /** The NFC-normalised memo that `invoice.memoHash` commits to, or `null`. */
  readonly memo: string | null;
}

function checksum(value: string, field: string): Address {
  // Strict: a mixed-case address must carry a valid EIP-55 checksum (a typo guard, spec §11.1).
  assertArgument(isAddress(value, { strict: true }), `${field} is not an address with a valid EIP-55 checksum`, { field });
  return getAddress(value);
}

/**
 * Builds an invoice from a draft: checksums addresses, draws a CSPRNG salt, normalises and hashes the memo,
 * and applies the field rules of spec §3.1 (including the uint53 rule). Shape rules that involve the
 * deployment address are checked by `invoiceShapeIssue` once the chain is known.
 */
export function buildInvoice(draft: InvoiceDraft, random: RandomSource = cryptoRandom): BuiltInvoice {
  const payee = checksum(draft.payee, "payee");
  const token = checksum(draft.token, "token");
  assertArgument(payee !== zeroAddress, "the payee cannot be the zero address");
  assertArgument(draft.amount >= 0n && draft.amount <= MAX_UINT128, "amount must be a uint128");
  assertArgument(Number.isInteger(draft.maxPayments) && draft.maxPayments >= 0 && BigInt(draft.maxPayments) <= MAX_UINT32, "maxPayments must be a uint32");
  const validAfter = draft.validAfter ?? 0n;
  let validUntil: bigint;
  if (draft.expiry.kind === "at") {
    validUntil = draft.expiry.validUntil;
    assertArgument(validUntil > 0n, "use { kind: 'never', confirmed: true } for an invoice without expiry");
  } else {
    // Widened on purpose: plain-JavaScript callers can pass anything.
    const confirmed: unknown = draft.expiry.confirmed;
    assertArgument(confirmed === true, "an invoice without expiry needs explicit confirmation");
    validUntil = 0n;
  }
  for (const [field, value] of [["validAfter", validAfter], ["validUntil", validUntil]] as const) {
    if (value < 0n || value > MAX_UINT53) {
      throw new PayLinkError("E_UINT53_RANGE", `${field} must be within [0, 2^53 - 1]`, { field });
    }
  }
  assertArgument(validUntil === 0n || validUntil >= validAfter, "validUntil must not be before validAfter");
  const memoText = draft.memo === undefined || draft.memo === null || draft.memo === "" ? null : normalizeMemo(draft.memo);
  const salt = draft.salt ?? randomBytes32(random);
  assertArgument(isBytes32(salt), "salt must be 32 bytes of lowercase hex");
  const invoice: Invoice = {
    payee,
    token,
    amount: draft.amount,
    validAfter,
    validUntil,
    maxPayments: draft.maxPayments,
    salt,
    memoHash: hashMemo(memoText),
  };
  return { invoice, memo: memoText };
}

/** Why an invoice fails the contract's shape check (`InvalidInvoice`, spec §7.2 #1). */
export type InvoiceShapeIssue = "payee-zero" | "payee-is-deployment" | "token-is-deployment" | "window-inverted";

/** The first shape rule the invoice breaks for this deployment, or `null` when the shape is valid. */
export function invoiceShapeIssue(invoice: Invoice, verifyingContract: Address): InvoiceShapeIssue | null {
  const same = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase();
  if (same(invoice.payee, zeroAddress)) {
    return "payee-zero";
  }
  if (same(invoice.payee, verifyingContract)) {
    return "payee-is-deployment";
  }
  if (same(invoice.token, verifyingContract)) {
    return "token-is-deployment";
  }
  if (invoice.validUntil !== 0n && invoice.validUntil < invoice.validAfter) {
    return "window-inverted";
  }
  return null;
}

/** True when the invoice's times are within the uint53 wire limit that conforming clients enforce (§3.1). */
export function isWithinWireLimits(invoice: Invoice): boolean {
  return invoice.validAfter <= MAX_UINT53 && invoice.validUntil <= MAX_UINT53;
}

/** The invoice kinds of spec §3.2, completed with the two combinations the table leaves out. */
export type InvoiceKind = "one-off" | "seats" | "fixed-unlimited" | "open-single" | "open-seats" | "receive-card";

export function invoiceKind(invoice: Invoice): InvoiceKind {
  const open = invoice.amount === 0n;
  if (invoice.maxPayments === 1) {
    return open ? "open-single" : "one-off";
  }
  if (invoice.maxPayments === 0) {
    return open ? "receive-card" : "fixed-unlimited";
  }
  return open ? "open-seats" : "seats";
}

/**
 * Things an issuer must be warned about before signing:
 * - `open-amount-single-use`: any payment of any amount, even 1 base unit, uses the link up
 *   (self-review observation O-1); prefer a fixed amount or a receive card;
 * - `no-expiry`: the link stays payable until cancelled (spec §14.7);
 * - `unlimited-payments`: the link accepts payments until it expires or is cancelled.
 */
export type IssuerWarning = "open-amount-single-use" | "no-expiry" | "unlimited-payments";

export function issuerWarnings(invoice: Invoice): readonly IssuerWarning[] {
  const warnings: IssuerWarning[] = [];
  if (invoice.amount === 0n && invoice.maxPayments === 1) {
    warnings.push("open-amount-single-use");
  }
  if (invoice.validUntil === 0n) {
    warnings.push("no-expiry");
  }
  if (invoice.maxPayments === 0) {
    warnings.push("unlimited-payments");
  }
  return warnings;
}

/** True when the invoice carries a memo hash, so its link must carry the memo (spec §10.5 step 9). */
export function hasMemo(invoice: Invoice): boolean {
  return invoice.memoHash !== ZERO_HASH;
}
