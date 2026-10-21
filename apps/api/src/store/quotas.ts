// SPDX-License-Identifier: MIT
/**
 * Per-address and deployment-wide daily quotas (docs/paypal/SPEC.md §9.4, threat T-60: abuse of the public demo), for
 * every route that costs PayPal calls, chain reads or assistant neurons. A refusal is the problem `quota-exhausted`
 * (429) with `Retry-After` at the next UTC midnight; the manual paths stay open (U6).
 *
 * | Counter        | Per payee per day                    | Whole deployment per day (E) |
 * |----------------|--------------------------------------|------------------------------|
 * | twins          | `config.quotas.twinsPerDay` (20)     | 500                          |
 * | aiCalls        | `config.quotas.aiCallsPerDay` (60)   | 1,500 (and the neuron ceiling, `chargeNeurons`) |
 * | sweeps         | 100 ("Check my invoices")            | n/a                          |
 * | checks         | 100 ("Was I really paid?")           | 2,000                        |
 * | sessions       | n/a                                  | 5,000 (src/session/types.ts) |
 *
 * The payee's counter is charged first: a payee over its own limit never consumes the deployment's.
 *
 * Owner: reconciler workstream (the PayPal spine charges `twins` in POST /v1/twin, the AI workstream `aiCalls` and
 * neurons in its routes).
 */
import type { Address } from "@paylink/api-contract";
import { ProblemError } from "../core/problem.ts";
import type { ApiServices } from "../core/services.ts";
import { msUntilNextUtcDay, utcDay } from "../reconciler/money.ts";
import type { GlobalQuotaKind, PayeeQuotaKind, QuotaResult } from "./types.ts";

export const PAYEE_DAILY = { sweeps: 100, checks: 100 } as const;
export const GLOBAL_DAILY = { twins: 500, aiCalls: 1_500, checks: 2_000 } as const satisfies Partial<Record<GlobalQuotaKind, number>>;

function exhausted(kind: string, scope: "payee" | "deployment", now: number): ProblemError {
  return new ProblemError("quota-exhausted", `the ${scope}'s daily ${kind} quota is used up`, {
    rule: scope === "payee" ? "E_QUOTA_PAYEE" : "E_QUOTA_GLOBAL",
    retryAfter: Math.ceil(msUntilNextUtcDay(now) / 1000),
  });
}

/** Counts one use for the payee (and the deployment, where it has a limit); throws `quota-exhausted` at a limit. */
export async function chargeQuota(services: ApiServices, payee: Address, kind: PayeeQuotaKind, now: number): Promise<void> {
  const { quotas } = services.runtime.config;
  const limit = kind === "twins" ? quotas.twinsPerDay : kind === "aiCalls" ? quotas.aiCallsPerDay : PAYEE_DAILY[kind];
  const day = utcDay(now);
  if (!(await services.stores.payee(payee).useQuota(day, kind, limit)).allowed) {
    throw exhausted(kind, "payee", now);
  }
  if (kind !== "sweeps" && !(await services.stores.global().useQuota(day, kind, GLOBAL_DAILY[kind])).allowed) {
    throw exhausted(kind, "deployment", now);
  }
}

/** Counts assistant neurons against the day's ceiling (`config.ai.dailyNeuronBudget`); `allowed: false` means resting. */
export async function chargeNeurons(services: ApiServices, neurons: number, now: number): Promise<QuotaResult> {
  return await services.stores.global().spendAiBudget(utcDay(now), neurons, services.runtime.config.ai.dailyNeuronBudget);
}
