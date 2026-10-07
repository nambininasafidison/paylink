// SPDX-License-Identifier: MIT
/**
 * End-to-end flows over the registry: an issuer creating a shareable invoice link (invoice spec §13.1) and a
 * payer authorizing a gasless EIP-3009 payment for a decoded link (§8, §13.2). Each composes the lower-level
 * functions and applies every rule the spec puts on that role.
 */
import type { Erc20Token, Registry, Token, V2Target } from "@paylink/chains";
import type { Hex } from "viem";
import type { AuthorizationAssessment } from "./attempts.ts";
import { encodeInvoiceFragment } from "./codec/fragment.ts";
import type { DecodedInvoiceLink } from "./codec/fragment.ts";
import { DEFAULT_AUTHORIZATION_TTL_SECONDS } from "./constants.ts";
import { invoiceKey } from "./eip712.ts";
import { assertArgument, PayLinkError } from "./errors.ts";
import { buildInvoice, invoiceShapeIssue, issuerWarnings } from "./invoice.ts";
import type { InvoiceDraft, IssuerWarning } from "./invoice.ts";
import { toRelayPayRequest } from "./json.ts";
import type { RelayPayRequestJson } from "./json.ts";
import { cryptoRandom } from "./random.ts";
import type { RandomSource } from "./random.ts";
import { signInvoice, signReceiveAuthorization } from "./sign.ts";
import type { SignedAuthorization } from "./sign.ts";
import type { CallReader, SignatureClient } from "./signature.ts";
import { resolveTokenDomain } from "./token-domain.ts";
import type { SignedInvoice, TypedDataSigner } from "./types.ts";
import { resolveTarget } from "./validate.ts";

export interface IssuedInvoice {
  readonly signed: SignedInvoice;
  readonly key: Hex;
  /** The URL fragment (without `#`), at most 1,200 characters. */
  readonly fragment: string;
  readonly target: V2Target;
  readonly token: Token;
  /** Show these before the payee shares the link (`issuerWarnings`). */
  readonly warnings: readonly IssuerWarning[];
  /**
   * How the payee was verified: `eoa` or `contract` (ERC-1271) with a client; `delegated` for an EIP-7702 EOA
   * (warn, §6.4); `unchecked` without a client (ECDSA assumed).
   */
  readonly payeeAccount: "eoa" | "contract" | "delegated" | "unchecked";
}

/**
 * Creates a signed invoice link on a registry chain:
 * the chain must have an `active` deployment (§4.2); the token must be on the chain's allowlist; the shape
 * must hold for the registry's `verifyingContract`; the signer must be the payee; the signature is verified
 * with the contract's dispatch (so counterfactual smart-account payees fail here, §6.3); and the fragment
 * must fit in 1,200 characters.
 */
export async function issueInvoice(parameters: {
  readonly registry: Registry;
  readonly chainId: number;
  readonly draft: InvoiceDraft;
  readonly signer: TypedDataSigner;
  /** Strongly recommended: verifies with the contract's dispatch (ERC-1271, EIP-7702) instead of ECDSA only. */
  readonly client?: SignatureClient;
  readonly random?: RandomSource;
}): Promise<IssuedInvoice> {
  const { registry, chainId, draft, signer, client } = parameters;
  const target = resolveTarget(chainId, registry);
  if (target.deployment.status !== "active") {
    throw new PayLinkError("E_DEPLOYMENT_INACTIVE", `the deployment on chain ${chainId} is ${target.deployment.status}`, {
      status: target.deployment.status,
    });
  }
  const { invoice, memo } = buildInvoice(draft, parameters.random ?? cryptoRandom);
  const token = registry.findToken(chainId, invoice.token);
  if (token === undefined) {
    throw new PayLinkError("E_TOKEN_UNKNOWN", `token ${invoice.token} is not on the allowlist of chain ${chainId}`, { token: invoice.token });
  }
  const issue = invoiceShapeIssue(invoice, target.deployment.address);
  if (issue !== null) {
    throw new PayLinkError("E_INVOICE_SHAPE", `invalid invoice shape: ${issue}`, { issue });
  }
  const deployment = { chainId, verifyingContract: target.deployment.address };
  const { signature, verification } = await signInvoice({ signer, deployment, invoice, ...(client === undefined ? {} : { client }) });
  const signed: SignedInvoice = { chainId, invoice, signature, memo };
  return {
    signed,
    key: invoiceKey(deployment, invoice),
    fragment: encodeInvoiceFragment(signed),
    target,
    token,
    warnings: issuerWarnings(invoice),
    payeeAccount: !verification.codeChecked ? "unchecked" : verification.method === "ecdsa" ? "eoa" : verification.delegated ? "delegated" : "contract",
  };
}

export interface PaymentAuthorization extends SignedAuthorization {
  /** The body of the relayer's `POST /v1/{chainId}/pay` (no memo, §11.2). */
  readonly request: RelayPayRequestJson;
}

/**
 * The payer signs a gasless EIP-3009 payment for a decoded link (§8.3). The token must support EIP-3009 and
 * the amount must satisfy the invoice (exact for a fixed invoice, positive for an open one). `validBefore`
 * is `now + ttl` (default 600 s), keeping the relayer's possible delay short (§8.5).
 *
 * Retry safety (§8.6): a new signature draws a new `payerSalt`, which makes it a new payment wherever
 * `maxPayments != 1`. It is therefore refused while an earlier authorization for the same link and payer is
 * `live` (resubmit that one; `E_AUTHORIZATION_OUTSTANDING`) or `consumed` without a recorded cancellation (it
 * was paid; `E_AUTHORIZATION_CONSUMED`, unless the user explicitly starts a new payment). Persist the result with
 * `recordOutstandingAuthorization` before sending its `request` anywhere.
 */
export async function authorizePayment(parameters: {
  readonly link: DecodedInvoiceLink;
  readonly signer: TypedDataSigner;
  /** Chain time. */
  readonly now: bigint;
  /**
   * The device's outstanding authorization for this link and payer, assessed on chain (`assessOutstanding`), or
   * `null` when the device holds none. Required, so that a retry can never re-sign by accident.
   */
  readonly outstanding: AuthorizationAssessment | null;
  /** The user explicitly started another payment after an earlier one for this link went through. */
  readonly newPayment?: boolean;
  /** Required for open-amount invoices; must equal the invoice amount otherwise. */
  readonly amount?: bigint;
  readonly ttlSeconds?: bigint;
  readonly payerRef?: Hex;
  /** Reads the token's EIP-712 domain from the chain; required when the registry does not state it. */
  readonly client?: CallReader;
  readonly random?: RandomSource;
}): Promise<PaymentAuthorization> {
  const { link, signer, now, outstanding } = parameters;
  if (outstanding?.state === "live") {
    throw new PayLinkError(
      "E_AUTHORIZATION_OUTSTANDING",
      "an authorization for this payment is still valid: resubmit it, or cancel it on the token first",
      { validBefore: outstanding.validBefore.toString() },
    );
  }
  if (outstanding?.state === "consumed" && parameters.newPayment !== true) {
    throw new PayLinkError("E_AUTHORIZATION_CONSUMED", "the earlier authorization for this link was used: verify its receipt before paying again");
  }
  const token = link.token;
  if (token.kind !== "erc20" || !token.capabilities.eip3009) {
    throw new PayLinkError("E_TOKEN_NOT_EIP3009", `${token.symbol} does not support EIP-3009 on chain ${link.chainId}`, { token: token.address });
  }
  const amount = parameters.amount ?? link.invoice.amount;
  assertArgument(link.invoice.amount === 0n ? amount > 0n : amount === link.invoice.amount, "the amount does not satisfy the invoice", {
    rule: "WrongAmount",
  });
  assertArgument(signer.address.toLowerCase() !== link.invoice.payee.toLowerCase(), "the payer cannot be the payee", { rule: "SelfPayment" });
  const ttl = parameters.ttlSeconds ?? DEFAULT_AUTHORIZATION_TTL_SECONDS;
  assertArgument(ttl > 0n, "the authorization window must be positive");
  const tokenDomain = await resolveTokenDomain({
    chainId: link.chainId,
    token: token satisfies Erc20Token,
    ...(parameters.client === undefined ? {} : { client: parameters.client }),
  });
  const signed = await signReceiveAuthorization({
    signer,
    tokenDomain,
    verifyingContract: link.target.deployment.address,
    key: link.key,
    amount,
    validBefore: now + ttl,
    ...(parameters.payerRef === undefined ? {} : { payerRef: parameters.payerRef }),
    random: parameters.random ?? cryptoRandom,
  });
  return { ...signed, request: toRelayPayRequest(link, signed.authorization) };
}
