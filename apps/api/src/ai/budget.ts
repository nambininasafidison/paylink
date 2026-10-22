// SPDX-License-Identifier: MIT
/**
 * Guards around a provider: the fallback model, and the daily neuron ceiling with the cost meter.
 *
 * - `withFallback`: the fallback model is tried once when the primary model times out, answers out of shape, is cut
 *   off, is busy or fails. Never after a refusal (a refusal goes to the manual path) and never when the day's budget is
 *   spent.
 * - `withBudget`: before each call, the Global store must have room for the call's estimated cost under the day's
 *   ceiling (`config.ai.dailyNeuronBudget`, Workers AI's 10,000 free neurons by default); otherwise the call is not made
 *   and the answer is `unavailable` / `budget`, which every caller shows as "Assistant resting". After the call, what
 *   it cost is counted (the provider's usage, or the estimate when it reports none); a count that would cross the
 *   ceiling fills it, so the next call rests. One log line per call: model, outcome, latency, tokens and neurons; never
 *   a prompt, an answer or a pasted text (docs/paypal/SPEC.md §9.4).
 *
 * Owner: AI workstream.
 */
import type { Logger } from "../core/log.ts";
import type { GlobalStore } from "../store/types.ts";
import type { ModelFacts } from "./models.ts";
import { estimateTokens, neuronsFor } from "./models.ts";
import type { AiFailure, AiProvider, StructuredResult, ToolTurnResult } from "./types.ts";

type Result = StructuredResult | ToolTurnResult;

/** Whether the fallback model may be tried after this failure (module comment). */
export function fallbackWorthy(result: Result): boolean {
  switch (result.outcome) {
    case "ok":
    case "refused":
      return false;
    case "timeout":
    case "invalid-output":
    case "truncated":
      return true;
    case "unavailable":
      return result.reason === "error" || result.reason === "rate-limited";
  }
}

export function withFallback(primary: AiProvider, fallback: AiProvider | null): AiProvider {
  if (fallback === null) {
    return primary;
  }
  return {
    kind: primary.kind,
    model: primary.model,
    async structured(request) {
      const first = await primary.structured(request);
      return fallbackWorthy(first) ? await fallback.structured(request) : first;
    },
    async toolTurn(request) {
      const first = await primary.toolTurn(request);
      return fallbackWorthy(first) ? await fallback.toolTurn(request) : first;
    },
  };
}

export interface BudgetOptions {
  readonly global: () => GlobalStore;
  /** Neurons per UTC day. */
  readonly ceiling: number;
  readonly clock: () => number;
  readonly logger: Logger;
  /** The primary model, for the estimate made before a call. */
  readonly model: ModelFacts;
  /** Which feature calls (log field only). */
  readonly feature?: string;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const RESTING: AiFailure = { outcome: "unavailable", reason: "budget" };

/** The cost of a call before it is made: its whole input, and every output token it may produce. */
export function estimateNeurons(model: ModelFacts, sentText: string, maxOutputTokens: number): number {
  return neuronsFor(model, estimateTokens(sentText), maxOutputTokens);
}

export function withBudget(inner: AiProvider, options: BudgetOptions): AiProvider {
  const { ceiling, clock, logger, model } = options;

  const metered = async <R extends Result>(call: string, sentText: string, maxOutputTokens: number, invoke: () => Promise<R>): Promise<R | AiFailure> => {
    const day = utcDay(clock());
    const estimate = estimateNeurons(model, sentText, maxOutputTokens);
    // Room for the whole estimated call, without counting anything yet.
    const room = await options.global().spendAiBudget(day, 0, Math.max(0, ceiling - estimate));
    if (!room.allowed) {
      logger.log("info", "ai.resting", { call, model: model.id, day, used: room.used, ceiling });
      return RESTING;
    }
    const result = await invoke();
    let neurons = 0;
    if (result.outcome === "ok") {
      neurons = result.usage.neurons ?? estimate;
    } else if (result.outcome === "timeout" || result.outcome === "invalid-output" || result.outcome === "truncated" || result.outcome === "refused") {
      // The model ran; its usage is unknown: count the estimate (over-counting keeps the free allocation safe).
      neurons = estimate;
    }
    if (result.outcome === "unavailable" && result.reason === "budget") {
      // Cloudflare says the account's free allocation is spent (3036): rest for the rest of the day without asking again.
      neurons = Number.MAX_SAFE_INTEGER;
    }
    if (neurons > 0) {
      const spent = await options.global().spendAiBudget(day, neurons, ceiling);
      if (!spent.allowed && spent.limit > spent.used) {
        await options.global().spendAiBudget(day, spent.limit - spent.used, ceiling);
      }
    }
    logger.log(result.outcome === "ok" ? "info" : "warn", "ai.call", {
      call,
      feature: options.feature,
      model: result.outcome === "ok" ? result.model : model.id,
      outcome: result.outcome === "unavailable" ? `unavailable:${result.reason}` : result.outcome,
      latencyMs: result.outcome === "ok" ? result.latencyMs : undefined,
      usageIn: result.outcome === "ok" ? result.usage.inputTokens : undefined,
      usageOut: result.outcome === "ok" ? result.usage.outputTokens : undefined,
      usageEstimated: result.outcome === "ok" ? result.usage.estimated : undefined,
      neurons: neurons === Number.MAX_SAFE_INTEGER ? null : neurons,
    });
    return result;
  };

  return {
    kind: inner.kind,
    model: inner.model,
    structured: async (request) => await metered("structured", request.system + request.user + JSON.stringify(request.schema), request.maxOutputTokens, async () => await inner.structured(request)),
    toolTurn: async (request) => await metered("toolTurn", JSON.stringify(request.messages) + JSON.stringify(request.tools), request.maxOutputTokens, async () => await inner.toolTurn(request)),
  };
}

/**
 * Today's neurons against the ceiling, read without spending (for the Status page's assistant row: "budget left", and
 * "resting" once a typical call no longer fits). `typicalCall` is the estimate of one A1 draft by default (E).
 */
export async function assistantBudget(global: GlobalStore, ceiling: number, now: number, typicalCall = 40): Promise<{ readonly day: string; readonly spent: number; readonly left: number; readonly resting: boolean }> {
  const day = utcDay(now);
  const read = await global.spendAiBudget(day, 0, Number.MAX_SAFE_INTEGER);
  const left = Math.max(0, ceiling - read.used);
  return { day, spent: read.used, left, resting: left < typicalCall };
}
