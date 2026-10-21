// SPDX-License-Identifier: MIT
/**
 * POST /v1/twin, GET /v1/twin/:key and the public GET /v1/rails/:key (docs/paypal/SPEC.md §7.2, §12.2).
 *
 * Routes: twin.create, twin.get, rails.get. Owner: PayPal spine workstream. Scaffold: no handler yet, so the app answers 501 `not-implemented`.
 */
import type { RouteHandlers } from "./types.ts";

export const twinHandlers: RouteHandlers = {};
