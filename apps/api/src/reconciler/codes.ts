// SPDX-License-Identifier: MIT
/**
 * The fixed codes the reconciler speaks in: why a twin is in its situation or why an action is proposed
 * (`REASON_CODES`), and why a twin is hands off or alarming (`ALERT_CODES`). The web edition renders each with
 * owner-reviewed i18n text (docs/paypal/SPEC.md §14.1, invariant AI-4): no model text ever replaces them, and the
 * assistant can only pick among them. The literal types live in `@paylink/api-contract` (desk.ts); the lists here are
 * checked to be exactly those types.
 *
 * Owner: reconciler workstream.
 */
import type { DeskAlertCode, DeskReasonCode } from "@paylink/api-contract";

export const REASON_CODES = [
  // S0
  "hands-off",
  // S1
  "open",
  "reminder-due",
  "reminder-after-3-days",
  "share-reminder",
  // S2
  "paid-on-paypal",
  "marked-paid-by-you",
  // S3
  "paid-on-chain",
  "paypal-still-open-after-record",
  "recorded-then-undone",
  // S4
  "paid-twice",
  // S5
  "payment-in-flight",
  "chain-payment-confirming",
  // S6
  "paypal-cancelled",
  // S7
  "chain-cancelled",
  "chain-expired",
  // S8
  "closed-paid-paypal",
  "closed-paid-chain",
  "closed-cancelled",
  // S9
  "refunded",
] as const satisfies readonly DeskReasonCode[];

export const ALERT_CODES = [
  "paypal-unreadable",
  "chain-unreadable",
  "chain-not-deployed",
  "reference-mismatch",
  "currency-mismatch",
  "amount-mismatch",
  "paid-amount-mismatch",
  "paypal-status-unknown",
  "paypal-scheduled",
  "paypal-draft",
  "paid-without-transactions",
  "paypal-open-with-payments",
  "chain-paid-unverified",
  "chain-payment-mismatch",
  "paid-twice",
] as const satisfies readonly DeskAlertCode[];

// Both lists name every member of their contract type (a missing code fails type-checking here).
type Missing<All, Listed> = Exclude<All, Listed>;
const everyReason: [Missing<DeskReasonCode, (typeof REASON_CODES)[number]>] extends [never] ? true : never = true;
const everyAlert: [Missing<DeskAlertCode, (typeof ALERT_CODES)[number]>] extends [never] ? true : never = true;
export const CODE_LISTS_COMPLETE = { reasons: everyReason, alerts: everyAlert } as const;

const reasons: ReadonlySet<string> = new Set(REASON_CODES);
export const isReasonCode = (code: string): code is DeskReasonCode => reasons.has(code);
