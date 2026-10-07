// SPDX-License-Identifier: MIT
/**
 * Signing: invoices and cancellations by the payee (invoice spec §6, §9.2), EIP-3009 authorizations by the
 * payer (§8.3). Every produced signature is verified locally before it is returned (§13.1: issuers MUST
 * verify the produced signature before sharing it).
 */
import type { Address, Hex } from "viem";
import { MAX_UINT256, ZERO_HASH } from "./constants.ts";
import { cancelDigest, cancelTypedData, invoiceKey, invoiceTypedData, receiveWithAuthorizationDigest, receiveWithAuthorizationTypedData } from "./eip712.ts";
import type { Eip712Domain, PayLinkDeployment } from "./eip712.ts";
import { assertArgument, PayLinkError } from "./errors.ts";
import { paymentNonce } from "./nonce.ts";
import { cryptoRandom, randomBytes32 } from "./random.ts";
import type { RandomSource } from "./random.ts";
import { normalizeEcdsaV, parseEcdsaSignature, recoverEcdsaSigner, verifySignature } from "./signature.ts";
import type { SignatureClient, SignatureVerification } from "./signature.ts";
import type { Authorization, CancelAuthorization, Invoice, TypedDataSigner } from "./types.ts";

const sameAddress = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase();

function requirePayee(signer: TypedDataSigner, invoice: Invoice): void {
  if (!sameAddress(signer.address, invoice.payee)) {
    throw new PayLinkError("E_SIGNER_NOT_PAYEE", `signer ${signer.address} is not the payee ${invoice.payee}`, {
      signer: signer.address,
      payee: invoice.payee,
    });
  }
}

async function verifyProduced(signer: Address, digest: Hex, signature: Hex, client: SignatureClient | undefined): Promise<SignatureVerification> {
  const check = await verifySignature({ signer, digest, signature, ...(client === undefined ? {} : { client }) });
  if (!check.valid) {
    throw new PayLinkError("E_SIGNATURE_INVALID", `the produced signature does not verify (${String(check.failure)})`, {
      failure: String(check.failure),
    });
  }
  return check;
}

/** A produced signature and how it was verified. */
export interface SignatureResult {
  /** Lowercase hex; ECDSA `v` normalised to {27, 28}. */
  readonly signature: Hex;
  readonly verification: SignatureVerification;
}

/**
 * The payee signs the invoice's EIP-712 typed data. The signature is verified before it is returned; pass a
 * client to verify with the contract's dispatch (needed for ERC-1271 and EIP-7702 payees).
 */
export async function signInvoice(parameters: {
  readonly signer: TypedDataSigner;
  readonly deployment: PayLinkDeployment;
  readonly invoice: Invoice;
  readonly client?: SignatureClient;
}): Promise<SignatureResult> {
  const { signer, deployment, invoice, client } = parameters;
  requirePayee(signer, invoice);
  const typed = invoiceTypedData(deployment, invoice);
  const signature = normalizeEcdsaV(await signer.signTypedData({ ...typed, message: { ...typed.message } }));
  const verification = await verifyProduced(invoice.payee, invoiceKey(deployment, invoice), signature, client);
  return { signature, verification };
}

/**
 * The payee signs `Cancel(key, deadline)` for a relayed `cancelBySig` (§9.2). The deadline is inclusive;
 * keep it short (1 hour recommended, `DEFAULT_CANCEL_TTL_SECONDS`).
 */
export async function signCancel(parameters: {
  readonly signer: TypedDataSigner;
  readonly deployment: PayLinkDeployment;
  readonly invoice: Invoice;
  readonly deadline: bigint;
  readonly client?: SignatureClient;
}): Promise<CancelAuthorization> {
  const { signer, deployment, invoice, deadline, client } = parameters;
  assertArgument(deadline >= 0n && deadline <= MAX_UINT256, "deadline must be a uint256");
  requirePayee(signer, invoice);
  const key = invoiceKey(deployment, invoice);
  const typed = cancelTypedData(deployment, key, deadline);
  const signature = normalizeEcdsaV(await signer.signTypedData({ ...typed, message: { ...typed.message } }));
  await verifyProduced(invoice.payee, cancelDigest(deployment, key, deadline), signature, client);
  return { chainId: deployment.chainId, invoice, deadline, signature };
}

export interface SignedAuthorization {
  /** The `IPayLinkV2.Authorization` argument of `payWithAuthorization`. */
  readonly authorization: Authorization;
  /** The bound token nonce (`paymentNonce`), recomputed on-chain. */
  readonly nonce: Hex;
  /** The digest the payer signed, under the token's domain. */
  readonly digest: Hex;
}

/**
 * The payer signs the token's EIP-3009 `ReceiveWithAuthorization` for one payment: `to` is the PayLinkV2
 * deployment and the nonce is the payment binding (§8.2, §8.3). Only the v, r, s form exists, so the signer
 * must produce a 65-byte ECDSA signature (EOA or passkey-derived account); smart accounts use `pay`.
 */
export async function signReceiveAuthorization(parameters: {
  readonly signer: TypedDataSigner;
  /** The token's EIP-712 domain (`resolveTokenDomain`). */
  readonly tokenDomain: Eip712Domain;
  /** The PayLinkV2 deployment that will receive the tokens and forward them. */
  readonly verifyingContract: Address;
  readonly key: Hex;
  readonly amount: bigint;
  readonly validBefore: bigint;
  readonly validAfter?: bigint;
  readonly payerRef?: Hex;
  readonly payerSalt?: Hex;
  readonly random?: RandomSource;
}): Promise<SignedAuthorization> {
  const { signer, tokenDomain, verifyingContract, key, amount, validBefore } = parameters;
  const validAfter = parameters.validAfter ?? 0n;
  const payerRef = parameters.payerRef ?? ZERO_HASH;
  const payerSalt = parameters.payerSalt ?? randomBytes32(parameters.random ?? cryptoRandom);
  assertArgument(amount > 0n, "the authorized amount must be positive");
  assertArgument(validAfter >= 0n && validBefore > validAfter && validBefore <= MAX_UINT256, "need 0 <= validAfter < validBefore <= 2^256 - 1");
  const nonce = paymentNonce({ key, payer: signer.address, amount, payerRef, payerSalt });
  const message = { from: signer.address, to: verifyingContract, value: amount, validAfter, validBefore, nonce };
  const typed = receiveWithAuthorizationTypedData(tokenDomain, message);
  const signature = normalizeEcdsaV(await signer.signTypedData({ ...typed, message: { ...typed.message } }));
  const digest = receiveWithAuthorizationDigest(tokenDomain, message);
  const parsed = parseEcdsaSignature(signature);
  const recovered = await recoverEcdsaSigner(digest, signature);
  if (!parsed.ok || !("signer" in recovered) || !sameAddress(recovered.signer, signer.address)) {
    throw new PayLinkError("E_SIGNATURE_INVALID", "the payer's EIP-3009 signature must be a 65-byte ECDSA signature by the payer");
  }
  return {
    authorization: { payer: signer.address, amount, payerRef, validAfter, validBefore, payerSalt, v: parsed.v, r: parsed.r, s: parsed.s },
    nonce,
    digest,
  };
}
