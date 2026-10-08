// SPDX-License-Identifier: MIT
/**
 * The payer's verification strip (PAYLINK-V2-SPEC §3.6, invoice spec §13.2), computed on the chain through the
 * registry's RPCs:
 *
 *   1. Signature valid: the payee's signature over the invoice key, with the contract's own dispatch (ECDSA without
 *      code, ERC-1271 with code, EIP-7702 delegation included). It proves only that this address signed.
 *   2. Right network: the payer's wallet is on the invoice's chain (computed by the page, from the wallet).
 *   3. Genuine PayLink contract: the registry address holds the release's code (masked runtime hash, the seven EIP-712
 *      immutables for this chain and address, ERC-5267 domain).
 *   4. Still payable: not cancelled, not sold out, inside its window, by chain time.
 *
 * A transport failure is "unknown", never "valid" and never "invalid": the Pay key waits.
 */
import { linkStatus, readLinkState, verifyDeploymentCode, verifySignature } from "@paylink/sdk";
import type { DecodedInvoiceLink, DeploymentFailure, LinkState, LinkStatus, SignatureFailure } from "@paylink/sdk";
import { chainTime } from "../core/clients.ts";
import type { ChainClient } from "../core/clients.ts";

export type SignatureCheck = { readonly state: "ok"; readonly delegated: boolean } | { readonly state: "err"; readonly failure: SignatureFailure } | { readonly state: "unknown" };
export type ContractCheck = { readonly state: "ok" } | { readonly state: "err"; readonly failure: DeploymentFailure } | { readonly state: "unknown" };
export type PayableCheck =
  | { readonly state: "ok" | "err"; readonly status: LinkStatus; readonly link: LinkState; readonly now: bigint }
  | { readonly state: "unknown" };

export interface LinkChecks {
  readonly signature: SignatureCheck;
  readonly contract: ContractCheck;
  readonly payable: PayableCheck;
}

export async function checkSignature(link: DecodedInvoiceLink, client: ChainClient): Promise<SignatureCheck> {
  try {
    const result = await verifySignature({ signer: link.invoice.payee, digest: link.key, signature: link.signature, client });
    return result.valid ? { state: "ok", delegated: result.delegated } : { state: "err", failure: result.failure ?? "malformed" };
  } catch {
    return { state: "unknown" };
  }
}

export async function checkContract(link: DecodedInvoiceLink, client: ChainClient): Promise<ContractCheck> {
  try {
    const result = await verifyDeploymentCode({ client, chainId: link.chainId, address: link.target.deployment.address });
    return result.genuine ? { state: "ok" } : { state: "err", failure: result.failure };
  } catch {
    return { state: "unknown" };
  }
}

export async function checkPayable(link: DecodedInvoiceLink, client: ChainClient): Promise<PayableCheck> {
  try {
    const [state, now] = await Promise.all([readLinkState(client, link.target.deployment.address, link.key), chainTime(client)]);
    const status = linkStatus(link.invoice, state, now);
    return { state: status === "payable" ? "ok" : "err", status, link: state, now };
  } catch {
    return { state: "unknown" };
  }
}

export async function checkLink(link: DecodedInvoiceLink, client: ChainClient): Promise<LinkChecks> {
  const [signature, contract, payable] = await Promise.all([checkSignature(link, client), checkContract(link, client), checkPayable(link, client)]);
  return { signature, contract, payable };
}

/** True when nothing red or unknown stands in the way (the network lamp is the page's). */
export function checksAllow(checks: LinkChecks): boolean {
  return checks.signature.state === "ok" && checks.contract.state === "ok" && checks.payable.state === "ok";
}
