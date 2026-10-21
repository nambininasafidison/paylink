// SPDX-License-Identifier: MIT
/**
 * Test support of the PayPal spine: a PayPal fake with a client over it, a Global store that records what the spine
 * asks of it (and only that: any other method fails the test), services for the webhook route without the other
 * workstreams' factories, and an instant sleep. Owner: PayPal spine workstream.
 */
import { createApp } from "../../src/core/app.ts";
import { createLogger } from "../../src/core/log.ts";
import type { ApiRuntime, ApiSecrets } from "../../src/core/runtime.ts";
import type { ApiServices } from "../../src/core/services.ts";
import type { AccessToken, PayPalClient } from "../../src/paypal/client.ts";
import type { PayPalFake, PayPalFakeOptions } from "../../src/paypal/fake/index.ts";
import { createPayPalFake } from "../../src/paypal/fake/index.ts";
import type { HttpPayPalClientOptions } from "../../src/paypal/http.ts";
import { createHttpPayPalClient } from "../../src/paypal/http.ts";
import { createWebhookHandlers, scheduleTwinCheck } from "../../src/routes/webhook.ts";
import type { GlobalStore, PayeeStore, ScheduledCheck, StoreFactory } from "../../src/store/types.ts";
import { T0, testRuntime } from "../helpers.ts";

export { T0 };

/** A clock tests move by hand. */
export function manualClock(start = T0): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
    set: (ms) => {
      at = ms;
    },
  };
}

/** Log lines as parsed JSON objects. */
export function logSink(): { readonly lines: string[]; readonly events: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  return { lines, events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/** The calls the spine makes on the Global store, and what it answers. */
export interface RecordingGlobal {
  readonly store: GlobalStore;
  readonly tokens: AccessToken[];
  readonly events: Map<string, number>;
  readonly checks: ScheduledCheck[];
  readonly health: Map<string, number>;
  /** Make every call fail (an unavailable Durable Object). */
  failing: boolean;
}

/** A Global store implementing only what the PayPal spine uses; any other method throws (a test would notice). */
export function recordingGlobal(): RecordingGlobal {
  const state: RecordingGlobal = { store: undefined as unknown as GlobalStore, tokens: [], events: new Map(), checks: [], health: new Map(), failing: false };
  const guard = <T>(work: () => T): Promise<T> => (state.failing ? Promise.reject(new Error("store unavailable")) : Promise.resolve(work()));
  const used: Partial<GlobalStore> = {
    getToken: (now) => guard(() => state.tokens.filter((t) => t.expiresAtMs > now).at(-1) ?? null),
    putToken: (token) =>
      guard(() => {
        state.tokens.push(token);
      }),
    markWebhookEvent: (id) =>
      guard(() => {
        if (state.events.has(id)) {
          return "seen" as const;
        }
        state.events.set(id, 1);
        return "new" as const;
      }),
    scheduleCheck: (check) =>
      guard(() => {
        state.checks.push(check);
      }),
    noteHealth: (fact, at) =>
      guard(() => {
        state.health.set(fact, at);
      }),
  };
  (state as { store: GlobalStore }).store = new Proxy(used, {
    get: (target, name: string) =>
      (target as Record<string, unknown>)[name] ??
      (() => {
        throw new Error(`GlobalStore.${name} is not used by the PayPal spine`);
      }),
  }) as GlobalStore;
  return state;
}

/** Stores whose payee side must not be touched by the spine's code under test. */
export function spineStores(global: RecordingGlobal): StoreFactory {
  return {
    payee: () =>
      new Proxy({} as PayeeStore, {
        get: (_target, name: string) => {
          throw new Error(`PayeeStore.${name} is not used by the PayPal spine`);
        },
      }),
    global: () => global.store,
  };
}

/** A fake and an HTTP client over it, with an instant sleep and a recording token store. */
export function fakeAndClient(
  options: { readonly fake?: PayPalFakeOptions; readonly client?: Partial<HttpPayPalClientOptions>; readonly clock?: () => number; readonly global?: RecordingGlobal } = {},
): { readonly fake: PayPalFake; readonly client: PayPalClient; readonly sleeps: number[]; readonly log: ReturnType<typeof logSink>; readonly global: RecordingGlobal } {
  const clock = options.clock ?? (() => T0);
  const fake = createPayPalFake({ clock, ...options.fake });
  const sleeps: number[] = [];
  const log = logSink();
  const global = options.global ?? recordingGlobal();
  const client = createHttpPayPalClient({
    baseUrl: fake.baseUrl,
    credentials: fake.credentials,
    transport: fake.fetch,
    clock,
    random: (n) => new Uint8Array(n).fill(128),
    logger: createLogger({ sink: (line) => log.lines.push(line), secrets: [fake.credentials.clientSecret], now: clock }),
    tokenStore: global.store,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...options.client,
  });
  return { fake, client, sleeps, log, global };
}

/** A service the spine's routes never reach: any use fails the test. */
function unused(area: string): never {
  return new Proxy(
    {},
    {
      get: (_target, name: string) => {
        throw new Error(`${area}.${name} is not used by the PayPal spine`);
      },
    },
  ) as never;
}

/**
 * Services for the PayPal routes: a runtime (fake or sandbox mode), the PayPal client given, the spine's stores, and
 * placeholders for the other workstreams' services (the webhook and twin routes do not reach them).
 */
export function spineServices(options: { readonly paypal: PayPalClient; readonly global: RecordingGlobal; readonly runtime?: ApiRuntime; readonly offline?: boolean; readonly secrets?: ApiSecrets; readonly lines?: string[] }): ApiServices {
  const runtime = options.runtime ?? testRuntime({ offline: options.offline ?? true, ...(options.secrets === undefined ? {} : { secrets: options.secrets }), ...(options.lines === undefined ? {} : { lines: options.lines }) });
  return {
    runtime,
    paypal: options.paypal,
    stores: spineStores(options.global),
    chain: unused("chain"),
    sessions: unused("sessions"),
    approvals: unused("approvals"),
    ai: unused("ai"),
  };
}

/** The app with the webhook route only, its sink planning the reconciliation (no reconciler behind it). */
export function spineApp(services: ApiServices): ReturnType<typeof createApp> {
  return createApp(services, [createWebhookHandlers(scheduleTwinCheck)]);
}
