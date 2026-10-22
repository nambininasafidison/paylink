// SPDX-License-Identifier: MIT
/**
 * Who may spend the assistant's neurons (threat T-60, src/ai/admission.ts), through the real route, the real provider
 * on a scripted Workers AI binding and the real budget guard: addresses cost nothing, so fresh keys must not be able to
 * spend the day's neurons, and the demo payees' reserve must survive whatever the public did.
 *
 * The review of 2026-10-22 measured the hole this closes: 8 fresh wallets from one machine, 461 drafts, 453 model calls
 * and 9,966 of the 10,000 daily neurons, after which every judge's assistant answered "resting".
 */
import type { Address, DraftResponse } from "@paylink/api-contract";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createAiProvider } from "../../src/ai/factory.ts";
import { createApp } from "../../src/core/app.ts";
import type { AiBinding } from "../../src/core/runtime.ts";
import type { ApiServices } from "../../src/core/services.ts";
import { aiHandlers } from "../../src/routes/ai.ts";
import { createMemoryStores } from "../../src/store/memory.ts";
import { DEMO_RESERVE, GLOBAL_DAILY, SOURCE_DAILY } from "../../src/store/quotas.ts";
import { T0, testRuntime, testServices } from "../helpers.ts";

const DAY = "2026-10-21";
const DEMO: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** A long client message (3,990 characters, as the review's probe): the costliest draft a caller can ask for. */
const MESSAGE = `Logo $120 by Friday. ${"Please make it bold and blue, with our name in capitals. ".repeat(70)}`.slice(0, 3990);

/** A Workers AI binding that always drafts, reporting usage as the platform would: prompt ≈ characters / 4, 150 out. */
function draftingBinding(): AiBinding & { calls: number } {
  const b = {
    calls: 0,
    run(_model: string, inputs: Readonly<Record<string, unknown>>) {
      b.calls += 1;
      const content = JSON.stringify({ amount_text: "$120", currency_text: "$", description: "Logo", client_name: null, client_email_token: null, due_text: "by Friday", due_date_iso: null, client_language: "en", clarifications: [], confidence: "high" });
      return Promise.resolve({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", refusal: null, content }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: Math.ceil(JSON.stringify(inputs).length / 4), completion_tokens: 150, total_tokens: 0 },
      });
    },
  };
  return b;
}

function world(demoPayees: readonly Address[] = [DEMO]) {
  const stores = createMemoryStores();
  const base = testRuntime();
  const binding = draftingBinding();
  const runtime = { ...base, ai: binding, config: { ...base.config, demoPayees, ai: { ...base.config.ai, mode: "workers-ai" as const } } };
  const services: ApiServices = {
    ...testServices({ runtime, stores }),
    ai: createAiProvider({ runtime, stores }),
    // Any "payee.<address>" token is that payee's session (the session service is tested on its own).
    sessions: { open: () => Promise.reject(new Error("unused")), check: (token) => Promise.resolve(token?.startsWith("payee.") === true ? { ok: true as const, payee: token.slice(6) as Address, expiresAt: T0 + 3_600_000 } : { ok: false as const, reason: "bad-mac" as const }) },
  };
  const app = createApp(services, [aiHandlers]);
  const draft = async (payee: Address, source: string): Promise<DraftResponse> =>
    (await (await app.request("/v1/ai/draft", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer payee.${payee}`, "cf-connecting-ip": source }, body: JSON.stringify({ text: MESSAGE, locale: "en" }) })).json()) as DraftResponse;
  const neurons = async (): Promise<number> => (await stores.global().spendAiBudget(DAY, 0, Number.MAX_SAFE_INTEGER)).used;
  return { services, binding, draft, neurons, ceiling: runtime.config.ai.dailyNeuronBudget, stores };
}

const fresh = (): Address => privateKeyToAccount(generatePrivateKey()).address;

describe("assistant admission (T-60)", () => {
  it("the review's probe, again: fresh wallets from one source stop at the source's limit, far from the day's neurons", async () => {
    const w = world();
    let drafts = 0;
    let wallets = 0;
    let resting = false;
    while (!resting && wallets < 20) {
      wallets += 1;
      const payee = fresh();
      for (let i = 0; i < 61 && !resting; i += 1) {
        const answer = await w.draft(payee, "203.0.113.9");
        resting = answer.outcome === "unavailable";
        drafts += resting ? 0 : 1;
      }
    }
    expect(drafts).toBeLessThanOrEqual(SOURCE_DAILY.aiCalls);
    expect(w.binding.calls).toBe(drafts);
    expect(await w.neurons()).toBeLessThanOrEqual(SOURCE_DAILY.neurons);
    // Another source (a judge) still drafts.
    expect((await w.draft(fresh(), "198.51.100.20")).outcome).toBe("draft");
  });

  it("fresh keys from many sources cannot take the day's neurons below the demo reserve; the demo payee still drafts", async () => {
    const w = world();
    let sources = 0;
    for (let s = 0; s < 60; s += 1) {
      sources += 1;
      let rested = false;
      for (let i = 0; i < SOURCE_DAILY.aiCalls + 1 && !rested; i += 1) {
        rested = (await w.draft(fresh(), `192.0.2.${String(s + 1)}`)).outcome === "unavailable";
      }
      expect(await w.neurons()).toBeLessThanOrEqual(w.ceiling - DEMO_RESERVE.neurons);
    }
    expect(sources).toBe(60);
    expect((await w.stores.global().useQuota(DAY, "aiCalls", 0)).used).toBeLessThanOrEqual(GLOBAL_DAILY.aiCalls);
    const before = w.binding.calls;
    expect(await w.draft(DEMO, "192.0.2.1")).toMatchObject({ outcome: "draft", draft: { amountBase: "120000000" } });
    expect(w.binding.calls).toBe(before + 1);
  });

  it("the public lane's neurons stop at the ceiling less the reserve even with no call limit left to hit", async () => {
    const w = world();
    // The day's neurons already near the public lane's edge (spent by earlier callers).
    await w.stores.global().spendAiBudget(DAY, w.ceiling - DEMO_RESERVE.neurons - 5, w.ceiling);
    expect(await w.draft(fresh(), "192.0.2.200")).toEqual({ outcome: "unavailable", reason: "resting" });
    expect(w.binding.calls).toBe(0);
    expect((await w.draft(DEMO, "192.0.2.200")).outcome).toBe("draft");
  });

  it("without demo payees configured, nobody has a reserved lane and the public limits apply to all", async () => {
    const w = world([]);
    await w.stores.global().spendAiBudget(DAY, w.ceiling - DEMO_RESERVE.neurons - 5, w.ceiling);
    expect(await w.draft(DEMO, "192.0.2.201")).toEqual({ outcome: "unavailable", reason: "resting" });
  });
});
