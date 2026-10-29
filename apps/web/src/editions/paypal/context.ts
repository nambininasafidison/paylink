// SPDX-License-Identifier: MIT
/**
 * What every PayPal-edition piece shares: the API named by `/config.json` for Ethereum Sepolia (or none), the support
 * line under an API failure in the user's language, and (re-exported from `money.ts`) the exact-cents conversions
 * between the signed amount (base units) and PayPal's two-decimal USD (docs/paypal/SPEC.md §7.2).
 *
 * Owner: web edition workstream.
 */
import { PAYPAL_EDITION_CHAIN_ID } from "@paylink/api-contract";
import type { MessageKey } from "@paylink/i18n";
import type { App } from "../../app/context.ts";
import { endpointFor } from "../../core/config.ts";
import { decodeUiError } from "../../core/errors.ts";
import type { UiError } from "../../core/errors.ts";
import { ApiError, paypalApi } from "./api.ts";
import type { PaypalApi } from "./api.ts";

export { baseFromDecimal, seconds, usdFromBase } from "./money.ts";

/** The API's base URL when `/config.json` names one that serves this edition's chain, else `null`. */
export function apiUrl(app: Pick<App, "config">): string | null {
  return endpointFor(app.config.api ?? null, PAYPAL_EDITION_CHAIN_ID);
}

/** The API client, or `null` when the edition's API is not configured (every PayPal feature then says so). */
export function apiFor(app: Pick<App, "config">): PaypalApi | null {
  const url = apiUrl(app);
  return url === null ? null : paypalApi(url);
}

/** Rules of the specification the page words on its own; any other rule reads by its problem code. */
const RULE_TEXT: Readonly<Record<string, MessageKey>> = {
  E_STALE: "paypal.error.stale",
  E_APPROVAL_EXPIRED: "paypal.error.stale",
  E_PROPOSAL_EXPIRED: "paypal.error.stale",
  E_ALREADY_USED: "paypal.error.answered",
  E_ALREADY_UNDONE: "paypal.error.undone",
  E_UNDO_EXPIRED: "paypal.error.undoExpired",
  E_BUSY: "paypal.error.busy",
  E_PAYPAL_SCHEDULED: "paypal.error.scheduled",
  // PayPal refuses its reminder for an invoice without the client's email (the capture of 2026-10-29); the desk never
  // offers one then, and says why the same way should PayPal refuse anyway.
  E_PAYPAL_REMINDER_NEEDS_EMAIL: "paypal.reminder.noEmail",
  E_TWIN_PRECISION: "paypal.twin.ineligible.cents",
  E_TWIN_OPEN_AMOUNT: "paypal.twin.ineligible.open",
  E_TWIN_MULTI_PAYMENT: "paypal.twin.ineligible.several",
  E_TWIN_TOKEN: "paypal.twin.ineligible.token",
  E_TWIN_EXPIRED: "paypal.error.twinExpired",
  E_TWIN_DUE_DATE: "paypal.error.dueDate",
  E_SESSION_ORIGIN: "paypal.error.origin",
  E_SESSION_TIME: "paypal.error.clock",
};

const CODE_TEXT: Readonly<Record<ApiError["code"], MessageKey>> = {
  network: "paypal.error.network",
  timeout: "paypal.error.network",
  "invalid-response": "paypal.error.invalid",
  "invalid-json": "paypal.error.refused",
  "invalid-request": "paypal.error.refused",
  "unsupported-media-type": "paypal.error.refused",
  "payload-too-large": "paypal.error.tooLong",
  unauthorized: "paypal.error.session",
  forbidden: "paypal.error.forbidden",
  "origin-not-allowed": "paypal.error.origin",
  "not-found": "paypal.error.notFound",
  "method-not-allowed": "paypal.error.refused",
  stale: "paypal.error.stale",
  conflict: "paypal.error.conflict",
  "rate-limited": "paypal.error.rate",
  "quota-exhausted": "paypal.error.quota",
  "webhook-rejected": "paypal.error.refused",
  "paypal-rejected": "paypal.error.paypalRejected",
  "paypal-unavailable": "paypal.error.paypalDown",
  "chain-unavailable": "paypal.error.chainDown",
  "assistant-unavailable": "paypal.error.assistant",
  "not-implemented": "paypal.error.notYet",
  internal: "paypal.error.internal",
};

/** A failure of the API, a wallet or the chain, in the user's language, with its engraved support code. */
export function failureText(app: Pick<App, "i18n">, error: unknown): UiError {
  const { t, lookup } = app.i18n;
  if (error instanceof ApiError) {
    const key = (error.rule === null ? undefined : RULE_TEXT[error.rule]) ?? CODE_TEXT[error.code];
    return { message: lookup(key) ?? t("error.unknown"), code: t("common.errorCode", { code: error.rule ?? error.code }), name: `Api ${error.code}` };
  }
  return decodeUiError(app, error);
}
