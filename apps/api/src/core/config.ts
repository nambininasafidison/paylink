// SPDX-License-Identifier: MIT
/**
 * The deployed API's configuration: code, not variables (a value here changes only with a reviewed commit). The Node
 * entry overrides the origins and modes for tests, e2e and the offline demo.
 *
 * Owner: foundation.
 */
import { PAYPAL_EDITION_CHAIN_ID, PAYPAL_PAYER_PAGES } from "@paylink/api-contract";
import { FALLBACK_MODEL, FREE_NEURONS_PER_DAY, PRIMARY_MODEL } from "../ai/models.ts";
import type { ApiConfig } from "./runtime.ts";
import { API_VERSION } from "./version.ts";

/**
 * The PayPal edition's origins (decision D-HOST): the Cloudflare Pages preview of branch `paypal`, where the edition is
 * served at /paypal/, and the production Pages origin, where it will be once merged.
 */
export const PAGES_ORIGINS = ["https://paypal.paylink-mg.pages.dev", "https://paylink-mg.pages.dev"] as const;

/** PayPal's sandbox REST base (`servers` of invoicing_v2.json and notifications_webhooks_v1.json at 90e8041, V). */
export const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

export const DEFAULT_CONFIG: ApiConfig = {
  service: "paylink-api",
  version: API_VERSION,
  allowedOrigins: PAGES_ORIGINS,
  // The host of the sandbox's recipient_view_url, as the owner's capture run of 2026-10-29 recorded it (§12.3, C).
  paypal: { mode: "sandbox", baseUrl: PAYPAL_SANDBOX_BASE, payerHost: PAYPAL_PAYER_PAGES.sandbox.host },
  ai: {
    mode: "workers-ai",
    model: PRIMARY_MODEL.id,
    fallbackModel: FALLBACK_MODEL.id,
    // The Workers Free plan's whole daily allocation; the Global store refuses calls beyond it ("Assistant resting").
    dailyNeuronBudget: FREE_NEURONS_PER_DAY,
    timeoutMs: 20_000,
  },
  chainId: PAYPAL_EDITION_CHAIN_ID,
  quotas: { twinsPerDay: 20, aiCallsPerDay: 60 },
  // The owner's "PayPal Demo" wallet (docs/runbooks/paypal.md §10 step 4), the payee of the video and the judge links
  // (and the account that deployed PayLinkV2 on Ethereum Sepolia, protocol/deployments/11155111.json): its sessions and
  // assistant calls draw on a reserved lane the public cannot spend (src/store/quotas.ts). Every other payee, a judge's
  // own wallet included, has the public limits.
  demoPayees: ["0xd9a39e47a152a88E408324E8f8fdAF89e86243A2"],
};

/** `DEFAULT_CONFIG` with some members replaced (Node entry, tests). */
export function configWith(overrides: { readonly allowedOrigins?: readonly string[]; readonly paypal?: Partial<ApiConfig["paypal"]>; readonly ai?: Partial<ApiConfig["ai"]>; readonly demoPayees?: readonly string[] }): ApiConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(overrides.allowedOrigins === undefined ? {} : { allowedOrigins: overrides.allowedOrigins }),
    ...(overrides.demoPayees === undefined ? {} : { demoPayees: overrides.demoPayees }),
    paypal: { ...DEFAULT_CONFIG.paypal, ...overrides.paypal },
    ai: { ...DEFAULT_CONFIG.ai, ...overrides.ai },
  };
}
