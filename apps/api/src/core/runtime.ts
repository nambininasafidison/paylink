// SPDX-License-Identifier: MIT
/**
 * What the platform gives the API, in one platform-neutral shape: the Worker entry (src/worker/) builds it from its
 * bindings and secrets, the Node entry (src/node/) from its options and the environment. Every area module receives it
 * through its factory and nothing reads `env` or `process` directly, so the same code runs in both.
 *
 * Owner: foundation.
 */
import type { StoreFactory } from "../store/types.ts";
import type { Logger } from "./log.ts";

/**
 * Cloudflare secrets of the Worker (environment variables of the Node entry). Never `[vars]`, never in the repository,
 * a log or a chat (docs/paypal/SPEC.md §12.1). Absent ones make the matching health row `not-configured`.
 */
export interface ApiSecrets {
  /** The sandbox app's client id ("PayLink Twin"). Not sensitive, kept with the secret for rotation. */
  readonly paypalClientId?: string;
  readonly paypalClientSecret?: string;
  /** The webhook subscription's id (P11), for P10. */
  readonly paypalWebhookId?: string;
  /** 32 random bytes, hex: approval tokens (§10.5). Rotating it invalidates open proposals only. */
  readonly approvalHmacKey?: string;
  /** 32 random bytes, hex: session tokens (§12.2). Rotating it invalidates sessions only. */
  readonly sessionHmacKey?: string;
}

/** The subset of the Workers AI binding the API calls (`env.AI.run(model, inputs, options)`, Cloudflare docs). */
export interface AiBinding {
  run(model: string, inputs: Readonly<Record<string, unknown>>, options?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface PayPalConfig {
  /** `sandbox`: api-m.sandbox.paypal.com; `fake`: the in-process PayPal fake (tests, e2e, `dev:offline`). Never live. */
  readonly mode: "sandbox" | "fake";
  /** REST base without a trailing slash (`servers` of the OpenAPI files, V). */
  readonly baseUrl: string;
  /**
   * The only host the pay page may send a payer to (`recipient_view_url`), pinned after the owner's capture run
   * (§12.3). `null` until then: the web edition then shows no PayPal key.
   */
  readonly payerHost: string | null;
}

export interface AiConfig {
  /** `workers-ai`: the Worker's AI binding; `replay`: recorded answers (tests, CI, `dev:offline`); `disabled`. */
  readonly mode: "workers-ai" | "replay" | "disabled";
  /** The model of A1 and A2 (decision D-AI, src/ai/models.ts). */
  readonly model: string;
  /** Tried once when the primary model fails or is unavailable; `null` for none. */
  readonly fallbackModel: string | null;
  /** The daily ceiling the Global Durable Object enforces, in Workers AI neurons (free allocation: 10,000 per day). */
  readonly dailyNeuronBudget: number;
  /** Per request, milliseconds. */
  readonly timeoutMs: number;
}

export interface ApiConfig {
  readonly service: "paylink-api";
  readonly version: string;
  /** Origins allowed by CORS: the PayPal edition's Pages origins (decision D-HOST), or the test origin in Node. */
  readonly allowedOrigins: readonly string[];
  readonly paypal: PayPalConfig;
  readonly ai: AiConfig;
  /** The chain of the PayPal edition (decision D-CHAIN): Ethereum Sepolia. */
  readonly chainId: number;
  /** Per payee per day (docs/paypal/SPEC.md §9.4, E). */
  readonly quotas: { readonly twinsPerDay: number; readonly aiCallsPerDay: number };
}

/** Everything the platform provides. */
export interface ApiRuntime {
  readonly kind: "worker" | "node";
  readonly config: ApiConfig;
  readonly secrets: ApiSecrets;
  /** Outgoing HTTP (PayPal, the chain's RPC); tests pass a fake. */
  readonly fetch: typeof fetch;
  /** Milliseconds since the epoch; tests pin it. */
  readonly clock: () => number;
  /** Cryptographically random bytes; tests seed it. */
  readonly random: (bytes: number) => Uint8Array;
  readonly logger: Logger;
  /** The Workers AI binding: Worker only, and only when `config.ai.mode` is `workers-ai`. */
  readonly ai: AiBinding | null;
}

/** What every area factory receives: the runtime and the stores (src/core/services.ts). */
export interface FactoryDeps {
  readonly runtime: ApiRuntime;
  readonly stores: StoreFactory;
}
