// SPDX-License-Identifier: MIT
/**
 * Cloudflare Worker entry of `paylink-api` (decision D-HOST): `fetch` serves the Hono app, `scheduled` runs the one cron,
 * and the Durable Object classes `Payee` and `Global` are exported for their bindings. The runtime is built once per
 * isolate from the bindings and secrets; no secret value is ever logged (the logger scrubs every one it is given).
 *
 * Owner: foundation. Workstreams change their factories and src/worker/durable.ts, not this file.
 */
import { createApp } from "../core/app.ts";
import { createServices } from "../core/services.ts";
import type { ApiServices } from "../core/services.ts";
import { runCron } from "../reconciler/cron.ts";
import { durableStores } from "./durable.ts";
import type { Env } from "./env.ts";
import { workerRuntime } from "./runtime.ts";

// Only the handlers and the Durable Object classes are exported: the runtime treats every named export as an entrypoint.
export { Global, Payee } from "./durable.ts";

let isolate: { readonly env: Env; readonly services: ApiServices; readonly app: ReturnType<typeof createApp> } | null = null;

function forEnv(env: Env): NonNullable<typeof isolate> {
  if (isolate?.env !== env) {
    const services = createServices(workerRuntime(env), durableStores(env));
    isolate = { env, services, app: createApp(services) };
  }
  return isolate;
}

export default {
  fetch: (request, env, ctx) => forEnv(env).app.fetch(request, env, ctx),
  scheduled: (controller, env, ctx) => {
    const { services } = forEnv(env);
    ctx.waitUntil(
      runCron(services, controller.scheduledTime).then(
        () => undefined,
        (error: unknown) => {
          services.runtime.logger.log("error", "cron.failed", { errorName: error instanceof Error ? error.name : typeof error });
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
