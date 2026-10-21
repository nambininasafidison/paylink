// SPDX-License-Identifier: MIT
/**
 * The one cron of the API (`* * * * *`, docs/paypal/SPEC.md §7.5, §13): the backstop for late or missing webhooks and the
 * daily cleanup.
 *
 * Each run reads at most `CRON_TWIN_BUDGET` (20) due twins from the Global store's schedule, oldest first: all their chain
 * states in **one** `eth_call` (src/chain/reader.ts) with at most `CRON_LOG_LOOKUPS` event lookups, then one P5 each,
 * with at most `CRON_AUTO_RECORDS` automatic records (P6 and a second P5 each). Worst case: 20 P5 + 1 `eth_call` +
 * 2 × 3 `eth_getLogs` attempts + 3 × 2 PayPal calls + 1 token refresh = 34 subrequests, under the Workers Free plan's
 * 50 (Cloudflare limits page, S, docs/paypal/SPEC.md §6.3).
 *
 * Back-off (§7.5): when PayPal answers 429 or 5xx, or does not answer, the run stops reading PayPal and pauses it for
 * 1 minute, doubling on each failing run up to 1 hour (Global health fact `paypal-backoff`, which turns the Status row
 * amber); the first good read clears it.
 *
 * Once per UTC day the run purges what is past retention (§11): the Global store, and up to `CRON_PURGE_PAYEES` payee
 * stores not purged for 24 hours.
 *
 * Owner: reconciler workstream.
 */
import type { ApiServices } from "../core/services.ts";
import { errorFields } from "../core/log.ts";
import type { TwinRecord } from "../store/types.ts";
import { chainTwinOf, reconcileTwin } from "./engine.ts";
import { utcDay } from "./money.ts";

export interface CronReport {
  readonly checked: number;
  readonly backoffMs: number;
  readonly purged: boolean;
}

/** Twins read per run at most (§7.5). */
export const CRON_TWIN_BUDGET = 20;
/** Event lookups (`eth_getLogs`) per run at most. */
export const CRON_LOG_LOOKUPS = 2;
/** Automatic records (P6) per run at most. */
export const CRON_AUTO_RECORDS = 3;
/** Payee stores purged per run at most, once a day. */
export const CRON_PURGE_PAYEES = 10;
export const BACKOFF_MIN_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

export async function runCron(services: ApiServices, now: number): Promise<CronReport> {
  const { logger } = services.runtime;
  const global = services.stores.global();
  const health = await global.readHealth();
  const backoff = health["paypal-backoff"];
  const pausedUntil = backoff !== undefined && (backoff.value ?? 0) > 0 ? backoff.at + (backoff.value ?? 0) : 0;
  let checked = 0;
  let backoffMs = 0;

  if (now < pausedUntil) {
    backoffMs = pausedUntil - now;
  } else {
    const due = await global.dueChecks(now, CRON_TWIN_BUDGET);
    const twins: TwinRecord[] = [];
    for (const check of due) {
      const twin = await services.stores.payee(check.payee).getTwin(check.key);
      if (twin === null) {
        await global.unscheduleCheck(check.payee, check.key);
      } else {
        twins.push(twin);
      }
    }
    const chain = await services.chain.observeMany(twins.map(chainTwinOf), { logLookups: CRON_LOG_LOOKUPS });
    let records = CRON_AUTO_RECORDS;
    let failed = false;
    for (const twin of twins) {
      const observation = chain.get(twin.key);
      const outcome = await reconcileTwin(services, twin.payee, twin.key, now, { source: "cron", automatic: records > 0, ...(observation === undefined ? {} : { chain: observation }) });
      if (outcome.status !== "done") {
        continue;
      }
      checked += 1;
      records -= outcome.recorded ? 1 : 0;
      if (outcome.paypalError?.retryable === true) {
        failed = true;
        break; // the twins not read keep their due time and come first next run
      }
    }
    if (failed) {
      backoffMs = Math.min(Math.max((backoff?.value ?? 0) * 2, BACKOFF_MIN_MS), BACKOFF_MAX_MS);
      await global.noteHealth("paypal-backoff", now, backoffMs);
    } else if (backoff !== undefined && (backoff.value ?? 0) > 0 && checked > 0) {
      await global.noteHealth("paypal-backoff", now, 0);
    }
  }

  let purged = false;
  const lastPurge = health.purge;
  if (lastPurge === undefined || utcDay(lastPurge.at) !== utcDay(now)) {
    try {
      const removed = (await global.purge(now)).removed;
      let payees = 0;
      for (const payee of await global.payeesToPurge(now, CRON_PURGE_PAYEES)) {
        await services.stores.payee(payee).purge(now);
        await global.markPayeePurged(payee, now);
        payees += 1;
      }
      await global.noteHealth("purge", now);
      purged = true;
      logger.log("info", "cron.purge", { removed, payees });
    } catch (error) {
      logger.log("error", "cron.purge-failed", errorFields(error));
    }
  }
  await global.noteHealth("cron-run", now);
  logger.log("info", "cron.run", { checked, backoffMs, purged });
  return { checked, backoffMs, purged };
}
