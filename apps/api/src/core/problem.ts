// SPDX-License-Identifier: MIT
/**
 * RFC 9457 problem responses with the contract's stable codes (`API_PROBLEMS` in @paylink/api-contract). Clients branch
 * on `code` and `rule`, never on `detail`.
 *
 * Owner: foundation.
 */
import { API_PROBLEMS } from "@paylink/api-contract";
import type { ApiProblem, ApiProblemCode } from "@paylink/api-contract";

/** Extensions a problem may carry (all JSON-safe). */
export type ProblemExtensions = Pick<ApiProblem, "rule" | "retryAfter" | "issues" | "requestId">;

export function problem(code: ApiProblemCode, detail: string, extensions: ProblemExtensions = {}): ApiProblem {
  const { status, title } = API_PROBLEMS[code];
  return { type: problemType(code), code, status, title, detail, ...extensions };
}

/** The documentation URI of a problem code (RFC 9457 `type`). */
export function problemType(code: ApiProblemCode): string {
  return `https://github.com/nambininasafidison/paylink/blob/paypal/apps/api/README.md#problem-${code}`;
}

/** A thrown problem: route handlers throw it, the app turns it into the response. */
export class ProblemError extends Error {
  readonly problem: ApiProblem;

  constructor(code: ApiProblemCode, detail: string, extensions: ProblemExtensions = {}) {
    super(detail);
    this.name = "ProblemError";
    this.problem = problem(code, detail, extensions);
  }
}
