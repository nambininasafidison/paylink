// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's shell end to end (e2e/specs/paypal.spec.ts, ADR 0018): the production build of the `all` and
 * `paypal` editions (production registry: Ethereum Sepolia, PayLinkV2 not deployed there yet), served under its real
 * `_headers`, and the edition's API (apps/api) through its Node entry in a separate process.
 *
 * The app keeps its production `/config.json`: the API is https://paylink-api.raherizonambinina.workers.dev, and the test
 * routes that origin to the local API (`routeApi`), as editions.ts does for the relayer. That is how the API origin is
 * configurable here: the page's Content-Security-Policy and the app's config stay the production ones, byte for byte.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { BrowserContext, Route } from "@playwright/test";
import { freePort } from "./anvil.ts";
import { REPO } from "./server.ts";

/** The API origin of apps/web/public/config.json (`api`), routed to the local API by `routeApi`. */
export const API_ORIGIN = "https://paylink-api.raherizonambinina.workers.dev";
/** Ethereum Sepolia's registry RPC (packages/chains). No test may reach it: `routeApi` refuses it. */
export const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

/** Builds `all` and `paypal` (production chains) into apps/web/dist-e2e-paypal. */
export async function buildPaypalSite(): Promise<string> {
  const app = join(REPO, "apps/web");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=@paylink/source", "scripts/build.ts", "--e2e"], {
      cwd: app,
      env: { ...process.env, PAYLINK_EDITIONS: "all,paypal", PAYLINK_E2E_OUT: "dist-e2e-paypal" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`the PayPal edition build exited with ${String(code)}`));
      }
    });
  });
  return join(app, "dist-e2e-paypal");
}

export interface LocalApi {
  readonly url: string;
  stop(): Promise<void>;
}

/** apps/api's Node entry (`start:local --offline`), answering CORS for the e2e site's origin only. No secret is set. */
export async function startApi(siteOrigin: string): Promise<LocalApi> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["--conditions=@paylink/source", "src/node/main.ts", "--port", String(port), "--origin", siteOrigin, "--offline"], {
    cwd: join(REPO, "apps/api"),
    env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the local API did not start"));
    }, 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes('"event":"listening"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the local API exited with ${String(code)}`));
    });
  });
  child.stdout?.resume();
  return {
    url: `http://127.0.0.1:${String(port)}`,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await exited;
      }
    },
  };
}

/**
 * Sends the page's requests for the production API to the local one (CORS answered by the API itself), and refuses
 * Ethereum Sepolia's RPC, which a shell test never needs. Returns the API requests seen.
 */
export async function routeApi(context: BrowserContext, api: LocalApi): Promise<{ method: string; path: string; status: number }[]> {
  const log: { method: string; path: string; status: number }[] = [];
  await context.route(`${API_ORIGIN}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers: Record<string, string> = {};
    for (const name of ["origin", "content-type", "accept", "authorization", "access-control-request-method", "access-control-request-headers"]) {
      const value = request.headers()[name];
      if (value !== undefined) {
        headers[name] = value;
      }
    }
    const body = request.method() === "POST" ? (request.postData() ?? "") : undefined;
    const response = await fetch(`${api.url}${url.pathname}${url.search}`, { method: request.method(), headers, ...(body === undefined ? {} : { body }) });
    log.push({ method: request.method(), path: url.pathname, status: response.status });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) });
  });
  await context.route((url) => url.origin === SEPOLIA_RPC, async (route: Route) => {
    await route.abort("connectionrefused");
  });
  return log;
}
