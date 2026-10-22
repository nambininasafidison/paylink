// SPDX-License-Identifier: MIT
/**
 * The Node entry over the same app (docs/paypal/SPEC.md §6.1, §15.2): tests, the e2e suite and the offline demo
 * (`pnpm --filter @paylink/api dev:offline`: the PayPal fake and recorded AI answers, no account needed). In-memory
 * stores; secrets from the environment, never from a file in the repository.
 *
 * Offline (`offline: true`), the same server also answers for the PayPal fake under `/__paypal/`: the payer's page
 * (`recipient_view_url`), the fake's test controls (`/__paypal/__fake/...`) and its webhook deliveries, which go to this
 * server's own `POST /v1/paypal/webhook` and are verified there by P10 like PayPal's. Two options exist for the
 * end-to-end suites only, and only offline:
 *
 * - `localChain`: an anvil fork of Ethereum Sepolia with PayLinkV2 deployed at its release address. The registry keeps
 *   its own RPC URL and every other fact; this process records the fork's deployment on its Ethereum Sepolia entry and
 *   sends the requests for that RPC URL to the fork, as the browser suites route the page's requests.
 * - `payerOrigin`: the origin the fake writes into `recipient_view_url` (the suites route PayPal's sandbox host to it).
 *
 * `aiBinding` (tests only) stands a scripted Workers AI binding in for `env.AI`, so the real Workers AI provider, the
 * desk agent and the fence run against a model that does what the test says. The Worker never has any of these.
 *
 * Owner: foundation.
 */
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createRegistry, registry as shippedRegistry, RELEASE } from "@paylink/chains";
import type { Registry } from "@paylink/chains";
import { getAddress, isAddress, isHex } from "viem";
import type { Address, Hex } from "viem";
import { createApp } from "../core/app.ts";
import { configWith } from "../core/config.ts";
import { createLogger } from "../core/log.ts";
import type { AiBinding, ApiRuntime, ApiSecrets } from "../core/runtime.ts";
import { createServices } from "../core/services.ts";
import type { ApiServices } from "../core/services.ts";
import { payPalFakeOf } from "../paypal/factory.ts";
import { runCron } from "../reconciler/cron.ts";
import { createMemoryStores } from "../store/memory.ts";
import type { StoreFactory } from "../store/types.ts";

/** Where the Node entry serves the PayPal fake when offline (the payer's page, the fake's controls). */
export const FAKE_PAYPAL_MOUNT = "/__paypal";

/** An anvil fork of the edition's chain with PayLinkV2 deployed on it (end-to-end suites only). */
export interface LocalChain {
  /** The fork's RPC (`http://127.0.0.1:<port>`): requests for the registry's RPC URL of the chain go there. */
  readonly forkUrl: string;
  /** PayLinkV2 as deployed on the fork: the release's CREATE2 address only. */
  readonly deployment: { readonly address: Address; readonly txHash: Hex; readonly blockNumber: string; readonly deployer: Address };
}

export interface NodeApiOptions {
  /** Origins allowed by CORS (the e2e suite's static server, `vite dev`). */
  readonly allowedOrigins: readonly string[];
  /** The PayPal fake and recorded AI answers instead of PayPal's sandbox and Workers AI (which needs the Worker). */
  readonly offline: boolean;
  readonly secrets?: ApiSecrets;
  readonly port?: number;
  readonly host?: string;
  readonly log?: (line: string) => void;
  readonly clock?: () => number;
  readonly fetch?: typeof fetch;
  readonly stores?: StoreFactory;
  /** Offline only, end-to-end suites: the edition's chain is this fork (module comment). */
  readonly localChain?: LocalChain;
  /** Offline only: the origin written into `recipient_view_url` (default: this server's `/__paypal`). */
  readonly payerOrigin?: string;
  /** Tests only: a scripted stand-in for the Workers AI binding (module comment). */
  readonly aiBinding?: AiBinding;
  /** Runs the cron (`runCron`) every this many milliseconds, as the Worker's one-minute trigger does. Off by default. */
  readonly cronIntervalMs?: number;
}

/** Secrets from the process environment (names of .dev.vars.example). */
export function secretsFromEnv(env: Readonly<Record<string, string | undefined>>): ApiSecrets {
  const pick = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const entries = [
    ["paypalClientId", pick("PAYPAL_CLIENT_ID")],
    ["paypalClientSecret", pick("PAYPAL_CLIENT_SECRET")],
    ["paypalWebhookId", pick("PAYPAL_WEBHOOK_ID")],
    ["approvalHmacKey", pick("APPROVAL_HMAC_KEY")],
    ["sessionHmacKey", pick("SESSION_HMAC_KEY")],
  ] as const;
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

/** `localChain` as JSON (`--local-chain`), checked: a fork URL on this machine and the release's deployment. */
export function parseLocalChain(text: string): LocalChain {
  const value = JSON.parse(text) as { forkUrl?: unknown; deployment?: { address?: unknown; txHash?: unknown; blockNumber?: unknown; deployer?: unknown } };
  const d = value.deployment ?? {};
  const forkUrl = typeof value.forkUrl === "string" ? new URL(value.forkUrl) : null;
  if (forkUrl?.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(forkUrl.hostname)) {
    throw new Error("--local-chain: forkUrl must be an http URL on this machine");
  }
  if (typeof d.address !== "string" || !isAddress(d.address) || typeof d.deployer !== "string" || !isAddress(d.deployer) || typeof d.txHash !== "string" || !isHex(d.txHash) || d.txHash.length !== 66) {
    throw new Error("--local-chain: deployment needs address, deployer and a 32-byte txHash");
  }
  if (typeof d.blockNumber !== "string" || !/^[0-9]{1,20}$/u.test(d.blockNumber)) {
    throw new Error("--local-chain: deployment.blockNumber must be a decimal string");
  }
  return { forkUrl: forkUrl.origin, deployment: { address: getAddress(d.address), deployer: getAddress(d.deployer), txHash: d.txHash, blockNumber: d.blockNumber } };
}

/** The shipped registry with `local`'s deployment recorded on the chain `chainId` (its RPC URLs and tokens unchanged). */
export function registryWithLocalDeployment(chainId: number, local: LocalChain): Registry {
  if (local.deployment.address !== RELEASE.create2.address) {
    throw new Error(`a local deployment must be PayLinkV2 at its release address ${RELEASE.create2.address}`);
  }
  if (shippedRegistry.get(chainId) === undefined) {
    throw new Error(`chain ${String(chainId)} is not in the registry`);
  }
  return createRegistry(
    shippedRegistry.chains.map((chain) =>
      chain.chainId !== chainId
        ? chain
        : {
            ...chain,
            deployment: {
              address: local.deployment.address,
              status: "active" as const,
              release: RELEASE.release,
              method: "CREATE2" as const,
              deployer: local.deployment.deployer,
              txHash: local.deployment.txHash,
              blockNumber: BigInt(local.deployment.blockNumber),
              initCodeHash: RELEASE.initCodeHash,
              maskedRuntimeHash: RELEASE.maskedRuntimeHash,
              runtimeCodeHash: `0x${"00".repeat(32)}`,
            },
          },
    ),
  );
}

/** `base`, with every request for one of `rpcUrls` sent to `forkUrl` instead (same method, headers and body). */
export function forkFetch(base: typeof fetch, rpcUrls: readonly string[], forkUrl: string): typeof fetch {
  const routed = new Set(rpcUrls.map((url) => url.replace(/\/+$/u, "")));
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!routed.has(request.url.replace(/\/+$/u, ""))) {
      return await base(input, init);
    }
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    return await base(forkUrl, { method: request.method, headers: request.headers, ...(body === undefined ? {} : { body }), signal: request.signal });
  };
}

export function nodeRuntime(options: NodeApiOptions): ApiRuntime {
  const secrets = options.secrets ?? {};
  if (!options.offline && (options.localChain !== undefined || options.payerOrigin !== undefined)) {
    throw new Error("localChain and payerOrigin are for the offline entry only (the PayPal fake), never PayPal's sandbox");
  }
  const scripted = options.aiBinding !== undefined;
  const config = configWith({
    allowedOrigins: options.allowedOrigins,
    paypal: options.offline ? { mode: "fake", baseUrl: "http://paypal.fake.invalid" } : {},
    // Workers AI is reachable only through the Worker's binding: the Node entry replays recorded answers, runs a test's
    // scripted binding, or has none.
    ai: { mode: scripted ? "workers-ai" : options.offline ? "replay" : "disabled" },
  });
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const local = options.localChain;
  const chain = shippedRegistry.get(config.chainId);
  const baseFetch = options.fetch ?? fetch;
  return {
    kind: "node",
    config,
    secrets,
    fetch: local === undefined || chain === undefined ? baseFetch : forkFetch(baseFetch, chain.rpc.map((r) => r.url), local.forkUrl),
    clock: options.clock ?? Date.now,
    random: (bytes) => new Uint8Array(randomBytes(bytes)),
    logger: createLogger({ sink: log, secrets: Object.values(secrets), base: { service: config.service, version: config.version } }),
    ai: options.aiBinding ?? null,
    registry: local === undefined ? shippedRegistry : registryWithLocalDeployment(config.chainId, local),
  };
}

export interface NodeApi {
  readonly url: string;
  readonly services: ApiServices;
  close(): Promise<void>;
}

export async function startNodeApi(options: NodeApiOptions): Promise<NodeApi> {
  const services = createServices(nodeRuntime(options), options.stores ?? createMemoryStores());
  const app = createApp(services);
  const fake = payPalFakeOf(services.paypal);
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (fake !== null && (url.pathname === FAKE_PAYPAL_MOUNT || url.pathname.startsWith(`${FAKE_PAYPAL_MOUNT}/`))) {
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      const inner = new URL(`${url.pathname.slice(FAKE_PAYPAL_MOUNT.length) || "/"}${url.search}`, "http://paypal.fake.invalid");
      return await fake.handle(new Request(inner, { method: request.method, headers: request.headers, ...(body === undefined ? {} : { body }) }));
    }
    return await app.fetch(request);
  };
  const host = options.host ?? "127.0.0.1";
  const server = serve({ fetch: handler, port: options.port ?? 0, hostname: host });
  await new Promise<void>((resolve) => {
    if (server.listening) {
      resolve();
    } else {
      server.once("listening", () => {
        resolve();
      });
    }
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host}:${String(port)}`;
  // The fake's payer pages and links name this server (or the suite's origin); its deliveries come back here.
  fake?.connect({ publicUrl: options.payerOrigin ?? `${url}${FAKE_PAYPAL_MOUNT}`, webhookUrl: `${url}/v1/paypal/webhook` });
  let cron: ReturnType<typeof setInterval> | null = null;
  if (options.cronIntervalMs !== undefined) {
    let running = false;
    cron = setInterval(() => {
      if (running) {
        return;
      }
      running = true;
      runCron(services, services.runtime.clock())
        .catch((error: unknown) => {
          services.runtime.logger.log("error", "cron.failed", { errorName: error instanceof Error ? error.name : typeof error });
        })
        .finally(() => {
          running = false;
        });
    }, options.cronIntervalMs);
    cron.unref();
  }
  return {
    url,
    services,
    close: async () => {
      if (cron !== null) {
        clearInterval(cron);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}
