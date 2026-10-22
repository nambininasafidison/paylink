// SPDX-License-Identifier: MIT
/**
 * Per-address, per-source and deployment-wide daily quotas (docs/paypal/SPEC.md §9.4, threat T-60: abuse of the public
 * demo), for every route that costs PayPal calls, chain reads or assistant neurons. A refusal is the problem
 * `quota-exhausted` (429) with `Retry-After` at the next UTC midnight; the manual paths stay open (U6).
 *
 * | Counter        | Per payee per day                    | Per source per day (the client IP)  | Whole deployment per day (E) |
 * |----------------|--------------------------------------|-------------------------------------|------------------------------|
 * | twins          | `config.quotas.twinsPerDay` (20)     | n/a                                 | 500                          |
 * | aiCalls        | `config.quotas.aiCallsPerDay` (60)   | 30 calls and 1,500 neurons          | 150 calls; neurons up to the ceiling less the demo reserve (src/ai/admission.ts) |
 * | sweeps         | 100 ("Check my invoices")            | n/a                                 | n/a                          |
 * | checks         | 100 ("Was I really paid?")           | n/a                                 | 2,000                        |
 * | sessions       | 20                                   | 30                                  | 5,000 (src/session/types.ts) |
 *
 * Addresses cost nothing to make, so the per-payee counters alone do not bound one actor with many keys (a Sybil): the
 * per-source counters do, and the demo payees of `config.demoPayees` (the owner's wallet for the video and the judges'
 * links) draw on a reserved lane of their own, `DEMO_RESERVE`, that no public caller can spend. The payee's counter is
 * charged first: a payee over its own limit never consumes the deployment's.
 *
 * Owner: reconciler workstream (the PayPal spine charges `twins` in POST /v1/twin, the AI workstream `aiCalls` and
 * neurons through src/ai/admission.ts).
 */
import type { Address } from "@paylink/api-contract";
import { ProblemError } from "../core/problem.ts";
import type { ApiServices } from "../core/services.ts";
import { msUntilNextUtcDay, utcDay } from "../reconciler/money.ts";
import type { GlobalQuotaKind, PayeeQuotaKind, QuotaResult } from "./types.ts";

export const PAYEE_DAILY = { sweeps: 100, checks: 100, sessions: 20 } as const;
export const GLOBAL_DAILY = { twins: 500, aiCalls: 150, checks: 2_000 } as const satisfies Partial<Record<GlobalQuotaKind, number>>;
/** Per request source per day (E): a judge's whole tour uses a few sessions and a dozen assistant calls. */
export const SOURCE_DAILY = { sessions: 30, aiCalls: 30, neurons: 1_500 } as const;
/** The demo payees' own lane per day (E): sessions, assistant calls, and the neurons kept out of the public's reach. */
export const DEMO_RESERVE = { sessions: 500, aiCalls: 150, neurons: 2_500 } as const;

/** Whether `payee` is one of the owner's demo payees (`config.demoPayees`). */
export function isDemoPayee(services: Pick<ApiServices, "runtime">, payee: string): boolean {
  const lower = payee.toLowerCase();
  return services.runtime.config.demoPayees.some((p) => p.toLowerCase() === lower);
}

export function exhausted(kind: string, scope: "payee" | "source" | "deployment", now: number): ProblemError {
  return new ProblemError("quota-exhausted", `the ${scope}'s daily ${kind} quota is used up`, {
    rule: scope === "payee" ? "E_QUOTA_PAYEE" : scope === "source" ? "E_QUOTA_SOURCE" : "E_QUOTA_GLOBAL",
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
  if (kind === "sweeps") {
    return;
  }
  // The demo payees' assistant calls count in their own lane (module comment).
  const lane = kind === "aiCalls" && isDemoPayee(services, payee) ? (["aiCallsDemo", DEMO_RESERVE.aiCalls] as const) : ([kind, GLOBAL_DAILY[kind]] as const);
  if (!(await services.stores.global().useQuota(day, lane[0], lane[1])).allowed) {
    throw exhausted(kind, "deployment", now);
  }
}

/**
 * Counts one assistant run: the payee's `aiCalls`, then (for a public payee) its source's calls, then the lane's calls
 * (public or demo). Throws `quota-exhausted` at the first limit reached, leaving the later counters untouched.
 */
export async function chargeAssistantCall(services: ApiServices, payee: Address, source: string, now: number): Promise<void> {
  const day = utcDay(now);
  if (!(await services.stores.payee(payee).useQuota(day, "aiCalls", services.runtime.config.quotas.aiCallsPerDay)).allowed) {
    throw exhausted("aiCalls", "payee", now);
  }
  await chargeSource(services, payee, source, "aiCalls", now);
  const demo = isDemoPayee(services, payee);
  if (!(await services.stores.global().useQuota(day, demo ? "aiCallsDemo" : "aiCalls", demo ? DEMO_RESERVE.aiCalls : GLOBAL_DAILY.aiCalls)).allowed) {
    throw exhausted("aiCalls", "deployment", now);
  }
}

/** Counts one use for a request source (never for a demo payee); throws `quota-exhausted` (`E_QUOTA_SOURCE`) at a limit. */
export async function chargeSource(services: ApiServices, payee: Address, source: string, kind: "sessions" | "aiCalls", now: number): Promise<void> {
  if (isDemoPayee(services, payee)) {
    return;
  }
  const subject = kind === "sessions" ? "sessions-source" : "aiCalls-source";
  if (!(await services.stores.global().useSubjectQuota(utcDay(now), subject, source, 1, SOURCE_DAILY[kind])).allowed) {
    throw exhausted(kind, "source", now);
  }
}

/** Counts assistant neurons against the day's ceiling (`config.ai.dailyNeuronBudget`); `allowed: false` means resting. */
export async function chargeNeurons(services: ApiServices, neurons: number, now: number): Promise<QuotaResult> {
  return await services.stores.global().spendAiBudget(utcDay(now), neurons, services.runtime.config.ai.dailyNeuronBudget);
}
