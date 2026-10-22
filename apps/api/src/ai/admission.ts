// SPDX-License-Identifier: MIT
/**
 * Who may spend the assistant's neurons, and how many (threat T-60, docs/paypal/SPEC.md §9.4). Every assistant run (an
 * A1 draft, an A2 desk run) is admitted here first, and runs on the provider this returns:
 *
 * | Caller | Counted against (per UTC day) | Neurons it may spend |
 * |---|---|---|
 * | any payee | its own `aiCalls` (`config.quotas.aiCallsPerDay`, 60) | |
 * | a public payee | its request source's 30 calls; the public lane's 150 calls | up to the daily ceiling less `DEMO_RESERVE.neurons`, and 1,500 per source |
 * | a demo payee (`config.demoPayees`) | the demo lane's 150 calls | up to the daily ceiling |
 *
 * Addresses cost nothing, so a payee's quota alone lets one actor with a handful of keys spend the whole day's neurons
 * (the review of 2026-10-22 measured 8 keys and 461 drafts); the per-source and public-lane limits bound that, and the
 * reserve keeps the demo payees' assistant working for the judges whatever the public did. Every refusal is "Assistant
 * resting" (the manual paths stay open, U6).
 *
 * The neuron limits wrap the deployment's provider (whose own guard, src/ai/budget.ts, keeps the whole ceiling): before
 * a call, the call's estimated cost must fit under the caller's lane and source; after it, its cost is counted for the
 * source.
 *
 * Owner: AI workstream.
 */
import type { Address } from "@paylink/api-contract";
import type { ApiServices } from "../core/services.ts";
import { chargeAssistantCall, DEMO_RESERVE, isDemoPayee, SOURCE_DAILY } from "../store/quotas.ts";
import { estimateNeurons } from "./budget.ts";
import { PRIMARY_MODEL } from "./models.ts";
import type { AiFailure, AiProvider, StructuredResult, ToolTurnResult } from "./types.ts";

/** The caller of an assistant run: the session's payee and the request's source (src/core/http.ts `clientSource`). */
export interface AssistantCaller {
  readonly payee: Address;
  readonly source: string;
}

const RESTING: AiFailure = { outcome: "unavailable", reason: "budget" };
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The provider for one public caller: each call fits under the public lane and the source's neurons, or rests. */
function publicLane(services: ApiServices, source: string): AiProvider {
  const inner = services.ai;
  const global = (): ReturnType<ApiServices["stores"]["global"]> => services.stores.global();
  const ceiling = services.runtime.config.ai.dailyNeuronBudget;
  const { logger } = services.runtime;
  const metered = async <R extends StructuredResult | ToolTurnResult>(sentText: string, maxOutputTokens: number, invoke: () => Promise<R>): Promise<R | AiFailure> => {
    const day = utcDay(services.runtime.clock());
    const estimate = estimateNeurons(PRIMARY_MODEL, sentText, maxOutputTokens);
    const lane = await global().spendAiBudget(day, 0, Math.max(0, ceiling - DEMO_RESERVE.neurons - estimate));
    const own = await global().useSubjectQuota(day, "neurons-source", source, 0, Math.max(0, SOURCE_DAILY.neurons - estimate));
    if (!lane.allowed || !own.allowed) {
      logger.log("info", "ai.resting", { lane: "public", reason: lane.allowed ? "source" : "reserve", day });
      return RESTING;
    }
    const result = await invoke();
    const spent = result.outcome === "ok" ? (result.usage.neurons ?? estimate) : result.outcome === "unavailable" ? 0 : estimate;
    if (spent > 0) {
      const counted = await global().useSubjectQuota(day, "neurons-source", source, spent, SOURCE_DAILY.neurons);
      if (!counted.allowed && counted.limit > counted.used) {
        await global().useSubjectQuota(day, "neurons-source", source, counted.limit - counted.used, SOURCE_DAILY.neurons);
      }
    }
    return result;
  };
  return {
    kind: inner.kind,
    model: inner.model,
    structured: async (request) => await metered(request.system + request.user + JSON.stringify(request.schema), request.maxOutputTokens, async () => await inner.structured(request)),
    toolTurn: async (request) => await metered(JSON.stringify(request.messages) + JSON.stringify(request.tools), request.maxOutputTokens, async () => await inner.toolTurn(request)),
  };
}

/**
 * Admits one assistant run (module table): counts it for the payee, the source and the lane, and returns the provider
 * the run must use. Throws `quota-exhausted` (the caller answers "resting") when a count is at its limit.
 */
export async function admitAssistant(services: ApiServices, caller: AssistantCaller, now: number): Promise<AiProvider> {
  await chargeAssistantCall(services, caller.payee, caller.source, now);
  return isDemoPayee(services, caller.payee) ? services.ai : publicLane(services, caller.source);
}
