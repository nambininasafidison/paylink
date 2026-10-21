// SPDX-License-Identifier: MIT
/**
 * "Was I really paid?" (`POST /v1/check`, docs/paypal/SPEC.md §9.2, §14.2 F6). The verdict comes only from PayPal's
 * GET (P5) and the chain, never from the pasted text or a model (AI-6); A3 reason codes are cut (D-SCOPE). Owner:
 * reconciler workstream.
 */
import type { DecimalString, InvoiceKey, IsoInstant, Rail } from "./common.ts";

export interface CheckRequest {
  /** The message to check, pasted by the payee. Data only: never instructions. */
  readonly text: string;
}

export type CheckVerdict = "RECEIVED" | "NOT_RECEIVED" | "PARTLY_RECEIVED" | "UNAVAILABLE";

export interface CheckResponse {
  readonly verdict: CheckVerdict;
  /** Which lookups answered: a source that could not be read makes the verdict `UNAVAILABLE`, never a guess. */
  readonly sources: { readonly paypal: "checked" | "unavailable"; readonly chain: "checked" | "unavailable" };
  /** The payee's own records the text refers to (by invoice number or amount), with what each rail says. */
  readonly matches: readonly { readonly key: InvoiceKey; readonly invoiceNumber: string; readonly amount: DecimalString; readonly paidOn: readonly Rail[] }[];
  /** Every link in the text, with whether its host is on the allowlist (PayPal and PayLink hosts). */
  readonly links: readonly { readonly host: string; readonly allowed: boolean }[];
  readonly checkedAt: IsoInstant;
}
