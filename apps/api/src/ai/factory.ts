// SPDX-License-Identifier: MIT
/**
 * Builds the AI provider for a runtime: Workers AI through the `AI` binding (`workers-ai`), recorded answers
 * (`replay`), or none (`disabled`). The provider charges the Global store's daily neuron ceiling before each call.
 *
 * Owner: AI workstream. Scaffold: the provider is unavailable whatever the mode, so every assistant path falls back to
 * the manual one (U6: everything works with the AI switched off).
 */
import type { FactoryDeps } from "../core/runtime.ts";
import type { AiProvider } from "./types.ts";

export function createAiProvider(deps: FactoryDeps): AiProvider {
  const { mode, model } = deps.runtime.config.ai;
  const unavailable = { outcome: "unavailable", reason: mode === "disabled" ? "disabled" : "error" } as const;
  return {
    kind: mode,
    model,
    structured: () => Promise.resolve(unavailable),
    toolTurn: () => Promise.resolve(unavailable),
  };
}
