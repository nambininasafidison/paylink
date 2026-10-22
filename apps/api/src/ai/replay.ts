// SPDX-License-Identifier: MIT
/**
 * Providers without a model, for tests, CI, the evals and the offline demo (docs/paypal/SPEC.md §15.2 L2):
 *
 * - `cassetteProvider`: answers from cassettes, found by the request's fingerprint (sha256 of its canonical JSON). A
 *   request no cassette holds answers `unavailable` / `disabled` (the manual path), or throws in strict mode.
 * - `scriptedProvider`: answers from a list, in order, and keeps every request it was asked (tests assert on them).
 * - `recordingProvider`: wraps a real provider and writes every exchange into a cassette (the owner's live evals).
 *
 * A cassette says where its answers come from: `recorded` from a live model (with the model and the date), or
 * `scripted` by hand to exercise code paths (never presented as a model's measured quality).
 *
 * Owner: AI workstream.
 */
import type { AiProvider, StructuredRequest, StructuredResult, ToolTurnRequest, ToolTurnResult } from "./types.ts";

export interface CassetteEntry {
  /**
   * The request's fingerprint. `match: "input"` entries (structured only) are found by the input alone (schema name
   * and user text), so a scripted answer survives a change of date in the instructions (the offline demo).
   */
  readonly fingerprint: string;
  readonly match?: "request" | "input";
  /** What was asked, for humans reading the cassette (the system prompt is left out: it is in the code). */
  readonly label?: string;
  readonly kind: "structured" | "toolTurn";
  readonly result: StructuredResult | ToolTurnResult;
}

export interface Cassette {
  readonly version: 1;
  readonly provenance: "recorded" | "scripted";
  /** The model of a recorded cassette; `scripted` otherwise. */
  readonly model: string;
  readonly recordedAt: string | null;
  readonly entries: readonly CassetteEntry[];
}

/** JSON with object keys sorted, so that equal requests have equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The fingerprint of a structured request: its instructions, input and schema (not its sampling settings). */
export async function structuredFingerprint(request: StructuredRequest): Promise<string> {
  return await sha256Hex(canonicalJson({ kind: "structured", system: request.system, user: request.user, schemaName: request.schemaName, schema: request.schema }));
}

/** The fingerprint of a structured request's input alone (`match: "input"` entries). */
export async function structuredInputFingerprint(request: Pick<StructuredRequest, "schemaName" | "user">): Promise<string> {
  return await sha256Hex(canonicalJson({ kind: "structured-input", schemaName: request.schemaName, user: request.user }));
}

/** The fingerprint of a tool turn: the conversation so far and the names of the tools offered. */
export async function toolTurnFingerprint(request: ToolTurnRequest): Promise<string> {
  return await sha256Hex(canonicalJson({ kind: "toolTurn", messages: request.messages, tools: request.tools.map((t) => t.name) }));
}

export interface CassetteProviderOptions {
  /** `unavailable`: a missing answer is the manual path (offline demo); `throw`: a test fails loudly. */
  readonly onMiss?: "unavailable" | "throw";
  readonly kind?: string;
  readonly model?: string;
}

export function cassetteProvider(cassettes: readonly Cassette[], options: CassetteProviderOptions = {}): AiProvider {
  const byFingerprint = new Map<string, CassetteEntry>();
  for (const cassette of cassettes) {
    for (const entry of cassette.entries) {
      byFingerprint.set(`${entry.kind}:${entry.match ?? "request"}:${entry.fingerprint}`, entry);
    }
  }
  const miss = (what: string): { readonly outcome: "unavailable"; readonly reason: "disabled" } => {
    if (options.onMiss === "throw") {
      throw new Error(`no cassette answers this ${what} request`);
    }
    return { outcome: "unavailable", reason: "disabled" };
  };
  return {
    kind: options.kind ?? "replay",
    model: options.model ?? cassettes[0]?.model ?? "replay",
    async structured(request) {
      const entry = byFingerprint.get(`structured:request:${await structuredFingerprint(request)}`) ?? byFingerprint.get(`structured:input:${await structuredInputFingerprint(request)}`);
      return entry === undefined ? miss("structured") : (entry.result as StructuredResult);
    },
    async toolTurn(request) {
      const entry = byFingerprint.get(`toolTurn:request:${await toolTurnFingerprint(request)}`);
      return entry === undefined ? miss("tool turn") : (entry.result as ToolTurnResult);
    },
  };
}

/** One scripted answer: a result, or a function of the request (a scripted model can read what it is sent). */
export type ScriptedAnswer<Req, Res> = Res | ((request: Req) => Res);

export interface ScriptedProvider extends AiProvider {
  readonly structuredRequests: StructuredRequest[];
  readonly toolTurnRequests: ToolTurnRequest[];
  /** Answers not used yet. */
  remaining(): number;
}

/**
 * Answers from `structured` and `toolTurn` lists, in order. When a list runs out the provider answers `unavailable` /
 * `error` (a test that expects more calls fails on its own assertions).
 */
export function scriptedProvider(script: { readonly structured?: readonly ScriptedAnswer<StructuredRequest, StructuredResult>[]; readonly toolTurn?: readonly ScriptedAnswer<ToolTurnRequest, ToolTurnResult>[] }, model = "scripted"): ScriptedProvider {
  const structuredAnswers = [...(script.structured ?? [])];
  const toolTurnAnswers = [...(script.toolTurn ?? [])];
  const structuredRequests: StructuredRequest[] = [];
  const toolTurnRequests: ToolTurnRequest[] = [];
  return {
    kind: "replay",
    model,
    structuredRequests,
    toolTurnRequests,
    remaining: () => structuredAnswers.length + toolTurnAnswers.length,
    structured(request) {
      structuredRequests.push(request);
      const next = structuredAnswers.shift();
      return Promise.resolve(next === undefined ? { outcome: "unavailable", reason: "error" } : typeof next === "function" ? next(request) : next);
    },
    toolTurn(request) {
      toolTurnRequests.push(request);
      const next = toolTurnAnswers.shift();
      return Promise.resolve(next === undefined ? { outcome: "unavailable", reason: "error" } : typeof next === "function" ? next(request) : next);
    },
  };
}

export interface RecordingProvider extends AiProvider {
  /** Everything recorded so far, as a cassette. */
  cassette(recordedAt: string): Cassette;
}

/** Wraps a live provider and records each exchange (the owner's live evals write the result next to the scoreboard). */
export function recordingProvider(inner: AiProvider, label: () => string = () => ""): RecordingProvider {
  const entries: CassetteEntry[] = [];
  return {
    kind: inner.kind,
    model: inner.model,
    async structured(request) {
      const result = await inner.structured(request);
      entries.push({ fingerprint: await structuredFingerprint(request), label: label(), kind: "structured", result });
      return result;
    },
    async toolTurn(request) {
      const result = await inner.toolTurn(request);
      entries.push({ fingerprint: await toolTurnFingerprint(request), label: label(), kind: "toolTurn", result });
      return result;
    },
    cassette: (recordedAt) => ({ version: 1, provenance: "recorded", model: inner.model, recordedAt, entries: [...entries] }),
  };
}
