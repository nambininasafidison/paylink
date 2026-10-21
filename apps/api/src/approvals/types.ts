// SPDX-License-Identifier: MIT
/**
 * Approvals (docs/paypal/SPEC.md §10.5, invariant AI-3): every AI-originated external effect needs the payee's tap on
 * exact values. A proposal is serialised as canonical JSON (keys sorted, exact string values), hashed with SHA-256, and
 * the approval token is `HMAC-SHA256(APPROVAL_HMAC_KEY, hash ‖ payee ‖ expiresAt)`, valid 15 minutes (E). The executor
 * accepts an approval only when the hash, the payee (the session's) and the expiry all check, and only once.
 *
 * Tests (L1): wrong hash, expired token, another account, replay, and a changed value in the proposal all refuse.
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
  /** Exact values (invoice number, amount, PayPal invoice id, deadline, ...), as strings. */
  readonly args: Readonly<Record<string, string>>;
}

/** A token as issued: the string the web edition sends back, and its parts for the store. */
export interface ApprovalToken {
  readonly token: string;
  readonly hash: Hex;
  readonly payee: Address;
  readonly expiresAt: number;
}

export type ApprovalCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "malformed" | "bad-mac" | "hash-mismatch" | "other-payee" | "expired" | "already-used" };

export interface Approvals {
  /** `0x` + SHA-256 of the canonical JSON of the proposal. */
  hash(proposal: CanonicalProposal): Promise<Hex>;
  issue(proposal: CanonicalProposal, now: number): Promise<ApprovalToken>;
  /** Checks a token against the stored proposal and the session's payee. Single use is enforced by the store. */
  verify(token: string, proposal: CanonicalProposal, sessionPayee: Address, now: number): Promise<ApprovalCheck>;
}
