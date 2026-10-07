// SPDX-License-Identifier: MIT
/**
 * Errors raised by the SDK itself. Every error carries a stable `code` (the symbolic names of invoice spec
 * §10.5 for link decoding) and the i18n key the user interface translates, with named parameters
 * (spec §3.9: whole sentences with named placeholders, no concatenation).
 */
import type { SdkI18nKey } from "./i18n-keys.ts";

/** Link-decoding errors, in the order of invoice spec §10.5 (plus §10.6 for receipts). */
export const LINK_ERROR_CODES = [
  "E_FRAGMENT_TOO_LONG",
  "E_FRAGMENT_CHARSET",
  "E_SEGMENT_COUNT",
  "E_VERSION_UNSUPPORTED",
  "E_CHAIN_ID_FORMAT",
  "E_CHAIN_UNKNOWN",
  "E_BASE64URL",
  "E_INVOICE_LENGTH",
  "E_SIGNATURE_LENGTH",
  "E_MEMO_PRESENCE",
  "E_MEMO_LENGTH",
  "E_MEMO_UTF8",
  "E_MEMO_HASH",
  "E_INVOICE_SHAPE",
  "E_UINT53_RANGE",
  "E_TOKEN_UNKNOWN",
  "E_RECEIPT_FORMAT",
] as const;

/** Errors of SDK operations other than decoding. */
export const OPERATION_ERROR_CODES = [
  "E_INVALID_ARGUMENT",
  "E_AMOUNT_FORMAT",
  "E_AMOUNT_PRECISION",
  "E_AMOUNT_RANGE",
  "E_SIGNER_NOT_PAYEE",
  "E_SIGNATURE_INVALID",
  "E_DEPLOYMENT_INACTIVE",
  "E_TOKEN_NOT_EIP3009",
  "E_TOKEN_NOT_EIP2612",
  "E_TOKEN_DOMAIN_UNKNOWN",
  "E_TOKEN_DOMAIN_MISMATCH",
  "E_GAS_ABOVE_CEILING",
  "E_AUTHORIZATION_OUTSTANDING",
  "E_AUTHORIZATION_CONSUMED",
] as const;

export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];
export type OperationErrorCode = (typeof OPERATION_ERROR_CODES)[number];
export type PayLinkErrorCode = LinkErrorCode | OperationErrorCode;

/** i18n key of each SDK error code. */
export const ERROR_CODE_I18N_KEYS = {
  E_FRAGMENT_TOO_LONG: "error.link.fragmentTooLong",
  E_FRAGMENT_CHARSET: "error.link.fragmentCharset",
  E_SEGMENT_COUNT: "error.link.segmentCount",
  E_VERSION_UNSUPPORTED: "error.link.versionUnsupported",
  E_CHAIN_ID_FORMAT: "error.link.chainIdFormat",
  E_CHAIN_UNKNOWN: "error.link.chainUnknown",
  E_BASE64URL: "error.link.base64url",
  E_INVOICE_LENGTH: "error.link.invoiceLength",
  E_SIGNATURE_LENGTH: "error.link.signatureLength",
  E_MEMO_PRESENCE: "error.link.memoPresence",
  E_MEMO_LENGTH: "error.link.memoLength",
  E_MEMO_UTF8: "error.link.memoUtf8",
  E_MEMO_HASH: "error.link.memoHash",
  E_INVOICE_SHAPE: "error.link.invoiceShape",
  E_UINT53_RANGE: "error.link.uint53Range",
  E_TOKEN_UNKNOWN: "error.link.tokenUnknown",
  E_RECEIPT_FORMAT: "error.link.receiptFormat",
  E_INVALID_ARGUMENT: "error.input.invalidArgument",
  E_AMOUNT_FORMAT: "error.input.amountFormat",
  E_AMOUNT_PRECISION: "error.input.amountPrecision",
  E_AMOUNT_RANGE: "error.input.amountRange",
  E_SIGNER_NOT_PAYEE: "error.issue.signerNotPayee",
  E_SIGNATURE_INVALID: "error.issue.signatureInvalid",
  E_DEPLOYMENT_INACTIVE: "error.issue.deploymentInactive",
  E_TOKEN_NOT_EIP3009: "error.token.notEip3009",
  E_TOKEN_NOT_EIP2612: "error.token.notEip2612",
  E_TOKEN_DOMAIN_UNKNOWN: "error.token.domainUnknown",
  E_TOKEN_DOMAIN_MISMATCH: "error.token.domainMismatch",
  E_GAS_ABOVE_CEILING: "error.gas.aboveCeiling",
  E_AUTHORIZATION_OUTSTANDING: "error.payment.authorizationOutstanding",
  E_AUTHORIZATION_CONSUMED: "error.payment.authorizationConsumed",
} as const satisfies Record<PayLinkErrorCode, SdkI18nKey>;

/** Named placeholder values for the translated message. Always strings, never markup. */
export type ErrorParams = Readonly<Record<string, string>>;

/** The SDK's error type. `message` is English developer text; show `i18nKey` with `params` to users. */
export class PayLinkError extends Error {
  readonly code: PayLinkErrorCode;
  readonly i18nKey: SdkI18nKey;
  readonly params: ErrorParams;

  constructor(code: PayLinkErrorCode, message: string, params: ErrorParams = {}, options?: { readonly cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "PayLinkError";
    this.code = code;
    this.i18nKey = ERROR_CODE_I18N_KEYS[code];
    this.params = Object.freeze({ ...params });
  }
}

/** Narrowing helper: `isPayLinkError(e, "E_CHAIN_UNKNOWN")`. */
export function isPayLinkError(error: unknown, code?: PayLinkErrorCode): error is PayLinkError {
  return error instanceof PayLinkError && (code === undefined || error.code === code);
}

/** Throws `E_INVALID_ARGUMENT` unless `condition` holds. */
export function assertArgument(condition: boolean, message: string, params: ErrorParams = {}): asserts condition {
  if (!condition) {
    throw new PayLinkError("E_INVALID_ARGUMENT", message, params);
  }
}
