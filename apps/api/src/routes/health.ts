// SPDX-License-Identifier: MIT
/**
 * `GET /v1/health` (public, docs/paypal/SPEC.md §13, §14.2 F8): one row per dependency for the Status page, from public
 * facts only: which secrets and bindings are present (never their values), what the Global store last saw (P5, verified
 * webhook, cron), and the chain's deployment as the registry records it. A row whose fact cannot be read says `unknown`;
 * a read never fails the document. Cached per isolate for 5 seconds.
 *
 * Owner: foundation (the document); each workstream sharpens its own row through the Global store's `noteHealth`.
 */
import { API_CONTRACT_VERSION } from "@paylink/api-contract";
import type { HealthResponse, HealthRow } from "@paylink/api-contract";
import type { ApiServices } from "../core/services.ts";
import type { RouteHandlers } from "./types.ts";

const CACHE_MS = 5_000;
const READ_TIMEOUT_MS = 2_000;

type HealthFacts = Awaited<ReturnType<ReturnType<ApiServices["stores"]["global"]>["readHealth"]>>;

async function readFacts(services: ApiServices): Promise<HealthFacts | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      services.stores.global().readHealth(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
        }, READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

/** The rows, from the runtime's configuration and the store's facts (`null`: the store could not be read). */
export function healthRows(services: ApiServices, facts: HealthFacts | null, now: number): HealthRow[] {
  const { config, secrets } = services.runtime;
  const paypalConfigured = config.paypal.mode === "fake" || (secrets.paypalClientId !== undefined && secrets.paypalClientSecret !== undefined);
  const lastGet = facts?.["paypal-get"]?.at;
  const lastWebhook = facts?.["webhook-verified"]?.at;
  const backoff = facts?.["paypal-backoff"];
  const rows: HealthRow[] = [
    {
      id: "paypal",
      state: !paypalConfigured ? "not-configured" : backoff !== undefined && (backoff.value ?? 0) > 0 ? "degraded" : lastGet === undefined ? "unknown" : "ok",
      code: !paypalConfigured ? "credentials-missing" : config.paypal.mode === "fake" ? "fake" : lastGet === undefined ? "not-read-yet" : "last-get",
      checkedAt: iso(lastGet),
    },
    {
      id: "webhook",
      state: config.paypal.mode === "fake" ? "ok" : secrets.paypalWebhookId === undefined ? "not-configured" : lastWebhook === undefined ? "unknown" : "ok",
      code: secrets.paypalWebhookId === undefined && config.paypal.mode !== "fake" ? "webhook-id-missing" : lastWebhook === undefined ? "none-verified-yet" : "last-verified",
      checkedAt: iso(lastWebhook),
      ...(lastWebhook === undefined ? {} : { values: { ageSeconds: Math.max(0, Math.round((now - lastWebhook) / 1000)) } }),
    },
    {
      id: "assistant",
      state: config.ai.mode === "disabled" ? "not-configured" : services.ai.kind === config.ai.mode ? "unknown" : "degraded",
      code: config.ai.mode === "disabled" ? "disabled" : `model:${services.ai.model}`,
      checkedAt: null,
      values: { dailyNeuronBudget: config.ai.dailyNeuronBudget },
    },
    {
      id: "chain",
      state: services.chain.deployed ? "ok" : "degraded",
      code: services.chain.deployed ? "deployed" : "not-deployed",
      checkedAt: null,
      values: { chainId: services.chain.chainId },
    },
    {
      id: "store",
      state: facts === null ? "unknown" : "ok",
      code: facts === null ? "unreadable" : "readable",
      checkedAt: iso(facts?.["cron-run"]?.at),
    },
  ];
  return rows;
}

export function healthDocument(services: ApiServices, rows: readonly HealthRow[], now: number): HealthResponse {
  const status = rows.some((r) => r.state === "down") ? "down" : rows.every((r) => r.state === "ok") ? "ok" : "degraded";
  return {
    status,
    service: "paylink-api",
    version: services.runtime.config.version,
    contract: API_CONTRACT_VERSION,
    time: new Date(now).toISOString(),
    paypalEnvironment: "sandbox",
    rows,
  };
}

let cached: { readonly at: number; readonly doc: HealthResponse; readonly services: ApiServices } | null = null;

export const healthHandlers: RouteHandlers = {
  health: async ({ c, services, now }) => {
    if (cached?.services !== services || now - cached.at >= CACHE_MS) {
      cached = { at: now, services, doc: healthDocument(services, healthRows(services, await readFacts(services), now), now) };
    }
    c.header("Cache-Control", "no-store");
    return c.json(cached.doc, 200);
  },
};
