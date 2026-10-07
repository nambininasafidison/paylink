// SPDX-License-Identifier: MIT
/**
 * Retry safety for gasless EIP-3009 payments (invoice spec §8.6).
 *
 * PayLinkV2 does not deduplicate across authorizations: two authorizations with different `payerSalt`s for the
 * same link are two payments wherever `maxPayments != 1` (receive cards, open-amount tills, N-seat links). A retry
 * is usually caused by a relayer that is slow, not one whose transaction failed, so the first authorization is
 * still valid until its `validBefore`. A client that re-signs, or falls back to permit or approve-and-pay, while it
 * is outstanding can charge the payer twice, and the relayer ("trusted for availability only") decides whether the
 * stale one lands.
 *
 * The rule enforced here:
 * 1. From the moment the payer signs, the signed relay body is persisted (`OutstandingAuthorization`, stored under
 *    `outstandingAuthorizationId`) before it is sent anywhere, so a page reload cannot lead to a second signature.
 * 2. Every retry resubmits exactly that body, to the relayer or by self-submission (`resubmissionCall`). A reverted
 *    submission does not consume the token nonce, and the token settles at most one copy: retries are idempotent.
 * 3. A new signature, or another settlement path, is allowed only once the outstanding authorization is dead:
 *    cancelled on the token (`prepareAuthorizationCancel`, then `withCancellation` with the mined receipt)
 *    or expired (chain time at or past `validBefore`, still unused). A consumed authorization that this device did
 *    not cancel is a payment that went through: verify the receipt, never sign again by default.
 * `authorizePayment` and `selectPaymentPath` both take the assessment, so neither can be called without it.
 */
import type { Erc20Token, Registry } from "@paylink/chains";
import { decodeFunctionResult, encodeFunctionData, getAddress, hashTypedData, keccak256, pad, stringToHex } from "viem";
import type { Address, Hex } from "viem";
import { isBytes32 } from "./bytes.ts";
import { payWithAuthorizationCall } from "./calls.ts";
import type { CallRequest } from "./calls.ts";
import type { DecodedInvoiceLink } from "./codec/fragment.ts";
import type { Eip712Domain, TypedDataPayload } from "./eip712.ts";
import { PayLinkError } from "./errors.ts";
import type { PaymentAuthorization } from "./issue.ts";
import type { ReceiptLike } from "./receipt.ts";
import { parseRelayPayRequest } from "./json.ts";
import type { RelayPayRequest, RelayPayRequestJson } from "./json.ts";
import { paymentNonce } from "./nonce.ts";
import { normalizeEcdsaV, parseEcdsaSignature, recoverEcdsaSigner } from "./signature.ts";
import type { CallReader } from "./signature.ts";
import { resolveTokenDomain } from "./token-domain.ts";
import type { TypedDataSigner } from "./types.ts";
import { resolveTarget, validateInvoiceParts } from "./validate.ts";

/**
 * What a payer client keeps in device storage from the moment the payer signs an EIP-3009 authorization until it
 * is known to be consumed or dead. JSON-safe (strings and numbers only), so it survives IndexedDB, export and
 * reload unchanged.
 */
export interface OutstandingAuthorization {
  readonly version: 1;
  /** The exact `POST /v1/{chainId}/pay` body. Resubmitting it is idempotent; it is never re-signed. */
  readonly request: RelayPayRequestJson;
  /** The invoice key, under the registry's `verifyingContract`. */
  readonly key: Hex;
  /** The bound token nonce (`paymentNonce`), whose `authorizationState` decides the authorization's fate. */
  readonly nonce: Hex;
  /** The payer's `cancelAuthorization` transaction, recorded only after its receipt reported success. */
  readonly cancelTxHash: Hex | null;
}

/** Where the outstanding authorization stands, from chain facts (invoice spec §8.6). */
export type AuthorizationAssessment =
  /**
   * Unused and before `validBefore`: it can still settle. Retry by resubmitting it; nothing else is offered until
   * it is cancelled on the token or expires.
   */
  | { readonly state: "live"; readonly validBefore: bigint }
  /** Used or cancelled, and not by a cancellation recorded on this device: treat as paid and verify the receipt. */
  | { readonly state: "consumed" }
  /** Dead: this device's `cancelAuthorization` was mined. A new authorization or another path is safe. */
  | { readonly state: "cancelled" }
  /** Dead: chain time reached `validBefore` and the token never used it. A new authorization is safe. */
  | { readonly state: "expired" };

/** True when the authorization can never settle and was not used: a new signature or another path is safe. */
export function isAuthorizationDead(assessment: AuthorizationAssessment | null): boolean {
  return assessment === null || assessment.state === "cancelled" || assessment.state === "expired";
}

/**
 * The storage key of the outstanding authorization for one (chain, invoice key, payer). A device keeps at most one
 * per link and payer: a further intended payment of the same link waits until it is consumed or dead.
 */
export function outstandingAuthorizationId(parameters: { readonly chainId: number; readonly key: Hex; readonly payer: Address }): string {
  return `paylink.v2.authorization/${String(parameters.chainId)}/${parameters.key.toLowerCase()}/${parameters.payer.toLowerCase()}`;
}

/** The record to persist right after `authorizePayment`, before the body is sent to anyone. */
export function recordOutstandingAuthorization(link: Pick<DecodedInvoiceLink, "key">, payment: PaymentAuthorization): OutstandingAuthorization {
  return { version: 1, request: payment.request, key: link.key, nonce: payment.nonce, cancelTxHash: null };
}

/** `keccak256("AuthorizationCanceled(address,bytes32)")`, EIP-3009. */
export const AUTHORIZATION_CANCELED_TOPIC: Hex = keccak256(stringToHex("AuthorizationCanceled(address,bytes32)"));

/**
 * The record with the payer's cancellation, from the mined transaction's receipt. The receipt must report success
 * and contain the token's `AuthorizationCanceled(payer, nonce)`: a cancel that lost the race to the relayer reverts
 * ("authorization is used or canceled"), and recording it would turn a payment that went through into a "dead"
 * authorization and invite a second payment.
 */
export function withCancellation(checked: CheckedOutstandingAuthorization, txHash: Hex, receipt: Pick<ReceiptLike, "status" | "logs">): OutstandingAuthorization {
  if (!isBytes32(txHash)) {
    throw new PayLinkError("E_INVALID_ARGUMENT", "the cancellation transaction hash must be 32 bytes of lowercase hex", { path: "txHash" });
  }
  const payerTopic = pad(checked.request.authorization.payer.toLowerCase() as Hex);
  const cancelled =
    receipt.status === "success" &&
    receipt.logs.some(
      (log) =>
        log.address.toLowerCase() === checked.token.address.toLowerCase() &&
        log.topics[0]?.toLowerCase() === AUTHORIZATION_CANCELED_TOPIC &&
        log.topics[1]?.toLowerCase() === payerTopic &&
        log.topics[2]?.toLowerCase() === checked.outstanding.nonce,
    );
  if (!cancelled) {
    throw new PayLinkError("E_INVALID_ARGUMENT", "the transaction did not cancel this authorization", { rule: "NotCancelled" });
  }
  return { ...checked.outstanding, cancelTxHash: txHash };
}

/** A stored record re-checked against the registry, with everything a resubmission or a cancellation needs. */
export interface CheckedOutstandingAuthorization {
  readonly outstanding: OutstandingAuthorization;
  readonly request: RelayPayRequest;
  readonly token: Erc20Token;
  readonly verifyingContract: Address;
}

/**
 * Parses a stored record (device storage is untrusted input) and re-derives it from the registry: the relay body
 * must pass the relayer's structural and registry checks, and `key` and `nonce` must equal the values recomputed
 * from it, so a tampered record cannot redirect a resubmission or a cancellation.
 */
export function parseOutstandingAuthorization(value: unknown, registry: Registry): CheckedOutstandingAuthorization {
  const invalid = (rule: string): never => {
    throw new PayLinkError("E_INVALID_ARGUMENT", `stored authorization: ${rule}`, { path: "$" });
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "cancelTxHash,key,nonce,request,version" || record["version"] !== 1) {
    return invalid("must have exactly version 1, request, key, nonce and cancelTxHash");
  }
  const cancelTxHash = record["cancelTxHash"];
  if (cancelTxHash !== null && !isBytes32(cancelTxHash)) {
    return invalid("cancelTxHash must be null or a transaction hash");
  }
  const request = parseRelayPayRequest(record["request"]);
  const target = resolveTarget(request.chainId, registry);
  const { key, token } = validateInvoiceParts({
    chainId: request.chainId,
    target,
    registry,
    invoice: request.invoice,
    signatureLength: (request.signature.length - 2) / 2,
    memo: { mode: "omitted" },
  });
  if (token.kind !== "erc20" || !token.capabilities.eip3009) {
    throw new PayLinkError("E_TOKEN_NOT_EIP3009", `${token.symbol} does not support EIP-3009`, { token: token.address });
  }
  const { authorization } = request;
  const nonce = paymentNonce({ key, payer: authorization.payer, amount: authorization.amount, payerRef: authorization.payerRef, payerSalt: authorization.payerSalt });
  if (record["key"] !== key || record["nonce"] !== nonce) {
    return invalid("key or nonce does not match the request");
  }
  const outstanding: OutstandingAuthorization = {
    version: 1,
    request: record["request"] as RelayPayRequestJson,
    key,
    nonce,
    cancelTxHash,
  };
  return { outstanding, request, token, verifyingContract: target.deployment.address };
}

/**
 * Pure assessment from chain facts. `now` is chain time (the latest block's timestamp): block timestamps never
 * decrease, so once it reaches `validBefore` no later block can include the authorization (FiatToken requires
 * `now < validBefore`). `consumed` is the token's `authorizationState(payer, nonce)`.
 */
export function assessOutstandingAuthorization(parameters: {
  readonly outstanding: OutstandingAuthorization;
  readonly now: bigint;
  readonly consumed: boolean;
}): AuthorizationAssessment {
  const { outstanding, now, consumed } = parameters;
  if (consumed) {
    // The chain is the authority: a cancellation recorded here counts only while the token agrees the nonce is spent.
    return outstanding.cancelTxHash === null ? { state: "consumed" } : { state: "cancelled" };
  }
  const validBefore = BigInt(outstanding.request.authorization.validBefore);
  return now < validBefore ? { state: "live", validBefore } : { state: "expired" };
}

const AUTHORIZATION_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "cancelAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** EIP-3009 `authorizationState(authorizer, nonce)`: true once the nonce was used or cancelled. */
export async function readAuthorizationState(parameters: {
  readonly client: CallReader;
  readonly token: Address;
  readonly payer: Address;
  readonly nonce: Hex;
}): Promise<boolean> {
  const { client, token, payer, nonce } = parameters;
  const result = await client.call({ to: token, data: encodeFunctionData({ abi: AUTHORIZATION_ABI, functionName: "authorizationState", args: [payer, nonce] }) });
  try {
    return decodeFunctionResult({ abi: AUTHORIZATION_ABI, functionName: "authorizationState", data: result.data ?? "0x" });
  } catch (error) {
    throw new PayLinkError("E_TOKEN_NOT_EIP3009", `${token} did not answer authorizationState`, { token }, { cause: error });
  }
}

/** Reads the token and assesses a parsed record at chain time `now` (the latest block's timestamp). */
export async function assessOutstanding(parameters: {
  readonly client: CallReader;
  readonly checked: CheckedOutstandingAuthorization;
  readonly now: bigint;
}): Promise<AuthorizationAssessment> {
  const { client, checked, now } = parameters;
  const consumed = await readAuthorizationState({ client, token: checked.token.address, payer: checked.request.authorization.payer, nonce: checked.outstanding.nonce });
  return assessOutstandingAuthorization({ outstanding: checked.outstanding, now, consumed });
}

/** "Pay with your own gas" for a retry: `payWithAuthorization` with exactly the stored, already-signed body. */
export function resubmissionCall(checked: CheckedOutstandingAuthorization): CallRequest {
  const { request } = checked;
  return payWithAuthorizationCall(checked.verifyingContract, request.invoice, request.signature, request.authorization);
}

export const CANCEL_AUTHORIZATION_TYPES = {
  CancelAuthorization: [
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type CancelAuthorizationTypedData = TypedDataPayload<
  "CancelAuthorization",
  typeof CANCEL_AUTHORIZATION_TYPES,
  { readonly authorizer: Address; readonly nonce: Hex }
>;

/** The payer's EIP-3009 `CancelAuthorization`, under the token's domain. */
export function cancelAuthorizationTypedData(tokenDomain: Eip712Domain, authorizer: Address, nonce: Hex): CancelAuthorizationTypedData {
  return {
    domain: { ...tokenDomain },
    types: CANCEL_AUTHORIZATION_TYPES,
    primaryType: "CancelAuthorization" as const,
    message: { authorizer, nonce },
  };
}

/**
 * Signs the token's `cancelAuthorization(payer, nonce)` for the stored authorization and returns the transaction
 * the payer sends to the token (it needs gas; the relayer only relays PayLink calls). Record its receipt with
 * `withCancellation`, which checks the token's `AuthorizationCanceled` event: the authorization is then dead and any
 * path may be used. Simulate
 * first: EIP-3009 lists `cancelAuthorization`, but a token may omit it, and then the only way out is expiry.
 */
export async function prepareAuthorizationCancel(parameters: {
  readonly checked: CheckedOutstandingAuthorization;
  readonly signer: TypedDataSigner;
  /** Reads the token's EIP-712 domain when the registry does not state it. */
  readonly client?: CallReader;
}): Promise<{ readonly call: CallRequest; readonly digest: Hex }> {
  const { checked, signer } = parameters;
  const payer = checked.request.authorization.payer;
  if (getAddress(signer.address) !== getAddress(payer)) {
    throw new PayLinkError("E_INVALID_ARGUMENT", "only the payer can cancel its authorization", { rule: "NotAuthorizer" });
  }
  const tokenDomain = await resolveTokenDomain({
    chainId: checked.request.chainId,
    token: checked.token,
    ...(parameters.client === undefined ? {} : { client: parameters.client }),
  });
  const typed = cancelAuthorizationTypedData(tokenDomain, payer, checked.outstanding.nonce);
  const signature = normalizeEcdsaV(await signer.signTypedData({ ...typed, message: { ...typed.message } }));
  const digest = hashTypedData(typed);
  const parsed = parseEcdsaSignature(signature);
  const recovered = await recoverEcdsaSigner(digest, signature);
  if (!parsed.ok || !("signer" in recovered) || getAddress(recovered.signer) !== getAddress(payer)) {
    throw new PayLinkError("E_SIGNATURE_INVALID", "the cancellation must be a 65-byte ECDSA signature by the payer", { failure: "payer" });
  }
  const data = encodeFunctionData({
    abi: AUTHORIZATION_ABI,
    functionName: "cancelAuthorization",
    args: [payer, checked.outstanding.nonce, parsed.v, parsed.r, parsed.s],
  });
  return { call: { to: checked.token.address, data, value: 0n }, digest };
}

/**
 * Device storage for outstanding authorizations, one record per `outstandingAuthorizationId`. The web client backs
 * it with IndexedDB; `memoryOutstandingAuthorizationStore` serves tests and short-lived processes. Records are
 * removed once the payment's receipt is verified, or once the authorization is dead and nothing replaced it.
 */
export interface OutstandingAuthorizationStore {
  get(id: string): Promise<unknown>;
  put(id: string, record: OutstandingAuthorization): Promise<void>;
  delete(id: string): Promise<void>;
}

export function memoryOutstandingAuthorizationStore(): OutstandingAuthorizationStore {
  const records = new Map<string, string>();
  return {
    get: (id) => {
      const text = records.get(id);
      return Promise.resolve(text === undefined ? undefined : (JSON.parse(text) as unknown));
    },
    put: (id, record) => {
      records.set(id, JSON.stringify(record));
      return Promise.resolve();
    },
    delete: (id) => {
      records.delete(id);
      return Promise.resolve();
    },
  };
}
