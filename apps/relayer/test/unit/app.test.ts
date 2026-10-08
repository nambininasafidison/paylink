// SPDX-License-Identifier: MIT
/**
 * The HTTP layer alone (Hono `app.request()`, no chain): CORS, media type and size limits, JSON and schema errors,
 * routing, requester identities, problem documents and the health aggregate. The gateway is a fake that records
 * what reaches it, so these tests also prove what never does.
 */
import { createRegistry, defineLocalChain } from "@paylink/chains";
import { describe, expect, it } from "vitest";
import type { SenderGateway } from "../../src/core/app.ts";
import { createApp, MAX_BODY_BYTES } from "../../src/core/app.ts";
import type { ChainStatus, EngineResult, RelayInput } from "../../src/core/engine.ts";
import { createLogger } from "../../src/core/log.ts";
import { originPolicy, PRODUCTION_ORIGIN } from "../../src/core/origins.ts";
import { problem } from "../../src/core/problem.ts";
import type { Operation } from "../../src/core/schemas.ts";

const local = defineLocalChain({ chainId: 10143, rpcUrl: "http://127.0.0.1:8545", tokens: [], deployment: null });
const registry = createRegistry([local]);

const status = (state: ChainStatus["state"]): ChainStatus => ({
  chainId: 10143,
  name: local.name,
  label: local.label,
  state,
  relayer: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  balanceWei: "1",
  minBalanceWei: "0",
  deployment: null,
  operations: { pay: false, cancel: false, onboard: false },
  pending: 0,
  inFlight: 0,
  blockNumber: "1",
  relayMarginSeconds: 120,
  budget: { day: "2026-10-07", limitWei: "1", spentWei: "0", reservedWei: "0" },
});

function harness(options: { result?: EngineResult; status?: () => Promise<ChainStatus>; ip?: string | undefined } = {}) {
  const calls: { chainId: number; operation: Operation; input: RelayInput }[] = [];
  const lines: string[] = [];
  let statusCalls = 0;
  const gateway: SenderGateway = {
    relay: (chainId, operation, input) => {
      calls.push({ chainId, operation, input });
      return Promise.resolve(options.result ?? { ok: true, httpStatus: 202, body: { status: "submitted", kind: operation, chainId, txHash: `0x${"ab".repeat(32)}`, duplicate: false, subject: `0x${"cd".repeat(32)}` } });
    },
    status: async () => {
      statusCalls += 1;
      return await (options.status ?? (() => Promise.resolve(status("ready"))))();
    },
  };
  const app = createApp<Record<string, never>>({
    registry,
    origins: originPolicy(),
    gateway: () => gateway,
    clientIp: () => ("ip" in options ? options.ip : "203.0.113.7"),
    logger: createLogger({ sink: (line) => lines.push(line) }),
    version: "0.1.0",
  });
  return { app, calls, lines, statusCalls: () => statusCalls };
}

const onboard = { chainId: 10143, address: "0x000000000000000000000000000000000000dEaD" };
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("CORS", () => {
  it("answers a preflight from the app and its previews, with the exposed headers", async () => {
    const { app } = harness();
    for (const origin of [PRODUCTION_ORIGIN, "https://feat-relayer.paylink-mg.pages.dev", "https://3f2a9c1b.paylink-mg.pages.dev"]) {
      const response = await app.request("/v1/10143/pay", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
      expect(response.headers.get("access-control-expose-headers")).toBe("Retry-After, X-Request-Id");
      expect(response.headers.get("vary")).toBe("Origin");
    }
  });

  it.each(["https://evil.example", "https://paylink-mg.pages.dev.evil.example", "https://a.b.paylink-mg.pages.dev", "http://paylink-mg.pages.dev", "https://paylink.pages.dev", "https://-x.paylink-mg.pages.dev", "null"])(
    "refuses %s before anything else runs (403, no CORS grant)",
    async (origin) => {
      const { app, calls } = harness();
      const preflight = await app.request("/v1/10143/onboard", { method: "OPTIONS", headers: { origin } });
      expect(preflight.status).toBe(403);
      const response = await app.request("/v1/10143/onboard", json(onboard, { origin }));
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.json()).toMatchObject({ code: "origin-not-allowed" });
      expect(calls).toHaveLength(0);
    },
  );

  it("serves clients that send no Origin (scripts, servers): CORS is not access control", async () => {
    const { app, calls } = harness();
    expect((await app.request("/v1/10143/onboard", json(onboard))).status).toBe(202);
    expect(calls).toHaveLength(1);
  });

  it("allows exact extra origins for local e2e, and refuses wildcards or paths", () => {
    expect(originPolicy(["http://127.0.0.1:5173"]).allows("http://127.0.0.1:5173")).toBe(true);
    expect(originPolicy(["http://127.0.0.1:5173"]).allows("http://127.0.0.1:5174")).toBe(false);
    expect(() => originPolicy(["http://example.com"])).toThrow(/local http origins/u);
    expect(() => originPolicy(["https://example.com/path"])).toThrow(/bare/u);
    expect(() => originPolicy(["*"])).toThrow(/not an origin/u);
  });
});

describe("requests", () => {
  it("passes a schema-valid body to the chain's sender with the requester's /64 or IPv4 identity", async () => {
    const v6 = harness({ ip: "2001:db8:abcd:12:1:2:3:4" });
    await v6.app.request("/v1/10143/onboard", json(onboard));
    expect(v6.calls[0]).toMatchObject({ chainId: 10143, operation: "onboard", input: { requester: "ip6:2001:db8:abcd:12::/64", body: onboard } });
    const v4 = harness({ ip: "::ffff:198.51.100.9" });
    await v4.app.request("/v1/10143/onboard", json(onboard));
    expect(v4.calls[0]?.input.requester).toBe("ip4:198.51.100.9");
  });

  it("sets the security headers and a request id on every response", async () => {
    const { app } = harness();
    const response = await app.request("/v1/10143/onboard", json(onboard));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it.each([
    ["an unknown chain", "/v1/1/onboard", json({ ...onboard, chainId: 1 }), 404, "unknown-chain"],
    ["a non-canonical chain id", "/v1/010143/onboard", json(onboard), 404, "unknown-chain"],
    ["an unknown operation", "/v1/10143/transfer", json(onboard), 404, "not-found"],
    ["a GET on an operation", "/v1/10143/pay", { method: "GET" }, 405, "method-not-allowed"],
    ["a POST on health", "/v1/health", json({}), 405, "method-not-allowed"],
    ["text/plain", "/v1/10143/onboard", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }, 415, "unsupported-media-type"],
    ["no content type", "/v1/10143/onboard", { method: "POST", body: "{}" }, 415, "unsupported-media-type"],
    ["broken JSON", "/v1/10143/onboard", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }, 400, "invalid-json"],
    ["invalid UTF-8", "/v1/10143/onboard", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0x7b, 0xff, 0x7d]) }, 400, "invalid-json"],
    ["an oversized body", "/v1/10143/onboard", { method: "POST", headers: { "content-type": "application/json" }, body: `{"pad":"${"x".repeat(MAX_BODY_BYTES)}"}` }, 413, "payload-too-large"],
    ["a declared oversized body", "/v1/10143/onboard", { method: "POST", headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" }, 413, "payload-too-large"],
    ["an extra property", "/v1/10143/onboard", json({ ...onboard, amount: "1" }), 400, "invalid-request"],
    ["the zero address", "/v1/10143/onboard", json({ ...onboard, address: "0x0000000000000000000000000000000000000000" }), 400, "invalid-request"],
    ["a body for another chain", "/v1/10143/onboard", json({ ...onboard, chainId: 84532 }), 400, "invalid-request"],
    ["an unknown path", "/", { method: "GET" }, 404, "not-found"],
  ] as const)("refuses %s without reaching the sender", async (_name, path, init, httpStatus, code) => {
    const { app, calls } = harness();
    const response = await app.request(path, init);
    expect(response.status).toBe(httpStatus);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code, status: httpStatus, type: `https://github.com/nambininasafidison/paylink/blob/main/apps/relayer/README.md#problem-${code}` });
    expect(body["instance"]).toMatch(/^urn:uuid:/u);
    expect(calls).toHaveLength(0);
  });

  it("reports schema issues as JSON paths, at most eight", async () => {
    const { app } = harness();
    const response = await app.request("/v1/10143/pay", json({ chainId: 10143, invoice: { payee: "0x1" }, payeeSig: "0xZZ", authorization: { v: 29 }, a: 1, b: 2, c: 3, d: 4, e: 5 }));
    const body = (await response.json()) as { issues: { path: string; message: string }[] };
    expect(body.issues).toHaveLength(8);
    expect(body.issues.map((issue) => issue.path)).toContain("$.invoice.payee");
  });

  it("refuses a request whose client address is unknown", async () => {
    const { app, calls } = harness({ ip: undefined });
    const response = await app.request("/v1/10143/onboard", json(onboard));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ rule: "RequesterAddress" });
    expect(calls).toHaveLength(0);
  });

  it("renders a sender's problem with Retry-After", async () => {
    const { app } = harness({ result: { ok: false, problem: problem("refused", "banned", { reason: "banned-key", retryAfter: 3600, fallback: "self-submit" }) } });
    const response = await app.request("/v1/10143/onboard", json(onboard));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await response.json()).toMatchObject({ code: "refused", reason: "banned-key", retryAfter: 3600, fallback: "self-submit", title: "The relayer will not relay this request now" });
  });

  it("turns an exception into a 500 problem and logs it without the request", async () => {
    const lines: string[] = [];
    const app = createApp<Record<string, never>>({
      registry,
      origins: originPolicy(),
      gateway: () => ({ relay: () => Promise.reject(new Error("boom")), status: () => Promise.reject(new Error("boom")) }),
      clientIp: () => "203.0.113.7",
      logger: createLogger({ sink: (line) => lines.push(line) }),
      version: "0.1.0",
    });
    const response = await app.request("/v1/10143/onboard", json(onboard));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "internal", fallback: "self-submit" });
    expect(lines.some((line) => line.includes('"event":"http.error"') && line.includes("boom"))).toBe(true);
    expect(lines.join("\n")).not.toContain("dEaD");
  });
});

describe("GET /v1/health", () => {
  it("aggregates the chains and caches the document for a few seconds", async () => {
    const { app, statusCalls } = harness();
    const first = await app.request("/v1/health");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "ok", service: "paylink-relayer", version: "0.1.0", chains: [{ chainId: 10143, state: "ready" }] });
    await app.request("/v1/health");
    expect(statusCalls()).toBe(1);
  });

  it("is degraded while a chain awaits its deployment, down (503) when no chain can relay", async () => {
    expect(await (await harness({ status: () => Promise.resolve(status("awaiting-deployment")) }).app.request("/v1/health")).json()).toMatchObject({ status: "degraded" });
    const down = await harness({ status: () => Promise.resolve(status("unfunded")) }).app.request("/v1/health");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ status: "down" });
  });

  it("reports a chain that does not answer in time as unreachable", async () => {
    const { app } = harness({ status: () => Promise.reject(new Error("rpc down")) });
    const response = await app.request("/v1/health");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ chains: [{ chainId: 10143, state: "unreachable" }] });
  });
});
