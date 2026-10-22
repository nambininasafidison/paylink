// SPDX-License-Identifier: MIT
/**
 * The scaffold end to end (foundation): the route table of the contract is served, `GET /v1/health` answers, every other
 * route answers 501 `not-implemented` until its workstream implements it, and the cross-cutting rules hold for all of
 * them: problems, request ids, security headers, CORS for the allowed origins only, sessions on `session` routes, body
 * helpers, logs without secrets, and the Node entry over real HTTP.
 */
import { readFileSync } from "node:fs";
import { API_CONTRACT_VERSION, API_ROUTES } from "@paylink/api-contract";
import type { ApiProblem, HealthResponse } from "@paylink/api-contract";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { createApp, HANDLER_MAPS, matchesPath } from "../src/core/app.ts";
import { DEFAULT_CONFIG, PAGES_ORIGINS, PAYPAL_SANDBOX_BASE } from "../src/core/config.ts";
import { parseBody, readJson } from "../src/core/http.ts";
import { createLogger } from "../src/core/log.ts";
import { ProblemError } from "../src/core/problem.ts";
import { API_VERSION } from "../src/core/version.ts";
import { secretsFromEnv, startNodeApi } from "../src/node/server.ts";
import { T0, TEST_ORIGIN, testApp, testRuntime, testServices } from "./helpers.ts";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const KEY = `0x${"ab".repeat(32)}`;
const concrete = (path: string): string => path.replace(":key", KEY).replace(":id", "p1");

describe("route table", () => {
  it("registers each contract route with at most one handler, and no handler for an unknown route", () => {
    const ids = new Set<string>(API_ROUTES.map((r) => r.id));
    const seen = new Set<string>();
    for (const map of HANDLER_MAPS) {
      for (const id of Object.keys(map)) {
        expect(ids.has(id), id).toBe(true);
        expect(seen.has(id), `${id} has two handlers`).toBe(false);
        seen.add(id);
      }
    }
  });

  it("answers 501 not-implemented, as a problem, on every route without a handler", async () => {
    const app = testApp();
    const implemented = new Set(HANDLER_MAPS.flatMap((map) => Object.keys(map)));
    for (const route of API_ROUTES.filter((r) => !implemented.has(r.id))) {
      const response = await app.request(concrete(route.path), { method: route.method, ...(route.method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      expect(response.status, route.id).toBe(501);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      const body = (await response.json()) as ApiProblem;
      expect(body).toMatchObject({ code: "not-implemented", status: 501, detail: `${route.method} ${route.path} is not implemented yet` });
      expect(body.requestId).toMatch(/^[0-9a-f]{24}$/u);
      expect(response.headers.get("x-request-id")).toBe(body.requestId);
    }
  });

  it("answers 404 for an unknown path and 405 for a known path with another method", async () => {
    const app = testApp();
    expect(((await (await app.request("/v1/nope")).json()) as ApiProblem).code).toBe("not-found");
    const wrong = await app.request("/v1/health", { method: "POST" });
    expect(wrong.status).toBe(405);
    expect(((await wrong.json()) as ApiProblem).code).toBe("method-not-allowed");
    expect(matchesPath("/v1/twin/:key", `/v1/twin/${KEY}`)).toBe(true);
    expect(matchesPath("/v1/twin/:key", "/v1/twin/")).toBe(false);
  });
});

describe("GET /v1/health", () => {
  it("answers the public document: version, contract, sandbox, the five rows", async () => {
    const response = await testApp().request("/v1/health");
    expect(response.status).toBe(200);
    const doc = (await response.json()) as HealthResponse;
    expect(doc).toMatchObject({ service: "paylink-api", version: PACKAGE.version, contract: API_CONTRACT_VERSION, paypalEnvironment: "sandbox", time: new Date(T0).toISOString() });
    expect(API_VERSION).toBe(PACKAGE.version);
    expect(doc.rows.map((r) => r.id)).toEqual(["paypal", "webhook", "assistant", "chain", "store"]);
    // The chain has no PayLinkV2 deployment yet (decision D-CHAIN), so the document is degraded; the in-memory stores
    // answer, so the store row is readable.
    expect(doc.status).toBe("degraded");
    expect(doc.rows.find((r) => r.id === "chain")).toMatchObject({ state: "degraded", code: "not-deployed", values: { chainId: 11155111 } });
    expect(doc.rows.find((r) => r.id === "store")).toMatchObject({ state: "ok", code: "readable" });
  });

  it("reports missing PayPal credentials and webhook id without revealing anything", async () => {
    const services = testServices({ runtime: testRuntime({ offline: false }) });
    const doc = (await (await testApp(services).request("/v1/health")).json()) as HealthResponse;
    expect(doc.rows.find((r) => r.id === "paypal")).toMatchObject({ state: "not-configured", code: "credentials-missing" });
    expect(doc.rows.find((r) => r.id === "webhook")).toMatchObject({ state: "not-configured", code: "webhook-id-missing" });
    expect(doc.rows.find((r) => r.id === "assistant")).toMatchObject({ state: "not-configured", code: "disabled" });
    const configured = testServices({ runtime: testRuntime({ offline: false, secrets: { paypalClientId: "client-id-123456", paypalClientSecret: "a-secret-value-0123456789" } }) });
    const text = await (await testApp(configured).request("/v1/health")).text();
    expect(text).not.toContain("a-secret-value-0123456789");
    expect(text).not.toContain("client-id-123456");
  });
});

describe("headers and CORS", () => {
  it("sets the security headers on every answer", async () => {
    const response = await testApp().request("/v1/health");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  });

  it("allows the configured origins only", async () => {
    const app = testApp();
    const preflight = await app.request("/v1/twin", { method: "OPTIONS", headers: { origin: TEST_ORIGIN } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(TEST_ORIGIN);
    expect(preflight.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
    const refused = await app.request("/v1/twin", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(refused.status).toBe(403);
    const health = await app.request("/v1/health", { headers: { origin: TEST_ORIGIN } });
    expect(health.headers.get("access-control-allow-origin")).toBe(TEST_ORIGIN);
    const other = await app.request("/v1/health", { headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("deploys for the PayPal edition's Pages origins and PayPal's sandbox only (D-HOST)", () => {
    expect(DEFAULT_CONFIG.allowedOrigins).toEqual(["https://paypal.paylink-mg.pages.dev", "https://paylink-mg.pages.dev"]);
    expect(PAGES_ORIGINS).toBe(DEFAULT_CONFIG.allowedOrigins);
    expect(DEFAULT_CONFIG.paypal).toEqual({ mode: "sandbox", baseUrl: PAYPAL_SANDBOX_BASE, payerHost: null });
    expect(PAYPAL_SANDBOX_BASE).toBe("https://api-m.sandbox.paypal.com");
    expect(DEFAULT_CONFIG.chainId).toBe(11155111);
    expect(DEFAULT_CONFIG.ai).toMatchObject({ mode: "workers-ai", model: "@cf/google/gemma-4-26b-a4b-it", fallbackModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", dailyNeuronBudget: 10_000 });
  });
});

describe("sessions on session routes", () => {
  const echo = { "desk.get": ({ c, payee }: { c: { json: (v: unknown) => Response }; payee: unknown }) => Promise.resolve(c.json({ payee })) };

  it("answer 401 before the handler runs without a valid token", async () => {
    const app = createApp(testServices(), [echo]);
    const missing = await app.request("/v1/desk");
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as ApiProblem).detail).toBe("send Authorization: Bearer <session token>");
    const bad = await app.request("/v1/desk", { headers: { authorization: "Bearer not-a-session" } });
    expect(bad.status).toBe(401);
    const garbled = await app.request("/v1/desk", { headers: { authorization: "Basic abc" } });
    expect(garbled.status).toBe(401);
  });

  it("pass the session's payee to the handler", async () => {
    const services = testServices();
    const payee: `0x${string}` = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const accepting = { ...services, sessions: { ...services.sessions, check: (token: string | null) => Promise.resolve(token === "good" ? { ok: true as const, payee, expiresAt: T0 + 1 } : { ok: false as const, reason: "bad-mac" as const }) } };
    const app = createApp(accepting, [echo]);
    const ok = await app.request("/v1/desk", { headers: { authorization: "Bearer good" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ payee });
  });

  it("refuse a body over the route's limit before the handler runs", async () => {
    const draft = { "ai.draft": () => Promise.reject(new Error("must not run")) };
    const app = createApp(testServices(), [draft]);
    const response = await app.request("/v1/ai/draft", { method: "POST", headers: { "content-type": "application/json", "content-length": String(16 * 1024 + 1) }, body: "{}" });
    expect(response.status).toBe(413);
  });

  it("turn an unexpected error into 500 internal, logged by class name only", async () => {
    const lines: string[] = [];
    const services = testServices({ runtime: testRuntime({ lines }) });
    const app = createApp(services, [{ "rails.get": () => Promise.reject(new TypeError("secret detail")) }]);
    const response = await app.request(`/v1/rails/${KEY}`);
    expect(response.status).toBe(500);
    expect(((await response.json()) as ApiProblem).code).toBe("internal");
    expect(lines.join("\n")).toContain('"errorName":"TypeError"');
    expect(lines.join("\n")).not.toContain("secret detail");
  });
});

describe("body helpers", () => {
  const probe = (limit: number) => {
    const app = new Hono();
    app.post("/", async (c) => {
      try {
        return c.json({ value: await readJson(c, limit) });
      } catch (error) {
        if (error instanceof ProblemError) {
          return c.json(error.problem, error.problem.status as 400);
        }
        throw error;
      }
    });
    return app;
  };

  it("reads JSON within the limit and refuses the rest with problems", async () => {
    const ok = await probe(64).request("/", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: '{"a":1}' });
    expect(await ok.json()).toEqual({ value: { a: 1 } });
    const big = await probe(4).request("/", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(((await big.json()) as ApiProblem).code).toBe("payload-too-large");
    const text = await probe(64).request("/", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(((await text.json()) as ApiProblem).code).toBe("unsupported-media-type");
    const bad = await probe(64).request("/", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(((await bad.json()) as ApiProblem).code).toBe("invalid-json");
  });

  it("reports schema failures as invalid-request with JSON paths", () => {
    const schema = z.strictObject({ text: z.string().max(3), locale: z.enum(["en", "fr", "mg"]) });
    expect(parseBody(schema, { text: "abc", locale: "fr" })).toEqual({ text: "abc", locale: "fr" });
    try {
      parseBody(schema, { text: "abcd", locale: "de" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      const issues = (error as ProblemError).problem.issues?.map((i) => i.path);
      expect(issues).toEqual(["$.text", "$.locale"]);
    }
  });
});

describe("logs", () => {
  it("drop secret-bearing fields and scrub known secret values", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), secrets: ["sk-0123456789abcdef", undefined], now: () => T0 });
    logger.log("info", "test", { token: "t", authorization: "Bearer x", body: "{}", text: "hello", kept: "ok", detail: "leak sk-0123456789abcdef here" });
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({ ts: new Date(T0).toISOString(), level: "info", event: "test", kept: "ok", detail: "leak [redacted] here" });
    logger.child({ requestId: "r" }).log("debug", "hidden");
    expect(lines).toHaveLength(1);
  });

  it("reads secrets from the environment by their documented names only", () => {
    expect(secretsFromEnv({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "", SESSION_HMAC_KEY: "k", OTHER: "x" })).toEqual({ paypalClientId: "id", sessionHmacKey: "k" });
  });
});

describe("Node entry", () => {
  it("serves the same app over HTTP", async () => {
    const api = await startNodeApi({ allowedOrigins: [TEST_ORIGIN], offline: true, log: () => undefined });
    try {
      const response = await fetch(`${api.url}/v1/health`, { headers: { origin: TEST_ORIGIN } });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(TEST_ORIGIN);
      expect(((await response.json()) as HealthResponse).service).toBe("paylink-api");
      expect(api.services.runtime.config.paypal.mode).toBe("fake");
      expect(api.services.runtime.config.ai.mode).toBe("replay");
    } finally {
      await api.close();
    }
  });
});
