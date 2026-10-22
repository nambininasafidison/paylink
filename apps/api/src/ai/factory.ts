// SPDX-License-Identifier: MIT
/**
 * Builds the AI provider for a runtime (`config.ai.mode`):
 *
 * | Mode | Provider |
 * |---|---|
 * | `workers-ai` | the primary model on the Worker's `AI` binding, the fallback model once on a failure worth retrying, under the daily neuron ceiling (src/ai/budget.ts) |
 * | `replay` | the offline demo's cassette (src/ai/demo-cassette.ts) under the same ceiling: a request it does not hold is the manual path |
 * | `disabled` | none: every assistant path is the manual one (U6) |
 *
 * `workers-ai` without a binding (a misconfigured deployment) answers `unavailable` / `error`, and the health row says so.
 *
 * Owner: AI workstream.
 */
import type { FactoryDeps } from "../core/runtime.ts";
import { withBudget, withFallback } from "./budget.ts";
import { DEMO_CASSETTE } from "./demo-cassette.ts";
import { modelFacts } from "./models.ts";
import { cassetteProvider } from "./replay.ts";
import type { AiProvider } from "./types.ts";
import { unavailableProvider } from "./types.ts";
import { workersAiProvider } from "./workers-ai.ts";

export function createAiProvider(deps: FactoryDeps): AiProvider {
  const { config, ai: binding, clock, logger } = deps.runtime;
  const { mode, model, fallbackModel, dailyNeuronBudget, timeoutMs } = config.ai;
  const primary = modelFacts(model);
  const budget = { global: () => deps.stores.global(), ceiling: dailyNeuronBudget, clock, logger, model: primary };
  switch (mode) {
    case "disabled":
      return unavailableProvider("disabled", model, "disabled");
    case "replay":
      return withBudget(cassetteProvider([DEMO_CASSETTE], { kind: "replay", model }), budget);
    case "workers-ai": {
      if (binding === null) {
        logger.log("error", "ai.no-binding", { model });
        return unavailableProvider("workers-ai", model, "error");
      }
      const first = workersAiProvider({ binding, model: primary, timeoutMs, clock });
      const second = fallbackModel === null ? null : workersAiProvider({ binding, model: modelFacts(fallbackModel), timeoutMs, clock });
      return withBudget(withFallback(first, second), budget);
    }
  }
}
