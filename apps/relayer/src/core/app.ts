// SPDX-License-Identifier: MIT
/**
 * The relayer's HTTP surface (Hono): the same app serves the Cloudflare Worker and the Node adapter.
 *
 * | Endpoint                          | Behaviour                                                                |
 * |-----------------------------------|--------------------------------------------------------------------------|
 * | `POST /v1/{chainId}/pay`          | `payWithAuthorization` only (body: invoice spec §11 `RelayPayRequest`)    |
 * | `POST /v1/{chainId}/cancel`       | `cancelBySig` only (body: `CancelAuthorization`)                          |
 * | `POST /v1/{chainId}/onboard`      | the registry faucet's `requestFunds(address)`, Monad testnet only         |
 * | `GET /v1/health`                  | per-chain state, relayer address and balance, budget (public data only)   |
 *
 * Here: CORS (`origins.ts`), body size and media type, JSON, the zod schemas, the path's chain against the relay
 * registry, the requester identity (`requesterFromIp`), response headers and RFC 9457 problems. Everything that
 * needs the chain happens behind `SenderGateway`, in the chain's ChainSender.
 */
import type { Registry } from "@paylink/chains";
import { isPayLinkError, requesterFromIp } from "@paylink/sdk";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ChainStatus, EngineResult, RelayInput } from "./engine.ts";
import type { Logger } from "./log.ts";
import { errorMessage, silentLogger } from "./log.ts";
import type { OriginPolicy } from "./origins.ts";
import type { Problem } from "./problem.ts";
import { problem, problemType } from "./problem.ts";
import type { Operation } from "./schemas.ts";
import { describeIssues, isOperation, OPERATIONS } from "./schemas.ts";

/** Where requests for a chain go: the chain's Durable Object (Worker) or its in-process engine (Node). */
export interface SenderGateway {
  relay(chainId: number, operation: Operation, input: RelayInput): Promise<EngineResult>;
  status(chainId: number): Promise<ChainStatus>;
}

/** The Hono environment of the app: the host's bindings and a request id per request. */
export interface AppEnv<Bindings extends object> {
  Bindings: Bindings;
  Variables: { requestId: string };
}

export interface AppOptions<Bindings extends object> {
  /** The chains the relayer serves (`relayRegistry`). */
  readonly registry: Registry;
  readonly origins: OriginPolicy;
  readonly gateway: (env: Bindings) => SenderGateway;
  /** The client's IP as the platform reports it (Cloudflare: `CF-Connecting-IP`; Node: the socket). */
  readonly clientIp: (c: Context<AppEnv<Bindings>>) => string | undefined;
  readonly logger?: Logger;
  readonly version: string;
  /** Milliseconds since the epoch (tests). */
  readonly clock?: () => number;
}

/** Largest accepted request body. A pay request with a 512-byte ERC-1271 signature is under 3 KiB. */
export const MAX_BODY_BYTES = 8 * 1024;
/** How long a health document is reused (per isolate), and how long one chain may take to answer it. */
const HEALTH_CACHE_MS = 5_000;
const HEALTH_TIMEOUT_MS = 4_000;
const CHAIN_ID_SEGMENT = /^[1-9][0-9]{0,15}$/u;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "Retry-After, X-Request-Id",
  "Access-Control-Max-Age": "600",
};

export interface HealthDocument {
  readonly status: "ok" | "degraded" | "down";
  readonly service: "paylink-relayer";
  readonly version: string;
  readonly time: string;
  readonly origins: string;
  readonly chains: readonly (ChainStatus | { readonly chainId: number; readonly name: string; readonly label: string; readonly state: "unreachable" })[];
}

function problemBody(failure: Problem, requestId: string): Record<string, unknown> {
  const { code, status, title, detail, ...extensions } = failure;
  return { type: problemType(code), title, status, detail, instance: `urn:uuid:${requestId}`, code, ...extensions };
}

async function readBody(request: Request): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: Problem }> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/iu.test(type)) {
    return { ok: false, problem: problem("unsupported-media-type", "send the body as application/json") };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, problem: problem("payload-too-large", `bodies are limited to ${String(MAX_BODY_BYTES)} bytes`) };
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, problem: problem("payload-too-large", `bodies are limited to ${String(MAX_BODY_BYTES)} bytes`) };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    return { ok: false, problem: problem("invalid-json", "the body is not UTF-8") };
  }
}

export function createApp<Bindings extends object>(options: AppOptions<Bindings>): Hono<AppEnv<Bindings>> {
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? Date.now;
  const app = new Hono<AppEnv<Bindings>>();
  let health: { readonly at: number; readonly document: HealthDocument; readonly httpStatus: 200 | 503 } | null = null;

  const respond = (status: number, body: unknown, contentType = "application/json"): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": `${contentType}; charset=utf-8` } });
  const fail = (c: { get(key: "requestId"): string }, failure: Problem, extraHeaders: Record<string, string> = {}): Response => {
    const response = respond(failure.status, problemBody(failure, c.get("requestId")), "application/problem+json");
    if (failure.retryAfter !== undefined) {
      response.headers.set("Retry-After", String(failure.retryAfter));
    }
    for (const [name, value] of Object.entries(extraHeaders)) {
      response.headers.set(name, value);
    }
    return response;
  };

  // Request id, security headers, CORS and the access log.
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    const started = clock();
    const origin = c.req.header("origin");
    const allowed = origin === undefined || options.origins.allows(origin);
    if (allowed) {
      if (c.req.method === "OPTIONS") {
        c.res = new Response(null, { status: 204 });
      } else {
        await next();
      }
    } else {
      c.res = fail(c, problem("origin-not-allowed", "this origin may not call the PayLink relayer"));
    }
    // Every response here is built by this app, so its headers are mutable.
    const headers = c.res.headers;
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(name, value);
    }
    headers.set("X-Request-Id", requestId);
    headers.set("Vary", "Origin");
    if (origin !== undefined && allowed) {
      headers.set("Access-Control-Allow-Origin", origin);
      for (const [name, value] of Object.entries(CORS_HEADERS)) {
        headers.set(name, value);
      }
    }
    logger.log("info", "http", { requestId, method: c.req.method, path: new URL(c.req.url).pathname, status: c.res.status, ms: clock() - started, cors: origin === undefined ? "none" : allowed ? "allowed" : "refused" });
  });

  app.get("/v1/health", async (c) => {
    const now = clock();
    if (health === null || now - health.at >= HEALTH_CACHE_MS) {
      const gateway = options.gateway(c.env);
      const chains = await Promise.all(
        options.registry.chains.map(async (chain) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              gateway.status(chain.chainId),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  reject(new Error("timeout"));
                }, HEALTH_TIMEOUT_MS);
              }),
            ]);
          } catch (error) {
            logger.log("warn", "health.chain-error", { chainId: chain.chainId, error: errorMessage(error) });
            return { chainId: chain.chainId, name: chain.name, label: chain.label, state: "unreachable" as const };
          } finally {
            if (timer !== undefined) {
              clearTimeout(timer);
            }
          }
        }),
      );
      const ready = chains.filter((chain) => chain.state === "ready").length;
      const status: HealthDocument["status"] = ready === chains.length && chains.length > 0 ? "ok" : chains.some((chain) => chain.state === "ready" || chain.state === "awaiting-deployment") ? "degraded" : "down";
      health = { at: now, httpStatus: status === "down" ? 503 : 200, document: { status, service: "paylink-relayer", version: options.version, time: new Date(now).toISOString(), origins: options.origins.description, chains } };
    }
    return respond(health.httpStatus, health.document);
  });

  app.post("/v1/:chainId/:operation", async (c) => {
    const { chainId: chainSegment, operation } = c.req.param();
    if (!isOperation(operation)) {
      return fail(c, problem("not-found", `no operation ${JSON.stringify(operation.slice(0, 32))}`));
    }
    const chain = CHAIN_ID_SEGMENT.test(chainSegment) ? options.registry.get(Number(chainSegment)) : undefined;
    if (chain === undefined) {
      return fail(c, problem("unknown-chain", `the relayer serves chains ${options.registry.chains.map((known) => String(known.chainId)).join(", ")}`, { fallback: "none" }));
    }
    const raw = await readBody(c.req.raw);
    if (!raw.ok) {
      return fail(c, raw.problem);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.text);
    } catch {
      return fail(c, problem("invalid-json", "the body is not valid JSON"));
    }
    const parsed = OPERATIONS[operation].safeParse(json);
    if (!parsed.success) {
      return fail(c, problem("invalid-request", "the body does not match the schema (docs/spec/paylink-invoice-v2.schema.json)", { issues: describeIssues(parsed.error) }));
    }
    if (parsed.data.chainId !== chain.chainId) {
      return fail(c, problem("invalid-request", `the body is for chain ${String(parsed.data.chainId)}, the path for chain ${String(chain.chainId)}`, { rule: "ChainMismatch" }));
    }
    const ip = options.clientIp(c);
    let requester: string;
    try {
      requester = requesterFromIp(ip ?? "");
    } catch (error) {
      if (!isPayLinkError(error)) {
        throw error;
      }
      return fail(c, problem("invalid-request", "the client address is unknown", { rule: "RequesterAddress" }));
    }
    const result = await options.gateway(c.env).relay(chain.chainId, operation, { body: parsed.data, requester, requestId: c.get("requestId") });
    return result.ok ? respond(result.httpStatus, result.body) : fail(c, result.problem);
  });

  app.all("/v1/:chainId/:operation", (c) => fail(c, problem("method-not-allowed", "use POST"), { Allow: "POST, OPTIONS" }));
  app.all("/v1/health", (c) => fail(c, problem("method-not-allowed", "use GET"), { Allow: "GET, OPTIONS" }));
  app.notFound((c) => fail(c, problem("not-found", "see https://github.com/nambininasafidison/paylink/blob/main/apps/relayer/README.md")));
  app.onError((error, c) => {
    logger.log("error", "http.error", { requestId: c.get("requestId"), error: errorMessage(error) });
    return fail(c, problem("internal", "unexpected error", { fallback: "self-submit" }));
  });
  return app;
}
