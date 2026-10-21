// SPDX-License-Identifier: MIT
/**
 * The AI provider interface (decision D-AI): Workers AI through the Worker's `AI` binding today, swappable for another
 * provider later without touching A1 or A2. Two calls are enough for the product:
 *
 * - `structured`: one request whose answer must match a JSON schema (A1, message to draft). Workers AI's
 *   `response_format: { type: "json_schema", json_schema }` where the model supports it (Cloudflare docs, JSON Mode).
 * - `toolTurn`: one turn of a tool-using conversation (A2, the desk). The provider returns either text or tool calls;
 *   the caller executes read tools and `propose_action` itself, appends the results and calls again (≤ 6 turns, ≤ 12
 *   tool calls, E). The provider never executes anything.
 *
 * Invariants this interface keeps (docs/paypal/SPEC.md §9.3): the model cannot sign or submit (AI-1: nothing here holds
 * a key or a client), cannot move money (AI-2: tools are the caller's allowlist), numbers come from code (AI-5), and
 * untrusted text travels only in `user` or `tool` messages, never in `system` (AI-7). Every outcome that is not a
 * usable answer (`refused`, `timeout`, `invalid-output`, `unavailable`) sends the payee to the manual path.
 *
 * Owner: AI workstream (interface, Workers AI provider, replay provider, A1, A2, evals). Other workstreams ask for
 * changes through a handoff (docs/paypal/SPEC.md "Ownership").
 */

/** A JSON Schema object (draft 2020-12 subset the providers accept). */
export type JsonSchema = Readonly<Record<string, unknown>>;

export type AiMessage =
  | { readonly role: "system"; readonly content: string }
  /** Untrusted text (pasted messages, memos, PayPal notes) goes here or in `tool`, never in `system` (AI-7). */
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly toolCalls?: readonly AiToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export interface AiTool {
  /** The PayPal Agent Toolkit's name where one exists (`get_invoice`, `search_invoicing`, `list_invoices`). */
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  /** The arguments as the model wrote them: untrusted JSON text, parsed and validated by the caller. */
  readonly arguments: string;
}

/** Tokens and the provider's own cost unit (Workers AI: neurons), for quotas, the daily ceiling and the cost meter. */
export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Estimated from the model's per-token neuron rates (Cloudflare pricing page); null when unknown. */
  readonly neurons: number | null;
}

/** Every provider answer carries the model that actually answered (a fallback may have). */
interface Answered {
  readonly model: string;
  readonly usage: AiUsage;
  readonly latencyMs: number;
}

export type AiFailure =
  | { readonly outcome: "refused" }
  | { readonly outcome: "timeout" }
  /** The answer did not parse or match the schema (Workers AI: "JSON Mode couldn't be met"). */
  | { readonly outcome: "invalid-output" }
  /** No provider, quota or budget exhausted, provider error: the assistant is resting. */
  | { readonly outcome: "unavailable"; readonly reason: "disabled" | "budget" | "rate-limited" | "error" };

export interface StructuredRequest {
  /** Fixed instructions (no user text). */
  readonly system: string;
  /** The untrusted input, already tokenised (emails, phones and 0x addresses replaced by placeholders). */
  readonly user: string;
  readonly schemaName: string;
  readonly schema: JsonSchema;
  readonly maxOutputTokens: number;
}

export type StructuredResult = (Answered & { readonly outcome: "ok"; readonly value: unknown }) | AiFailure;

export interface ToolTurnRequest {
  /** The whole conversation so far, append-only. */
  readonly messages: readonly AiMessage[];
  /** The allowlist of tools for this turn: read tools and `propose_action` only (AI-2, snapshot-tested). */
  readonly tools: readonly AiTool[];
  readonly maxOutputTokens: number;
}

export type ToolTurnResult =
  | (Answered & { readonly outcome: "ok"; readonly text: string | null; readonly toolCalls: readonly AiToolCall[]; readonly finish: "stop" | "tool_calls" | "length" })
  | AiFailure;

export interface AiProvider {
  /** `workers-ai`, `replay` or `disabled`. */
  readonly kind: string;
  /** The primary model id. */
  readonly model: string;
  structured(request: StructuredRequest): Promise<StructuredResult>;
  toolTurn(request: ToolTurnRequest): Promise<ToolTurnResult>;
}
