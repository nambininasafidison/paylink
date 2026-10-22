// SPDX-License-Identifier: MIT
/**
 * Fixtures for the PayPal edition's unit tests: a translator with the edition's catalogue (as `boot` builds it), a
 * page-less `App` for the edition's pieces, and the API's answers as the contract types them.
 */
import type { AlertView, AutoRecordView, CheckResponse, DeskResponse, ProposalView } from "@paylink/api-contract";
import { EN } from "@paylink/i18n";
import type { EditionMessages, Locale, Messages } from "@paylink/i18n";
import type { App } from "../../src/app/context.ts";
import { paypalTranslator } from "../../src/editions/paypal/copy.ts";
import en from "../../../../packages/i18n/src/locales/paypal.en.json";
import fr from "../../../../packages/i18n/src/locales/paypal.fr.json";
import mg from "../../../../packages/i18n/src/locales/paypal.mg.json";
import coreFr from "../../../../packages/i18n/src/locales/fr.json";
import coreMg from "../../../../packages/i18n/src/locales/mg.json";

const CATALOGUE: Readonly<Record<Locale, EditionMessages>> = { en, fr, mg };
const CORE: Readonly<Record<Locale, Messages>> = { en: EN, fr: coreFr, mg: coreMg };

export const KEY = `0x${"ab".repeat(32)}` as const;
export const API = "https://api.example";

/** An `App` with what the edition's pieces read: language, translator, configuration, site, an empty device store. */
export function paypalApp(locale: Locale = "en", options: { readonly api?: string | null } = {}): App {
  const i18n = paypalTranslator(locale, CORE[locale], { own: CATALOGUE[locale], english: CATALOGUE.en });
  const api = options.api === undefined ? API : options.api;
  return {
    i18n,
    locale,
    config: { version: 1, banner: null, relayer: null, indexer: null, api: api === null ? null : { url: api, chains: [11155111] }, rpc: {} },
    configProblem: null,
    site: { origin: "https://paypal.paylink-mg.pages.dev", base: "/paypal/" },
    framed: false,
    fx: null,
    store: { getInvoice: () => Promise.resolve(undefined) },
    session: { account: () => null, ready: Promise.resolve(), subscribe: () => () => undefined },
  } as unknown as App;
}

export function proposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    id: "p_1",
    kind: "cancel_paylink",
    key: KEY,
    invoiceNumber: "PL-11155111-abababababab",
    amount: "120.00",
    rail: "USDC",
    situation: "S2",
    exact: [
      { label: "invoice", value: "PL-11155111-abababababab" },
      { label: "amount", value: "120.00 USD" },
      { label: "action", value: "cancel_paylink" },
      { label: "effect", value: "closes-the-token-rail" },
      { label: "rail", value: "USDC" },
    ],
    reasonCode: "paid-on-paypal",
    origin: "reconciler",
    message: null,
    args: { invoice: "PL-11155111-abababababab", amount: "120.00", currency: "USD" },
    hash: `0x${"cd".repeat(32)}`,
    token: "approval-token",
    expiresAt: "2026-10-22T10:15:00.000Z",
    state: "open",
    createdAt: "2026-10-22T10:00:00.000Z",
    ...over,
  };
}

export function autoRecord(over: Partial<AutoRecordView> = {}): AutoRecordView {
  return {
    id: "r_PAY-1",
    key: KEY,
    invoiceNumber: "PL-11155111-abababababab",
    paymentId: "EXTR-86F38350LX4353815",
    rail: "USDC",
    txHash: `0x${"ef".repeat(32)}`,
    recordedAt: "2026-10-22T09:00:00.000Z",
    undoUntil: "2099-10-23T09:00:00.000Z",
    undone: false,
    ...over,
  };
}

export function alert(over: Partial<AlertView> = {}): AlertView {
  return { key: KEY, invoiceNumber: "PL-11155111-abababababab", situation: "S4", code: "paid-twice", raisedAt: "2026-10-22T09:30:00.000Z", ...over };
}

export function desk(over: Partial<DeskResponse> = {}): DeskResponse {
  return { proposals: [proposal()], autoRecords: [autoRecord()], alerts: [alert()], checkedAt: "2026-10-22T10:00:00.000Z", assistant: { available: true, reason: null }, ...over };
}

export function check(over: Partial<CheckResponse> = {}): CheckResponse {
  return { verdict: "NOT_RECEIVED", sources: { paypal: "checked", chain: "checked" }, matches: [], links: [{ host: "paypa1-secure.example", allowed: false }], checkedAt: "2026-10-22T10:00:00.000Z", ...over };
}
