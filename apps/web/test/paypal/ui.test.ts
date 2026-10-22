// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's screens and their states (docs/paypal/SPEC.md §14.3), rendered without a page: the assistant
 * sheet (empty, drafting, draft, clarification, unavailable, resting), the twin panel (not eligible, no API, created
 * and read back, PayPal unavailable then retried, hands off), the desk's cards (proposal, approving, done, stale,
 * rejected, a cancel this device cannot sign, share, auto-record with Undo, alert) and the "Was I really paid?" verdict.
 *
 * AI-4 is checked on each: model text sits only in `[data-ai]` boxes, never in the exact-values grid or a verdict.
 */
import type { ApproveResponse, AutoRecordView, ClarificationCode, DeskAlertCode, DraftResponse, ProposalView, TwinView } from "@paylink/api-contract";
import type { IssuedInvoice } from "@paylink/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountProvider } from "../../src/accounts/types.ts";
import type { App } from "../../src/app/context.ts";
import { ApiError } from "../../src/editions/paypal/api.ts";
import { draftCard, openSheet, prefillOf } from "../../src/editions/paypal/assistant.ts";
import type { DraftPrefill } from "../../src/editions/paypal/assistant.ts";
import { alertCard, proposalCard, recordCard, verdictReadout } from "../../src/editions/paypal/desk.ts";
import type { DeskActions } from "../../src/editions/paypal/desk.ts";
import { forgetSession } from "../../src/editions/paypal/session.ts";
import { twinPanel } from "../../src/editions/paypal/twin.ts";
import { cachedTwin } from "../../src/editions/paypal/twins.ts";
import { API, KEY, alert, autoRecord, check, paypalApp, proposal } from "./fixtures.ts";

const PAYEE = "0x1111111111111111111111111111111111111111";
const tick = async (ms = 0): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

type Route = (body: unknown) => { status: number; body: unknown } | "network";

/** Stubs `fetch` for the API's routes (`"POST /v1/ai/draft"` → answer) and records what was asked. */
function stubApi(routes: Readonly<Record<string, Route>>): { method: string; path: string; body: unknown }[] {
  const seen: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ method, path: url.pathname, body });
      const route = url.origin === API ? routes[`${method} ${url.pathname}`] : undefined;
      const answer = route?.(body);
      if (answer === undefined || answer === "network") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    }),
  );
  return seen;
}

/** An app whose wallet is connected and whose desk session is open (no signature needed). */
function signedIn(locale: "en" | "fr" | "mg" = "en", api: string | null = API): App {
  const account = { address: PAYEE, kind: "injected" } as unknown as AccountProvider;
  sessionStorage.setItem("paylink.paypal.session", JSON.stringify({ payee: PAYEE, token: "ps1.test", expiresAt: Date.now() + 3_600_000 }));
  return { ...paypalApp(locale, { api }), session: { account: () => account, ready: Promise.resolve(), subscribe: () => () => undefined } } as unknown as App;
}

const draft = (over: Partial<Extract<DraftResponse, { outcome: "draft" }>> = {}): Extract<DraftResponse, { outcome: "draft" }> => ({
  outcome: "draft",
  draft: { amountBase: "120000000", amountText: "$120", currency: "USD", description: "Logo design", clientName: "Sarah", clientEmail: "sarah@example.com", dueDate: "2026-11-06", clientLanguage: "en" },
  clarifications: [],
  confidence: "high",
  model: "@cf/google/gemma-4-26b-a4b-it",
  ...over,
});

beforeEach(() => {
  forgetSession();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.remove();
  }
  document.body.replaceChildren();
});

describe("the assistant sheet", () => {
  async function draftWith(routes: Readonly<Record<string, Route>>, text = "Love it! Send me the invoice, $120, I'll pay by Friday.", app: App = signedIn()): Promise<{ dialog: HTMLDialogElement; used: DraftPrefill[]; manual: number[]; seen: ReturnType<typeof stubApi> }> {
    const seen = stubApi(routes);
    const used: DraftPrefill[] = [];
    const manual: number[] = [];
    const modal = openSheet(app, (p) => used.push(p), () => manual.push(1));
    const input = modal.element.querySelector<HTMLTextAreaElement>("#assist-text");
    expect(document.activeElement).toBe(input);
    if (input !== null) {
      input.value = text;
    }
    modal.element.querySelector<HTMLButtonElement>("[data-action=draft]")?.click();
    await tick(30);
    return { dialog: modal.element, used, manual, seen };
  }

  it("is empty until a message is pasted, and says so instead of calling anyone", async () => {
    const { dialog, seen } = await draftWith({}, "   ");
    expect(dialog.querySelector(".status")?.textContent).toBe("Paste a message or describe the job first.");
    expect(seen).toEqual([]);
    expect(dialog.querySelector(".privacy")?.textContent).toContain("Cloudflare Workers AI");
  });

  it("shows the draft in an AI box with its pill, the amount as code parsed it, and fills the form only on Use draft", async () => {
    const { dialog, used, seen } = await draftWith({ "POST /v1/ai/draft": () => ({ status: 200, body: draft() }) });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/ai/draft", body: { text: "Love it! Send me the invoice, $120, I'll pay by Friday.", locale: "en" } });
    const card = dialog.querySelector<HTMLElement>("[data-ai=draft]");
    expect(card?.querySelector(".pill")?.textContent).toBe("AI draft");
    expect(card?.textContent).toContain("120.00 USD");
    expect(card?.textContent).toContain("As written: $120");
    expect(card?.textContent).toContain("Logo design");
    expect(card?.textContent).toContain("Model @cf/google/gemma-4-26b-a4b-it");
    expect(card?.classList.contains("screen")).toBe(false);
    expect(used).toEqual([]);
    card?.querySelector<HTMLButtonElement>("[data-action=use-draft]")?.click();
    expect(used).toEqual([{ amount: "120", memo: "Logo design", clientName: "Sarah", clientEmail: "sarah@example.com", dueDate: "2026-11-06" }]);
  });

  it("asks the fixed questions of its clarification codes, never model prose, and keeps the amount out when there is none", async () => {
    const response = draft({ draft: { ...draft().draft, amountBase: null, amountText: null, currency: null }, clarifications: ["amount_missing", "payee_address_ignored", "made_up_code" as ClarificationCode], confidence: "low" });
    const { dialog } = await draftWith({ "POST /v1/ai/draft": () => ({ status: 200, body: response }) });
    const questions = [...dialog.querySelectorAll(".ai-questions li")].map((li) => li.textContent);
    expect(questions).toEqual([
      "How much is it? The message names no amount.",
      "The message names an address to pay: it was ignored. You are always the payee.",
      "Check this draft against the message before you use it.",
    ]);
    expect(dialog.querySelector(".ai-note")?.textContent).toBe("The assistant is unsure about this draft. Check every value against the message.");
    expect(prefillOf(response.draft).amount).toBeNull();
  });

  it.each([
    ["refused", "unavailable", "Assistant unavailable."],
    ["timeout", "unavailable", "Assistant unavailable."],
    ["resting", "resting", "Assistant resting."],
  ])("says %s in fixed words and leaves the form one key away", async (reason, state, words) => {
    const { dialog, manual } = await draftWith({ "POST /v1/ai/draft": () => ({ status: 200, body: { outcome: "unavailable", reason } }) });
    const note = dialog.querySelector<HTMLElement>(`[data-state=${state}]`);
    expect(note?.querySelector("b")?.textContent).toBe(words);
    expect(dialog.querySelector("[data-ai=draft]")).toBeNull();
    note?.querySelector<HTMLButtonElement>("[data-action=manual]")?.click();
    expect(manual).toEqual([1]);
  });

  it("reads an API without the assistant (501), a quota (429) and no API at all as unavailable or resting", async () => {
    expect((await draftWith({ "POST /v1/ai/draft": () => ({ status: 501, body: { code: "not-implemented", status: 501 } }) })).dialog.querySelector("[data-state=unavailable]")).not.toBeNull();
    document.querySelector("dialog")?.remove();
    expect((await draftWith({ "POST /v1/ai/draft": () => ({ status: 429, body: { code: "quota-exhausted", status: 429, rule: "E_AI_QUOTA" } }) })).dialog.querySelector("[data-state=resting]")).not.toBeNull();
    document.querySelector("dialog")?.remove();
    const none = await draftWith({}, "a message", signedIn("en", null));
    expect(none.dialog.querySelector("[data-state=unavailable] .status-code")?.textContent).toBe("Error code ApiNotConfigured");
    expect(none.seen).toEqual([]);
  });

  it("renders the draft card in French and Malagasy", () => {
    for (const locale of ["fr", "mg"] as const) {
      const card = draftCard(paypalApp(locale), draft(), { use: () => undefined, manual: () => undefined });
      expect(card.querySelector(".pill")?.textContent).toBe(locale === "fr" ? "Brouillon IA" : "Drafitra AI");
      expect(card.textContent).toContain(locale === "fr" ? "120,00 USD" : "120,00 USD");
    }
  });
});

describe("the twin panel", () => {
  const issued = (amount = 120_000_000n, maxPayments = 1, symbol = "USDC"): IssuedInvoice =>
    ({ key: KEY, signed: { chainId: 11155111, invoice: { amount, maxPayments } }, token: { symbol, decimals: 6 } }) as unknown as IssuedInvoice;
  const twin = (over: Partial<TwinView> = {}): TwinView => ({
    key: KEY,
    paypalId: "INV2-ABCD-1234",
    number: "PL-11155111-abababababab",
    status: "SHARED",
    statusClass: "open",
    recipientViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-ABCD-1234",
    amount: "120.00",
    currency: "USD",
    situation: "S1",
    checkedAt: "2026-10-22T10:00:00.000Z",
    ...over,
  });

  it("says why an invoice cannot have a twin, and that none can be made without the API", () => {
    expect(twinPanel(paypalApp(), issued(0n), "https://x/#y", null).textContent).toContain("open-amount link cannot have a PayPal twin");
    expect(twinPanel(paypalApp(), issued(120_000_000n, 3), "https://x/#y", null).getAttribute("data-state")).toBe("ineligible");
    expect(twinPanel(paypalApp(), issued(120_000_001n), "https://x/#y", null).textContent).toContain("fraction of a cent");
    const none = twinPanel(paypalApp("en", { api: null }), issued(), "https://x/#y", null);
    expect(none.getAttribute("data-state")).toBe("no-api");
    expect(none.querySelector("button")).toBeNull();
  });

  it("makes the twin with the signed link and the payee's details, then shows what PayPal answered", async () => {
    const seen = stubApi({ "POST /v1/twin": () => ({ status: 201, body: twin() }) });
    const panel = twinPanel(signedIn(), issued(), "https://paypal.paylink-mg.pages.dev/paypal/pay/#2.11155111.x", { clientName: "Sarah", clientEmail: "sarah@example.com", dueDate: "2026-11-06" });
    document.body.append(panel);
    const key = panel.querySelector<HTMLButtonElement>("[data-action=make-twin]");
    expect(key?.textContent).toBe("Make the PayPal twin · 120.00 USD");
    key?.click();
    await tick(30);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/twin", body: { link: "https://paypal.paylink-mg.pages.dev/paypal/pay/#2.11155111.x", recipient: { givenName: "Sarah", email: "sarah@example.com" }, dueDate: "2026-11-06" } });
    expect(panel.getAttribute("data-state")).toBe("created");
    expect(panel.querySelector(".twin-number")?.textContent).toBe("PL-11155111-abababababab");
    expect(panel.querySelector(".twin-readout .pill")?.textContent).toBe("SHARED");
    expect(panel.querySelector(".status")?.textContent).toBe("PayPal twin PL-11155111-abababababab made and read back from PayPal.");
    expect(cachedTwin(KEY)?.number).toBe("PL-11155111-abababababab");
  });

  it("keeps the invoice valid when PayPal does not answer, and makes the twin on retry", async () => {
    let calls = 0;
    stubApi({ "POST /v1/twin": () => (++calls === 1 ? { status: 503, body: { code: "paypal-unavailable", status: 503 } } : { status: 200, body: twin({ status: "SENT" }) }) });
    const panel = twinPanel(signedIn(), issued(), "https://x/#y", null);
    panel.querySelector<HTMLButtonElement>("[data-action=make-twin]")?.click();
    await tick(30);
    expect(panel.getAttribute("data-state")).toBe("paypal-unavailable");
    expect(panel.querySelector(".status")?.textContent).toContain("Your invoice is valid and payable in dollars now");
    expect(panel.querySelector("[data-action=make-twin]")?.textContent).toBe("Try PayPal again");
    panel.querySelector<HTMLButtonElement>("[data-action=make-twin]")?.click();
    await tick(30);
    expect(panel.getAttribute("data-state")).toBe("created");
    expect(panel.querySelector(".twin-readout .pill")?.textContent).toBe("SENT");
  });

  it("says hands off when PayPal's copy does not match (S0)", async () => {
    stubApi({ "POST /v1/twin": () => ({ status: 200, body: twin({ situation: "S0", status: "DRAFT", statusClass: "not-sent" }) }) });
    const panel = twinPanel(signedIn(), issued(), "https://x/#y", null);
    panel.querySelector<HTMLButtonElement>("[data-action=make-twin]")?.click();
    await tick(30);
    expect(panel.getAttribute("data-state")).toBe("hands-off");
    expect(panel.querySelector(".status")?.classList.contains("err")).toBe(true);
  });
});

describe("the desk's cards", () => {
  const actions = (over: Partial<DeskActions> = {}): DeskActions & { log: string[] } => {
    const log: string[] = [];
    return {
      log,
      approve: vi.fn((p: ProposalView) => {
        log.push(`approve ${p.id} ${p.hash} ${p.token}`);
        return Promise.resolve<ApproveResponse>({ state: "done", proposalId: p.id });
      }),
      reject: vi.fn((p: ProposalView) => {
        log.push(`reject ${p.id}`);
        return Promise.resolve();
      }),
      undo: vi.fn((r: AutoRecordView) => {
        log.push(`undo ${r.id}`);
        return Promise.resolve();
      }),
      reload: vi.fn(() => {
        log.push("reload");
      }),
      ...over,
    };
  };

  it("shows the exact values in a display window, the assistant's words apart in an AI box (AI-4)", () => {
    const message = { text: "Hi Sarah, a gentle reminder: invoice PL-11155111-abababababab for 120.00 USD is due.", language: "en" as const, grounded: true };
    const card = proposalCard(paypalApp(), proposal({ kind: "share_reminder_text", origin: "assistant", message, reasonCode: "share-reminder" }), actions());
    const grid = card.querySelector<HTMLElement>("[data-exact]");
    expect(grid?.classList.contains("screen")).toBe(true);
    expect(grid?.querySelector("[data-ai]")).toBeNull();
    expect(grid?.textContent).not.toContain("gentle reminder");
    expect([...(grid?.querySelectorAll("dt") ?? [])].map((dt) => dt.textContent)).toEqual(["Invoice", "Amount", "Action", "Effect", "Rail"]);
    expect(grid?.querySelector("[data-label=action] dd")?.textContent).toBe("Cancel the PayLink link");
    expect(grid?.querySelector("[data-label=effect] dd")?.textContent).toBe("The link stops accepting dollars on the chain");
    const box = card.querySelector<HTMLElement>("[data-ai=message]");
    expect(box?.textContent).toContain("gentle reminder");
    expect(box?.querySelector(".pill")?.textContent).toBe("Assistant");
    expect(card.querySelector(".desk-card-title")?.textContent).toBe("A reminder in your client's language, for you to send.");
  });

  it("approves with the proposal's own hash and token, then reads done", async () => {
    const act = actions();
    const card = proposalCard(paypalApp(), proposal({ kind: "cancel_paypal", rail: "PAYPAL" }), act);
    expect(card.getAttribute("data-state")).toBe("open");
    card.querySelector<HTMLButtonElement>("[data-action=approve]")?.click();
    expect(card.getAttribute("data-state")).toBe("approving");
    await tick();
    expect(act.log).toEqual([`approve p_1 0x${"cd".repeat(32)} approval-token`]);
    expect(card.getAttribute("data-state")).toBe("done");
    expect(card.querySelector("[data-action=approve]")).toBeNull();
  });

  it("a reminder PayPal may have sent without answering reads done, and says it counts as sent", async () => {
    const act = actions({ approve: (p) => Promise.resolve<ApproveResponse>({ state: "done", proposalId: p.id, unconfirmed: true }) });
    const card = proposalCard(paypalApp(), proposal({ kind: "send_reminder", reasonCode: "reminder-due" }), act);
    card.querySelector<HTMLButtonElement>("[data-action=approve]")?.click();
    await tick();
    expect(card.getAttribute("data-state")).toBe("done");
    expect(card.querySelector(".status")?.textContent).toContain("PayPal did not answer. It may have sent the reminder");
    expect(card.querySelector("[data-action=approve]")).toBeNull();
  });

  it("reads stale when the executor's fresh read disagrees (409), and offers to read the desk again", async () => {
    const act = actions({ approve: () => Promise.reject(new ApiError(409, "stale", "E_STALE")) });
    const card = proposalCard(paypalApp(), proposal(), act);
    card.querySelector<HTMLButtonElement>("[data-action=approve]")?.click();
    await tick();
    expect(card.getAttribute("data-state")).toBe("stale");
    expect(card.querySelector(".status")?.textContent).toContain("The situation changed since this was proposed.");
    card.querySelector<HTMLButtonElement>("[data-action=reload]")?.click();
    expect(act.log).toEqual(["reload"]);
  });

  it("does not sign a cancel for an invoice this device did not create", async () => {
    const act = actions({ approve: (p) => Promise.resolve({ state: "signature-required", proposalId: p.id, cancel: { key: KEY, deadline: "1792666800" } }) });
    const card = proposalCard(signedIn(), proposal(), act);
    card.querySelector<HTMLButtonElement>("[data-action=approve]")?.click();
    await tick(10);
    expect(card.getAttribute("data-state")).toBe("open");
    expect(card.querySelector(".status")?.textContent).toContain("cancel it from the device that signed it");
  });

  it("rejects, and shares a reminder only after the tap, through a key of its own", async () => {
    const act = actions();
    const rejected = proposalCard(paypalApp(), proposal(), act);
    rejected.querySelector<HTMLButtonElement>("[data-action=reject]")?.click();
    await tick();
    expect(rejected.getAttribute("data-state")).toBe("rejected");
    const share = proposalCard(paypalApp(), proposal({ kind: "share_reminder_text", rail: null }), act);
    share.querySelector<HTMLButtonElement>("[data-action=approve]")?.click();
    await tick(10);
    expect(share.getAttribute("data-state")).toBe("done");
    expect(share.querySelector("[data-action=share]")).not.toBeNull();
    expect(act.log).toEqual(["reject p_1", `approve p_1 0x${"cd".repeat(32)} approval-token`]);
  });

  it("lists an automatic record with Undo while the 24 hours run, and none after", async () => {
    const act = actions();
    const card = recordCard(paypalApp(), autoRecord(), act, Date.parse("2099-10-22T09:00:00.000Z"));
    expect(card.querySelector("[data-action=undo]")?.textContent).toBe("Undo (24 hours left)");
    card.querySelector<HTMLButtonElement>("[data-action=undo]")?.click();
    await tick();
    expect(act.log).toEqual(["undo r_PAY-1"]);
    expect(card.getAttribute("data-state")).toBe("undone");
    const late = recordCard(paypalApp(), autoRecord({ undoUntil: "2026-10-21T00:00:00.000Z" }), act);
    expect(late.querySelector("[data-action=undo]")).toBeNull();
    expect(late.textContent).toContain("use your PayPal dashboard");
  });

  it("raises paid twice with the guide and nothing to press, and hands off with its reason", () => {
    const twice = alertCard(paypalApp(), alert());
    // A list item (the desk's list holds list items only), whose content is the alert region.
    expect(twice.getAttribute("role")).toBeNull();
    expect(twice.querySelector(":scope > [role=alert] > .desk-card-title")?.textContent).toBe("This invoice was paid on PayPal and on the chain.");
    expect(twice.querySelectorAll(".desk-guide li")).toHaveLength(3);
    expect(twice.querySelector(".desk-guide a")?.getAttribute("href")).toBe("/paypal/send/");
    expect(twice.querySelector("button")).toBeNull();
    const off = alertCard(paypalApp(), alert({ situation: "S0", code: "amount-mismatch" }));
    expect(off.querySelector(".desk-card-title")?.textContent).toBe("The PayPal invoice's amount differs from the signed amount.");
    expect(alertCard(paypalApp(), alert({ situation: "S0", code: "brand-new-code" as DeskAlertCode })).querySelector(".desk-card-title")?.textContent).toBe("The rails disagree for this invoice.");
    // A record of a chain payment gone from PayPal: its own pill and note; the two proposals are elsewhere on the desk.
    const missing = alertCard(paypalApp(), alert({ situation: "S3", code: "record-missing" }));
    expect(missing.querySelector(".pill")?.textContent).toBe("PayPal open again");
    expect(missing.querySelector(".desk-card-title")?.textContent).toContain("no longer on the PayPal invoice");
    expect(missing.textContent).toContain("record the chain payment on PayPal again, or cancel the PayPal invoice");
    expect(missing.querySelector("button")).toBeNull();
  });
});

describe("Was I really paid?", () => {
  it("answers from PayPal and the chain, flags unknown link hosts, and never guesses when a source is silent", () => {
    const not = verdictReadout(paypalApp(), check());
    expect(not.getAttribute("data-verdict")).toBe("NOT_RECEIVED");
    expect(not.querySelector(".verdict b")?.textContent).toBe("Not received");
    expect(not.querySelector(".verdict")?.classList.contains("is-err")).toBe(true);
    expect([...not.querySelectorAll(".vstrip li")].map((li) => li.getAttribute("data-lamp"))).toEqual(["ok", "ok"]);
    expect(not.textContent).toContain("paypa1-secure.example · unknown site: do not open");
    expect(not.querySelector("[data-ai]")).toBeNull();
    // The API said "received", but the chain did not answer: no verdict.
    const silent = verdictReadout(paypalApp(), check({ verdict: "RECEIVED", sources: { paypal: "checked", chain: "unavailable" } }));
    expect(silent.getAttribute("data-verdict")).toBe("UNAVAILABLE");
    expect(silent.querySelector(".verdict b")?.textContent).toBe("Can't check now");
    const partly = verdictReadout(paypalApp("fr"), check({ verdict: "PARTLY_RECEIVED", matches: [{ key: KEY, invoiceNumber: "PL-1", amount: "120.00", paidOn: ["PAYPAL"] }] }));
    expect(partly.querySelector(".verdict b")?.textContent).toBe("Reçu en partie");
    expect(partly.textContent).toContain("payée sur PAYPAL");
  });
});
