// SPDX-License-Identifier: MIT
/**
 * A1, the message-to-draft assistant (docs/paypal/SPEC.md §9.2, decision D-AI: Workers AI behind a provider interface).
 * The model only extracts; code parses the amount from the text the model copied, resolves dates, restores tokens and
 * fixes the payee to the session account. Owner: AI workstream.
 */
import type { BaseUnits, IsoDate, Locale } from "./common.ts";

/** Longest message the assistant accepts (E). */
export const DRAFT_MAX_TEXT = 4000;

/** Why a draft needs the payee's answer (E; rendered with fixed i18n text). */
export const CLARIFICATION_CODES = [
  "amount_missing",
  "amount_ambiguous",
  "several_amounts",
  "currency_not_usd",
  "due_date_unclear",
  "due_date_past",
  "due_date_too_far",
  "payee_address_ignored",
] as const;
export type ClarificationCode = (typeof CLARIFICATION_CODES)[number];

/** Why the assistant gave no draft: the manual form opens with a notice (docs/paypal/SPEC.md §3.2 "A1 draft"). */
export const ASSISTANT_UNAVAILABLE_REASONS = ["disabled", "resting", "refused", "timeout", "invalid_output", "error"] as const;
export type AssistantUnavailableReason = (typeof ASSISTANT_UNAVAILABLE_REASONS)[number];

export interface DraftRequest {
  readonly text: string;
  /** The interface language, written into the instructions; never inferred from the text. */
  readonly locale: Locale;
}

/** The draft as code made it from the model's extraction. */
export interface InvoiceDraft {
  /** USD in 6-decimal base units, parsed by code from `amountText`; null when the text gives no single USD amount. */
  readonly amountBase: BaseUnits | null;
  /** The amount exactly as the message wrote it (copied verbatim by the model, checked by code). */
  readonly amountText: string | null;
  readonly currency: "USD" | null;
  /** The memo, at most 280 bytes of UTF-8 (invoice spec). */
  readonly description: string;
  readonly clientName: string | null;
  /** Restored by code from the message's own email token; goes to PayPal only. */
  readonly clientEmail: string | null;
  readonly dueDate: IsoDate | null;
  readonly clientLanguage: Locale | null;
}

export type DraftResponse =
  | {
      readonly outcome: "draft";
      readonly draft: InvoiceDraft;
      readonly clarifications: readonly ClarificationCode[];
      readonly confidence: "high" | "medium" | "low";
      /** The model that answered, as the provider reports it (logs and evals record it too). */
      readonly model: string;
    }
  | { readonly outcome: "unavailable"; readonly reason: AssistantUnavailableReason };
