// SPDX-License-Identifier: MIT
/**
 * The Worker's runtime, built once per isolate from its bindings and secrets (src/worker/index.ts). Kept out of the
 * entry module because the platform treats every named export of the entry as an entrypoint.
 *
 * Owner: foundation.
 */
import { DEFAULT_CONFIG } from "../core/config.ts";
import { createLogger } from "../core/log.ts";
import type { ApiRuntime } from "../core/runtime.ts";
import type { Env } from "./env.ts";

// Workers Logs collects console output; the logger serialises one JSON object per line.
const sink = (line: string): void => {
  // eslint-disable-next-line no-console -- the platform's log sink
  console.log(line);
};

/** The runtime of this isolate, from its bindings and secrets. */
export function workerRuntime(env: Env): ApiRuntime {
  const secrets = {
    ...(env.PAYPAL_CLIENT_ID === undefined ? {} : { paypalClientId: env.PAYPAL_CLIENT_ID }),
    ...(env.PAYPAL_CLIENT_SECRET === undefined ? {} : { paypalClientSecret: env.PAYPAL_CLIENT_SECRET }),
    ...(env.PAYPAL_WEBHOOK_ID === undefined ? {} : { paypalWebhookId: env.PAYPAL_WEBHOOK_ID }),
    ...(env.APPROVAL_HMAC_KEY === undefined ? {} : { approvalHmacKey: env.APPROVAL_HMAC_KEY }),
    ...(env.SESSION_HMAC_KEY === undefined ? {} : { sessionHmacKey: env.SESSION_HMAC_KEY }),
  };
  return {
    kind: "worker",
    config: DEFAULT_CONFIG,
    secrets,
    fetch: (input, init) => fetch(input, init),
    clock: () => Date.now(),
    random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
    logger: createLogger({ sink, secrets: Object.values(secrets), base: { service: DEFAULT_CONFIG.service, version: DEFAULT_CONFIG.version } }),
    ai: env.AI,
  };
}
