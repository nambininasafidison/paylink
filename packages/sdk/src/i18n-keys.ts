// SPDX-License-Identifier: MIT
/**
 * Every i18n key the SDK can produce. `@paylink/i18n` imports this list for its completeness test, so a key
 * added here fails CI until EN, FR and MG translate it (spec §3.9). Keys name a situation, not a code path;
 * their named placeholders are listed next to them.
 */
export const SDK_I18N_KEYS = [
  // Link decoding (invoice spec §10.5, §10.6). No placeholders.
  "error.link.fragmentTooLong",
  "error.link.fragmentCharset",
  "error.link.segmentCount",
  "error.link.versionUnsupported",
  "error.link.chainIdFormat",
  "error.link.chainUnknown",
  "error.link.base64url",
  "error.link.invoiceLength",
  "error.link.signatureLength",
  "error.link.memoPresence",
  "error.link.memoLength",
  "error.link.memoUtf8",
  "error.link.memoHash",
  "error.link.invoiceShape",
  "error.link.uint53Range",
  "error.link.tokenUnknown",
  "error.link.receiptFormat",
  // Input and issuing.
  "error.input.invalidArgument",
  "error.input.amountFormat",
  "error.input.amountPrecision", // {decimals}
  "error.input.amountRange",
  "error.issue.signerNotPayee",
  "error.issue.signatureInvalid",
  "error.issue.deploymentInactive", // {status}
  "error.token.notEip3009",
  "error.token.notEip2612",
  "error.token.domainUnknown",
  "error.token.domainMismatch",
  "error.gas.aboveCeiling", // {estimate} {ceiling}
  // Retry safety (invoice spec §8.6).
  "error.payment.authorizationOutstanding", // {validBefore}
  "error.payment.authorizationConsumed",
  // PayLinkV2 custom errors (spec §7.6), with the error's arguments as placeholders.
  "error.contract.invalidInvoice",
  "error.contract.invalidSignature",
  "error.contract.signatureExpired", // {deadline}
  "error.contract.notPayee",
  "error.contract.cancelled",
  "error.contract.notYetValid", // {validAfter}
  "error.contract.expired", // {validUntil}
  "error.contract.soldOut", // {maxPayments}
  "error.contract.wrongAmount", // {expected} {sent}
  "error.contract.wrongPaymentPath",
  "error.contract.selfPayment",
  "error.contract.receivedMismatch", // {expected} {received}
  "error.contract.payeeShortPaid", // {expected} {received}
  "error.contract.batchTooLarge", // {max}
  // OpenZeppelin errors that can surface through PayLinkV2.
  "error.contract.reentrancy",
  "error.contract.tokenCallFailed", // {token}
  "error.contract.insufficientNativeBalance", // {balance} {needed}
  "error.contract.payeeRejectedNative",
  "error.contract.unexpected", // {name}
  "error.contract.panic", // {code}
  "error.contract.revertedWithoutReason",
  // Token-side reverts bubbled up unchanged (FiatToken v2 strings, OpenZeppelin ERC-20 v5 errors).
  "error.token.insufficientBalance",
  "error.token.insufficientAllowance",
  "error.token.authorizationInvalid",
  "error.token.authorizationUsed",
  "error.token.authorizationExpired",
  "error.token.authorizationNotYetValid",
  "error.token.permitExpired",
  "error.token.permitInvalid",
  "error.token.accountBlocked",
  "error.token.paused",
  "error.token.reverted", // {reason} (untrusted text: render as text only)
  // Wallet and network.
  "error.wallet.rejected",
  "error.wallet.wrongNetwork",
  "error.wallet.insufficientFunds",
  "error.network.unavailable",
  "error.network.timeout",
  // Receipt verification (invoice spec §12).
  "error.receipt.chainUnknown",
  "error.receipt.notFound",
  "error.receipt.transactionReverted",
  "error.receipt.logNotFound",
  "error.receipt.wrongContract",
  "error.receipt.notPaidEvent",
  "error.receipt.malformedLog",
  "error.receipt.tokenNotAllowlisted",
  "error.receipt.invoiceMismatch", // {field}
  // Anything else.
  "error.unknown", // {selector} when revert data was present
] as const;

export type SdkI18nKey = (typeof SDK_I18N_KEYS)[number];
