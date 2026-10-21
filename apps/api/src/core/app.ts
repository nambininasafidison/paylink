// SPDX-License-Identifier: MIT
/**
 * The API's HTTP surface (Hono): one app for the Cloudflare Worker and the Node entry. It registers every route of the
 * contract's table (`API_ROUTES`, docs/paypal/SPEC.md §13) and dispatches each to its workstream's handler, or answers
 * 501 `not-implemented` while there is none. Around every handler: a request id, security headers, CORS for the
 * configured origins only, body limits per route, the session check on `session` routes, and RFC 9457 problems for
 * every error (an unexpected error is logged as its class name only and answers 500 `internal`).
 *
 * Owner: foundation. Workstreams add handlers in src/routes/<area>.ts, never here.
 */
import { API_ROUTES, REQUEST_ID_HEADER } from "@paylink/api-contract";
import type { ApiProblem } from "@paylink/api-contract";
import { Hono } from "hono";
import type { Context, Input } from "hono";
import { routePath } from "hono/route";
import { aiHandlers } from "../routes/ai.ts";
import { checkHandlers } from "../routes/check.ts";
import { deskHandlers } from "../routes/desk.ts";
import { healthHandlers } from "../routes/health.ts";
import { sessionHandlers } from "../routes/session.ts";
import { twinHandlers } from "../routes/twin.ts";
import type { ApiEnv, RouteHandler, RouteHandlers } from "../routes/types.ts";
import { BODY_LIMITS, DEFAULT_BODY_LIMIT } from "../routes/types.ts";
import { webhookHandlers } from "../routes/webhook.ts";
import { errorFields } from "./log.ts";
import { problem, ProblemError } from "./problem.ts";
import type { ApiServices } from "./services.ts";

/** Every workstream's handlers. A route id appears in at most one map (test/smoke.test.ts). */
export const HANDLER_MAPS: readonly RouteHandlers[] = [sessionHandlers, aiHandlers, twinHandlers, webhookHandlers, deskHandlers, checkHandlers, healthHandlers];

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Expose-Headers": `Retry-After, ${REQUEST_ID_HEADER}`,
  "Access-Control-Max-Age": "600",
};

function respondProblem<P extends string, I extends Input>(c: Context<ApiEnv, P, I>, body: ApiProblem): Response {
  const withId: ApiProblem = { ...body, requestId: c.get("requestId") };
  if (body.retryAfter !== undefined) {
    c.header("Retry-After", String(body.retryAfter));
  }
  return c.body(JSON.stringify(withId), body.status as 400, { "Content-Type": "application/problem+json" });
}

function requestId(services: ApiServices): string {
  return [...services.runtime.random(12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(c: Context<ApiEnv>): string | null {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{1,2048})$/u.exec(header);
  return match?.[1] ?? null;
}

/** The app over `services`. `maps` replaces the workstreams' handlers (tests of the cross-cutting rules only). */
export function createApp(services: ApiServices, maps: readonly RouteHandlers[] = HANDLER_MAPS): Hono<ApiEnv> {
  const { config, logger, clock } = services.runtime;
  const allowed = new Set(config.allowedOrigins);
  const app = new Hono<ApiEnv>();

  app.use("*", async (c, next) => {
    c.set("requestId", requestId(services));
    const origin = c.req.header("origin");
    const corsOk = origin !== undefined && allowed.has(origin);
    if (c.req.method === "OPTIONS") {
      if (!corsOk) {
        return respondProblem(c, problem("origin-not-allowed", "this origin may not call the API"));
      }
      return c.body(null, 204, { ...CORS_HEADERS, "Access-Control-Allow-Origin": origin, Vary: "Origin" });
    }
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) {
        c.res.headers.set(name, value);
      }
    }
    c.res.headers.set(REQUEST_ID_HEADER, c.get("requestId"));
    if (corsOk) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.set("Access-Control-Expose-Headers", CORS_HEADERS["Access-Control-Expose-Headers"] ?? "");
      c.res.headers.append("Vary", "Origin");
    }
    return undefined;
  });

  const handlers = new Map<string, RouteHandler>();
  for (const map of maps) {
    for (const [id, handler] of Object.entries(map)) {
      handlers.set(id, handler);
    }
  }

  for (const route of API_ROUTES) {
    app.on(route.method, route.path, async (c) => {
      const handler = handlers.get(route.id);
      if (handler === undefined) {
        throw new ProblemError("not-implemented", `${route.method} ${route.path} is not implemented yet`);
      }
      const limit = BODY_LIMITS[route.id] ?? DEFAULT_BODY_LIMIT;
      const declared = Number(c.req.header("content-length") ?? "0");
      if (route.method === "POST" && Number.isFinite(declared) && declared > limit) {
        throw new ProblemError("payload-too-large", `the body may not exceed ${String(limit)} bytes`);
      }
      const now = clock();
      let payee = null;
      if (route.auth === "session") {
        const session = await services.sessions.check(bearer(c), now);
        if (!session.ok) {
          throw new ProblemError("unauthorized", session.reason === "missing" ? "send Authorization: Bearer <session token>" : "the session token is not valid");
        }
        payee = session.payee;
      }
      return await handler({ c, services, payee, now });
    });
  }

  app.notFound((c) => {
    const known = API_ROUTES.some((route) => matchesPath(route.path, c.req.path));
    return respondProblem(c, known ? problem("method-not-allowed", `${c.req.method} is not allowed here`) : problem("not-found", "no such endpoint"));
  });

  app.onError((error, c) => {
    if (error instanceof ProblemError) {
      return respondProblem(c, error.problem);
    }
    logger.log("error", "request.failed", { requestId: c.get("requestId"), route: routePath(c), ...errorFields(error) });
    return respondProblem(c, problem("internal", "the request failed"));
  });

  return app;
}

/** Whether `path` matches a route template (`:name` segments match one non-empty segment). */
export function matchesPath(template: string, path: string): boolean {
  const a = template.split("/");
  const b = path.split("/");
  return a.length === b.length && a.every((segment, i) => (segment.startsWith(":") ? (b[i] ?? "") !== "" : segment === b[i]));
}
