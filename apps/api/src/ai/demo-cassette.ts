// SPDX-License-Identifier: MIT
/**
 * The offline demo's answers (`pnpm --filter @paylink/api dev:offline`, docs/paypal/SPEC.md §15.2 "Run without
 * keys"): three sample client messages, one per language, each with a hand-written model answer. They are **scripted**,
 * not recorded: they show what code does with an answer (amount parsed from the copied text, date resolved by code,
 * clarifications), never a model's quality. Any other message gets no answer offline, and the manual form opens.
 *
 * Entries match the input alone (`match: "input"`), so they hold on any day: the dates are code's, resolved from the
 * copied phrase against today. `label` is the exact message; test/ai/cassettes.test.ts recomputes each fingerprint.
 *
 * Owner: AI workstream.
 */
import type { Cassette } from "./replay.ts";

const usage = { inputTokens: 0, outputTokens: 0, neurons: 0, estimated: false } as const;

export const DEMO_MESSAGES = {
  en: "Love it! Send me the invoice, $120, I'll pay by Friday. - Sarah",
  fr: "Super travail ! Envoie-moi la facture : 120 $ pour le logo, je paie avant le 30. Merci, Sarah",
  mg: "Misaotra betsaka! Alefaso ny faktiora: $80 ho an'ny fandikan-teny, handoa aho rahampitso. - Rado",
} as const;

export const DEMO_CASSETTE: Cassette = {
  version: 1,
  provenance: "scripted",
  model: "scripted",
  recordedAt: null,
  entries: [
    {
      fingerprint: "6417fa346c982291d118781b8c0288d8d3a981e78c23a79a19d4c24e9c222422",
      match: "input",
      label: DEMO_MESSAGES.en,
      kind: "structured",
      result: {
        outcome: "ok",
        model: "scripted",
        usage,
        latencyMs: 0,
        value: { amount_text: "$120", currency_text: "$", description: "Logo design", client_name: "Sarah", client_email_token: null, due_text: "by Friday", due_date_iso: null, client_language: "en", clarifications: [], confidence: "high" },
      },
    },
    {
      fingerprint: "88b33c84462f9bc5c839d231993dbddf2052d4a815aca478744d4a0f3d9118a3",
      match: "input",
      label: DEMO_MESSAGES.fr,
      kind: "structured",
      result: {
        outcome: "ok",
        model: "scripted",
        usage,
        latencyMs: 0,
        value: { amount_text: "120 $", currency_text: "$", description: "Création du logo", client_name: "Sarah", client_email_token: null, due_text: "avant le 30", due_date_iso: null, client_language: "fr", clarifications: [], confidence: "high" },
      },
    },
    {
      fingerprint: "0e4637f673e805c9834d2cc156d396fc5afa3d73b5d8d24af0780f4767e05145",
      match: "input",
      label: DEMO_MESSAGES.mg,
      kind: "structured",
      result: {
        outcome: "ok",
        model: "scripted",
        usage,
        latencyMs: 0,
        value: { amount_text: "$80", currency_text: "$", description: "Fandikan-teny", client_name: "Rado", client_email_token: null, due_text: "rahampitso", due_date_iso: null, client_language: "mg", clarifications: [], confidence: "high" },
      },
    },
  ],
};
