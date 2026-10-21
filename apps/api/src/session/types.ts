// SPDX-License-Identifier: MIT
/**
 * Sessions (docs/paypal/SPEC.md §12.2): `POST /v1/session` verifies the payee's EIP-712 `PayLinkSession` signature
 * (SESSION_TYPES in @paylink/api-contract; ERC-1271 through the chain for smart accounts) and returns an HMAC token
 * (`SESSION_HMAC_KEY`) valid at most 12 hours. Only the payee's own twins and desk are reachable with it.
 *
 * Owner: reconciler workstream (types and implementation; other workstreams ask for changes through a handoff).
 */
import type { Address, SessionRequest, SessionResponse } from "@paylink/api-contract";

export type SessionCheck = { readonly ok: true; readonly payee: Address; readonly expiresAt: number } | { readonly ok: false; readonly reason: "missing" | "malformed" | "bad-mac" | "expired" };

export interface Sessions {
  /** Verifies the signed session request; rejects with a `ProblemError` (`unauthorized`, `invalid-request`). */
  open(request: SessionRequest, now: number): Promise<SessionResponse>;
  /** Checks an `Authorization: Bearer` token. */
  check(token: string | null, now: number): Promise<SessionCheck>;
}
