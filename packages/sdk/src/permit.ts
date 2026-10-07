// SPDX-License-Identifier: MIT
/**
 * The EIP-2612 path (`payWithPermit`, spec §3.5: MUSD, AUSD, USDC): the payer signs a permit for exactly the
 * payment amount, with PayLinkV2 as spender, and sends one transaction. The contract runs the permit in
 * try/catch after recording the payment, so a front-run permit is harmless (invoice spec §14.9).
 */
import { decodeFunctionResult, encodeFunctionData, hashTypedData } from "viem";
import type { Address, Hex } from "viem";
import { payWithPermitCall } from "./calls.ts";
import type { CallRequest } from "./calls.ts";
import type { DecodedInvoiceLink } from "./codec/fragment.ts";
import { MAX_UINT256, ZERO_HASH } from "./constants.ts";
import type { Eip712Domain } from "./eip712.ts";
import { assertArgument, PayLinkError } from "./errors.ts";
import { normalizeEcdsaV, parseEcdsaSignature, recoverEcdsaSigner } from "./signature.ts";
import type { CallReader } from "./signature.ts";
import { resolveTokenDomain } from "./token-domain.ts";
import type { Permit, TypedDataSigner } from "./types.ts";

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const NONCES_ABI = [
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** The owner's current EIP-2612 nonce, `nonces(owner)`. */
export async function readPermitNonce(client: CallReader, token: Address, owner: Address): Promise<bigint> {
  const result = await client.call({ to: token, data: encodeFunctionData({ abi: NONCES_ABI, functionName: "nonces", args: [owner] }) });
  return decodeFunctionResult({ abi: NONCES_ABI, functionName: "nonces", data: result.data ?? "0x" });
}

/** Signs `Permit(owner, spender, value, nonce, deadline)` under the token's domain; verified before it is returned. */
export async function signPermit(parameters: {
  readonly signer: TypedDataSigner;
  readonly tokenDomain: Eip712Domain;
  readonly spender: Address;
  readonly value: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}): Promise<Permit> {
  const { signer, tokenDomain, spender, value, nonce, deadline } = parameters;
  assertArgument(value > 0n && value <= MAX_UINT256, "the permit value must be a positive uint256");
  assertArgument(nonce >= 0n && nonce <= MAX_UINT256 && deadline >= 0n && deadline <= MAX_UINT256, "nonce and deadline must be uint256");
  const typed = {
    domain: { ...tokenDomain },
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: { owner: signer.address, spender, value, nonce, deadline },
  };
  const signature = normalizeEcdsaV(await signer.signTypedData({ ...typed, message: { ...typed.message } }));
  const parsed = parseEcdsaSignature(signature);
  const recovered = await recoverEcdsaSigner(hashTypedData(typed), signature);
  if (!parsed.ok || !("signer" in recovered) || recovered.signer.toLowerCase() !== signer.address.toLowerCase()) {
    throw new PayLinkError("E_SIGNATURE_INVALID", "an EIP-2612 permit must be a 65-byte ECDSA signature by the owner");
  }
  return { deadline, v: parsed.v, r: parsed.r, s: parsed.s };
}

export interface PermitPayment {
  readonly permit: Permit;
  /** The `payWithPermit` transaction the payer sends (no value). */
  readonly call: CallRequest;
}

/**
 * The payer prepares a `payWithPermit` for a decoded link: the token must support EIP-2612; the permit is
 * for exactly the amount paid (never unlimited, §13.2), with PayLinkV2 as spender; the nonce and, when the
 * registry does not state it, the token's domain are read from the chain.
 */
export async function preparePermitPayment(parameters: {
  readonly link: DecodedInvoiceLink;
  readonly signer: TypedDataSigner;
  readonly client: CallReader;
  /** Permit deadline (unix seconds, chain time). */
  readonly deadline: bigint;
  /** Required for open-amount invoices; must equal the invoice amount otherwise. */
  readonly amount?: bigint;
  readonly payerRef?: Hex;
}): Promise<PermitPayment> {
  const { link, signer, client, deadline } = parameters;
  const token = link.token;
  if (token.kind !== "erc20" || !token.capabilities.eip2612) {
    throw new PayLinkError("E_TOKEN_NOT_EIP2612", `${token.symbol} does not support EIP-2612 on chain ${link.chainId}`, { token: token.address });
  }
  const amount = parameters.amount ?? link.invoice.amount;
  assertArgument(link.invoice.amount === 0n ? amount > 0n : amount === link.invoice.amount, "the amount does not satisfy the invoice", { rule: "WrongAmount" });
  assertArgument(signer.address.toLowerCase() !== link.invoice.payee.toLowerCase(), "the payer cannot be the payee", { rule: "SelfPayment" });
  const tokenDomain = await resolveTokenDomain({ chainId: link.chainId, token, client });
  const nonce = await readPermitNonce(client, token.address, signer.address);
  const spender = link.target.deployment.address;
  const permit = await signPermit({ signer, tokenDomain, spender, value: amount, nonce, deadline });
  return { permit, call: payWithPermitCall(spender, link.invoice, link.signature, amount, permit, parameters.payerRef ?? ZERO_HASH) };
}
