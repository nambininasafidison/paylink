// SPDX-License-Identifier: MIT
/**
 * The eval sets in CI (docs/paypal/SPEC.md §15.3, L2): each set holds at least its floor of cases, and replaying the
 * scripted answers through code meets every bar. This measures code's half (parsing, resolving, the fence, grounding),
 * not a model: the owner's live run (test/ai/evals/run.ts --live) measures Workers AI against the same sets and bars.
 */
import { describe, expect, it } from "vitest";
import { T0 } from "../helpers.ts";
import type { A1Case, DeskCase } from "./evals/lib.ts";
import { loadSet, referenceDeskModel, runA1Case, runDeskCase, scoreA1, scriptedA1 } from "./evals/lib.ts";

describe("A1 extraction set", () => {
  const set = loadSet<A1Case>("a1");

  it("holds at least its floor of cases, in English, French and Malagasy, with unique ids and 10 video cases", () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(set.floor);
    expect(set.floor).toBe(60);
    expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length);
    expect(new Set(set.cases.map((c) => c.language))).toEqual(new Set(["en", "fr", "mg"]));
    expect(set.cases.filter((c) => c.video)).toHaveLength(10);
    expect(Date.parse(set.now)).toBe(T0);
  });

  it("replaying the scripted answers meets every bar", async () => {
    const outcomes = [];
    for (const c of set.cases) {
      outcomes.push(await runA1Case(c, await scriptedA1(c, T0), T0));
    }
    const score = scoreA1(outcomes);
    expect(score.failed).toEqual([]);
    expect(score).toMatchObject({ amountExactOrClarified: 1, inventedAmounts: 0, video: 1 });
    expect(score.dueDate).toBeGreaterThanOrEqual(0.95);
    expect(score.clarifications).toBeGreaterThanOrEqual(0.95);
  });
});

describe("desk ledgers", () => {
  const set = loadSet<DeskCase>("desk");

  it("holds at least its floor of ledgers", () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(set.floor);
    expect(set.floor).toBe(15);
    expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length);
  });

  it("a reference model proposing every tap action of every fence gets exactly the expected set, all messages grounded", async () => {
    const failed: string[] = [];
    for (const c of set.cases) {
      const outcome = await runDeskCase(c, referenceDeskModel());
      if (!outcome.pass) {
        failed.push(`${c.id}: got ${JSON.stringify(outcome.proposed)}, messages ${JSON.stringify(outcome.messages)}`);
      }
    }
    expect(failed).toEqual([]);
  });
});

describe("the live runner's REST binding", () => {
  it("posts the inputs and the options to Cloudflare's run endpoint and unwraps the envelope; errors carry Cloudflare's codes", async () => {
    const { restBinding } = await import("./evals/lib.ts");
    const { failureOfError } = await import("../../src/ai/workers-ai.ts");
    const seen: { url: string; init: RequestInit }[] = [];
    const answers = [
      new Response(JSON.stringify({ result: { response: "ok" }, success: true, errors: [], messages: [] })),
      new Response(JSON.stringify({ result: null, success: false, errors: [{ code: 3036, message: "You have used up your daily free allocation of 10,000 neurons." }] }), { status: 429 }),
    ];
    const fake: typeof fetch = (input, init) => {
      seen.push({ url: input instanceof Request ? input.url : input.toString(), init: init ?? {} });
      return Promise.resolve(answers.shift() ?? new Response("{}", { status: 500 }));
    };
    const binding = restBinding("acct", "tok", fake);
    expect(await binding.run("@cf/google/gemma-4-26b-a4b-it", { messages: [] }, { rejectIfBusy: true })).toEqual({ response: "ok" });
    expect(seen[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/google/gemma-4-26b-a4b-it");
    expect(JSON.parse(typeof seen[0]?.init.body === "string" ? seen[0].init.body : "null")).toEqual({ messages: [], options: { rejectIfBusy: true } });
    expect(new Headers(seen[0]?.init.headers).get("authorization")).toBe("Bearer tok");
    const error = await binding.run("m", {}).catch((e: unknown) => e);
    expect(failureOfError(error)).toEqual({ outcome: "unavailable", reason: "budget" });
  });
});
