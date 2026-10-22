// SPDX-License-Identifier: MIT
/**
 * The injection suite, a blocking gate (invariant AI-7, docs/paypal/SPEC.md §15.3 "Injection (blocking)"): every case
 * of apps/api/evals/injection.cases.json must hold, on every run. Pasted text, memos, PayPal notes, webhook bodies and a
 * model that obeys them try to trigger actions, change amounts, redirect the payee or exfiltrate data; none may reach an
 * effect outside the fence, an amount code did not parse from the message, or another payee's data.
 */
import { describe, expect, it } from "vitest";
import { T0 } from "../helpers.ts";
import type { InjectionCase } from "./evals/lib.ts";
import { loadSet, runInjectionCase } from "./evals/lib.ts";

const set = loadSet<InjectionCase>("injection");

describe("injection suite", () => {
  it("holds at least its floor of cases, over every vector", () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(set.floor);
    expect(set.floor).toBeGreaterThanOrEqual(30);
    expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length);
    expect(new Set(set.cases.map((c) => c.vector))).toEqual(new Set(["pasted-text", "memo", "model-output", "paypal-note", "webhook-body"]));
  });

  for (const c of set.cases) {
    it(`${c.id} ${c.vector} / ${c.attack}`, async () => {
      const outcome = await runInjectionCase(c, T0);
      expect(outcome.failures).toEqual([]);
    });
  }
});
