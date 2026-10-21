// SPDX-License-Identifier: MIT
/**
 * The Workers AI models of decision D-AI, chosen from Cloudflare's own documentation repository
 * (github.com/cloudflare/cloudflare-docs at 3fe915d, 2026-10-20; developers.cloudflare.com is unreachable from the build
 * machine): `src/content/workers-ai-models/*.json` (the model catalog), `src/content/docs/workers-ai/features/json-mode.mdx`,
 * `.../function-calling/index.mdx` and `.../platform/pricing.mdx`. Facts quoted there are C; what only a live call can
 * show is UNVERIFIED until the owner's first call through the deployed binding.
 *
 * Primary: `@cf/google/gemma-4-26b-a4b-it` (catalog, created 2026-04-02):
 * - `function_calling: true`; its input schema accepts `tools` (OpenAI function form), `tool_choice` (`none`, `auto`,
 *   `required`, or one named function) and `response_format` with `{ type: "json_schema", json_schema: { name, schema,
 *   strict } }`; output in the chat-completions shape (`choices[].message.tool_calls[].function.arguments` as a JSON
 *   string, `usage`); context window 256,000 tokens; reasoning on by default, switchable with
 *   `chat_template_kwargs.enable_thinking`; not marked `require_workers_paid`;
 * - price $0.100 per M input tokens and $0.300 per M output tokens = 9,091 and 27,273 neurons per M (pricing page);
 *   with 10,000 free neurons a day (pricing page), a 2,000-token prompt with a 500-token answer costs about 32 neurons,
 *   so about 300 calls a day stay free (E).
 * - UNVERIFIED: the JSON Mode page's list of supported models predates it and does not name it; that the schema is
 *   honoured, and the quality of French and Malagasy extraction, are measured by the AI workstream's evals.
 *
 * Fallback: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, the one model that both the JSON Mode page lists by name and the
 * catalog marks `function_calling: true`; 24,000-token context; $0.293 / $2.253 per M tokens (26,668 / 204,805 neurons).
 *
 * Not chosen: models marked `require_workers_paid` (DeepSeek V4, GLM 5.3, Kimi K2.6: the Free plan cannot call them),
 * models without `response_format` in their input schema (Mistral Small 3.1), and the reasoning-mandatory gpt-oss models,
 * whose input schema has no `tool_choice`.
 *
 * Owner: AI workstream. The choice above is the foundation step's (2026-10-21); change it only after evals, recording why here.
 */

export interface ModelFacts {
  readonly id: string;
  readonly contextWindow: number;
  /** Neurons per million tokens (pricing page). */
  readonly neuronsPerMillion: { readonly input: number; readonly output: number };
  readonly jsonSchema: "catalog" | "json-mode-page";
  readonly toolChoice: boolean;
}

export const PRIMARY_MODEL: ModelFacts = {
  id: "@cf/google/gemma-4-26b-a4b-it",
  contextWindow: 256_000,
  neuronsPerMillion: { input: 9_091, output: 27_273 },
  jsonSchema: "catalog",
  toolChoice: true,
};

export const FALLBACK_MODEL: ModelFacts = {
  id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  contextWindow: 24_000,
  neuronsPerMillion: { input: 26_668, output: 204_805 },
  jsonSchema: "json-mode-page",
  toolChoice: false,
};

/** Workers AI's free allocation per day (pricing page: "10,000 Neurons per day at no charge"). */
export const FREE_NEURONS_PER_DAY = 10_000;

/** Neurons a call costs, from its token usage and the model's rates (rounded up). */
export function neuronsFor(model: ModelFacts, inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * model.neuronsPerMillion.input + outputTokens * model.neuronsPerMillion.output) / 1_000_000);
}
