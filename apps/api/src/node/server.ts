// SPDX-License-Identifier: MIT
/**
 * The Node entry over the same app (docs/paypal/SPEC.md §6.1, §15.2): tests, the e2e suite and the offline demo
 * (`pnpm --filter @paylink/api dev:offline`: the PayPal fake and recorded AI answers, no account needed). In-memory
 * stores; secrets from the environment, never from a file in the repository.
 *
 * Owner: foundation.
 */
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createApp } from "../core/app.ts";
import { configWith } from "../core/config.ts";
import { createLogger } from "../core/log.ts";
import type { ApiRuntime, ApiSecrets } from "../core/runtime.ts";
import { createServices } from "../core/services.ts";
import type { ApiServices } from "../core/services.ts";
import { createMemoryStores } from "../store/memory.ts";
import type { StoreFactory } from "../store/types.ts";

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

export function nodeRuntime(options: NodeApiOptions): ApiRuntime {
  const secrets = options.secrets ?? {};
  const config = configWith({
    allowedOrigins: options.allowedOrigins,
    paypal: options.offline ? { mode: "fake", baseUrl: "http://paypal.fake.invalid" } : {},
    // Workers AI is reachable only through the Worker's binding: the Node entry replays recorded answers or has none.
    ai: { mode: options.offline ? "replay" : "disabled" },
  });
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  return {
    kind: "node",
    config,
    secrets,
    fetch: options.fetch ?? fetch,
    clock: options.clock ?? Date.now,
    random: (bytes) => new Uint8Array(randomBytes(bytes)),
    logger: createLogger({ sink: log, secrets: Object.values(secrets), base: { service: config.service, version: config.version } }),
    ai: null,
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
  const host = options.host ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port: options.port ?? 0, hostname: host });
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
  return {
    url: `http://${host}:${String(port)}`,
    services,
    close: async () => {
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
