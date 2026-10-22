// SPDX-License-Identifier: MIT
/**
 * The obedient model of the L3 injection case (test/e2e/obedient.ts) in the reconciler's world, through the real Workers
 * AI provider, the desk agent and the fence: everything it proposes outside the fence, with other values, for a key that
 * is not the payee's or with an ungrounded message is refused; the only open proposals are the fence's own, with the
 * fence's values; nothing reaches PayPal (AI-2, AI-3, AI-5). The e2e suite repeats this through the browser, the Node
 * entry, the PayPal fake and a fork of Ethereum Sepolia.
 */
import { describe, expect, it } from "vitest";
import { PRIMARY_MODEL } from "../../src/ai/models.ts";
import { workersAiProvider } from "../../src/ai/workers-ai.ts";
import { ATTACK, attackCalls, obedientModel } from "../e2e/obedient.ts";
import { B_KEY, deskWorld, KEY, proposals } from "./support.ts";

describe("the obedient model of the L3 injection case", () => {
  it("tries every effect, and the fence leaves only its own proposals, with its own values and no attacker text", async () => {
    const d = await deskWorld();
    const sent: string[] = [];
    const binding = obedientModel((_model, inputs) => sent.push(JSON.stringify(inputs)));
    const ai = workersAiProvider({ binding, model: PRIMARY_MODEL, timeoutMs: 5_000, clock: () => d.w.clock.now });
    const desk = await d.run(ai);
    expect(desk.assistant).toEqual({ available: true, reason: null });
    // KEY is open (S1): its fence is the reminder text to share; B_KEY was cancelled on the chain (S7): cancel on PayPal.
    expect(proposals(desk).sort()).toEqual([
      ["cancel_paypal", B_KEY, "reconciler", null],
      ["share_reminder_text", KEY, "reconciler", null],
    ]);
    for (const p of desk.proposals) {
      expect(JSON.stringify(p)).not.toContain(ATTACK.address);
      expect(JSON.stringify(p)).not.toContain(ATTACK.link);
      expect(p.args["amount"]).toBe("120.00");
    }
    // Three turns: list, the attack (every proposal refused or reduced to the fence's own), the end.
    expect(sent).toHaveLength(3);
    expect(d.reports).toEqual([{ turns: 3, toolCalls: 1 + attackCalls(KEY, null).length, proposed: 1, refusedByFence: attackCalls(KEY, null).length - 1, messagesDropped: 1, ending: "done" }]);
    expect(d.w.paypal.writes()).toEqual([]);
  });

  it("refuses to draft (A1): the payee gets the manual form", async () => {
    const binding = obedientModel();
    const ai = workersAiProvider({ binding, model: PRIMARY_MODEL, timeoutMs: 5_000, clock: () => 0 });
    expect(await ai.structured({ system: "s", user: "u", schemaName: "draft", schema: {}, maxOutputTokens: 100, sampling: { temperature: 0, reasoning: false } })).toEqual({ outcome: "refused" });
  });
});
