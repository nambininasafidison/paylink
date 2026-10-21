// SPDX-License-Identifier: MIT
/**
 * The cron backstop (docs/paypal/SPEC.md §7.5): due twins only, at most 20 a run, their chain states in one eth_call,
 * one P5 each, back-off on PayPal's 429/5xx (doubling from 1 minute to 1 hour, then cleared), and the daily purge.
 */
import type { InvoiceKey } from "@paylink/api-contract";
import { describe, expect, it } from "vitest";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, CRON_TWIN_BUDGET, runCron } from "../../src/reconciler/cron.ts";
import { registerTwin } from "../../src/reconciler/engine.ts";
import { T0 } from "../helpers.ts";
import { DAY, KEY, PAYEE } from "./fixtures.ts";
import { world } from "./world.ts";
import type { World } from "./world.ts";

const keyN = (n: number): InvoiceKey => `0x${n.toString(16).padStart(64, "0")}`;

async function many(n: number): Promise<World> {
  const w = world();
  for (let i = 1; i <= n; i += 1) {
    w.paypal.add(`INV2-${String(i)}`, keyN(i));
    await registerTwin(w.services, w.twin(keyN(i), `INV2-${String(i)}`), w.clock.now);
  }
  w.paypal.calls.length = 0;
  w.rpc.calls.length = 0;
  return w;
}

describe("the cron", () => {
  it("reads nothing before a twin is due, then each due twin once, with one chain eth_call", async () => {
    const w = await many(3);
    expect(await runCron(w.services, w.clock.now)).toMatchObject({ checked: 0, backoffMs: 0 });
    expect(w.paypal.calls).toEqual([]);
    w.advance(60_000);
    expect(await runCron(w.services, w.clock.now)).toMatchObject({ checked: 3 });
    expect(w.paypal.calls.filter((c) => c.op === "get")).toHaveLength(3);
    expect(w.rpc.calls.map((c) => c.method)).toEqual(["eth_call"]);
  });

  it("reads at most 20 twins a run, the oldest due first, the rest next run", async () => {
    const w = await many(CRON_TWIN_BUDGET + 5);
    w.advance(60_000);
    expect((await runCron(w.services, w.clock.now)).checked).toBe(CRON_TWIN_BUDGET);
    expect(w.paypal.calls.filter((c) => c.op === "get")).toHaveLength(CRON_TWIN_BUDGET);
    expect(w.rpc.calls.filter((c) => c.method === "eth_call")).toHaveLength(1);
    expect((await runCron(w.services, w.clock.now)).checked).toBe(5);
  });

  it("backs off PayPal on 429/5xx, doubling to an hour, and clears the back-off on the first good read", async () => {
    const w = await many(2);
    w.advance(60_000);
    w.paypal.failGets = 429;
    expect((await runCron(w.services, w.clock.now)).backoffMs).toBe(BACKOFF_MIN_MS);
    expect(w.paypal.calls.filter((c) => c.op === "get")).toHaveLength(1);
    const health = await w.services.stores.global().readHealth();
    expect(health["paypal-backoff"]).toEqual({ at: w.clock.now, value: BACKOFF_MIN_MS });
    // Inside the back-off: no PayPal call at all.
    w.advance(30_000);
    expect((await runCron(w.services, w.clock.now)).backoffMs).toBe(30_000);
    expect(w.paypal.calls.filter((c) => c.op === "get")).toHaveLength(1);
    // Failing again doubles it, up to an hour.
    w.advance(30_000);
    expect((await runCron(w.services, w.clock.now)).backoffMs).toBe(2 * BACKOFF_MIN_MS);
    for (let i = 0; i < 8; i += 1) {
      w.advance(BACKOFF_MAX_MS);
      await runCron(w.services, w.clock.now);
    }
    expect((await w.services.stores.global().readHealth())["paypal-backoff"]?.value).toBe(BACKOFF_MAX_MS);
    w.paypal.failGets = null;
    w.advance(BACKOFF_MAX_MS);
    expect((await runCron(w.services, w.clock.now)).checked).toBeGreaterThan(0);
    expect((await w.services.stores.global().readHealth())["paypal-backoff"]?.value).toBe(0);
  });

  it("purges once per UTC day and notes its runs for the Status page", async () => {
    const w = await many(1);
    expect((await runCron(w.services, w.clock.now)).purged).toBe(true);
    expect((await runCron(w.services, w.clock.now + 1000)).purged).toBe(false);
    const health = await w.services.stores.global().readHealth();
    expect(health["cron-run"]?.at).toBe(T0 + 1000);
    expect(health.purge?.at).toBe(T0);
    expect((await runCron(w.services, T0 + DAY)).purged).toBe(true);
  });

  it("drops a scheduled check whose twin is gone", async () => {
    const w = world();
    await w.services.stores.global().scheduleCheck({ payee: PAYEE, key: KEY, dueAt: T0 });
    expect((await runCron(w.services, T0)).checked).toBe(0);
    expect(await w.services.stores.global().dueChecks(T0 + DAY, 20)).toEqual([]);
  });

  it("keeps each run inside the subrequest budget: two event lookups, at most three records; the rest follow", async () => {
    const w = await many(5);
    for (let i = 1; i <= 5; i += 1) {
      w.payOnChain(keyN(i), `0x${(i + 100).toString(16).padStart(64, "0")}`);
    }
    const perRun: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      w.advance(60_000);
      const before = w.paypal.writes().length;
      const rpcBefore = w.rpc.calls.length;
      await runCron(w.services, w.clock.now);
      perRun.push(w.paypal.writes().length - before);
      expect(w.rpc.calls.slice(rpcBefore).filter((c) => c.method === "eth_getLogs").length).toBeLessThanOrEqual(2);
      expect(w.rpc.calls.slice(rpcBefore).filter((c) => c.method === "eth_call")).toHaveLength(1);
    }
    expect(perRun).toEqual([2, 2, 1]);
    expect(w.paypal.writes().every((c) => c.op === "record")).toBe(true);
  });
});
