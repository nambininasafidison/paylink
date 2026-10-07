// SPDX-License-Identifier: MIT
/**
 * The checks a relayer applies before it simulates and sends (invoice spec §13.3, PAYLINK-V2-SPEC §3.7
 * pipeline steps 2 and 3), shared so that the relayer and its tests use exactly the SDK's rules:
 * the chain in the body equals the chain in the path; the chain has a canonical, non-revoked deployment;
 * the invoice passes the decoder's checks; the payee signature verifies with the contract's dispatch; and,
 * for payments, the binding nonce is recomputed and the payer's EIP-3009 signature verified with **the token's**
 * dispatch (Circle FiatToken v2.2 checks `r ‖ s ‖ v` with ECDSA when the payer has no code and through ERC-1271
 * when it has code, including an EIP-7702 designator). Only the two relayable entry points are ever built, always
 * with `value = 0`.
 *
 * The result also describes the payee's and the payer's code, which the relayer's admission policy needs
 * (`RelayAdmissionLedger`): code can make a relay pass simulation and revert on inclusion, at the relayer's expense.
 *
 * Time (audit finding A-04). Both checks need `now`, the timestamp of the block the relayer simulates against, and
 * apply the chain's relay margin (`chain.relay.minRemainingSeconds` in the registry): every time bound the call
 * carries must still hold in a block stamped `now + margin`. A bound one second ahead passes every check and
 * `eth_call`, then reverts in any later block, and the party that chose it sends no transaction: the payer chooses
 * `validBefore` alone, the requester picks the invoice's last second, and anyone can sign a throwaway cancellation
 * with `deadline = now`. Re-run `assertRelayWindow` against the pending block's timestamp right before broadcast.
 */
import type { Registry, Token, V2Target } from "@paylink/chains";
import { keccak256 } from "viem";
import type { Address, Hex } from "viem";
import { cancelBySigCall, payWithAuthorizationCall } from "./calls.ts";
import type { CallRequest } from "./calls.ts";
import { EIP7702_DELEGATION_PREFIX } from "./constants.ts";
import { cancelDigest, receiveWithAuthorizationDigest } from "./eip712.ts";
import { PayLinkError } from "./errors.ts";
import type { RelayPayRequest } from "./json.ts";
import { paymentNonce } from "./nonce.ts";
import { verifySignatureWithCode } from "./signature.ts";
import type { SignatureClient } from "./signature.ts";
import { resolveTokenDomain } from "./token-domain.ts";
import type { Authorization, CancelAuthorization, Invoice } from "./types.ts";
import { resolveTarget, validateInvoiceParts } from "./validate.ts";

/** What an account's code means for relaying (read with `eth_getCode` while checking the request). */
export interface AccountCode {
  /** `none`: no code; `delegated`: an EIP-7702 designator `0xef0100 ‖ delegate`; `contract`: any other code. */
  readonly kind: "none" | "delegated" | "contract";
  /** keccak256 of the code, or `null` when there is none. */
  readonly codeHash: Hex | null;
}

/** Classifies `eth_getCode` output. */
export function describeAccountCode(code: Hex | undefined): AccountCode {
  if (code === undefined || code === "0x") {
    return { kind: "none", codeHash: null };
  }
  return { kind: code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX) ? "delegated" : "contract", codeHash: keccak256(code) };
}

/** The time bounds of a relayed call, reduced to what admission needs. */
export interface RelayWindow {
  /**
   * The last block timestamp at which the call still passes every time bound it carries (inclusive): a
   * cancellation's `deadline`; for a payment, the earlier of `validBefore - 1` (the token requires
   * `now < validBefore`) and the invoice's `validUntil` when it is not 0.
   */
  readonly validThrough: bigint;
  /** The chain's relay margin (registry `chain.relay.minRemainingSeconds`): admit only while `validThrough >= now + margin`. */
  readonly minRemainingSeconds: bigint;
}

export interface CheckedRelayCall extends RelayWindow {
  readonly target: V2Target;
  readonly token: Token;
  readonly key: Hex;
  readonly payee: Address;
  /** The payee's code at check time: PayLinkV2 asks a payee with code (ERC-1271) on every call. */
  readonly payeeCode: AccountCode;
  /** The only transaction the relayer may send for this request: to the canonical deployment, value 0. */
  readonly call: CallRequest;
}

export interface CheckedPayRequest extends CheckedRelayCall {
  /** The recomputed binding nonce (spec §8.2). */
  readonly nonce: Hex;
  readonly payer: Address;
  /** The authorized amount and the payer's reference: with `key`, `payer` and `nonce`, what identifies the payment on chain. */
  readonly amount: bigint;
  readonly payerRef: Hex;
  /** The payer's code at check time: the token asks a payer with code (ERC-1271) when it settles. */
  readonly payerCode: AccountCode;
}

/** The last block timestamp at which `payWithAuthorization` passes its time bounds (`RelayWindow.validThrough`). */
export function paymentValidThrough(invoice: Pick<Invoice, "validUntil">, authorization: Pick<Authorization, "validBefore">): bigint {
  const authorizationEnd = authorization.validBefore - 1n;
  return invoice.validUntil !== 0n && invoice.validUntil < authorizationEnd ? invoice.validUntil : authorizationEnd;
}

/** The chain's relay margin, in seconds, from the registry (invoice spec §13.3). */
export function relayMargin(target: V2Target): bigint {
  const relay = target.chain.relay;
  if (relay === null) {
    // createRegistry refuses a v2 chain without relay timing; this guards hand-built objects.
    throw new PayLinkError("E_INVALID_ARGUMENT", `chain ${String(target.chain.chainId)} has no relay timing`, { rule: "RelayTiming" });
  }
  return BigInt(relay.minRemainingSeconds);
}

/**
 * Refuses a relay whose time bounds end within the margin: `validThrough` must be at least `now + margin`, `now`
 * being a block timestamp (audit finding A-04). The checks call it against the block simulated against; call it
 * again against the pending block's timestamp right before broadcasting.
 */
export function assertRelayWindow(window: RelayWindow, now: bigint): void {
  const required = now + window.minRemainingSeconds;
  if (window.validThrough < required) {
    throw new PayLinkError("E_INVALID_ARGUMENT", `the call stays valid until ${window.validThrough.toString()}, before the relay margin ends at ${required.toString()}`, {
      rule: "RelayValidityTooShort",
      validThrough: window.validThrough.toString(),
      required: required.toString(),
    });
  }
}

function checkTarget(registry: Registry, pathChainId: number, bodyChainId: number): V2Target {
  if (pathChainId !== bodyChainId) {
    throw new PayLinkError("E_INVALID_ARGUMENT", `the body is for chain ${bodyChainId}, the path for chain ${pathChainId}`, { rule: "ChainMismatch" });
  }
  const target = resolveTarget(bodyChainId, registry);
  if (target.deployment.status === "revoked") {
    throw new PayLinkError("E_DEPLOYMENT_INACTIVE", `the deployment on chain ${bodyChainId} is revoked`, { status: "revoked" });
  }
  return target;
}

/** Verifies the payee's signature with PayLinkV2's dispatch and returns the payee's code. */
async function checkPayee(invoice: Invoice, digest: Hex, signature: Hex, client: SignatureClient): Promise<AccountCode> {
  const code = await client.getCode({ address: invoice.payee });
  const check = await verifySignatureWithCode({ signer: invoice.payee, digest, signature, client, code });
  if (!check.valid) {
    throw new PayLinkError("E_SIGNATURE_INVALID", `the payee signature does not verify (${String(check.failure)})`, { failure: String(check.failure) });
  }
  return describeAccountCode(code);
}

const reject = (rule: string, message: string): never => {
  throw new PayLinkError("E_INVALID_ARGUMENT", message, { rule });
};

/**
 * Checks a parsed `POST /v1/{chainId}/pay` body (`parseRelayPayRequest`) and returns the
 * `payWithAuthorization` call to simulate and send. At `now` (chain time: the timestamp of the block the relayer
 * simulates against) it refuses an authorization outside its window, which the token would reject (FiatToken:
 * `validAfter < now < validBefore`), an invoice outside its window, and any time bound that ends within the chain's
 * relay margin (`RelayValidityTooShort`, audit finding A-04).
 * Passing these checks makes a request well-formed, not safe to relay: apply the admission policy next
 * (`RelayAdmissionLedger.admit`), then simulate against the pending block immediately before sending.
 */
export async function checkRelayPayRequest(parameters: {
  readonly registry: Registry;
  readonly pathChainId: number;
  readonly request: RelayPayRequest;
  readonly client: SignatureClient;
  /** Chain time: the timestamp of the block the relayer simulates against. */
  readonly now: bigint;
}): Promise<CheckedPayRequest> {
  const { registry, request, client } = parameters;
  const { invoice, authorization } = request;
  const target = checkTarget(registry, parameters.pathChainId, request.chainId);
  const { key, token } = validateInvoiceParts({
    chainId: request.chainId,
    target,
    registry,
    invoice,
    signatureLength: (request.signature.length - 2) / 2,
    memo: { mode: "omitted" },
  });
  if (token.kind !== "erc20" || !token.capabilities.eip3009) {
    throw new PayLinkError("E_TOKEN_NOT_EIP3009", `${token.symbol} does not support EIP-3009`, { token: token.address });
  }
  if (invoice.amount === 0n ? authorization.amount === 0n : authorization.amount !== invoice.amount) {
    reject("WrongAmount", "the authorized amount does not satisfy the invoice");
  }
  if (authorization.payer.toLowerCase() === invoice.payee.toLowerCase()) {
    reject("SelfPayment", "the payer is the payee");
  }
  const { now } = parameters;
  if (!(authorization.validAfter < now && now < authorization.validBefore)) {
    reject("AuthorizationWindow", "the authorization is not valid now");
  }
  if (now < invoice.validAfter) {
    reject("NotYetValid", "the invoice is not valid yet");
  }
  if (invoice.validUntil !== 0n && now > invoice.validUntil) {
    reject("Expired", "the invoice has expired");
  }
  const window: RelayWindow = { validThrough: paymentValidThrough(invoice, authorization), minRemainingSeconds: relayMargin(target) };
  assertRelayWindow(window, now);
  const payeeCode = await checkPayee(invoice, key, request.signature, client);
  const nonce = paymentNonce({ key, payer: authorization.payer, amount: authorization.amount, payerRef: authorization.payerRef, payerSalt: authorization.payerSalt });
  const tokenDomain = await resolveTokenDomain({ chainId: request.chainId, token, client });
  const digest = receiveWithAuthorizationDigest(tokenDomain, {
    from: authorization.payer,
    to: target.deployment.address,
    value: authorization.amount,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce,
  });
  // FiatToken's v, r, s overload verifies abi.encodePacked(r, s, v) with its SignatureChecker: the same dispatch.
  const signature: Hex = `0x${authorization.r.slice(2)}${authorization.s.slice(2)}${authorization.v.toString(16).padStart(2, "0")}`;
  const payerCodeRaw = await client.getCode({ address: authorization.payer });
  const payerCheck = await verifySignatureWithCode({ signer: authorization.payer, digest, signature, client, code: payerCodeRaw });
  if (!payerCheck.valid) {
    throw new PayLinkError("E_SIGNATURE_INVALID", "the payer's EIP-3009 signature does not verify for this payment", { failure: "payer" });
  }
  return {
    target,
    token,
    key,
    nonce,
    payee: invoice.payee,
    payeeCode,
    payer: authorization.payer,
    amount: authorization.amount,
    payerRef: authorization.payerRef,
    payerCode: describeAccountCode(payerCodeRaw),
    call: payWithAuthorizationCall(target.deployment.address, invoice, request.signature, authorization),
    ...window,
  };
}

/**
 * Checks a `POST /v1/{chainId}/cancel` body (`parseCancelAuthorizationJson`) and returns the `cancelBySig` call.
 * At `now` (chain time) it refuses a deadline already passed (the contract's `SignatureExpired`) and one that ends
 * within the chain's relay margin (`RelayValidityTooShort`, audit finding A-04): a throwaway payee can sign
 * `deadline = now` for free.
 */
export async function checkRelayCancelRequest(parameters: {
  readonly registry: Registry;
  readonly pathChainId: number;
  readonly request: CancelAuthorization;
  readonly client: SignatureClient;
  /** Chain time: the timestamp of the block the relayer simulates against. */
  readonly now: bigint;
}): Promise<CheckedRelayCall> {
  const { registry, request, client } = parameters;
  const target = checkTarget(registry, parameters.pathChainId, request.chainId);
  const { key, token } = validateInvoiceParts({
    chainId: request.chainId,
    target,
    registry,
    invoice: request.invoice,
    signatureLength: (request.signature.length - 2) / 2,
    memo: { mode: "omitted" },
  });
  if (parameters.now > request.deadline) {
    reject("SignatureExpired", "the cancellation deadline has passed");
  }
  const window: RelayWindow = { validThrough: request.deadline, minRemainingSeconds: relayMargin(target) };
  assertRelayWindow(window, parameters.now);
  const digest = cancelDigest({ chainId: request.chainId, verifyingContract: target.deployment.address }, key, request.deadline);
  const payeeCode = await checkPayee(request.invoice, digest, request.signature, client);
  return { target, token, key, payee: request.invoice.payee, payeeCode, call: cancelBySigCall(target.deployment.address, request), ...window };
}
