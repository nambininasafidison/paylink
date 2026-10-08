// SPDX-License-Identifier: MIT
/** `/config.json` is input: strictly validated, never a source of addresses, and replaced by defaults when wrong. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, endpointFor, loadConfig, parseConfig } from "../src/core/config.ts";
import { SCRIPT_URL } from "./helpers.ts";

const valid = {
  version: 1,
  banner: { level: "warning", text: { en: "Maintenance tonight.", fr: "Maintenance ce soir." } },
  relayer: { url: "https://paylink-relayer.example.workers.dev", chains: [10143] },
  indexer: null,
  rpc: { "10143": ["https://rpc.example.org"] },
};

describe("parseConfig", () => {
  it("accepts the shipped public/config.json: the production relayer for the relayed testnets, nothing else", () => {
    const shipped: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "../public/config.json"), "utf8"));
    expect(parseConfig(shipped)).toEqual({
      ok: true,
      config: { ...DEFAULT_CONFIG, relayer: { url: "https://paylink-relayer.raherizonambinina.workers.dev", chains: [10143, 84532, 421614] } },
    });
  });

  it("accepts a complete configuration", () => {
    const result = parseConfig(valid);
    expect(result.ok).toBe(true);
    expect(result.config.relayer?.url).toBe("https://paylink-relayer.example.workers.dev");
  });

  it.each([
    ["an unknown key", { ...valid, contract: "0x0000000000000000000000000000000000000001" }],
    ["another version", { ...valid, version: 2 }],
    ["plain http", { ...valid, relayer: { url: "http://relayer.example", chains: [10143] } }],
    ["credentials in a URL", { ...valid, relayer: { url: "https://user:pass@relayer.example", chains: [10143] } }],
    ["a query string", { ...valid, indexer: { url: "https://indexer.example/graphql?token=x", chains: [10143] } }],
    ["a fragment", { ...valid, indexer: { url: "https://indexer.example/#x", chains: [10143] } }],
    ["a javascript: URL", { ...valid, rpc: { "10143": [SCRIPT_URL] } }],
    ["a chain ID that is not a number", { ...valid, rpc: { monad: ["https://rpc.example.org"] } }],
    ["too many RPCs", { ...valid, rpc: { "10143": Array.from({ length: 5 }, (_, i) => `https://rpc${String(i)}.example.org`) } }],
    ["an empty banner", { ...valid, banner: { level: "info", text: { en: "" } } }],
    ["an unknown banner level", { ...valid, banner: { level: "panic", text: { en: "x" } } }],
    ["not an object", "relayer=https://evil.example"],
  ])("rejects %s and falls back to the defaults", (_name, value) => {
    const result = parseConfig(value);
    expect(result.ok).toBe(false);
    expect(result.config).toBe(DEFAULT_CONFIG);
    expect(result.ok ? "" : result.problem).not.toBe("");
  });
});

describe("loadConfig", () => {
  it("fetches <base>config.json from the same origin without the HTTP cache", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(valid), { status: 200 })));
    const result = await loadConfig("/", fetcher);
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/config.json", expect.objectContaining({ cache: "no-cache", credentials: "same-origin" }));
  });

  it("reports an HTTP error, a network failure or bad JSON, with the defaults in use", async () => {
    const notFound = await loadConfig("/", () => Promise.resolve(new Response("", { status: 404 })));
    expect(notFound).toEqual({ ok: false, config: DEFAULT_CONFIG, problem: "HTTP 404" });
    const offline = await loadConfig("/", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(offline).toEqual({ ok: false, config: DEFAULT_CONFIG, problem: "Failed to fetch" });
    const garbage = await loadConfig("/", () => Promise.resolve(new Response("{", { status: 200 })));
    expect(garbage.ok).toBe(false);
  });
});

describe("endpointFor", () => {
  it("returns an endpoint only for the chains it serves", () => {
    const config = parseConfig(valid).config;
    expect(endpointFor(config.relayer, 10143)).toBe("https://paylink-relayer.example.workers.dev");
    expect(endpointFor(config.relayer, 84532)).toBeNull();
    expect(endpointFor(config.indexer, 10143)).toBeNull();
  });
});
