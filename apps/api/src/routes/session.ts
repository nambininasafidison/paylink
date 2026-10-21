// SPDX-License-Identifier: MIT
/**
 * POST /v1/session: verify the signed PayLinkSession (src/session/), answer a token.
 *
 * Routes: session.create. Owner: reconciler workstream. Scaffold: no handler yet, so the app answers 501 `not-implemented`.
 */
import type { RouteHandlers } from "./types.ts";

export const sessionHandlers: RouteHandlers = {};
