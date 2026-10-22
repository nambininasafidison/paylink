// SPDX-License-Identifier: MIT
/**
 * The Workers AI models of decision D-AI, chosen from Cloudflare's own documentation repository
 * (github.com/cloudflare/cloudflare-docs at 3fe915d, 2026-10-20; developers.cloudflare.com is unreachable from the build
 * machine). Files read, all under `src/content/`: `workers-ai-models/gemma-4-26b-a4b-it.json` and
 * `workers-ai-models/llama-3.3-70b-instruct-fp8-fast.json` (the catalog entries: properties, input and output schemas),
 * `docs/workers-ai/features/json-mode.mdx`, `docs/workers-ai/features/function-calling/index.mdx`,
 * `docs/workers-ai/features/reject-if-busy.mdx`, `docs/workers-ai/configuration/bindings.mdx`,
 * `docs/workers-ai/get-started/workers-wrangler.mdx`, `docs/workers-ai/platform/pricing.mdx`,
 * `docs/workers-ai/platform/errors.mdx` and `docs/workers-ai/platform/data-usage.mdx`. What only a live call can show
 * is UNVERIFIED until the owner's first call through the deployed binding (apps/api/evals/README.md).
 *
 * Primary: `@cf/google/gemma-4-26b-a4b-it` (catalog entry created 2026-04-02, not deprecated):
 * - properties `function_calling: true`, `context_window: 256000`, `reasoning` with `default_enabled: true` and
 *   `mandatory: false`; no `require_workers_paid` property;
 * - its input schema accepts `messages` (roles system, user, assistant with `tool_calls`, tool with `tool_call_id`),
 *   `tools` (`{ type: "function", function: { name, description, parameters, strict } }`), `tool_choice` (`none`,
 *   `auto`, `required`, or one named function), `response_format` `{ type: "json_schema", json_schema: { name, schema,
 *   strict } }`, `max_completion_tokens`, `temperature` (0 to 2), `seed` and `chat_template_kwargs.enable_thinking`;
 * - its output schema is the chat-completions shape: `choices[].message.{content, refusal, tool_calls[].function.
 *   {name, arguments}}`, `finish_reason` in `stop | length | tool_calls | content_filter | function_call`, and an
 *   optional `usage` (`prompt_tokens`, `completion_tokens`); the get-started page's sample answer has no `usage`;
 * - price $0.100 per M input tokens and $0.300 per M output tokens = 9,091 and 27,273 neurons per M (pricing page).
 *   With 10,000 free neurons a day, a 1,500-token prompt with a 400-token answer costs about 25 neurons (E).
 * - UNVERIFIED: the JSON Mode page's list of supported models predates it and does not name it; that the schema is
 *   honoured, the quality of French and Malagasy extraction, and the presence of `usage` are measured by the evals.
 *
 * Fallback: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, listed by name on the JSON Mode page and `function_calling:
 * true` in its catalog entry; 24,000-token context; $0.293 / $2.253 per M tokens (26,668 / 204,805 neurons). Its input
 * schema is the older Workers AI form: messages carry only `role` and `content` (no `tool_calls`, no `tool_call_id`),
 * `response_format` is `{ type: "json_schema", json_schema: <the schema itself> }` as on the JSON Mode page, the limit
 * is `max_tokens` (default 256), and the output is `{ response, tool_calls: [{ name, arguments }], usage }`.
 *
 * Not chosen: models marked `require_workers_paid` (the Free plan cannot call them: error 5035), models without
 * `response_format` in their input schema, and reasoning-mandatory models.
 *
 * Every call passes `{ rejectIfBusy: true }` as the binding's third argument (reject-if-busy page): a busy model answers
 * 429 / 3040 at once instead of queueing, and the fallback is tried.
 *
 * Owner: AI workstream. The choice above is the foundation step's (2026-10-21), re-read by the AI workstream on
 * 2026-10-22; change it only after evals, recording why here.
 */

/** How the model's input and output are shaped (see the module comment). */
export type ModelDialect = "chat-completions" | "legacy";

export interface ModelFacts {
  readonly id: string;
  readonly dialect: ModelDialect;
  readonly contextWindow: number;
  /** Neurons per million tokens (pricing page). */
  readonly neuronsPerMillion: { readonly input: number; readonly output: number };
  /** Where JSON schema output is documented for this model: its catalog entry, or the JSON Mode page's list. */
  readonly jsonSchema: "catalog" | "json-mode-page";
  readonly toolChoice: boolean;
  /** The model reasons by default and the reasoning can be switched off (`chat_template_kwargs.enable_thinking`). */
  readonly reasoningSwitch: boolean;
}

export const PRIMARY_MODEL: ModelFacts = {
  id: "@cf/google/gemma-4-26b-a4b-it",
  dialect: "chat-completions",
  contextWindow: 256_000,
  neuronsPerMillion: { input: 9_091, output: 27_273 },
  jsonSchema: "catalog",
  toolChoice: true,
  reasoningSwitch: true,
};

export const FALLBACK_MODEL: ModelFacts = {
  id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  dialect: "legacy",
  contextWindow: 24_000,
  neuronsPerMillion: { input: 26_668, output: 204_805 },
  jsonSchema: "json-mode-page",
  toolChoice: false,
  reasoningSwitch: false,
};

/** The models this API knows the facts of. */
export const KNOWN_MODELS: readonly ModelFacts[] = [PRIMARY_MODEL, FALLBACK_MODEL];

/** Workers AI's free allocation per day (pricing page: "10,000 Neurons per day at no charge"). */
export const FREE_NEURONS_PER_DAY = 10_000;

/**
 * The facts of a configured model id. An id this module does not know is called in the chat-completions dialect and
 * costed at the highest known rates, so the daily ceiling errs on the side of resting.
 */
export function modelFacts(id: string): ModelFacts {
  const known = KNOWN_MODELS.find((m) => m.id === id);
  if (known !== undefined) {
    return known;
  }
  const input = Math.max(...KNOWN_MODELS.map((m) => m.neuronsPerMillion.input));
  const output = Math.max(...KNOWN_MODELS.map((m) => m.neuronsPerMillion.output));
  return { id, dialect: "chat-completions", contextWindow: 8_000, neuronsPerMillion: { input, output }, jsonSchema: "catalog", toolChoice: false, reasoningSwitch: false };
}

/** Neurons a call costs, from its token usage and the model's rates (rounded up). */
export function neuronsFor(model: ModelFacts, inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * model.neuronsPerMillion.input + outputTokens * model.neuronsPerMillion.output) / 1_000_000);
}

/**
 * Tokens of a text when the provider reports none (E): one token per three characters, rounded up. Deliberately high
 * for English (about four characters a token) so that estimates over-count neurons rather than under-count them.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
