// SPDX-License-Identifier: MIT
/**
 * The services a route handler, the webhook and the cron use, assembled once per runtime from each area's factory. The
 * entries (src/worker/index.ts, src/node/main.ts) never change when an area's implementation does: each workstream
 * replaces the body of its own factory.
 *
 * | Service     | Factory (owner)                                   |
 * |-------------|---------------------------------------------------|
 * | `paypal`    | src/paypal/factory.ts (PayPal spine)              |
 * | `stores`    | given by the entry: src/worker/durable.ts or src/store/memory.ts (reconciler) |
 * | `chain`     | src/chain/factory.ts (reconciler)                 |
 * | `sessions`  | src/session/factory.ts (reconciler)               |
 * | `approvals` | src/approvals/factory.ts (reconciler)             |
 * | `ai`        | src/ai/factory.ts (AI)                            |
 *
 * Owner: foundation.
 */
import { createAiProvider } from "../ai/factory.ts";
import type { AiProvider } from "../ai/types.ts";
import { createApprovals } from "../approvals/factory.ts";
import type { Approvals } from "../approvals/types.ts";
import { createChainReader } from "../chain/factory.ts";
import type { ChainReader } from "../chain/types.ts";
import type { PayPalClient } from "../paypal/client.ts";
import { createPayPalClient } from "../paypal/factory.ts";
import { createSessions } from "../session/factory.ts";
import type { Sessions } from "../session/types.ts";
import type { StoreFactory } from "../store/types.ts";
import type { ApiRuntime } from "./runtime.ts";

export interface ApiServices {
  readonly runtime: ApiRuntime;
  readonly paypal: PayPalClient;
  readonly stores: StoreFactory;
  readonly chain: ChainReader;
  readonly sessions: Sessions;
  readonly approvals: Approvals;
  readonly ai: AiProvider;
}

export function createServices(runtime: ApiRuntime, stores: StoreFactory): ApiServices {
  const deps = { runtime, stores };
  return {
    runtime,
    paypal: createPayPalClient(deps),
    stores,
    chain: createChainReader(deps),
    sessions: createSessions(deps),
    approvals: createApprovals(deps),
    ai: createAiProvider(deps),
  };
}
