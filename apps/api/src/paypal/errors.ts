// SPDX-License-Identifier: MIT
/**
 * How a failed PayPal call reaches the API's caller: as one of the contract's problems (`API_PROBLEMS`,
 * apps/api/README.md#problem-codes), never as PayPal's own words. The problem's `rule` carries PayPal's error `name` (or
 * the client's `E_PAYPAL_*` code), and `issue` PayPal's first `details[].issue` when there is one, so the web edition
 * and the desk can branch on stable codes.
 *
 * | PayPal call failed with | Problem | Why |
 * |---|---|---|
 * | no credentials (`E_PAYPAL_NOT_CONFIGURED`) | `paypal-unavailable` 503 | the operator has not set the sandbox app's secrets |
 * | the token endpoint (P1) refused, or 401/403 after a fresh token | `paypal-unavailable` 503 | credentials or app permissions: an operator problem, not the caller's |
 * | no answer, 429 or 5xx | `paypal-unavailable` 503, `retryAfter` | PayPal is down or throttling: try later |
 * | 404 `RESOURCE_NOT_FOUND` | `paypal-rejected` 502, rule `RESOURCE_NOT_FOUND` | the twin's invoice is gone on PayPal's side (S0) |
 * | other 4xx (`INVALID_REQUEST`, `UNPROCESSABLE_ENTITY`, ...) | `paypal-rejected` 502 | PayPal refused what PayLink sent |
 * | an answer PayLink cannot read | `paypal-rejected` 502, rule `E_PAYPAL_UNEXPECTED_RESPONSE` | PayPal changed or failed |
 * | an id PayLink refuses to send (`E_PAYPAL_INVALID_INPUT`) | `invalid-request` 400 | the caller sent it |
 *
 * Owner: PayPal spine workstream.
 */
import { ProblemError } from "../core/problem.ts";
import { isPayPalError } from "./client.ts";

/** Seconds to suggest before retrying when PayPal gave no `Retry-After`. */
const DEFAULT_RETRY_AFTER_S = 30;

/** The problem for a PayPal failure; anything that is not a `PayPalError` is rethrown untouched (a bug: 500). */
export function paypalProblem(error: unknown): ProblemError {
  if (!isPayPalError(error)) {
    throw error;
  }
  const rule = error.paypalName ?? `HTTP_${String(error.status)}`;
  if (rule === "E_PAYPAL_INVALID_INPUT") {
    return new ProblemError("invalid-request", "the PayPal identifier is not valid", { rule });
  }
  if (rule === "E_PAYPAL_NOT_CONFIGURED") {
    return new ProblemError("paypal-unavailable", "the PayPal sandbox credentials are not configured", { rule });
  }
  if (error.operation === "P1" || error.status === 401 || error.status === 403) {
    return new ProblemError("paypal-unavailable", "PayPal refused the API's credentials", { rule });
  }
  if (error.status === 0 || error.status === 429 || error.status >= 500) {
    const retryAfter = Math.max(1, Math.ceil((error.retryAfterMs ?? DEFAULT_RETRY_AFTER_S * 1000) / 1000));
    return new ProblemError("paypal-unavailable", "PayPal did not answer; try again later", { rule, retryAfter });
  }
  const issue = error.issue === null ? "" : ` (${error.issue})`;
  return new ProblemError("paypal-rejected", `PayPal refused the request${issue}`, { rule: error.issue === null ? rule : `${rule}:${error.issue}` });
}

/** Runs `work`, turning a PayPal failure into the matching problem. */
export async function withPayPalProblems<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw paypalProblem(error);
  }
}
