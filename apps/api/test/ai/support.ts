// SPDX-License-Identifier: MIT
/**
 * Helpers of the AI workstream's tests: scripted model turns that read what they are sent, and a desk world (the
 * reconciler's world of test/reconciler/world.ts, with twins in chosen situations and the desk agent wired into the
 * desk routes as src/routes/desk.ts would wire it).
 */
import type { DeskResponse, DeskSweepResponse, InvoiceKey } from "@paylink/api-contract";
import { createDeskAgent } from "../../src/ai/desk/agent.ts";
import type { DeskRunReport } from "../../src/ai/desk/agent.ts";
import { scriptedProvider } from "../../src/ai/replay.ts";
import type { ScriptedAnswer, ScriptedProvider } from "../../src/ai/replay.ts";
import type { AiProvider, ToolTurnRequest, ToolTurnResult } from "../../src/ai/types.ts";
import type { ApiServices } from "../../src/core/services.ts";
import { registerTwin } from "../../src/reconciler/engine.ts";
import { sweep } from "../../src/reconciler/desk.ts";
import { DAY, KEY, OTHER_KEY, PAYEE } from "../reconciler/fixtures.ts";
import { world } from "../reconciler/world.ts";
import type { World } from "../reconciler/world.ts";

export { DAY, KEY, OTHER_KEY, PAYEE };

const usage = { inputTokens: 2000, outputTokens: 150, neurons: 23, estimated: false } as const;

/** A model turn that calls tools. */
export function calls(...list: readonly (readonly [string, unknown])[]): ToolTurnResult {
  return {
    outcome: "ok",
    model: "@cf/google/gemma-4-26b-a4b-it",
    usage,
    latencyMs: 900,
    text: null,
    finish: "tool_calls",
    toolCalls: list.map(([name, args], i) => ({ id: `call_${String(i)}_${name}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args) })),
  };
}

/** A model turn that ends the run with text. */
export function says(text: string): ToolTurnResult {
  return { outcome: "ok", model: "@cf/google/gemma-4-26b-a4b-it", usage, latencyMs: 700, text, finish: "stop", toolCalls: [] };
}

/** The parsed results of the tool calls of the latest turn, by tool-call id order. */
export function lastResults(request: ToolTurnRequest): unknown[] {
  const out: unknown[] = [];
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const m = request.messages[i];
    if (m?.role !== "tool") {
      break;
    }
    out.unshift(JSON.parse(m.content) as unknown);
  }
  return out;
}

/** The `i`-th element, or a failed test. */
export function nth<T>(list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) {
    throw new Error(`no element ${String(i)}`);
  }
  return value;
}

/** Every tool result of the conversation so far, parsed. */
export function allResults(request: ToolTurnRequest): unknown[] {
  return request.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content) as unknown);
}

export interface DeskWorld {
  readonly w: World;
  readonly reports: DeskRunReport[];
  /** Runs "Check my invoices" with this model. */
  run(ai: AiProvider): Promise<DeskSweepResponse>;
  /** A scripted model from turns. */
  model(turns: readonly ScriptedAnswer<ToolTurnRequest, ToolTurnResult>[]): ScriptedProvider;
}

export const B_KEY: InvoiceKey = `0x${"ef".repeat(32)}`;

/**
 * Two twins of the payee: KEY open on both rails (S1: share the reminder text; PayPal's reminder once due), and B_KEY
 * cancelled on the chain (S7: cancel the PayPal invoice). `options.overdue` moves the clock past KEY's due date.
 */
export async function deskWorld(options: { readonly overdue?: boolean } = {}): Promise<DeskWorld> {
  const w = world();
  w.paypal.add("INV2-A", KEY);
  w.paypal.add("INV2-B", B_KEY);
  await registerTwin(w.services, w.twin(KEY, "INV2-A"), w.clock.now);
  await registerTwin(w.services, w.twin(B_KEY, "INV2-B", { dueDate: null }), w.clock.now);
  w.cancelOnChain(B_KEY);
  if (options.overdue === true) {
    w.advance(17 * DAY);
  }
  const reports: DeskRunReport[] = [];
  return {
    w,
    reports,
    run: async (ai) => {
      const services: ApiServices = { ...w.services, ai };
      return await sweep(services, PAYEE, w.clock.now, createDeskAgent({ onReport: (r) => reports.push(r) }));
    },
    model: (turns) => scriptedProvider({ toolTurn: turns }),
  };
}

/** The proposals of a desk, as `[kind, key, origin, message text or null]`. */
export function proposals(desk: DeskResponse): [string, string, string, string | null][] {
  return desk.proposals.filter((p) => p.state === "open").map((p) => [p.kind, p.key, p.origin, p.message?.text ?? null]);
}
