// SPDX-License-Identifier: MIT
/**
 * POST /v1/check: the deterministic "Was I really paid?" verdict from P5 and the chain (§9.2, AI-6).
 *
 * Routes: check. Owner: reconciler workstream. Scaffold: no handler yet, so the app answers 501 `not-implemented`.
 */
import type { RouteHandlers } from "./types.ts";

export const checkHandlers: RouteHandlers = {};
