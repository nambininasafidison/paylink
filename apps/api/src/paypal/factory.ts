// SPDX-License-Identifier: MIT
/**
 * Builds the PayPal client for a runtime. One implementation, the HTTP client (src/paypal/http.ts), in both modes:
 *
 * - `sandbox` (the Worker, and the Node entry with credentials): PayPal's sandbox at `runtime.config.paypal.baseUrl`
 *   with the app's credentials from the secrets, `runtime.fetch` as transport, and the token shared through the Global
 *   store. Without both secrets every call fails with `E_PAYPAL_NOT_CONFIGURED` (problem `paypal-unavailable`) before
 *   anything is sent.
 * - `fake` (tests, e2e, `dev:offline`): a PayPal fake per runtime (src/paypal/fake/), reached in process; its webhook
 *   deliveries go out through `runtime.fetch` to the URL the Node entry connects (`payPalFakeOf(client).connect`).
 *
 * Owner: PayPal spine workstream.
 */
import type { FactoryDeps } from "../core/runtime.ts";
import type { PayPalClient } from "./client.ts";
import type { PayPalFake } from "./fake/index.ts";
import { createPayPalFake, FAKE_WEBHOOK_ID } from "./fake/index.ts";
import { createHttpPayPalClient } from "./http.ts";
import type { TokenStore } from "./token.ts";

const fakes = new WeakMap<PayPalClient, PayPalFake>();

export function createPayPalClient(deps: FactoryDeps): PayPalClient {
  const { runtime, stores } = deps;
  const tokenStore: TokenStore = {
    getToken: (now) => stores.global().getToken(now),
    putToken: (token) => stores.global().putToken(token),
  };
  const common = { clock: runtime.clock, random: runtime.random, logger: runtime.logger, tokenStore };
  if (runtime.config.paypal.mode === "fake") {
    const fake = createPayPalFake({ clock: runtime.clock, baseUrl: runtime.config.paypal.baseUrl, deliver: (url, init) => runtime.fetch(url, init), autoDeliver: true });
    const client = createHttpPayPalClient({ ...common, baseUrl: fake.baseUrl, credentials: fake.credentials, transport: fake.fetch });
    fakes.set(client, fake);
    return client;
  }
  const { paypalClientId: clientId, paypalClientSecret: clientSecret } = runtime.secrets;
  return createHttpPayPalClient({
    ...common,
    baseUrl: runtime.config.paypal.baseUrl,
    credentials: clientId !== undefined && clientSecret !== undefined ? { clientId, clientSecret } : null,
    transport: (input, init) => runtime.fetch(input, init),
  });
}

/** The fake behind a client built in `fake` mode, or null (the Node entry connects it; tests drive it). */
export function payPalFakeOf(client: PayPalClient): PayPalFake | null {
  return fakes.get(client) ?? null;
}

/**
 * The webhook subscription P10 verifies against: the `PAYPAL_WEBHOOK_ID` secret, or the fake's own subscription in
 * `fake` mode; `null` when a sandbox deployment has none (the route then answers 503 and PayPal delivers again later).
 */
export function webhookIdFor(deps: Pick<FactoryDeps, "runtime">): string | null {
  const { runtime } = deps;
  return runtime.secrets.paypalWebhookId ?? (runtime.config.paypal.mode === "fake" ? FAKE_WEBHOOK_ID : null);
}
