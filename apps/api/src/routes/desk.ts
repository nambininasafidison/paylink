// SPDX-License-Identifier: MIT
/**
 * The desk: proposals, auto-records, alerts, and the executor's approval round trip (§10).
 *
 * Routes: desk.get, desk.sweep, desk.approve, desk.reject, desk.undo. Owner: reconciler workstream. Scaffold: no handler yet, so the app answers 501 `not-implemented`.
 */
import type { RouteHandlers } from "./types.ts";

export const deskHandlers: RouteHandlers = {};
