// SPDX-License-Identifier: MIT
/**
 * How a workstream plugs its route handlers into the app without editing it: each area module exports a
 * `RouteHandlers` map keyed by the contract's route ids (`API_ROUTES` in @paylink/api-contract). The app (src/core/app.ts)
 * registers every route of the table; a route whose id has no handler answers 501 `not-implemented`.
 *
 * Before a handler runs, the app has already: assigned a request id, applied CORS for the allowed origins, refused
 * bodies over the route's limit or of the wrong media type, and, for `session` routes, checked the bearer token
 * (401 `unauthorized` otherwise) and set `payee`. Handlers validate their own body with their own zod schema
 * (`parseBody` in src/core/http.ts) and answer JSON or throw a `ProblemError`.
 *
 * Owner: foundation.
 */
import type { Address, ApiRouteId } from "@paylink/api-contract";
import type { Context } from "hono";
import type { ApiServices } from "../core/services.ts";

/** Hono's environment for the API: per-request variables only (bindings are resolved into `ApiServices`). */
export interface ApiEnv {
  Variables: { requestId: string };
}

export interface HandlerArgs {
  readonly c: Context<ApiEnv>;
  readonly services: ApiServices;
  /** The session's payee on `session` routes; `null` on `public`, `signature` and `paypal` routes. */
  readonly payee: Address | null;
  /** Milliseconds since the epoch, from the runtime's clock. */
  readonly now: number;
}

export type RouteHandler = (args: HandlerArgs) => Promise<Response>;

export type RouteHandlers = Partial<Readonly<Record<ApiRouteId, RouteHandler>>>;

/** Largest accepted request body per route (bytes); 8 KiB unless listed. The webhook's cap is §7.5's 64 KB. */
export const BODY_LIMITS: Partial<Readonly<Record<ApiRouteId, number>>> = {
  "paypal.webhook": 64 * 1024,
  "ai.draft": 16 * 1024,
  check: 16 * 1024,
};
export const DEFAULT_BODY_LIMIT = 8 * 1024;
