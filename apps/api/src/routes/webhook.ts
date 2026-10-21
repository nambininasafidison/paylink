// SPDX-License-Identifier: MIT
/**
 * POST /v1/paypal/webhook: raw body (64 KB cap), P10 postback, event-id idempotency, then P5 and reconcile (§7.5).
 *
 * Routes: paypal.webhook. Owner: PayPal spine workstream. Scaffold: no handler yet, so the app answers 501 `not-implemented`.
 */
import type { RouteHandlers } from "./types.ts";

export const webhookHandlers: RouteHandlers = {};
