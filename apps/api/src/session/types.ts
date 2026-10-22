// SPDX-License-Identifier: MIT
/**
 * Sessions (docs/paypal/SPEC.md §12.2): `POST /v1/session` verifies the payee's EIP-712 `PayLinkSession` signature
 * (SESSION_DOMAIN and SESSION_TYPES in @paylink/api-contract; ECDSA first, then ERC-1271 through the chain for a smart
 * account) and returns an HMAC token (`SESSION_HMAC_KEY`) valid at most 12 hours. Only the payee's own twins and desk are
 * reachable with it.
 *
 * Rules (E): the signed origin is one of the API's allowed origins; the signature was made within the last 10 minutes
 * (5 minutes of clock skew tolerated); the session lasts at most 12 hours; each signed nonce opens one session only, and
 * a replayed one counts against nothing; then, for a fresh nonce only, the daily limits (abuse of the public demo, threat
 * T-60): 20 sessions per payee and 30 per request source (src/store/quotas.ts), and `SESSIONS_PER_DAY` for the whole
 * deployment. The demo payees (`config.demoPayees`) skip the payee and source limits and use their own reserved lane.
 *
 * Token format (opaque to clients): `ps1.<payee, 40 hex lowercase>.<expiresAt, ms>.<MAC, base64url>`, the MAC covering
 * `paylink.session.v1`, the payee and the expiry.
 *
 * Owner: reconciler workstream (types and implementation; other workstreams ask for changes through a handoff).
 */
import type { Address, SessionRequest, SessionResponse } from "@paylink/api-contract";

export type SessionCheck = { readonly ok: true; readonly payee: Address; readonly expiresAt: number } | { readonly ok: false; readonly reason: "missing" | "malformed" | "bad-mac" | "expired" };

export interface Sessions {
  /**
   * Verifies the signed session request; rejects with a `ProblemError` (`unauthorized`, `forbidden`, `invalid-request`,
   * `quota-exhausted`). `source` is the request's source (`clientSource`, src/core/http.ts); `unknown` when absent.
   */
  open(request: SessionRequest, now: number, context?: { readonly source: string }): Promise<SessionResponse>;
  /** Checks an `Authorization: Bearer` token. */
  check(token: string | null, now: number): Promise<SessionCheck>;
}

/** How far back the signature may have been made, and how far ahead the payee's clock may be (seconds, E). */
export const SESSION_SIGNED_WITHIN_S = 10 * 60;
export const SESSION_CLOCK_SKEW_S = 5 * 60;
/** Sessions the deployment opens per UTC day at most (E). */
export const SESSIONS_PER_DAY = 5_000;
