// SPDX-License-Identifier: MIT
/**
 * `@paylink/sdk`: the PayLink v2 client SDK (PAYLINK-V2-SPEC §3.5; normative format in
 * docs/spec/paylink-invoice-v2.md). Isomorphic: runs in the browser, the Cloudflare Worker relayer and Node.
 *
 * @packageDocumentation
 */
export { erc20ApproveAbi, payLinkV2Abi } from "./abi.ts";
export {
  assessOutstanding,
  assessOutstandingAuthorization,
  AUTHORIZATION_CANCELED_TOPIC,
  CANCEL_AUTHORIZATION_TYPES,
  cancelAuthorizationTypedData,
  isAuthorizationDead,
  memoryOutstandingAuthorizationStore,
  outstandingAuthorizationId,
  parseOutstandingAuthorization,
  prepareAuthorizationCancel,
  readAuthorizationState,
  recordOutstandingAuthorization,
  resubmissionCall,
  withCancellation,
} from "./attempts.ts";
export type {
  AuthorizationAssessment,
  CancelAuthorizationTypedData,
  CheckedOutstandingAuthorization,
  OutstandingAuthorization,
  OutstandingAuthorizationStore,
} from "./attempts.ts";
export { convertDecimals, formatAmount, formatAmountLocale, parseAmount } from "./amount.ts";
export type { FormatAmountOptions, ParseAmountOptions } from "./amount.ts";
export { approveCall, cancelBySigCall, cancelCall, payCall, payNativeCall, payWithAuthorizationCall, payWithPermitCall } from "./calls.ts";
export type { CallRequest } from "./calls.ts";
export { base64UrlDecode, base64UrlEncode } from "./codec/base64url.ts";
export {
  decodeInvoiceFragment,
  decodeReceiptFragment,
  encodeInvoiceFragment,
  encodeReceiptFragment,
  fragmentOf,
  withFragment,
} from "./codec/fragment.ts";
export type { DecodedInvoiceLink, DecodedReceiptLink } from "./codec/fragment.ts";
export { packInvoice, unpackInvoice } from "./codec/packed.ts";
export * from "./constants.ts";
export { readLinkState, readLinkStates } from "./contract.ts";
export { expectedImmutables, maskedRuntimeHash, maskRuntimeCode, readImmutables, verifyDeploymentCode } from "./deployment.ts";
export type { DeploymentCheck, DeploymentFailure, ImmutableReference, ReleaseIdentity } from "./deployment.ts";
export {
  CANCEL_TYPES,
  cancelDigest,
  cancelStructHash,
  cancelTypedData,
  domainSeparator,
  EIP712_DOMAIN_FIELDS,
  INVOICE_TYPES,
  invoiceKey,
  invoiceStructHash,
  invoiceTypedData,
  payLinkDomain,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  receiveWithAuthorizationDigest,
  receiveWithAuthorizationTypedData,
} from "./eip712.ts";
export type {
  CancelTypedData,
  Eip712Domain,
  InvoiceTypedData,
  PayLinkDeployment,
  ReceiveWithAuthorizationMessage,
  ReceiveWithAuthorizationTypedData,
  TypedDataPayload,
} from "./eip712.ts";
export { contractError, decodeError, decodeRevertData, revertDataOf } from "./error-decoder.ts";
export type { DecodedError, ErrorSource } from "./error-decoder.ts";
export { assertArgument, ERROR_CODE_I18N_KEYS, isPayLinkError, LINK_ERROR_CODES, OPERATION_ERROR_CODES, PayLinkError } from "./errors.ts";
export type { ErrorParams, LinkErrorCode, OperationErrorCode, PayLinkErrorCode } from "./errors.ts";
export { clampGasLimit, GAS_ESTIMATE_MARGIN, gasBounds, gasLimitFor } from "./gas.ts";
export { SDK_I18N_KEYS } from "./i18n-keys.ts";
export type { SdkI18nKey } from "./i18n-keys.ts";
export { buildInvoice, expiresIn, hasMemo, invoiceKind, invoiceShapeIssue, isWithinWireLimits, issuerWarnings } from "./invoice.ts";
export type { BuiltInvoice, Expiry, InvoiceDraft, InvoiceKind, InvoiceShapeIssue, IssuerWarning } from "./invoice.ts";
export { authorizePayment, issueInvoice } from "./issue.ts";
export type { IssuedInvoice, PaymentAuthorization } from "./issue.ts";
export {
  parseCancelAuthorizationJson,
  parseInvoiceJson,
  parseReceiptReferenceJson,
  parseRelayPayRequest,
  parseSignedInvoiceJson,
  toCancelAuthorizationJson,
  toInvoiceJson,
  toReceiptReferenceJson,
  toRelayPayRequest,
  toSignedInvoiceJson,
} from "./json.ts";
export type {
  CancelAuthorizationJson,
  InvoiceJson,
  PaymentAuthorizationJson,
  ReceiptReferenceJson,
  RelayPayRequest,
  RelayPayRequestJson,
  SignedInvoiceJson,
} from "./json.ts";
export { hashMemo, memoBytes, normalizeMemo, sanitizeMemoForDisplay } from "./memo.ts";
export { paymentNonce } from "./nonce.ts";
export { linkStatus, predictPayment } from "./payability.ts";
export type { LinkStatus, PaymentAttempt, SettlementFunction } from "./payability.ts";
export { PERMIT_TYPES, preparePermitPayment, readPermitNonce, signPermit } from "./permit.ts";
export type { PermitPayment } from "./permit.ts";
export { cryptoRandom, randomBytes32 } from "./random.ts";
export type { RandomSource } from "./random.ts";
export { DEFAULT_RELAY_ADMISSION_POLICY, RelayAdmissionLedger, REVERT_PENALTIES } from "./relay-admission.ts";
export type {
  Admission,
  AdmissionRefusal,
  RelayAdmissionPolicy,
  RelayAdmissionSnapshot,
  RelayOutcome,
  RelayRelease,
  RelayTicket,
  RevertAttribution,
  RevertCause,
} from "./relay-admission.ts";
export { attributeRelayRevert, AUTHORIZATION_USED_EVENT, replayRevertData } from "./relay-attribution.ts";
export type { AttributionClient, ReplayClient } from "./relay-attribution.ts";
export { assertRelayWindow, checkRelayCancelRequest, checkRelayPayRequest, describeAccountCode, paymentValidThrough, relayMargin } from "./relayer.ts";
export type { AccountCode, CheckedPayRequest, CheckedRelayCall, RelayWindow } from "./relayer.ts";
export { requesterFromIp } from "./requester.ts";
export type { RequesterId } from "./requester.ts";
export { createReceiptVerifier, decodePaidLog, invoiceMismatch, isPaymentForArmedInvoice, verifyReceipt } from "./receipt.ts";
export type { LogLike, PaidEvent, ReceiptClient, ReceiptFailure, ReceiptLike, ReceiptProof, ReceiptVerification, ReceiptVerifier } from "./receipt.ts";
export { isDelegatedCode, payerAccountKind, selectPaymentPath } from "./router.ts";
export type { PayerAccountKind, PaymentPath, ResubmitOnly, Route, RouteInput } from "./router.ts";
export { signCancel, signInvoice, signReceiveAuthorization } from "./sign.ts";
export type { SignatureResult, SignedAuthorization } from "./sign.ts";
export { isRevertError, normalizeEcdsaV, parseEcdsaSignature, recoverEcdsaSigner, verifySignature, verifySignatureWithCode } from "./signature.ts";
export type { CallReader, CodeReader, SignatureClient, SignatureFailure, SignatureVerification } from "./signature.ts";
export { readTokenDomain, resolveTokenDomain } from "./token-domain.ts";
export { EMPTY_LINK_STATE } from "./types.ts";
export type {
  Authorization,
  CancelAuthorization,
  Invoice,
  LinkState,
  PaymentBinding,
  Permit,
  ReceiptReference,
  SignedInvoice,
  TypedDataSigner,
} from "./types.ts";
export { resolveTarget, validateInvoiceParts } from "./validate.ts";
export type { MemoInput, ValidatedInvoice } from "./validate.ts";
