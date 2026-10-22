// SPDX-License-Identifier: MIT
/**
 * The Workers AI provider: one model called through the Worker's `AI` binding (`env.AI.run(model, inputs, options)`,
 * Cloudflare docs `configuration/bindings.mdx`), in the dialect its catalog entry documents (src/ai/models.ts).
 *
 * What it does, and nothing more: build the request, wait at most `timeoutMs`, and turn the answer into the provider
 * interface's outcome. It executes no tool, holds no key and keeps no state between calls.
 *
 * | Answer | Outcome |
 * |---|---|
 * | JSON matching nothing we sent (no choices, no response) | `invalid-output` |
 * | `message.refusal` set, or `finish_reason: content_filter` | `refused` |
 * | `finish_reason: length` (or, in the legacy dialect, output tokens at the limit) | `truncated` |
 * | Thrown error with 3036 ("daily free allocation") | `unavailable` / `budget` |
 * | Thrown error with 3040 ("Capacity temporarily exceeded") | `unavailable` / `rate-limited` |
 * | Thrown error with 3007 or 3008 (timeout, aborted), or no answer within `timeoutMs` | `timeout` |
 * | Thrown error "JSON Mode couldn't be met" | `invalid-output` |
 * | Any other error (5035 "requires a Workers Paid plan", 5007 "no such model", …) | `unavailable` / `error` |
 *
 * The codes and messages are those of `platform/errors.mdx`, `features/json-mode.mdx` and `features/reject-if-busy.mdx`.
 * How the binding surfaces them (an `Error` whose message contains the code or the text) is UNVERIFIED until the
 * owner's first live call; matching either the code or the text covers both likely forms.
 *
 * Owner: AI workstream.
 */
import type { AiBinding } from "../core/runtime.ts";
import type { ModelFacts } from "./models.ts";
import { estimateTokens, neuronsFor } from "./models.ts";
import type { AiFailure, AiMessage, AiProvider, AiTool, AiToolCall, AiUsage, StructuredRequest, StructuredResult, ToolTurnRequest, ToolTurnResult } from "./types.ts";

export interface WorkersAiOptions {
  readonly binding: AiBinding;
  readonly model: ModelFacts;
  readonly timeoutMs: number;
  readonly clock: () => number;
}

/** The binding's third argument on every call (features/reject-if-busy.mdx). */
export const RUN_OPTIONS = { rejectIfBusy: true } as const;

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The failure an error thrown by the binding stands for (module table). */
export function failureOfError(error: unknown): AiFailure {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/\b3036\b|daily free allocation/iu.test(text)) {
    return { outcome: "unavailable", reason: "budget" };
  }
  if (/\b3040\b|capacity temporarily exceeded/iu.test(text)) {
    return { outcome: "unavailable", reason: "rate-limited" };
  }
  if (/\b300[78]\b|timed? ?out|aborted/iu.test(text)) {
    return { outcome: "timeout" };
  }
  if (/json mode couldn'?t be met/iu.test(text)) {
    return { outcome: "invalid-output" };
  }
  return { outcome: "unavailable", reason: "error" };
}

const TIMEOUT = Symbol("timeout");

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMEOUT);
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------------------------------ requests

function chatMessages(messages: readonly AiMessage[]): Json[] {
  return messages.map((m): Json => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls === undefined || m.toolCalls.length === 0 ? {} : { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }),
        };
      case "tool":
        return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
  });
}

/** The legacy dialect has no `tool_calls` or `tool_call_id`: a call is written as JSON text, as in the docs' example. */
function legacyMessages(messages: readonly AiMessage[]): Json[] {
  return messages.map((m): Json => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.toolCalls === undefined || m.toolCalls.length === 0 ? (m.content ?? "") : JSON.stringify({ tool_calls: m.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) }),
        };
      case "tool":
        return { role: "tool", content: JSON.stringify({ tool_call_id: m.toolCallId, result: m.content }) };
    }
  });
}

const functionTools = (tools: readonly AiTool[], strict: boolean): Json[] =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters, ...(strict ? { strict: true } : {}) } }));

/** The request body of a structured call, in the model's dialect. */
export function structuredInputs(model: ModelFacts, request: StructuredRequest): Json {
  const messages = [
    { role: "system", content: request.system },
    { role: "user", content: request.user },
  ];
  if (model.dialect === "legacy") {
    return { messages, response_format: { type: "json_schema", json_schema: request.schema }, max_tokens: request.maxOutputTokens, temperature: request.sampling.temperature };
  }
  return {
    messages,
    response_format: { type: "json_schema", json_schema: { name: request.schemaName, schema: request.schema, strict: true } },
    max_completion_tokens: request.maxOutputTokens,
    temperature: request.sampling.temperature,
    ...(model.reasoningSwitch ? { chat_template_kwargs: { enable_thinking: request.sampling.reasoning } } : {}),
  };
}

/** The request body of a tool turn, in the model's dialect. */
export function toolTurnInputs(model: ModelFacts, request: ToolTurnRequest): Json {
  if (model.dialect === "legacy") {
    return { messages: legacyMessages(request.messages), tools: functionTools(request.tools, false), max_tokens: request.maxOutputTokens, temperature: request.sampling.temperature };
  }
  return {
    messages: chatMessages(request.messages),
    tools: functionTools(request.tools, true),
    tool_choice: "auto",
    max_completion_tokens: request.maxOutputTokens,
    temperature: request.sampling.temperature,
    ...(model.reasoningSwitch ? { chat_template_kwargs: { enable_thinking: request.sampling.reasoning } } : {}),
  };
}

// ------------------------------------------------------------------------------------------ answers

/** One answer, reduced to what both dialects can say. */
interface Reduced {
  readonly content: unknown;
  readonly refusal: string | null;
  readonly toolCalls: readonly AiToolCall[];
  readonly finish: string | null;
  readonly usage: { readonly input: number; readonly output: number } | null;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

function usageOf(raw: unknown): Reduced["usage"] {
  if (!isRecord(raw)) {
    return null;
  }
  const input = count(raw["prompt_tokens"]);
  const output = count(raw["completion_tokens"]);
  return input === null || output === null ? null : { input, output };
}

function reduceChat(answer: Json): Reduced | null {
  const choices = answer["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const choice: unknown = choices[0];
  if (!isRecord(choice) || !isRecord(choice["message"])) {
    return null;
  }
  const message = choice["message"];
  const calls = Array.isArray(message["tool_calls"]) ? (message["tool_calls"] as unknown[]) : [];
  const toolCalls: AiToolCall[] = [];
  for (const [i, call] of calls.entries()) {
    if (!isRecord(call) || !isRecord(call["function"]) || typeof call["function"]["name"] !== "string") {
      return null;
    }
    const args = call["function"]["arguments"];
    toolCalls.push({ id: typeof call["id"] === "string" && call["id"] !== "" ? call["id"] : `call_${String(i)}`, name: call["function"]["name"], arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) });
  }
  const refusal = message["refusal"];
  return { content: message["content"] ?? null, refusal: typeof refusal === "string" && refusal.trim() !== "" ? refusal : null, toolCalls, finish: typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : null, usage: usageOf(answer["usage"]) };
}

function reduceLegacy(answer: Json): Reduced | null {
  if (!("response" in answer) && !Array.isArray(answer["tool_calls"])) {
    return null;
  }
  const calls = Array.isArray(answer["tool_calls"]) ? (answer["tool_calls"] as unknown[]) : [];
  const toolCalls: AiToolCall[] = [];
  for (const [i, call] of calls.entries()) {
    if (!isRecord(call) || typeof call["name"] !== "string") {
      return null;
    }
    const args = call["arguments"];
    toolCalls.push({ id: `call_${String(i)}`, name: call["name"], arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) });
  }
  return { content: answer["response"] ?? null, refusal: null, toolCalls, finish: null, usage: usageOf(answer["usage"]) };
}

/** Strips one Markdown code fence around a JSON answer (some models add one even in JSON mode). */
function unfence(text: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/u.exec(text);
  return match?.[1] ?? text;
}

export function workersAiProvider(options: WorkersAiOptions): AiProvider {
  const { binding, model, timeoutMs, clock } = options;

  const usage = (reduced: Reduced, sent: Json): AiUsage => {
    if (reduced.usage !== null) {
      return { inputTokens: reduced.usage.input, outputTokens: reduced.usage.output, neurons: neuronsFor(model, reduced.usage.input, reduced.usage.output), estimated: false };
    }
    const input = estimateTokens(JSON.stringify(sent));
    const output = estimateTokens(JSON.stringify({ c: reduced.content, t: reduced.toolCalls }));
    return { inputTokens: input, outputTokens: output, neurons: neuronsFor(model, input, output), estimated: true };
  };

  /** Runs one request; a failure, or the reduced answer with the time it took. */
  const run = async (inputs: Json): Promise<AiFailure | { readonly reduced: Reduced; readonly latencyMs: number }> => {
    const started = clock();
    let answer: unknown;
    try {
      const outcome = await withTimeout(binding.run(model.id, inputs, RUN_OPTIONS), timeoutMs);
      if (outcome === TIMEOUT) {
        return { outcome: "timeout" };
      }
      answer = outcome;
    } catch (error) {
      return failureOfError(error);
    }
    if (!isRecord(answer)) {
      return { outcome: "invalid-output" };
    }
    const reduced = model.dialect === "legacy" ? reduceLegacy(answer) : reduceChat(answer);
    if (reduced === null) {
      return { outcome: "invalid-output" };
    }
    if (reduced.refusal !== null || reduced.finish === "content_filter") {
      return { outcome: "refused" };
    }
    return { reduced, latencyMs: Math.max(0, clock() - started) };
  };

  const truncated = (reduced: Reduced, maxOutputTokens: number): boolean => reduced.finish === "length" || (model.dialect === "legacy" && reduced.usage !== null && reduced.usage.output >= maxOutputTokens);

  return {
    kind: "workers-ai",
    model: model.id,

    async structured(request: StructuredRequest): Promise<StructuredResult> {
      const inputs = structuredInputs(model, request);
      const done = await run(inputs);
      if ("outcome" in done) {
        return done;
      }
      const { reduced, latencyMs } = done;
      if (truncated(reduced, request.maxOutputTokens)) {
        return { outcome: "truncated" };
      }
      let value: unknown = reduced.content;
      if (typeof value === "string") {
        try {
          value = JSON.parse(unfence(value)) as unknown;
        } catch {
          return { outcome: "invalid-output" };
        }
      }
      if (!isRecord(value)) {
        return { outcome: "invalid-output" };
      }
      return { outcome: "ok", value, model: model.id, usage: usage(reduced, inputs), latencyMs };
    },

    async toolTurn(request: ToolTurnRequest): Promise<ToolTurnResult> {
      const inputs = toolTurnInputs(model, request);
      const done = await run(inputs);
      if ("outcome" in done) {
        return done;
      }
      const { reduced, latencyMs } = done;
      if (truncated(reduced, request.maxOutputTokens)) {
        return { outcome: "truncated" };
      }
      if (reduced.content !== null && typeof reduced.content !== "string") {
        return { outcome: "invalid-output" };
      }
      const text = typeof reduced.content === "string" && reduced.content.trim() !== "" ? reduced.content : null;
      return { outcome: "ok", text, toolCalls: reduced.toolCalls, finish: reduced.toolCalls.length > 0 ? "tool_calls" : "stop", model: model.id, usage: usage(reduced, inputs), latencyMs };
    },
  };
}
