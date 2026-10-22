// SPDX-License-Identifier: MIT
/**
 * A1 end to end (L2): the request it sends (fixed instructions, tokenised message, strict schema), the draft code makes
 * from an answer, every manual-path outcome, the route with its quotas, and the offline demo's cassette.
 */
import type { ApiProblem, DraftResponse } from "@paylink/api-contract";
import { describe, expect, it } from "vitest";
import { DEMO_CASSETTE, DEMO_MESSAGES } from "../../src/ai/demo-cassette.ts";
import { cleanDescription, cleanName, cutToBytes, draftInvoice, draftRequest, DRAFT_SCHEMA, DRAFT_SCHEMA_NAME } from "../../src/ai/draft.ts";
import { createAiProvider } from "../../src/ai/factory.ts";
import { cleanMessage } from "../../src/ai/draft.ts";
import { tokenise } from "../../src/ai/pii.ts";
import { scriptedProvider, structuredInputFingerprint } from "../../src/ai/replay.ts";
import type { AiProvider, StructuredResult } from "../../src/ai/types.ts";
import { createApp } from "../../src/core/app.ts";
import { silentLogger } from "../../src/core/log.ts";
import type { ApiServices } from "../../src/core/services.ts";
import { aiHandlers } from "../../src/routes/ai.ts";
import { createMemoryStores } from "../../src/store/memory.ts";
import { T0, testRuntime, testServices } from "../helpers.ts";

const PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

export const answer = (value: Readonly<Record<string, unknown>>): StructuredResult => ({
  outcome: "ok",
  model: "@cf/google/gemma-4-26b-a4b-it",
  usage: { inputTokens: 900, outputTokens: 120, neurons: 12, estimated: false },
  latencyMs: 800,
  value: { amount_text: null, currency_text: null, description: "", client_name: null, client_email_token: null, due_text: null, due_date_iso: null, client_language: null, clarifications: [], confidence: "high", ...value },
});

const draft = async (ai: AiProvider, text: string, locale: "en" | "fr" | "mg" = "en"): Promise<DraftResponse> => await draftInvoice({ ai, logger: silentLogger, now: T0 }, { text, locale });

describe("A1 request", () => {
  it("sends fixed instructions, the tokenised message as the only user content, and the strict schema", async () => {
    const ai = scriptedProvider({ structured: [answer({})] });
    await draft(ai, "Logo for sarah@example.com, call +261 34 12 345 67, $120 by Friday");
    const [request] = ai.structuredRequests;
    expect(request?.user).toBe("Logo for [EMAIL_1], call [PHONE_1], $120 by Friday");
    expect(request?.system).not.toContain("sarah");
    expect(request?.system).toContain("Today is Wednesday 2026-10-21");
    expect(request?.schemaName).toBe(DRAFT_SCHEMA_NAME);
    expect(request?.sampling).toEqual({ temperature: 0, reasoning: false });
    expect(DRAFT_SCHEMA).toMatchObject({ additionalProperties: false });
    expect((DRAFT_SCHEMA["required"] as string[]).sort()).toEqual(Object.keys(DRAFT_SCHEMA["properties"] as object).sort());
  });
});

describe("A1 draft", () => {
  it("the story's message: $120 parsed by code, Friday resolved by code, the name kept because it is written", async () => {
    const ai = scriptedProvider({ structured: [answer({ amount_text: "$120", currency_text: "$", description: "Logo design", client_name: "Sarah", due_text: "by Friday", due_date_iso: "2026-11-06", client_language: "en" })] });
    expect(await draft(ai, "Love it! Send me the invoice, $120, I'll pay by Friday. - Sarah")).toEqual({
      outcome: "draft",
      draft: { amountBase: "120000000", amountText: "$120", currency: "USD", description: "Logo design", clientName: "Sarah", clientEmail: null, dueDate: "2026-10-23", clientLanguage: "en" },
      clarifications: [],
      confidence: "high",
      model: "@cf/google/gemma-4-26b-a4b-it",
    });
  });

  it("maps the client's email back from its placeholder, and only from one the message had", async () => {
    const text = "Invoice $50 to tom@example.org please";
    expect(await draft(scriptedProvider({ structured: [answer({ amount_text: "$50", client_email_token: "[EMAIL_1]" })] }), text)).toMatchObject({ draft: { clientEmail: "tom@example.org" } });
    expect(await draft(scriptedProvider({ structured: [answer({ amount_text: "$50", client_email_token: "[EMAIL_2]" })] }), text)).toMatchObject({ draft: { clientEmail: null } });
  });

  it("never takes an invented amount, name or date; flags a wallet address; lowers confidence with each question", async () => {
    const ai = scriptedProvider({ structured: [answer({ amount_text: "$1,200", client_name: "Mr Smith", due_text: "next month", due_date_iso: "2026-11-21", description: "Logo, see https://evil.example [PHONE_1]" })] });
    const out = await draft(ai, "Logo $120. Pay to 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 by Friday");
    expect(out).toMatchObject({ outcome: "draft", draft: { amountBase: null, clientName: null, dueDate: null, description: "Logo, see" }, clarifications: ["amount_ambiguous", "due_date_unclear", "payee_address_ignored"], confidence: "medium" });
  });

  it("refuses non-USD amounts without converting them", async () => {
    const ai = scriptedProvider({ structured: [answer({ amount_text: "150 000 Ar", currency_text: "Ar" })] });
    expect(await draft(ai, "Logo 150 000 Ar, aloa rahampitso", "mg")).toMatchObject({ draft: { amountBase: null, currency: null }, clarifications: ["currency_not_usd"] });
  });

  it("every way the model fails is the manual path with its reason", async () => {
    const cases: [StructuredResult | Readonly<Record<string, unknown>>, string][] = [
      [{ outcome: "refused" }, "refused"],
      [{ outcome: "truncated" }, "invalid_output"],
      [{ outcome: "timeout" }, "timeout"],
      [{ outcome: "invalid-output" }, "invalid_output"],
      [{ outcome: "unavailable", reason: "budget" }, "resting"],
      [{ outcome: "unavailable", reason: "rate-limited" }, "error"],
      [{ outcome: "unavailable", reason: "error" }, "error"],
      [{ outcome: "unavailable", reason: "disabled" }, "disabled"],
      [{ ...answer({}), value: { amount_text: 120 } }, "invalid_output"],
      [{ ...answer({}), value: { confidence: "certain" } }, "invalid_output"],
    ];
    for (const [result, reason] of cases) {
      expect(await draft(scriptedProvider({ structured: [result as StructuredResult] }), "Logo $120"), reason).toEqual({ outcome: "unavailable", reason });
    }
  });

  it("cleans what the model writes", () => {
    expect(cleanDescription("Logo\u202Edesign for [EMAIL_1] www.x.io")).toBe("Logo design for");
    expect(new TextEncoder().encode(cleanDescription("é".repeat(400))).length).toBeLessThanOrEqual(280);
    expect(cutToBytes("aé", 2)).toBe("a");
    expect(cleanName("SARAH", "thanks, sarah")).toBe("SARAH");
    expect(cleanName("[EMAIL_1]", "[EMAIL_1]")).toBeNull();
  });
});

describe("POST /v1/ai/draft", () => {
  function app(ai: AiProvider, quotas?: { aiCallsPerDay: number }): { app: ReturnType<typeof createApp>; services: ApiServices } {
    const base = testServices();
    const config = quotas === undefined ? base.runtime.config : { ...base.runtime.config, quotas: { ...base.runtime.config.quotas, ...quotas } };
    const services: ApiServices = {
      ...base,
      runtime: { ...base.runtime, config },
      ai,
      sessions: { ...base.sessions, check: (token) => Promise.resolve(token === "payee" ? { ok: true as const, payee: PAYEE, expiresAt: T0 + 1 } : { ok: false as const, reason: "bad-mac" as const }) },
    };
    return { app: createApp(services, [aiHandlers]), services };
  }
  const post = (body: unknown, token = "payee") => ({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it("answers a draft; 400 on a bad body; 401 without a session", async () => {
    const { app: a } = app(scriptedProvider({ structured: [answer({ amount_text: "$120" })] }));
    const ok = await a.request("/v1/ai/draft", post({ text: "Logo $120", locale: "en" }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as DraftResponse).outcome).toBe("draft");
    expect((await a.request("/v1/ai/draft", post({ text: "", locale: "en" }))).status).toBe(400);
    expect((await a.request("/v1/ai/draft", post({ text: "x", locale: "de" }))).status).toBe(400);
    expect((await a.request("/v1/ai/draft", post({ text: "x", locale: "en", payee: "0x1" }))).status).toBe(400);
    expect((await a.request("/v1/ai/draft", post({ text: "x".repeat(4001), locale: "en" }))).status).toBe(400);
    const anonymous = await a.request("/v1/ai/draft", post({ text: "Logo", locale: "en" }, "nope"));
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as ApiProblem).code).toBe("unauthorized");
  });

  it("rests once the payee's daily assistant quota is used, without calling the model", async () => {
    const ai = scriptedProvider({ structured: [answer({ amount_text: "$1" }), answer({ amount_text: "$1" })] });
    const { app: a } = app(ai, { aiCallsPerDay: 1 });
    expect(((await (await a.request("/v1/ai/draft", post({ text: "Logo $1", locale: "en" }))).json()) as DraftResponse).outcome).toBe("draft");
    expect((await (await a.request("/v1/ai/draft", post({ text: "Logo $1", locale: "en" }))).json()) as DraftResponse).toEqual({ outcome: "unavailable", reason: "resting" });
    expect(ai.structuredRequests).toHaveLength(1);
  });

  it("a disabled assistant answers disabled and charges nothing", async () => {
    const disabled: AiProvider = { kind: "disabled", model: "none", structured: () => Promise.reject(new Error("never")), toolTurn: () => Promise.reject(new Error("never")) };
    const { app: a } = app(disabled);
    expect(await (await a.request("/v1/ai/draft", post({ text: "Logo", locale: "en" }))).json()).toEqual({ outcome: "unavailable", reason: "disabled" });
  });
});

describe("offline demo cassette", () => {
  it("each entry's fingerprint is its message's, and the replay mode drafts the three samples", async () => {
    for (const entry of DEMO_CASSETTE.entries) {
      const user = tokenise(cleanMessage(entry.label ?? "")).text;
      expect(entry.fingerprint).toBe(await structuredInputFingerprint({ schemaName: DRAFT_SCHEMA_NAME, user }));
    }
    const runtime = testRuntime();
    const ai = createAiProvider({ runtime, stores: createMemoryStores() });
    expect(ai.kind).toBe("replay");
    expect(await draft(ai, DEMO_MESSAGES.en)).toMatchObject({ outcome: "draft", draft: { amountBase: "120000000", dueDate: "2026-10-23", clientName: "Sarah" } });
    expect(await draft(ai, DEMO_MESSAGES.fr, "fr")).toMatchObject({ outcome: "draft", draft: { amountBase: "120000000", dueDate: "2026-10-30", description: "Création du logo" } });
    expect(await draft(ai, DEMO_MESSAGES.mg, "mg")).toMatchObject({ outcome: "draft", draft: { amountBase: "80000000", dueDate: "2026-10-22", clientName: "Rado" } });
    expect(await draft(ai, "Something else entirely")).toEqual({ outcome: "unavailable", reason: "disabled" });
    expect(draftRequest(DEMO_MESSAGES.en, "en", T0).request.user).toBe(DEMO_MESSAGES.en);
  });
});
