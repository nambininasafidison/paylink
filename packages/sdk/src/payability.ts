// SPDX-License-Identifier: MIT
/**
 * The payability predicate of invoice spec §7.2, evaluated off-chain in the contract's order, so a client
 * can show "Still payable" and predict exactly which error a payment would revert with before asking for a
 * signature or gas. The chain stays the authority: simulate (`eth_call`) before sending.
 */
import type { Address } from "viem";
import { MAX_UINT128 } from "./constants.ts";
import { contractError } from "./error-decoder.ts";
import type { DecodedError } from "./error-decoder.ts";
import { invoiceShapeIssue } from "./invoice.ts";
import type { Invoice, LinkState } from "./types.ts";

/** The four settlement entry points (§7.4). */
export type SettlementFunction = "payWithAuthorization" | "pay" | "payWithPermit" | "payNative";

export interface PaymentAttempt {
  readonly invoice: Invoice;
  readonly verifyingContract: Address;
  /** `stateOf(key)` from the chain. */
  readonly state: LinkState;
  /** Chain time (the latest block's timestamp), not the device clock (§2.3, §14.12). */
  readonly now: bigint;
  readonly fn: SettlementFunction;
  /** The amount paid (`msg.value` for `payNative`). */
  readonly amount: bigint;
  readonly payer: Address;
  /** Result of `verifySignature` with the contract's dispatch. */
  readonly signatureValid: boolean;
}

/**
 * The error the contract would revert with, checked in its order (§7.2): `InvalidInvoice`,
 * `WrongPaymentPath`, `Cancelled`, `InvalidSignature`, `NotYetValid`, `Expired`, `SoldOut`, `WrongAmount`,
 * `SelfPayment`; or `null` when the predicate holds. Token-side checks (`ReceivedMismatch`,
 * `PayeeShortPaid`, balances, allowances) are outside the predicate.
 */
export function predictPayment(attempt: PaymentAttempt): DecodedError | null {
  const { invoice, state, now, fn, amount } = attempt;
  if (fn === "payNative" && amount > MAX_UINT128) {
    return contractError("WrongAmount", { expected: invoice.amount.toString(), sent: MAX_UINT128.toString() });
  }
  if (invoiceShapeIssue(invoice, attempt.verifyingContract) !== null) {
    return contractError("InvalidInvoice");
  }
  const native = invoice.token.toLowerCase() === "0x0000000000000000000000000000000000000000";
  if (native !== (fn === "payNative")) {
    return contractError("WrongPaymentPath");
  }
  if (state.cancelled) {
    return contractError("Cancelled");
  }
  if (!attempt.signatureValid) {
    return contractError("InvalidSignature");
  }
  if (now < invoice.validAfter) {
    return contractError("NotYetValid", { validAfter: invoice.validAfter.toString() });
  }
  if (invoice.validUntil !== 0n && now > invoice.validUntil) {
    return contractError("Expired", { validUntil: invoice.validUntil.toString() });
  }
  if (invoice.maxPayments !== 0 && state.payments >= invoice.maxPayments) {
    return contractError("SoldOut", { maxPayments: String(invoice.maxPayments) });
  }
  if (invoice.amount === 0n ? amount === 0n : amount !== invoice.amount) {
    return contractError("WrongAmount", { expected: invoice.amount.toString(), sent: amount.toString() });
  }
  if (attempt.payer.toLowerCase() === invoice.payee.toLowerCase()) {
    return contractError("SelfPayment");
  }
  return null;
}

/**
 * What the "Still payable" lamp shows (§13.2 check 4). `paid` is a one-off invoice that has its payment:
 * clients present it as "already paid", never as a request to pay again (§14.3).
 */
export type LinkStatus = "payable" | "cancelled" | "not-yet-valid" | "expired" | "paid" | "sold-out";

export function linkStatus(invoice: Invoice, state: LinkState, now: bigint): LinkStatus {
  if (state.cancelled) {
    return "cancelled";
  }
  if (invoice.maxPayments !== 0 && state.payments >= invoice.maxPayments) {
    return invoice.maxPayments === 1 ? "paid" : "sold-out";
  }
  if (now < invoice.validAfter) {
    return "not-yet-valid";
  }
  if (invoice.validUntil !== 0n && now > invoice.validUntil) {
    return "expired";
  }
  return "payable";
}
