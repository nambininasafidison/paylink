// SPDX-License-Identifier: MIT
/**
 * A2, the collections desk ("Check my invoices", docs/paypal/SPEC.md §9.2): the reconciler's sweep has read every open
 * twin again (P5 and the chain); then this agent runs once. It may read (src/ai/desk/tools.ts) and propose inside the
 * fence; it cannot do anything else:
 *
 * - it is given `services` by the sweep, but uses only `services.ai` (the model), `services.runtime` (clock, logger)
 *   and the quota counter: never the PayPal client, the chain reader, the approvals or the sessions (AI-1, AI-2;
 *   a static test reads this directory for such uses);
 * - every effect goes through `toolbox.propose`, the reconciler's fence (src/reconciler/desk.ts): a kind, a twin or a
 *   value outside it is refused there and logged `fence.reject`; what it queues waits for the payee's tap on exact
 *   values (AI-3), and the executor reads PayPal and the chain again before acting;
 * - every text the model writes is checked (src/ai/desk/grounding.ts): numbers from the tool data only, no links,
 *   contacts, addresses, threats or legal claims; a failing message is dropped and the proposal shows fixed text (AI-5);
 * - the conversation is append-only; tool results travel only in `tool` messages (AI-7);
 * - limits: 6 turns, 12 tool calls, 5 proposals, 800 output tokens a turn, 4 KiB of arguments a call (E);
 * - a refusal, a cut-off answer, a timeout or an answer out of shape ends the run: the desk keeps the reconciler's own
 *   proposals with fixed text (the manual path) and says the assistant was unavailable; a spent budget says "resting".
 *
 * Owner: AI workstream. Wired into the desk routes by `createDeskHandlers(deskAgent)` (src/routes/desk.ts).
 */
import type { DeskResponse, Locale } from "@paylink/api-contract";
import type { ApiServices } from "../../core/services.ts";
import { ProblemError } from "../../core/problem.ts";
import type { DeskAgent, DeskToolbox } from "../../reconciler/desk.ts";
import { chargeQuota } from "../../store/quotas.ts";
import { antananarivoToday } from "../dates.ts";
import { DESK_REQUEST, deskInstructions } from "../prompts.ts";
import type { AiMessage, AiToolCall } from "../types.ts";
import { checkMessage, groundSet } from "./grounding.ts";
import { chainView, DESK_TOOLS, findTwin, invoiceView, isDeskTool, paged, TOOL_ARGUMENTS } from "./tools.ts";
import type { DeskToolName } from "./tools.ts";

export interface DeskLimits {
  readonly turns: number;
  readonly toolCalls: number;
  readonly proposals: number;
  readonly maxOutputTokens: number;
  readonly argumentBytes: number;
}

export const DESK_LIMITS: DeskLimits = { turns: 6, toolCalls: 12, proposals: 5, maxOutputTokens: 800, argumentBytes: 4096 };

type Assistant = DeskResponse["assistant"];

const isLocale = (value: unknown): value is Locale => value === "en" || value === "fr" || value === "mg";

/** The payee's language, when the sweep passes one (a later field of the toolbox; English otherwise). */
function localeOf(toolbox: DeskToolbox): Locale {
  const value = (toolbox as unknown as Readonly<Record<string, unknown>>)["locale"];
  return isLocale(value) ? value : "en";
}

/** What one run did, for the log line and the tests. */
export interface DeskRunReport {
  readonly turns: number;
  readonly toolCalls: number;
  readonly proposed: number;
  readonly refusedByFence: number;
  readonly messagesDropped: number;
  readonly ending: "done" | "no-twins" | "turn-limit" | "tool-call-limit" | "resting" | "unavailable" | "refused" | "truncated" | "timeout" | "invalid-output";
}

interface RunState {
  readonly toolbox: DeskToolbox;
  readonly locale: Locale;
  readonly limits: DeskLimits;
  /** Everything the read tools returned in this run: the data numbers must come from. */
  ground: string;
  toolCalls: number;
  proposed: number;
  refusedByFence: number;
  messagesDropped: number;
}

const result = (value: unknown): string => JSON.stringify(value);

async function runTool(state: RunState, call: AiToolCall, log: ApiServices["runtime"]["logger"]): Promise<string> {
  if (!isDeskTool(call.name)) {
    log.log("warn", "a2.unknown-tool", { tool: /^[a-z_]{1,40}$/u.test(call.name) ? call.name : "invalid" });
    return result({ error: "unknown_tool", allowed: DESK_TOOLS.map((t) => t.name) });
  }
  if (new TextEncoder().encode(call.arguments).length > state.limits.argumentBytes) {
    return result({ error: "arguments_too_large" });
  }
  let raw: unknown;
  try {
    raw = call.arguments.trim() === "" ? {} : (JSON.parse(call.arguments) as unknown);
  } catch {
    return result({ error: "arguments_not_json" });
  }
  const name: DeskToolName = call.name;
  const { toolbox } = state;
  const read = (value: unknown): string => {
    const text = result(value);
    state.ground += `\n${text}`;
    return text;
  };
  switch (name) {
    case "list_invoices": {
      const args = TOOL_ARGUMENTS.list_invoices.safeParse(raw);
      return args.success ? read(paged(toolbox.twins.map(invoiceView), args.data)) : result({ error: "invalid_arguments" });
    }
    case "get_invoice": {
      const args = TOOL_ARGUMENTS.get_invoice.safeParse(raw);
      if (!args.success) {
        return result({ error: "invalid_arguments" });
      }
      const twin = findTwin(toolbox.twins, args.data.invoice_id);
      return twin === null ? result({ error: "not_found" }) : read(invoiceView(twin));
    }
    case "search_invoicing": {
      const args = TOOL_ARGUMENTS.search_invoicing.safeParse(raw);
      if (!args.success) {
        return result({ error: "invalid_arguments" });
      }
      const f = args.data.invoice_filters ?? {};
      const matches = toolbox.twins.filter(
        (t) => (f.status === undefined || (t.lastStatus !== null && f.status.includes(t.lastStatus))) && (f.invoice_number === undefined || t.invoiceNumber === f.invoice_number) && (f.reference === undefined || t.key === f.reference.toLowerCase()),
      );
      return read(paged(matches.map(invoiceView), args.data));
    }
    case "chain_invoice_state": {
      const args = TOOL_ARGUMENTS.chain_invoice_state.safeParse(raw);
      if (!args.success) {
        return result({ error: "invalid_arguments" });
      }
      const twin = findTwin(toolbox.twins, args.data.invoice_key);
      return twin === null ? result({ error: "not_found" }) : read(chainView(twin));
    }
    case "list_chain_payments": {
      const args = TOOL_ARGUMENTS.list_chain_payments.safeParse(raw);
      if (!args.success) {
        return result({ error: "invalid_arguments" });
      }
      const since = args.data.since;
      const payments = toolbox.twins
        .filter((t) => t.chainPayment !== null)
        .map(chainView)
        .filter((v) => since === undefined || ((v["payment"] as { paid_on: string } | null)?.paid_on ?? "") >= since);
      return read({ items: payments });
    }
    case "allowed_actions": {
      const args = TOOL_ARGUMENTS.allowed_actions.safeParse(raw);
      if (!args.success) {
        return result({ error: "invalid_arguments" });
      }
      const fence = await toolbox.allowedActions(args.data.invoice_key);
      return read({ invoice_key: args.data.invoice_key.toLowerCase(), actions: fence.map((a) => ({ kind: a.kind, proposable: a.actor !== "automatic", reason_code: a.reasonCode, values: a.args })) });
    }
    case "propose_action": {
      const args = TOOL_ARGUMENTS.propose_action.safeParse(raw);
      if (!args.success) {
        state.refusedByFence += 1;
        log.log("warn", "a2.propose-invalid", { issues: args.error.issues.length });
        return result({ status: "rejected", reason: "invalid_arguments" });
      }
      if (state.proposed >= state.limits.proposals) {
        return result({ status: "rejected", reason: "proposal_limit" });
      }
      let message: { readonly text: string; readonly language: Locale; readonly grounded: boolean } | undefined;
      if (args.data.message !== undefined) {
        const checked = checkMessage(args.data.message, groundSet(state.ground));
        if (!checked.grounded) {
          state.messagesDropped += 1;
          log.log("warn", "a2.message-dropped", { problems: [...checked.problems], ungrounded: [...checked.ungrounded].slice(0, 5) });
        }
        message = { text: checked.text, language: args.data.message_language ?? state.locale, grounded: checked.grounded };
      }
      const outcome = await toolbox.propose({ kind: args.data.kind, key: args.data.invoice_key, ...(args.data.args === undefined ? {} : { args: args.data.args }), ...(message === undefined ? {} : { message }) });
      if (outcome.outcome === "queued") {
        state.proposed += 1;
        return result({ status: "queued", proposal_id: outcome.id, message_kept: message?.grounded ?? false });
      }
      state.refusedByFence += 1;
      return result({ status: "rejected", reason: outcome.reason });
    }
  }
}

/** Runs the desk once (module comment), with `limits`; the report goes to the log and to `onReport`. */
export function createDeskAgent(options: { readonly limits?: DeskLimits; readonly onReport?: (report: DeskRunReport) => void } = {}): DeskAgent {
  const limits = options.limits ?? DESK_LIMITS;
  return async (services: ApiServices, toolbox: DeskToolbox, now: number): Promise<Assistant> => {
    const { ai } = services;
    const logger = services.runtime.logger;
    const finish = (report: Omit<DeskRunReport, "turns" | "toolCalls" | "proposed" | "refusedByFence" | "messagesDropped"> & Partial<DeskRunReport>, assistant: Assistant): Assistant => {
      const full: DeskRunReport = { turns: 0, toolCalls: 0, proposed: 0, refusedByFence: 0, messagesDropped: 0, ...report };
      logger.log(assistant.available ? "info" : "warn", "a2.run", { ending: full.ending, turns: full.turns, toolCalls: full.toolCalls, proposed: full.proposed, refusedByFence: full.refusedByFence, dropped: full.messagesDropped });
      options.onReport?.(full);
      return assistant;
    };
    if (ai.kind === "disabled") {
      return { available: false, reason: "disabled" };
    }
    if (toolbox.twins.length === 0) {
      return finish({ ending: "no-twins" }, { available: true, reason: null });
    }
    try {
      await chargeQuota(services, toolbox.payee, "aiCalls", now);
    } catch (error) {
      if (error instanceof ProblemError && error.problem.code === "quota-exhausted") {
        return finish({ ending: "resting" }, { available: false, reason: "resting" });
      }
      throw error;
    }
    const locale = localeOf(toolbox);
    const state: RunState = { toolbox, locale, limits, ground: "", toolCalls: 0, proposed: 0, refusedByFence: 0, messagesDropped: 0 };
    const messages: AiMessage[] = [
      { role: "system", content: deskInstructions(antananarivoToday(now), locale, limits) },
      { role: "user", content: DESK_REQUEST },
    ];
    const counts = (): Pick<DeskRunReport, "toolCalls" | "proposed" | "refusedByFence" | "messagesDropped"> => ({ toolCalls: state.toolCalls, proposed: state.proposed, refusedByFence: state.refusedByFence, messagesDropped: state.messagesDropped });
    for (let turn = 1; turn <= limits.turns; turn += 1) {
      const answer = await ai.toolTurn({ messages: [...messages], tools: DESK_TOOLS, maxOutputTokens: limits.maxOutputTokens, sampling: { temperature: 0, reasoning: false } });
      if (answer.outcome !== "ok") {
        if (answer.outcome === "unavailable") {
          return finish({ ending: answer.reason === "budget" ? "resting" : "unavailable", turns: turn, ...counts() }, { available: false, reason: answer.reason === "budget" ? "resting" : answer.reason === "disabled" ? "disabled" : "error" });
        }
        return finish({ ending: answer.outcome, turns: turn, ...counts() }, { available: false, reason: "error" });
      }
      if (answer.text !== null) {
        // Shown nowhere, checked anyway: a model that writes ungrounded numbers is logged (AI-5 on every message).
        const checked = checkMessage(answer.text, groundSet(state.ground));
        if (!checked.grounded) {
          logger.log("info", "a2.summary-ungrounded", { problems: [...checked.problems] });
        }
      }
      if (answer.toolCalls.length === 0) {
        return finish({ ending: "done", turns: turn, ...counts() }, { available: true, reason: null });
      }
      messages.push({ role: "assistant", content: answer.text, toolCalls: answer.toolCalls });
      let overLimit = false;
      for (const call of answer.toolCalls) {
        state.toolCalls += 1;
        let content: string;
        if (state.toolCalls > limits.toolCalls) {
          overLimit = true;
          content = result({ error: "tool_call_limit" });
        } else {
          content = await runTool(state, call, logger);
        }
        messages.push({ role: "tool", toolCallId: call.id, content });
      }
      if (overLimit) {
        return finish({ ending: "tool-call-limit", turns: turn, ...counts() }, { available: true, reason: null });
      }
    }
    return finish({ ending: "turn-limit", turns: limits.turns, ...counts() }, { available: true, reason: null });
  };
}

/** The desk agent of the deployed API. */
export const deskAgent: DeskAgent = createDeskAgent();
