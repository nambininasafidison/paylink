// SPDX-License-Identifier: MIT
/**
 * POST /v1/ai/draft: A1, a client message to an invoice draft (§9.2), behind quotas and the daily ceiling.
 *
 * Routes: ai.draft. Owner: AI workstream. Scaffold: no handler yet, so the app answers 501 `not-implemented`.
 */
import type { RouteHandlers } from "./types.ts";

export const aiHandlers: RouteHandlers = {};
