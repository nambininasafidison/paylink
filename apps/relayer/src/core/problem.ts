// SPDX-License-Identifier: MIT
/**
 * Error responses of the relayer: RFC 9457 problem details (`application/problem+json`) with a stable,
 * machine-readable `code`. Clients branch on `code` (and, for refusals, on `reason`), never on `detail`, which is
 * prose for humans and logs.
 *
 * Every problem is a plain, structured-cloneable object: it crosses the Durable Object RPC boundary unchanged and is
 * serialised once, by the HTTP layer.
 */

/** Stable problem codes, each documented in apps/relayer/README.md ("Problem codes"). */
export type ProblemCode =
  | "invalid-json"
  | "invalid-request"
  | "unsupported-media-type"
  | "payload-too-large"
  | "origin-not-allowed"
  | "not-found"
  | "method-not-allowed"
  | "unknown-chain"
  | "chain-not-ready"
  | "onboarding-unavailable"
  | "rejected"
  | "already-settled"
  | "already-cancelled"
  | "invoice-closed"
  | "refused"
  | "rate-limited"
  | "simulation-failed"
  | "gas-above-ceiling"
  | "budget-exhausted"
  | "fees-too-high"
  | "relayer-unavailable"
  | "faucet-unavailable"
  | "upstream-error"
  | "internal";

/** Extension members a problem may carry. All values are JSON-safe. */
export interface ProblemExtensions {
  /** The SDK rule or error code that failed (`WrongAmount`, `E_SIGNATURE_INVALID`, `RelayValidityTooShort`, ...). */
  readonly rule?: string;
  /** For `refused`: the admission refusal (`in-flight-key`, `banned-payer`, ...), from `RelayAdmissionLedger`. */
  readonly reason?: string;
  /** Seconds after which a retry can succeed; also sent as the `Retry-After` header. */
  readonly retryAfter?: number;
  /** A decoded revert (simulation): contract or token error name, its source and the i18n key clients display. */
  readonly error?: { readonly name: string; readonly source: string; readonly i18nKey: string };
  /** For `invalid-request`: the first offending fields, as JSON paths. */
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
  /** What the client should do next: `self-submit` the same authorisation, `retry` later, or `none`. */
  readonly fallback?: "self-submit" | "retry" | "none";
  /** For `already-settled`: the transaction that settled it, when the relayer knows it. */
  readonly txHash?: string;
}

export interface Problem extends ProblemExtensions {
  readonly code: ProblemCode;
  readonly status: number;
  readonly title: string;
  readonly detail: string;
}

/** Title and HTTP status of each code. */
export const PROBLEMS: Readonly<Record<ProblemCode, { readonly status: number; readonly title: string }>> = Object.freeze({
  "invalid-json": { status: 400, title: "The request body is not valid JSON" },
  "invalid-request": { status: 400, title: "The request does not match the schema" },
  "unsupported-media-type": { status: 415, title: "The request body must be application/json" },
  "payload-too-large": { status: 413, title: "The request body is too large" },
  "origin-not-allowed": { status: 403, title: "This origin may not call the relayer" },
  "not-found": { status: 404, title: "No such endpoint" },
  "method-not-allowed": { status: 405, title: "Method not allowed" },
  "unknown-chain": { status: 404, title: "The relayer does not serve this chain" },
  "chain-not-ready": { status: 503, title: "PayLink is not deployed on this chain yet" },
  "onboarding-unavailable": { status: 404, title: "Onboarding is not offered on this chain" },
  rejected: { status: 422, title: "The request fails the relay checks" },
  "already-settled": { status: 409, title: "This authorisation has already been used" },
  "already-cancelled": { status: 409, title: "This invoice is already cancelled" },
  "invoice-closed": { status: 409, title: "This invoice no longer accepts payments" },
  refused: { status: 429, title: "The relayer will not relay this request now" },
  "rate-limited": { status: 429, title: "Too many requests" },
  "simulation-failed": { status: 422, title: "The transaction would revert" },
  "gas-above-ceiling": { status: 422, title: "The gas estimate is above the registry ceiling" },
  "budget-exhausted": { status: 503, title: "The relayer's daily gas budget is spent" },
  "fees-too-high": { status: 503, title: "Network fees are above the relayer's cap" },
  "relayer-unavailable": { status: 503, title: "The relayer is unavailable" },
  "faucet-unavailable": { status: 503, title: "The faucet cannot pay out now" },
  "upstream-error": { status: 502, title: "The chain's RPC endpoints failed" },
  internal: { status: 500, title: "Internal error" },
});

/** Builds a problem with its code's status and title. */
export function problem(code: ProblemCode, detail: string, extensions: ProblemExtensions = {}): Problem {
  const { status, title } = PROBLEMS[code];
  return { code, status, title, detail, ...extensions };
}

/** The value of a `Retry-After` header for a refusal ending at `until` (unix seconds), at least 1 s. */
export function secondsUntil(until: bigint, nowSeconds: bigint): number {
  const delta = until - nowSeconds;
  return delta <= 0n ? 1 : delta > 86_400n * 7n ? 86_400 * 7 : Number(delta);
}

/** The documentation URI of a problem code (RFC 9457 `type`). */
export function problemType(code: ProblemCode): string {
  return `https://github.com/nambininasafidison/paylink/blob/main/apps/relayer/README.md#problem-${code}`;
}
