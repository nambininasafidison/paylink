// SPDX-License-Identifier: MIT
/**
 * The one cron of the API (`* * * * *`, docs/paypal/SPEC.md §7.5, §13): the backstop for late or missing webhooks and the
 * daily cleanup. Each run reads at most 20 due twins (one P5 each), all their chain states in one multicall and at most
 * one token refresh, so a run stays under the Workers Free plan's 50 subrequests (Cloudflare limits page, C); it backs
 * off on PayPal 429/5xx (doubling, at most 1 hour). Once a day it purges what is past its retention (§11).
 *
 * Owner: reconciler workstream. Scaffold: does nothing and says so.
 */
import type { ApiServices } from "../core/services.ts";

export interface CronReport {
  readonly checked: number;
  readonly backoffMs: number;
  readonly purged: boolean;
}

/** Twins read per run at most (§7.5). */
export const CRON_TWIN_BUDGET = 20;

export async function runCron(services: ApiServices, now: number): Promise<CronReport> {
  services.runtime.logger.log("info", "cron.idle", { at: new Date(now).toISOString(), reason: "not-implemented" });
  return await Promise.resolve({ checked: 0, backoffMs: 0, purged: false });
}
