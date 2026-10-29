// SPDX-License-Identifier: MIT
/**
 * The Node entry's offline options (src/node/server.ts), which the end-to-end suites and the judges' offline path use and
 * the Worker never has: the PayPal fake served under `/__paypal` (its payer page and its webhook deliveries back to this
 * server), the minute cron, and an anvil fork of Ethereum Sepolia recorded as PayLinkV2's deployment, reached through
 * the registry's own RPC URL. Each option refuses to run against PayPal's sandbox.
 */
import type { HealthResponse } from "@paylink/api-contract";
import { RELEASE, registry as shippedRegistry } from "@paylink/chains";
import { describe, expect, it } from "vitest";
import { FAKE_PAYPAL_MOUNT, forkFetch, nodeRuntime, parseLocalChain, registryWithLocalDeployment, startNodeApi } from "../src/node/server.ts";
import type { LocalChain } from "../src/node/server.ts";
import { TEST_ORIGIN } from "./helpers.ts";

const SEPOLIA = 11155111;
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const LOCAL: LocalChain = {
  forkUrl: "http://127.0.0.1:8545",
  deployment: { address: RELEASE.create2.address, txHash: `0x${"ab".repeat(32)}`, blockNumber: "11967300", deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
};

describe("--local-chain", () => {
  it("accepts a fork on this machine and the release's deployment, and nothing else", () => {
    expect(parseLocalChain(JSON.stringify({ forkUrl: "http://127.0.0.1:8545/", deployment: { ...LOCAL.deployment, address: RELEASE.create2.address.toLowerCase() } }))).toEqual(LOCAL);
    for (const forkUrl of ["https://ethereum-sepolia-rpc.publicnode.com", "http://10.0.0.2:8545", "file:///tmp/x", 7]) {
      expect(() => parseLocalChain(JSON.stringify({ forkUrl, deployment: LOCAL.deployment }))).toThrow(/forkUrl/);
    }
    expect(() => parseLocalChain(JSON.stringify({ forkUrl: LOCAL.forkUrl, deployment: { ...LOCAL.deployment, txHash: "0x12" } }))).toThrow(/txHash/);
    expect(() => parseLocalChain(JSON.stringify({ forkUrl: LOCAL.forkUrl, deployment: { ...LOCAL.deployment, blockNumber: 12 } }))).toThrow(/blockNumber/);
  });

  it("records the deployment on Ethereum Sepolia only, at the release address only, with the registry's RPC and tokens", () => {
    const local = registryWithLocalDeployment(SEPOLIA, LOCAL);
    const chain = local.get(SEPOLIA);
    // The shipped registry records the owner's deployment (protocol/deployments/11155111.json); the fork's replaces it.
    expect(shippedRegistry.get(SEPOLIA)?.deployment).toMatchObject({ address: RELEASE.create2.address, txHash: "0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3", blockNumber: 12_017_054n });
    expect(chain?.deployment).toMatchObject({ address: RELEASE.create2.address, status: "active", method: "CREATE2", txHash: LOCAL.deployment.txHash, deployer: LOCAL.deployment.deployer, blockNumber: 11_967_300n, initCodeHash: RELEASE.initCodeHash });
    expect(chain?.rpc).toEqual(shippedRegistry.get(SEPOLIA)?.rpc);
    expect(chain?.tokens).toEqual(shippedRegistry.get(SEPOLIA)?.tokens);
    for (const other of shippedRegistry.chains.filter((c) => c.chainId !== SEPOLIA)) {
      expect(local.get(other.chainId)).toEqual(other);
    }
    expect(() => registryWithLocalDeployment(SEPOLIA, { ...LOCAL, deployment: { ...LOCAL.deployment, address: "0x000000000000000000000000000000000000dEaD" } })).toThrow(/release address/);
  });

  it("sends the requests for the registry's RPC URL to the fork, method, headers and body unchanged; nothing else", async () => {
    const seen: { url: string; method: string; body: string | null; type: string | null }[] = [];
    const base: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push({ url: request.url, method: request.method, body: request.method === "GET" ? null : await request.text(), type: request.headers.get("content-type") });
      return new Response("{}");
    };
    const routed = forkFetch(base, [RPC], LOCAL.forkUrl);
    await routed(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":1}' });
    await routed(`${RPC}/`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":2}' });
    await routed("https://api-m.sandbox.paypal.com/v2/invoicing/invoices/X");
    expect(seen).toEqual([
      { url: "http://127.0.0.1:8545/", method: "POST", body: '{"id":1}', type: "application/json" },
      { url: "http://127.0.0.1:8545/", method: "POST", body: '{"id":2}', type: "application/json" },
      { url: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/X", method: "GET", body: null, type: null },
    ]);
  });

  it("is refused with PayPal's sandbox: a fork and a payer origin exist for the PayPal fake only", () => {
    expect(() => nodeRuntime({ allowedOrigins: [TEST_ORIGIN], offline: false, localChain: LOCAL })).toThrow(/offline/);
    expect(() => nodeRuntime({ allowedOrigins: [TEST_ORIGIN], offline: false, payerOrigin: "https://www.sandbox.paypal.com" })).toThrow(/offline/);
    const runtime = nodeRuntime({ allowedOrigins: [TEST_ORIGIN], offline: true, localChain: LOCAL });
    expect(runtime.registry.get(SEPOLIA)?.deployment?.address).toBe(RELEASE.create2.address);
    expect(nodeRuntime({ allowedOrigins: [TEST_ORIGIN], offline: true }).registry).toBe(shippedRegistry);
  });
});

describe("the offline Node entry", () => {
  it("serves the PayPal fake's payer pages under /__paypal, and the API everywhere else", async () => {
    const api = await startNodeApi({ allowedOrigins: [TEST_ORIGIN], offline: true, log: () => undefined });
    try {
      const page = await fetch(`${api.url}${FAKE_PAYPAL_MOUNT}/invoice/p/INV2-NONE-NONE-NONE-NONE`);
      expect(page.status).toBe(404);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await page.text()).toContain("Invoice not found");
      const health = (await (await fetch(`${api.url}/v1/health`)).json()) as HealthResponse;
      expect(health.rows.find((r) => r.id === "paypal")).toMatchObject({ code: "fake" });
      expect((await fetch(`${api.url}/__paypalx/invoice/p/X`)).status).toBe(404);
    } finally {
      await api.close();
    }
  });

  it("runs the cron on its interval, as the Worker's minute trigger does, and stops it on close", async () => {
    const lines: string[] = [];
    const api = await startNodeApi({ allowedOrigins: [TEST_ORIGIN], offline: true, cronIntervalMs: 25, log: (line) => lines.push(line) });
    try {
      await expect.poll(() => lines.filter((l) => l.includes('"event":"cron.run"')).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
      const health = (await (await fetch(`${api.url}/v1/health`)).json()) as HealthResponse;
      expect(health.rows.find((r) => r.id === "store")?.checkedAt).not.toBeNull();
    } finally {
      await api.close();
    }
    const runs = lines.filter((l) => l.includes('"event":"cron.run"')).length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(lines.filter((l) => l.includes('"event":"cron.run"')).length).toBe(runs);
  });
});
