// SPDX-License-Identifier: MIT
/**
 * The Worker's bindings (deploy/wrangler.toml) and secrets. Secrets are Cloudflare secrets set in the dashboard
 * (Workers & Pages → paylink-api → Settings → Variables and Secrets), never `[vars]` entries and never in this repository
 * (docs/paypal/SPEC.md §12.1; test/deploy.test.ts keeps wrangler.toml free of them).
 *
 * Owner: foundation.
 */
import type { Global, Payee } from "./durable.ts";

export interface Env {
  /** Workers AI (decision D-AI): `[ai] binding = "AI"`. */
  readonly AI: Ai;
  readonly PAYEE: DurableObjectNamespace<Payee>;
  readonly GLOBAL: DurableObjectNamespace<Global>;
  readonly PAYPAL_CLIENT_ID?: string;
  readonly PAYPAL_CLIENT_SECRET?: string;
  readonly PAYPAL_WEBHOOK_ID?: string;
  readonly APPROVAL_HMAC_KEY?: string;
  readonly SESSION_HMAC_KEY?: string;
}
