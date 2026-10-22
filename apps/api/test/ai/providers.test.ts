// SPDX-License-Identifier: MIT
/**
 * The providers (L2): the Workers AI provider against a scripted binding in both dialects of src/ai/models.ts (request
 * shapes from the catalog entries, answers, every failure of the error table), the fallback, the daily neuron ceiling
 * ("Assistant resting") and the cost log line, the cassette and scripted providers, and the factory's modes.
 */
import { describe, expect, it } from "vitest";
import { assistantBudget, estimateNeurons, withBudget, withFallback } from "../../src/ai/budget.ts";
import { createAiProvider } from "../../src/ai/factory.ts";
import { FALLBACK_MODEL, modelFacts, neuronsFor, PRIMARY_MODEL } from "../../src/ai/models.ts";
import { cassetteProvider, recordingProvider, scriptedProvider, structuredFingerprint, toolTurnFingerprint } from "../../src/ai/replay.ts";
import type { AiProvider, StructuredRequest, ToolTurnRequest } from "../../src/ai/types.ts";
import { failureOfError, RUN_OPTIONS, structuredInputs, toolTurnInputs, workersAiProvider } from "../../src/ai/workers-ai.ts";
import type { AiBinding } from "../../src/core/runtime.ts";
import { createMemoryStores } from "../../src/store/memory.ts";
import { T0, testRuntime } from "../helpers.ts";

const STRUCTURED: StructuredRequest = { system: "Extract.", user: "Logo, $120", schemaName: "invoice_draft", schema: { type: "object" }, maxOutputTokens: 600, sampling: { temperature: 0, reasoning: false } };
const TURN: ToolTurnRequest = {
  messages: [
    { role: "system", content: "Desk." },
    { role: "user", content: "Check my invoices" },
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "list_invoices", arguments: "{}" }] },
    { role: "tool", toolCallId: "c1", content: '{"items":[]}' },
  ],
  tools: [{ name: "list_invoices", description: "List.", parameters: { type: "object", properties: {} } }],
  maxOutputTokens: 800,
  sampling: { temperature: 0, reasoning: false },
};

interface Call {
  readonly model: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly options: unknown;
}

function binding(answers: readonly unknown[]): AiBinding & { readonly calls: Call[] } {
  const queue = [...answers];
  const calls: Call[] = [];
  return {
    calls,
    run(model, inputs, options) {
      calls.push({ model, inputs, options });
      const next = queue.shift();
      if (next === "hang") {
        return new Promise(() => undefined);
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const chat = (message: Readonly<Record<string, unknown>>, finish = "stop", usage: unknown = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }) => ({
  id: "x",
  object: "chat.completion",
  created: 0,
  model: PRIMARY_MODEL.id,
  choices: [{ index: 0, message: { role: "assistant", refusal: null, ...message }, finish_reason: finish, logprobs: null }],
  ...(usage === null ? {} : { usage }),
});

const provider = (b: AiBinding, model = PRIMARY_MODEL, timeoutMs = 1000) => workersAiProvider({ binding: b, model, timeoutMs, clock: () => T0 });

describe("Workers AI provider: requests in the model's dialect", () => {
  it("chat-completions (the primary model): json_schema with name and strict, max_completion_tokens, reasoning switch", () => {
    expect(structuredInputs(PRIMARY_MODEL, STRUCTURED)).toEqual({
      messages: [
        { role: "system", content: "Extract." },
        { role: "user", content: "Logo, $120" },
      ],
      response_format: { type: "json_schema", json_schema: { name: "invoice_draft", schema: { type: "object" }, strict: true } },
      max_completion_tokens: 600,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    const turn = toolTurnInputs(PRIMARY_MODEL, TURN);
    expect(turn["tool_choice"]).toBe("auto");
    expect(turn["tools"]).toEqual([{ type: "function", function: { name: "list_invoices", description: "List.", parameters: { type: "object", properties: {} }, strict: true } }]);
    expect(turn["messages"]).toEqual([
      { role: "system", content: "Desk." },
      { role: "user", content: "Check my invoices" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_invoices", arguments: "{}" } }] },
      { role: "tool", content: '{"items":[]}', tool_call_id: "c1" },
    ]);
  });

  it("legacy (the fallback model): the JSON Mode page's json_schema, max_tokens, calls written as text", () => {
    expect(structuredInputs(FALLBACK_MODEL, STRUCTURED)).toEqual({
      messages: [
        { role: "system", content: "Extract." },
        { role: "user", content: "Logo, $120" },
      ],
      response_format: { type: "json_schema", json_schema: { type: "object" } },
      max_tokens: 600,
      temperature: 0,
    });
    const turn = toolTurnInputs(FALLBACK_MODEL, TURN);
    const messages = turn["messages"] as { role: string; content: string }[];
    expect(messages.every((m) => Object.keys(m).sort().join() === "content,role")).toBe(true);
    expect(JSON.parse(messages[2]?.content ?? "")).toEqual({ tool_calls: [{ id: "c1", name: "list_invoices", arguments: "{}" }] });
    expect(JSON.parse(messages[3]?.content ?? "")).toEqual({ tool_call_id: "c1", result: '{"items":[]}' });
    expect(turn).not.toHaveProperty("tool_choice");
  });

  it("passes rejectIfBusy as the binding's third argument, never in the inputs", async () => {
    const b = binding([chat({ content: '{"a":1}' })]);
    await provider(b).structured(STRUCTURED);
    expect(b.calls[0]?.options).toEqual(RUN_OPTIONS);
    expect(b.calls[0]?.inputs).not.toHaveProperty("rejectIfBusy");
    expect(b.calls[0]?.model).toBe("@cf/google/gemma-4-26b-a4b-it");
  });
});

describe("Workers AI provider: answers", () => {
  it("parses a JSON answer (with or without a code fence) and costs it from usage", async () => {
    const b = binding([chat({ content: '{"amount_text":"$120"}' }), chat({ content: '```json\n{"x":2}\n```' })]);
    const p = provider(b);
    const first = await p.structured(STRUCTURED);
    expect(first).toMatchObject({ outcome: "ok", value: { amount_text: "$120" }, model: PRIMARY_MODEL.id, usage: { inputTokens: 1000, outputTokens: 100, neurons: neuronsFor(PRIMARY_MODEL, 1000, 100), estimated: false } });
    expect(await p.structured(STRUCTURED)).toMatchObject({ outcome: "ok", value: { x: 2 } });
  });

  it("estimates usage when the answer has none (the get-started sample has no usage)", async () => {
    const result = await provider(binding([chat({ content: "{}" }, "stop", null)])).structured(STRUCTURED);
    expect(result).toMatchObject({ outcome: "ok", usage: { estimated: true } });
    expect(result.outcome === "ok" && (result.usage.neurons ?? 0) > 0).toBe(true);
  });

  it("legacy answers: response as text or as an object, tool calls with object arguments", async () => {
    const b = binding([{ response: '{"a":1}', usage: { prompt_tokens: 10, completion_tokens: 5 } }, { response: { a: 2 } }, { response: "", tool_calls: [{ name: "list_invoices", arguments: { page: 1 } }] }]);
    const p = provider(b, FALLBACK_MODEL);
    expect(await p.structured(STRUCTURED)).toMatchObject({ outcome: "ok", value: { a: 1 }, model: FALLBACK_MODEL.id });
    expect(await p.structured(STRUCTURED)).toMatchObject({ outcome: "ok", value: { a: 2 } });
    expect(await p.toolTurn(TURN)).toMatchObject({ outcome: "ok", finish: "tool_calls", toolCalls: [{ id: "call_0", name: "list_invoices", arguments: '{"page":1}' }] });
  });

  it("tool calls in the chat dialect keep the model's ids and argument text", async () => {
    const answer = chat({ content: null, tool_calls: [{ id: "abc", type: "function", function: { name: "get_invoice", arguments: '{"invoice_id":"INV2-1"}' } }] }, "tool_calls");
    expect(await provider(binding([answer])).toolTurn(TURN)).toMatchObject({ outcome: "ok", text: null, finish: "tool_calls", toolCalls: [{ id: "abc", name: "get_invoice", arguments: '{"invoice_id":"INV2-1"}' }] });
  });

  it("maps refusals, filters, cut-offs, malformed answers and thrown errors (module table)", async () => {
    const cases: [unknown, string][] = [
      [chat({ content: null, refusal: "I can't help with that." }), "refused"],
      [chat({ content: "{}" }, "content_filter"), "refused"],
      [chat({ content: '{"a":' }, "length"), "truncated"],
      [chat({ content: "not json" }), "invalid-output"],
      [chat({ content: "[1,2]" }), "invalid-output"],
      [{ choices: [] }, "invalid-output"],
      ["a string", "invalid-output"],
      [new Error("3036: You have used up your daily free allocation of 10,000 neurons."), "unavailable:budget"],
      [new Error("AiError: 3040: Capacity temporarily exceeded, please try again."), "unavailable:rate-limited"],
      [new Error("3007: Request timeout"), "timeout"],
      [new Error("JSON Mode couldn't be met"), "invalid-output"],
      [new Error("5035: This model requires a Workers Paid plan."), "unavailable:error"],
      [new Error("network down"), "unavailable:error"],
    ];
    for (const [answer, expected] of cases) {
      const result = await provider(binding([answer])).structured(STRUCTURED);
      expect(result.outcome === "unavailable" ? `unavailable:${result.reason}` : result.outcome, expected).toBe(expected);
    }
    expect(failureOfError("plain")).toEqual({ outcome: "unavailable", reason: "error" });
  });

  it("times out after timeoutMs, without waiting for the binding", async () => {
    expect(await provider(binding(["hang"]), PRIMARY_MODEL, 20).structured(STRUCTURED)).toEqual({ outcome: "timeout" });
  });

  it("a legacy answer at the output limit is a cut-off", async () => {
    const result = await provider(binding([{ response: '{"a":1}', usage: { prompt_tokens: 10, completion_tokens: 600 } }]), FALLBACK_MODEL).structured(STRUCTURED);
    expect(result).toEqual({ outcome: "truncated" });
  });
});

describe("fallback and budget", () => {
  const ok = { outcome: "ok", value: {}, model: "m", usage: { inputTokens: 100, outputTokens: 10, neurons: 7, estimated: false }, latencyMs: 1 } as const;

  it("tries the fallback once after a failure worth retrying, never after a refusal or a spent budget", async () => {
    for (const [first, retried] of [
      [{ outcome: "timeout" }, true],
      [{ outcome: "invalid-output" }, true],
      [{ outcome: "truncated" }, true],
      [{ outcome: "unavailable", reason: "rate-limited" }, true],
      [{ outcome: "unavailable", reason: "error" }, true],
      [{ outcome: "refused" }, false],
      [{ outcome: "unavailable", reason: "budget" }, false],
    ] as const) {
      const fallback = scriptedProvider({ structured: [ok] });
      const result = await withFallback(scriptedProvider({ structured: [first] }), fallback).structured(STRUCTURED);
      expect(fallback.structuredRequests.length, first.outcome).toBe(retried ? 1 : 0);
      expect(result.outcome).toBe(retried ? "ok" : first.outcome);
    }
  });

  it("rests when the day's ceiling has no room for the call, counts what each call cost, and logs no text", async () => {
    const lines: string[] = [];
    const runtime = testRuntime({ lines });
    const stores = createMemoryStores();
    const estimate = estimateNeurons(PRIMARY_MODEL, STRUCTURED.system + STRUCTURED.user + JSON.stringify(STRUCTURED.schema), STRUCTURED.maxOutputTokens);
    const inner = scriptedProvider({ structured: [ok, ok, ok] });
    const ceiling = estimate + 7;
    const metered = withBudget(inner, { global: () => stores.global(), ceiling, clock: () => T0, logger: runtime.logger, model: PRIMARY_MODEL });
    expect(await metered.structured(STRUCTURED)).toMatchObject({ outcome: "ok" });
    // 7 neurons spent: room for exactly one more estimated call.
    expect(await metered.structured(STRUCTURED)).toMatchObject({ outcome: "ok" });
    expect(await metered.structured(STRUCTURED)).toEqual({ outcome: "unavailable", reason: "budget" });
    expect(inner.structuredRequests).toHaveLength(2);
    expect(lines.filter((l) => l.includes('"ai.call"'))).toHaveLength(2);
    expect(lines.some((l) => l.includes('"ai.resting"'))).toBe(true);
    expect(lines.join("\n")).not.toContain("Logo, $120");
    // The next UTC day starts empty.
    const tomorrow = withBudget(scriptedProvider({ structured: [ok] }), { global: () => stores.global(), ceiling, clock: () => T0 + 86_400_000, logger: runtime.logger, model: PRIMARY_MODEL });
    expect((await tomorrow.structured(STRUCTURED)).outcome).toBe("ok");
  });

  it("Cloudflare's own 'daily free allocation' answer rests the assistant for the rest of the day", async () => {
    const stores = createMemoryStores();
    const inner = scriptedProvider({ structured: [{ outcome: "unavailable", reason: "budget" }, ok] });
    const metered = withBudget(inner, { global: () => stores.global(), ceiling: 10_000, clock: () => T0, logger: testRuntime().logger, model: PRIMARY_MODEL });
    expect(await metered.structured(STRUCTURED)).toEqual({ outcome: "unavailable", reason: "budget" });
    expect(await metered.structured(STRUCTURED)).toEqual({ outcome: "unavailable", reason: "budget" });
    expect(inner.structuredRequests).toHaveLength(1);
  });

  it("the day's budget is readable without spending it (the Status row)", async () => {
    const stores = createMemoryStores();
    expect(await assistantBudget(stores.global(), 10_000, T0)).toEqual({ day: "2026-10-21", spent: 0, left: 10_000, resting: false });
    await stores.global().spendAiBudget("2026-10-21", 9_980, 10_000);
    expect(await assistantBudget(stores.global(), 10_000, T0)).toEqual({ day: "2026-10-21", spent: 9_980, left: 20, resting: true });
    expect((await assistantBudget(stores.global(), 10_000, T0)).spent).toBe(9_980);
  });

  it("a call that would cross the ceiling fills it, so the next one rests", async () => {
    const stores = createMemoryStores();
    const big = { ...ok, usage: { ...ok.usage, neurons: 1_000_000 } };
    const metered = withBudget(scriptedProvider({ structured: [big, ok] }), { global: () => stores.global(), ceiling: 10_000, clock: () => T0, logger: testRuntime().logger, model: PRIMARY_MODEL });
    expect((await metered.structured(STRUCTURED)).outcome).toBe("ok");
    expect(await metered.structured(STRUCTURED)).toEqual({ outcome: "unavailable", reason: "budget" });
  });
});

describe("cassettes", () => {
  it("answers by fingerprint, misses as the manual path (or throws in strict mode), and records live exchanges", async () => {
    const answer = { outcome: "ok", value: { a: 1 }, model: "m", usage: { inputTokens: 1, outputTokens: 1, neurons: 1, estimated: false }, latencyMs: 1 } as const;
    const recorder = recordingProvider(scriptedProvider({ structured: [answer], toolTurn: [{ outcome: "refused" }] }), () => "case-1");
    await recorder.structured(STRUCTURED);
    await recorder.toolTurn(TURN);
    const cassette = recorder.cassette("2026-10-22T00:00:00.000Z");
    expect(cassette).toMatchObject({ provenance: "recorded", entries: [{ kind: "structured", label: "case-1", fingerprint: await structuredFingerprint(STRUCTURED) }, { kind: "toolTurn", fingerprint: await toolTurnFingerprint(TURN) }] });
    const replay = cassetteProvider([cassette]);
    expect(await replay.structured(STRUCTURED)).toEqual(answer);
    expect(await replay.toolTurn(TURN)).toEqual({ outcome: "refused" });
    expect(await replay.structured({ ...STRUCTURED, user: "other" })).toEqual({ outcome: "unavailable", reason: "disabled" });
    await expect(cassetteProvider([cassette], { onMiss: "throw" }).structured({ ...STRUCTURED, user: "other" })).rejects.toThrow(/no cassette/u);
    // Sampling settings are not part of the fingerprint; the system prompt is.
    expect(await structuredFingerprint({ ...STRUCTURED, sampling: { temperature: 1, reasoning: true } })).toBe(await structuredFingerprint(STRUCTURED));
    expect(await structuredFingerprint({ ...STRUCTURED, system: "Other." })).not.toBe(await structuredFingerprint(STRUCTURED));
  });
});

describe("factory", () => {
  it("disabled, replay (offline), and workers-ai with and without a binding", async () => {
    const stores = createMemoryStores();
    const base = testRuntime();
    const make = (mode: "disabled" | "replay" | "workers-ai", ai: AiBinding | null): AiProvider => createAiProvider({ runtime: { ...base, ai, config: { ...base.config, ai: { ...base.config.ai, mode } } }, stores });
    expect(await make("disabled", null).structured(STRUCTURED)).toEqual({ outcome: "unavailable", reason: "disabled" });
    expect(make("replay", null).kind).toBe("replay");
    expect(await make("workers-ai", null).structured(STRUCTURED)).toEqual({ outcome: "unavailable", reason: "error" });
    // Primary busy, fallback answers: the answer names the fallback model.
    const b = binding([new Error("3040: Capacity temporarily exceeded"), { response: { ok: true }, usage: { prompt_tokens: 5, completion_tokens: 5 } }]);
    const result = await make("workers-ai", b).structured(STRUCTURED);
    expect(result).toMatchObject({ outcome: "ok", model: FALLBACK_MODEL.id, value: { ok: true } });
    expect(b.calls.map((c) => c.model)).toEqual([PRIMARY_MODEL.id, FALLBACK_MODEL.id]);
  });

  it("an unknown model id is costed at the highest known rates", () => {
    const facts = modelFacts("@cf/unknown/model");
    expect(facts.neuronsPerMillion).toEqual({ input: FALLBACK_MODEL.neuronsPerMillion.input, output: FALLBACK_MODEL.neuronsPerMillion.output });
    expect(modelFacts(PRIMARY_MODEL.id)).toBe(PRIMARY_MODEL);
  });
});
