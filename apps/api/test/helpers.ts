// SPDX-License-Identifier: MIT
/**
 * Test helpers shared by every workstream's tests: a Node runtime with a pinned clock and seeded randomness, services
 * over chosen stores, and the app ready for `app.request()`.
 *
 * Owner: foundation (workstreams may add helpers in their own files).
 */
import { createApp } from "../src/core/app.ts";
import type { ApiRuntime, ApiSecrets } from "../src/core/runtime.ts";
import { createServices } from "../src/core/services.ts";
import type { ApiServices } from "../src/core/services.ts";
import { nodeRuntime } from "../src/node/server.ts";
import { createMemoryStores } from "../src/store/memory.ts";
import type { StoreFactory } from "../src/store/types.ts";

/** 2026-10-21T12:00:00.000Z. */
export const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
export const TEST_ORIGIN = "http://127.0.0.1:5173";

export function testRuntime(options: { readonly offline?: boolean; readonly secrets?: ApiSecrets; readonly now?: number; readonly lines?: string[] } = {}): ApiRuntime {
  let counter = 0;
  const runtime = nodeRuntime({
    allowedOrigins: [TEST_ORIGIN],
    offline: options.offline ?? true,
    secrets: options.secrets ?? {},
    clock: () => options.now ?? T0,
    log: (line) => options.lines?.push(line),
  });
  return {
    ...runtime,
    random: (bytes) => {
      counter += 1;
      return new Uint8Array(bytes).fill(counter % 256);
    },
  };
}

export function testServices(options: { readonly runtime?: ApiRuntime; readonly stores?: StoreFactory } = {}): ApiServices {
  return createServices(options.runtime ?? testRuntime(), options.stores ?? createMemoryStores());
}

export function testApp(services: ApiServices = testServices()): ReturnType<typeof createApp> {
  return createApp(services);
}
