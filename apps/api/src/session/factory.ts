// SPDX-License-Identifier: MIT
/**
 * Builds the session service (EIP-712 `PayLinkSession` verification, HMAC tokens under `SESSION_HMAC_KEY`).
 *
 * Owner: reconciler workstream. Scaffold: opening a session answers 501; no token is ever valid, so every session route
 * answers 401 once its handler exists and before sessions do.
 */
import { pendingMethod } from "../core/not-implemented.ts";
import type { FactoryDeps } from "../core/runtime.ts";
import type { SessionCheck, Sessions } from "./types.ts";

export function createSessions(deps: FactoryDeps): Sessions {
  const configured = deps.runtime.secrets.sessionHmacKey !== undefined;
  return {
    open: pendingMethod("sessions"),
    check: (token) => Promise.resolve<SessionCheck>({ ok: false, reason: token === null ? "missing" : configured ? "bad-mac" : "malformed" }),
  };
}
