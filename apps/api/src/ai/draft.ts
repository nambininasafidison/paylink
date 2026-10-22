// SPDX-License-Identifier: MIT
/**
 * A1, a client's message to an invoice draft (docs/paypal/SPEC.md §9.2, §3.2 "A1 draft"). The model only extracts
 * text fields; code does the rest:
 *
 * 1. the message is cleaned (NFC, control characters) and its personal data replaced by placeholders (src/ai/pii.ts);
 * 2. one structured call with fixed instructions (src/ai/prompts.ts) and the message as the only user content (AI-7);
 * 3. the answer is checked against the schema; any failure (refused, cut off, timed out, out of shape, resting) is the
 *    manual path: `{ outcome: "unavailable", reason }`, and the web edition opens the empty form with a notice (U6);
 * 4. the amount is parsed by code from the text the model copied, and only when the copy is in the message
 *    (src/ai/amounts.ts); the due date is resolved by code from the phrase the model copied (src/ai/dates.ts) (AI-5);
 * 5. the client's email is mapped back by code from its placeholder; names must be written in the message; the
 *    description loses placeholders, any email, phone or address written out, links and control characters, and is
 *    cut to 280 bytes (the memo limit);
 * 6. a `0x` address in the message is never the payee (there is no payee field at all: the payee is the session's
 *    account) and raises `payee_address_ignored`;
 * 7. the clarifications are code's own; the model's list is not trusted.
 *
 * Owner: AI workstream.
 */
import type { ClarificationCode, DraftRequest, DraftResponse, InvoiceDraft, Locale } from "@paylink/api-contract";
import { CLARIFICATION_CODES } from "@paylink/api-contract";
import * as z from "zod";
import type { Logger } from "../core/log.ts";
import { decideAmount } from "./amounts.ts";
import { antananarivoToday, decideDueDate } from "./dates.ts";
import { restore, tokenise, withoutPlaceholders } from "./pii.ts";
import { draftInstructions } from "./prompts.ts";
import type { AiFailure, AiProvider, JsonSchema, StructuredRequest } from "./types.ts";

/** Memo limit of the invoice spec (bytes of UTF-8; the SDK's `MAX_MEMO_BYTES`). */
export const MEMO_MAX_BYTES = 280;
export const NAME_MAX = 140;
/** Output budget of one draft (tokens; the schema's answer is under 200 tokens). */
export const DRAFT_MAX_OUTPUT_TOKENS = 600;
export const DRAFT_SCHEMA_NAME = "invoice_draft";

const nullable = (schema: Readonly<Record<string, unknown>>): JsonSchema => ({ anyOf: [schema, { type: "null" }] });

/** The answer's JSON schema (strict: every property required, nothing else allowed). */
export const DRAFT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount_text", "currency_text", "description", "client_name", "client_email_token", "due_text", "due_date_iso", "client_language", "clarifications", "confidence"],
  properties: {
    amount_text: nullable({ type: "string", maxLength: 64 }),
    currency_text: nullable({ type: "string", maxLength: 16 }),
    description: { type: "string", maxLength: 280 },
    client_name: nullable({ type: "string", maxLength: NAME_MAX }),
    client_email_token: nullable({ type: "string", pattern: "^\\[EMAIL_[0-9]{1,2}\\]$" }),
    due_text: nullable({ type: "string", maxLength: 80 }),
    due_date_iso: nullable({ type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
    client_language: nullable({ type: "string", enum: ["en", "fr", "mg"] }),
    clarifications: { type: "array", items: { type: "string", enum: [...CLARIFICATION_CODES] }, maxItems: 8 },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

/** What code accepts from the model: the schema's shape, lenient only on absent keys (read as null). */
export const DraftAnswerSchema = z.object({
  amount_text: z.string().max(64).nullable().default(null),
  currency_text: z.string().max(16).nullable().default(null),
  description: z.string().max(1000).default(""),
  client_name: z.string().max(NAME_MAX).nullable().default(null),
  client_email_token: z.string().max(16).nullable().default(null),
  due_text: z.string().max(80).nullable().default(null),
  due_date_iso: z.string().max(10).nullable().default(null),
  client_language: z.enum(["en", "fr", "mg"]).nullable().default(null),
  clarifications: z.array(z.string().max(40)).max(16).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("low"),
});
export type DraftAnswer = z.output<typeof DraftAnswerSchema>;

// U+202A–U+202E and U+2066–U+2069 (bidirectional controls), other C0/C1 controls except tab and line feed.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;
const URL = /\b(?:https?:\/\/|www\.)\S+/giu;

/** The message as the model and code see it: NFC, controls removed, trimmed. */
export function cleanMessage(text: string): string {
  return text.normalize("NFC").replace(CONTROLS, "").trim();
}

/** Cuts a string to at most `max` bytes of UTF-8 without splitting a character. */
export function cutToBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) {
    return text;
  }
  let out = "";
  let size = 0;
  for (const char of text) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > max) {
      break;
    }
    out += char;
    size += bytes;
  }
  return out.trimEnd();
}

/**
 * The memo the model proposed, made safe: no placeholders, no personal data it may have written out (an email, a phone
 * number, a `0x` address: the memo travels in the link and its hash goes on chain), no links or controls, one line, at
 * most 280 bytes.
 */
export function cleanDescription(text: string): string {
  const plain = text.normalize("NFC").replace(CONTROLS, " ").replace(URL, " ");
  return cutToBytes(withoutPlaceholders(tokenise(withoutPlaceholders(plain)).text).replace(/\s+/gu, " ").replace(/\s+([,.;:!?])/gu, "$1").replace(/^[\s,.;:]+|[\s,;:]+$/gu, "").trim(), MEMO_MAX_BYTES);
}

const squashLower = (s: string): string => s.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();

/** A name is kept only if the message writes it (the model may not invent a client). */
export function cleanName(name: string | null, message: string): string | null {
  if (name === null) {
    return null;
  }
  const cleaned = withoutPlaceholders(tokenise(withoutPlaceholders(name.replace(CONTROLS, ""))).text).replace(/\s+/gu, " ").trim().slice(0, NAME_MAX);
  return cleaned !== "" && squashLower(message).includes(squashLower(cleaned)) ? cleaned : null;
}

/** The reason the web edition shows when the model gave no usable answer. */
export function unavailableReason(failure: AiFailure): Extract<DraftResponse, { outcome: "unavailable" }>["reason"] {
  switch (failure.outcome) {
    case "refused":
      return "refused";
    case "timeout":
      return "timeout";
    case "truncated":
    case "invalid-output":
      return "invalid_output";
    case "unavailable":
      return failure.reason === "budget" ? "resting" : failure.reason === "disabled" ? "disabled" : "error";
  }
}

export interface DraftDeps {
  readonly ai: AiProvider;
  readonly logger: Logger;
  /** Milliseconds since the epoch (today is taken in Antananarivo). */
  readonly now: number;
}

/** The structured request A1 sends for a message (exported for the evals and the cassettes). */
export function draftRequest(message: string, locale: Locale, now: number): { readonly request: StructuredRequest; readonly tokenised: ReturnType<typeof tokenise>; readonly cleaned: string } {
  const cleaned = cleanMessage(message);
  const tokenised = tokenise(cleaned);
  return {
    cleaned,
    tokenised,
    request: {
      system: draftInstructions(antananarivoToday(now), locale),
      user: tokenised.text,
      schemaName: DRAFT_SCHEMA_NAME,
      schema: DRAFT_SCHEMA,
      maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
      sampling: { temperature: 0, reasoning: false },
    },
  };
}

/** Code's half of A1: the draft from the model's answer and the message (steps 4–7 of the module comment). */
export function draftFromAnswer(answer: DraftAnswer, tokenised: ReturnType<typeof tokenise>, locale: Locale, now: number): { readonly draft: InvoiceDraft; readonly clarifications: readonly ClarificationCode[]; readonly confidence: "high" | "medium" | "low"; readonly notes: readonly string[] } {
  const today = antananarivoToday(now);
  const text = tokenised.text;
  const amount = decideAmount(text, answer.amount_text);
  const due = decideDueDate(text, answer.due_text, answer.due_date_iso, today, answer.client_language ?? locale);
  const clarifications = new Set<ClarificationCode>([...amount.clarifications, ...due.clarifications]);
  if (tokenised.counts.ADDRESS > 0) {
    clarifications.add("payee_address_ignored");
  }
  const ordered = CLARIFICATION_CODES.filter((c) => clarifications.has(c));
  const confidence = ordered.length === 0 ? answer.confidence : answer.confidence === "high" ? "medium" : answer.confidence;
  const notes = [`amount:${amount.basis}`, `due:${due.basis}`, ...(due.disagreed ? ["due:model-disagreed"] : [])];
  return {
    draft: {
      amountBase: amount.amountBase === null ? null : amount.amountBase.toString(),
      amountText: amount.amountText,
      currency: amount.currency,
      description: cleanDescription(answer.description),
      clientName: cleanName(answer.client_name, text),
      clientEmail: restore(tokenised, answer.client_email_token, "EMAIL"),
      dueDate: due.dueDate,
      clientLanguage: answer.client_language,
    },
    clarifications: ordered,
    confidence,
    notes,
  };
}

/** A1 end to end (module comment). Never throws for a model's failure: that is `unavailable`. */
export async function draftInvoice(deps: DraftDeps, input: DraftRequest): Promise<DraftResponse> {
  const { ai, logger, now } = deps;
  if (ai.kind === "disabled") {
    return { outcome: "unavailable", reason: "disabled" };
  }
  const { request, tokenised } = draftRequest(input.text, input.locale, now);
  const result = await ai.structured(request);
  if (result.outcome !== "ok") {
    logger.log("info", "a1.unavailable", { outcome: result.outcome });
    return { outcome: "unavailable", reason: unavailableReason(result) };
  }
  const parsed = DraftAnswerSchema.safeParse(result.value);
  if (!parsed.success) {
    logger.log("warn", "a1.invalid-answer", { issues: parsed.error.issues.length });
    return { outcome: "unavailable", reason: "invalid_output" };
  }
  const made = draftFromAnswer(parsed.data, tokenised, input.locale, now);
  logger.log("info", "a1.draft", { model: result.model, clarifications: [...made.clarifications], notes: [...made.notes], pii: [`email:${String(tokenised.counts.EMAIL)}`, `phone:${String(tokenised.counts.PHONE)}`, `address:${String(tokenised.counts.ADDRESS)}`] });
  return { outcome: "draft", draft: made.draft, clarifications: made.clarifications, confidence: made.confidence, model: result.model };
}
