// SPDX-License-Identifier: MIT
/**
 * Approvals (docs/paypal/SPEC.md §10.5, invariant AI-3): every AI-originated external effect needs the payee's tap on
 * exact values. A proposal is serialised as canonical JSON (keys sorted, exact string values), hashed with SHA-256, and
 * the approval token is `HMAC-SHA256(APPROVAL_HMAC_KEY, hash ‖ payee ‖ expiresAt)`, valid 15 minutes (E). The executor
 * accepts an approval only when the MAC, the hash, the payee (the session's) and the expiry all check, and only once
 * (the proposal's compare-and-set from `open` to `approving` in the payee's store).
 *
 * Token format (opaque to clients): `pa1.<hash, 64 hex>.<payee, 40 hex lowercase>.<expiresAt, ms>.<MAC, base64url>`.
 * The MAC covers `paylink.approval.v1`, the hash, the payee and the expiry, separated by newlines.
 *
 * Tests (L1, test/approvals/): wrong hash, expired token, another account, replay, a changed value, a forged or
 * truncated token, another key.
 *
 * Owner: reconciler workstream (types and implementation; other workstreams ask for changes through a handoff).
 */
import type { Address, Hex, InvoiceKey, ProposalKind } from "@paylink/api-contract";

/** How long an approval token is valid (E). */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** What a proposal's hash binds: everything the executor will use, nothing the model wrote. */
export interface CanonicalProposal {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly key: InvoiceKey;
  readonly payee: Address;
  readonly chainId: number;
  /** Exact values (invoice number, amount, PayPal invoice id, transaction hash, ...), as strings. */
  readonly args: Readonly<Record<string, string>>;
}

/** A token as issued: the string the web edition sends back, and its parts. */
export interface ApprovalToken {
  readonly token: string;
  readonly hash: Hex;
  readonly payee: Address;
  readonly expiresAt: number;
}

export type ApprovalFailure = "malformed" | "bad-mac" | "hash-mismatch" | "other-payee" | "expired" | "already-used" | "unavailable";

export type ApprovalCheck = { readonly ok: true } | { readonly ok: false; readonly reason: ApprovalFailure };

export interface Approvals {
  /** `0x` + SHA-256 of the canonical JSON of the proposal (payee and key lowercased). */
  hash(proposal: CanonicalProposal): Promise<Hex>;
  /** A token for the proposal and its payee, valid `APPROVAL_TTL_MS` (or until `notAfter`, if sooner). */
  issue(proposal: CanonicalProposal, now: number, notAfter?: number): Promise<ApprovalToken>;
  /** Checks a token against the stored proposal and the session's payee. Single use is enforced by the store. */
  verify(token: string, proposal: CanonicalProposal, sessionPayee: Address, now: number): Promise<ApprovalCheck>;
}
