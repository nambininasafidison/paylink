// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's screens and every state of docs/paypal/SPEC.md §14.3, in the production build under its real
 * `_headers` (Content-Security-Policy, Trusted Types), with a mock EIP-6963 wallet on a local Ethereum Sepolia and the
 * edition's API played by the test (e2e/fixtures/paypal-ui.ts): what the API answers, how late and how it fails is
 * chosen per test, so each state is reached on purpose.
 *
 * - Assistant sheet (F1): empty · drafting · draft · clarification needed · unavailable · resting.
 * - Twin panel (F1): creating · created and read back · PayPal unavailable then retried · hands off (S0) · refused ·
 *   not eligible.
 * - Rail chooser (F2, F3): both rails, PayPal followed at top level · withheld (host, amount) · hidden (no twin, no API) ·
 *   "PayPal says paid" (advisory) · a PayPal payment in flight · the token paused or an address frozen · paying in
 *   PayPal USD from the payer's own wallet.
 * - Till (F4): lit via PAYPAL only on PayPal's own PAID; lit via the token from the chain.
 * - Desk (F5): no session · alerts, proposals and records in order · approving then done · stale · rejected · share a
 *   reminder · the payee's own chain cancel · Undo · Check my invoices · the assistant resting · errors and a lapsed
 *   session.
 * - Was I really paid? (F6): checking · the three verdicts · a source not answering · the API not answering.
 * - Ledger (F7) and Status (F8).
 * - AI-4 on every money screen; axe-core WCAG 2.2 AA at 320 px in EN, FR and MG, light and dark; no CSP violation.
 *
 * Each state leaves a screenshot in the test's output folder (the "e2e snapshot" of §14.3).
 */
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { decodeFunctionData, parseAbi } from "viem";
import type { Hex } from "viem";
import type { InvoiceKey } from "../../packages/api-contract/src/index.ts";
import { axe } from "../fixtures/axe.ts";
import { horizontalOverflow, setLocale } from "../fixtures/layout.ts";
import { servePages } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import {
  ACCOUNTS,
  alert,
  autoRecord,
  buildPaypalUiSite,
  check,
  desk,
  draftAnswer,
  health,
  inDays,
  keyOf,
  MockApi,
  numberOf,
  ok,
  PAYER_FUNDS,
  PAYLINK,
  problem,
  proposal,
  PYUSD,
  rails,
  routeSepolia,
  SEPOLIA,
  startSepolia,
  twin,
  USDC,
} from "../fixtures/paypal-ui.ts";
import type { ApiAnswer, RpcOverride, SepoliaChain } from "../fixtures/paypal-ui.ts";
import { installWallet } from "../fixtures/wallet.ts";
import type { MockWallet } from "../fixtures/wallet.ts";

const PAYER_PAGE = "https://www.sandbox.paypal.com/invoice/p/#INV2E2E0AAAABBBBCCCC";
const payLinkAbi = parseAbi([
  "function payWithAuthorization((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv, bytes payeeSig, (address,uint128,bytes32,uint256,uint256,bytes32,uint8,bytes32,bytes32) auth)",
  "function cancel((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv)",
]);

let chain: SepoliaChain;
let server: StaticServer;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  chain = await startSepolia();
  server = await servePages(await buildPaypalUiSite());
});

test.afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.close().catch(() => undefined);
  }
});

test.afterAll(async () => {
  await server.close();
  await chain.anvil.stop();
});

interface Actor {
  readonly page: Page;
  readonly api: MockApi;
  readonly wallet: MockWallet;
  /** Answers some of the page's chain calls instead of anvil (`current`: set per test). */
  readonly rpc: { current: RpcOverride | null };
  /** Page errors and CSP violations (failed loads of mocked failures are expected and not listed). */
  readonly problems: string[];
  readonly context: BrowserContext;
}

async function actor(browser: Browser, account: string = ACCOUNTS.payee, options: { phone?: boolean; scheme?: "light" | "dark" } = {}): Promise<Actor> {
  const context = await browser.newContext({ viewport: options.phone === true ? { width: 320, height: 760 } : { width: 1280, height: 900 }, colorScheme: options.scheme ?? "light" });
  contexts.push(context);
  const api = new MockApi(server.origin);
  await api.install(context);
  const rpc: { current: RpcOverride | null } = { current: null };
  await routeSepolia(context, chain.anvil, rpc);
  // PayPal's payer page: the test stands in for it (nothing leaves the machine).
  await context.route("https://www.sandbox.paypal.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>PayPal sandbox (e2e)</title><p>PayPal's payer page</p>" });
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations?: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const wallet = await installWallet(page, { account, chainId: SEPOLIA, endpoints: new Map([[SEPOLIA, chain.anvil.url]]), known: [SEPOLIA] });
  return { page, api, wallet, rpc, problems, context };
}

async function clean(a: Actor): Promise<void> {
  expect(await a.page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []), "CSP violations").toEqual([]);
  expect(a.problems).toEqual([]);
}

async function snap(a: Actor, name: string, target?: Locator): Promise<void> {
  await (target ?? a.page).screenshot({ path: test.info().outputPath(`${name}.png`), ...(target === undefined ? { fullPage: true } : {}) });
}

/**
 * AI-4: no model text on a money screen. Nothing marked `data-ai` sits inside the signing display, the lamps, the till,
 * the receipt, the twin readout, an exact-values grid or a verdict, and none of `texts` (what the mocked model "wrote")
 * appears in them.
 */
async function noAiOnMoneyScreens(page: Page, texts: readonly string[] = []): Promise<void> {
  const money = ".signing, .vstrip, .till, .receipt, .twin-readout, [data-exact], .check-verdict, .rails";
  expect(await page.locator(`:is(${money}) [data-ai], :is(${money})[data-ai]`).count(), "data-ai inside a money screen").toBe(0);
  const shown = await page.locator(money).allTextContents();
  for (const text of texts) {
    for (const screen of shown) {
      expect(screen, `model text "${text}" on a money screen`).not.toContain(text);
    }
  }
}

/** Signs an invoice on the create terminal and returns its payment link. */
async function createInvoice(a: Actor, amount: string, memo: string, options: { token?: string; payments?: "one" | "unlimited"; fill?: boolean } = {}): Promise<string> {
  const { page } = a;
  if (options.fill !== false) {
    await page.goto(`${server.origin}/paypal/`);
    if (options.token !== undefined) {
      await page.locator(".view-create .readout select").selectOption({ label: options.token });
    }
    await page.locator("#amount").fill(amount);
    await page.locator("#memo").fill(memo);
    if (options.payments !== undefined) {
      await page.locator(`label:has(input[name=payments][value=${options.payments}])`).click();
    }
  }
  await page.locator(".view-create > .key-primary").click();
  await expect(page.locator(".signing")).toBeVisible();
  await page.locator(".signing + .key-row .key-primary").click();
  await expect(page.locator(".ticket")).toBeVisible();
  return await page.locator(".share input").inputValue();
}

/** The key of the invoice this device signed last (the device store, as the ledger reads it). */
async function lastKey(page: Page): Promise<InvoiceKey> {
  return await page.evaluate(
    async () =>
      await new Promise<InvoiceKey>((resolve, reject) => {
        const open = indexedDB.open("paylink");
        open.onerror = () => {
          reject(new Error("no device store"));
        };
        open.onsuccess = () => {
          const read = open.result.transaction("invoices").objectStore("invoices").getAll();
          read.onsuccess = () => {
            const records = (read.result as { key: InvoiceKey; createdAt: number }[]).sort((x, y) => y.createdAt - x.createdAt);
            open.result.close();
            if (records[0] === undefined) {
              reject(new Error("no invoice on this device"));
            } else {
              resolve(records[0].key);
            }
          };
        };
      }),
  );
}

/**
 * Opens the desk: connects the wallet if needed, then signs the desk session (no transaction). The page restores a
 * wallet connected earlier in this context on its own (no-wallet, then a stored session reads ready), so each state is
 * acted on as it shows.
 */
async function openDesk(a: Actor): Promise<Locator> {
  const { page } = a;
  await page.goto(`${server.origin}/paypal/desk/`);
  const view = page.locator(".view-desk");
  await expect
    .poll(
      async () => {
        const state = await view.getAttribute("data-desk");
        const key = state === "no-wallet" ? "connect" : state === "no-session" ? "open-session" : null;
        if (key !== null) {
          await view.locator(`[data-action=${key}]:enabled`).click({ timeout: 1_000 }).catch(() => undefined);
        }
        return state;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe("ready");
  return view;
}

const sent = (wallet: MockWallet): number => wallet.sent().length;

// ------------------------------------------------------------------------------------------- assistant sheet

test.describe("create: the assistant sheet (F1)", () => {
  test("empty: focus in the message, the privacy line, a refusal of an empty draft, and focus back on the key when closed", async ({ browser }) => {
    const a = await actor(browser);
    await a.page.goto(`${server.origin}/paypal/`);
    const key = a.page.locator(".view-create [data-action=assistant]");
    await expect(key).toHaveText("Assistant");
    await key.click();
    const sheet = a.page.locator("dialog[open]");
    await expect(sheet).toBeVisible();
    await expect(a.page.locator("#assist-text")).toBeFocused();
    await expect(sheet.locator(".privacy")).toContainText("Cloudflare Workers AI");
    await expect(sheet.locator("label[for=assist-text] .count")).toHaveText("0 of 4000");
    await snap(a, "assistant-empty");
    await sheet.locator("[data-action=draft]").click();
    await expect(sheet.locator(".status")).toHaveText(/Paste a message or describe the job first\./);
    expect(a.api.calls).toEqual([]);
    expect(a.wallet.requests.filter((r) => r.method === "eth_signTypedData_v4")).toHaveLength(0);
    await a.page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(key).toBeFocused();
    await clean(a);
  });

  test("drafting then draft: the AI box, Use draft fills the form, the payee signs, and the twin panel takes the client's details", async ({ browser }) => {
    const a = await actor(browser);
    a.api.on("ai.draft", ok(draftAnswer({}, { description: "Logo design", clientName: "Sarah", dueDate: inDays(14) }), 200, 1200));
    await a.page.goto(`${server.origin}/paypal/`);
    await a.page.locator("[data-action=assistant]").click();
    const sheet = a.page.locator("dialog[open]");
    await a.page.locator("#assist-text").fill("Love it! Send me the invoice, $120, I'll pay in two weeks. Sarah");
    await sheet.locator("[data-action=draft]").click();
    // The first draft opens the desk session: one signature, no transaction.
    await expect(sheet.locator("[data-ai=drafting]")).toBeVisible();
    await expect(sheet.locator("[data-ai=drafting]")).toHaveAttribute("aria-busy", "true");
    await expect(sheet.locator("[data-action=draft]")).toBeDisabled();
    await snap(a, "assistant-drafting");
    const card = sheet.locator("[data-ai=draft]");
    await expect(card).toBeVisible();
    await expect(card.locator(".ai-head .pill")).toHaveText("AI draft");
    await expect(card.locator(".ai-model")).toHaveText("Model @cf/google/gemma-4-26b-a4b-it");
    await expect(card.locator(".facts > div").nth(0)).toContainText("120.00 USD");
    await expect(card.locator(".facts > div").nth(0)).toContainText("As written: $120");
    await expect(card.locator(".facts > div").nth(1)).toContainText("Logo design");
    await expect(card.locator(".facts > div").nth(2)).toContainText("Sarah");
    await expect(card.locator(".facts > div").nth(4)).toContainText("English");
    await expect(card.locator("[data-action=use-draft]")).toBeFocused();
    await snap(a, "assistant-draft");
    // The request: the text and the interface language, with the session token (the signature was verified).
    const [draftCall] = a.api.to("ai.draft");
    expect(draftCall?.body).toEqual({ text: "Love it! Send me the invoice, $120, I'll pay in two weeks. Sarah", locale: "en" });
    expect(draftCall?.token).toMatch(/^ps1\.e2e-/);
    expect(a.api.to("session.create")).toHaveLength(1);
    expect(sent(a.wallet)).toBe(0);
    await card.locator("[data-action=use-draft]").click();
    await expect(sheet).toBeHidden();
    await expect(a.page.locator("#amount")).toHaveValue("120");
    await expect(a.page.locator("#memo")).toHaveValue("Logo design");
    await expect(a.page.locator("input[name=payments][value=one]")).toBeChecked();
    await expect(a.page.locator("input[name=expiry][value='30d']")).toBeChecked();
    await expect(a.page.locator("[data-drafted]")).toHaveText("Filled from the AI draft. Check every value, then review and sign.");
    // The payee reviews and signs the form's values on the unchanged signing display: no AI box, no model text there.
    await a.page.locator(".view-create > .key-primary").click();
    await expect(a.page.locator(".signing")).toContainText("You are about to sign this invoice");
    await noAiOnMoneyScreens(a.page, ["@cf/google/gemma-4-26b-a4b-it", "AI draft"]);
    await a.page.locator(".signing + .key-row .key-primary").click();
    await expect(a.page.locator(".ticket")).toBeVisible();
    // The twin panel comes first under "Invoice signed", before the card and the share keys; its key is the primary one
    // until the twin exists, and the form's own key steps back meanwhile.
    const panel = a.page.locator("section.twin");
    await expect(panel).toHaveAttribute("data-state", "ready");
    await expect(a.page.locator(".issued > :first-child")).toHaveClass(/\btwin\b/);
    await expect(panel.locator("[data-action=make-twin]")).toHaveClass(/\bkey-primary\b/);
    await expect(a.page.locator(".view-create > .key")).toHaveClass(/\bkey-line\b/);
    await expect(a.page.locator(".ticket")).toContainText("Pay on PayPal, or in USDC from any wallet.");
    await expect(panel.locator("#twin-name")).toHaveValue("Sarah");
    await expect(panel.locator("#twin-due")).toHaveValue(inDays(14));
    await expect(panel.locator("[data-action=make-twin]")).toHaveText("Make the PayPal twin · 120.00 USD");
    await clean(a);
  });

  test("clarification needed: fixed questions, never model prose; no amount means none in the form", async ({ browser }) => {
    const a = await actor(browser);
    a.api.on("ai.draft", ok(draftAnswer({ clarifications: ["amount_missing", "payee_address_ignored"], confidence: "low" }, { amountBase: null, amountText: null, currency: null })));
    await a.page.goto(`${server.origin}/paypal/`);
    await a.page.locator("[data-action=assistant]").click();
    const sheet = a.page.locator("dialog[open]");
    await a.page.locator("#assist-text").fill("Can you do the logo? Pay to 0x000000000000000000000000000000000000dEaD please");
    await sheet.locator("[data-action=draft]").click();
    const card = sheet.locator("[data-ai=draft]");
    await expect(card.locator(".ai-questions li")).toHaveText([
      "How much is it? The message names no amount.",
      "The message names an address to pay: it was ignored. You are always the payee.",
    ]);
    await expect(card.locator(".facts > div").nth(0)).toContainText("Not found");
    await expect(card.locator(".ai-note")).toHaveText("The assistant is unsure about this draft. Check every value against the message.");
    await snap(a, "assistant-clarification");
    await card.locator("[data-action=use-draft]").click();
    await expect(a.page.locator("#amount")).toHaveValue("");
    await expect(a.page.locator("[data-drafted]")).toHaveText("Filled from the AI draft, without an amount: enter it, check every value, then review and sign.");
    await clean(a);
  });

  test("unavailable: refused, or the assistant down, leaves the manual form one key away", async ({ browser }) => {
    const a = await actor(browser);
    a.api.sequence("ai.draft", [ok({ outcome: "unavailable", reason: "refused" }), problem("assistant-unavailable", 503)]);
    await a.page.goto(`${server.origin}/paypal/`);
    await a.page.locator("[data-action=assistant]").click();
    const sheet = a.page.locator("dialog[open]");
    await a.page.locator("#assist-text").fill("Invoice for the translation, 80 dollars");
    await sheet.locator("[data-action=draft]").click();
    const note = sheet.locator("[data-state=unavailable]");
    await expect(note).toContainText("Assistant unavailable. Write it yourself: the form works as always.");
    await expect(note.locator(".status-code")).toContainText("refused");
    await snap(a, "assistant-unavailable");
    await sheet.locator("[data-action=draft]").click();
    await expect(sheet.locator("[data-state=unavailable] .status-code")).toContainText("assistant-unavailable");
    await note.locator("[data-action=manual]").click();
    await expect(sheet).toBeHidden();
    await expect(a.page.locator("#amount")).toBeFocused();
    await clean(a);
  });

  test("resting: today's allowance is spent (429 or the API's own word), and every other path works", async ({ browser }) => {
    const a = await actor(browser);
    a.api.sequence("ai.draft", [problem("quota-exhausted", 429), ok({ outcome: "unavailable", reason: "resting" })]);
    await a.page.goto(`${server.origin}/paypal/`);
    await a.page.locator("[data-action=assistant]").click();
    const sheet = a.page.locator("dialog[open]");
    await a.page.locator("#assist-text").fill("Invoice for the translation, 80 dollars");
    await sheet.locator("[data-action=draft]").click();
    await expect(sheet.locator("[data-state=resting]")).toContainText("Assistant resting. Today's allowance is used up.");
    await snap(a, "assistant-resting");
    await sheet.locator("[data-action=draft]").click();
    await expect(sheet.locator("[data-state=resting] .status-code")).toContainText("resting");
    await clean(a);
  });
});

// ------------------------------------------------------------------------------------------- twin panel

test.describe("create: the twin panel (F1)", () => {
  test("creating, then created and read back from PayPal: UNPAID, the number, the amount; the request is the link as shared", async ({ browser }) => {
    const a = await actor(browser);
    const link = await createInvoice(a, "120", "Logo design");
    const key = await lastKey(a.page);
    a.api.on("twin.create", ok(twin(key), 201, 1200));
    const panel = a.page.locator("section.twin");
    await panel.locator("#twin-name").fill("Sarah");
    await panel.locator("#twin-email").fill("sarah@example.com");
    await panel.locator("#twin-due").fill(inDays(10));
    await panel.locator("[data-action=make-twin]").click();
    await expect(panel).toHaveAttribute("data-state", "creating");
    await expect(panel.locator("[data-action=make-twin]")).toHaveAttribute("aria-busy", "true");
    await snap(a, "twin-creating", panel);
    await expect(panel).toHaveAttribute("data-state", "created");
    const readout = panel.locator(".twin-readout");
    await expect(readout).toHaveAttribute("data-status", "UNPAID");
    await expect(readout.locator(".twin-number")).toHaveText(numberOf(key));
    await expect(readout.locator(".readings")).toContainText("120.00 USD");
    await expect(panel.locator(".status")).toHaveText(`PayPal twin ${numberOf(key)} made and read back from PayPal.`);
    await snap(a, "twin-created", panel);
    expect(a.api.to("twin.create").map((c) => c.body)).toEqual([{ link, recipient: { givenName: "Sarah", email: "sarah@example.com" }, dueDate: inDays(10) }]);
    // The panel never changes the signed invoice: no new signature, no transaction (the session's one signature aside).
    expect(a.wallet.requests.filter((r) => r.method === "eth_signTypedData_v4")).toHaveLength(2);
    expect(sent(a.wallet)).toBe(0);
    await noAiOnMoneyScreens(a.page);
    await clean(a);
  });

  test("PayPal unavailable: the invoice stays valid, and Retry makes the twin when PayPal answers", async ({ browser }) => {
    const a = await actor(browser);
    await createInvoice(a, "45.5", "Translation, 3 pages");
    const key = await lastKey(a.page);
    a.api.sequence("twin.create", [problem("paypal-unavailable", 503), ok(twin(key, { amount: "45.50", status: "SENT" }), 201)]);
    const panel = a.page.locator("section.twin");
    await panel.locator("[data-action=make-twin]").click();
    await expect(panel).toHaveAttribute("data-state", "paypal-unavailable");
    await expect(panel.locator(".status")).toContainText("PayPal did not answer. Your invoice is valid and payable in dollars now");
    await expect(panel.locator("[data-action=make-twin]")).toHaveText("Try PayPal again");
    await expect(a.page.locator(".ticket")).toBeVisible();
    await snap(a, "twin-paypal-unavailable", panel);
    await panel.locator("[data-action=make-twin]").click();
    await expect(panel).toHaveAttribute("data-state", "created");
    await expect(panel.locator(".twin-readout")).toHaveAttribute("data-status", "SENT");
    await clean(a);
  });

  test("hands off (S0): PayPal's copy does not match, so the pay page will not offer PayPal", async ({ browser }) => {
    const a = await actor(browser);
    await createInvoice(a, "120", "Logo design");
    const key = await lastKey(a.page);
    a.api.on("twin.create", ok(twin(key, { status: "DRAFT", statusClass: "not-sent", situation: "S0" }), 200));
    const panel = a.page.locator("section.twin");
    await panel.locator("[data-action=make-twin]").click();
    await expect(panel).toHaveAttribute("data-state", "hands-off");
    await expect(panel.locator(".status.err")).toContainText("PayPal's copy does not match this invoice");
    await expect(panel.locator(".twin-readout")).toHaveAttribute("data-status", "DRAFT");
    await snap(a, "twin-hands-off", panel);
    await clean(a);
  });

  test("refused: the API's rule in fixed words with its code; not eligible: an open amount gets no twin and no call", async ({ browser }) => {
    const a = await actor(browser);
    await createInvoice(a, "120", "Logo design");
    a.api.on("twin.create", problem("conflict", 409, "E_TWIN_EXPIRED"));
    const panel = a.page.locator("section.twin");
    await panel.locator("[data-action=make-twin]").click();
    await expect(panel).toHaveAttribute("data-state", "error");
    await expect(panel.locator(".status.err")).toContainText("The invoice has expired.");
    await expect(panel.locator(".status .code")).toHaveText("Error code E_TWIN_EXPIRED");
    await snap(a, "twin-error", panel);
    const calls = a.api.calls.length;
    await a.page.goto(`${server.origin}/paypal/`);
    await a.page.locator("#memo").fill("Tips jar");
    await a.page.locator("label:has(input[name=payments][value=unlimited])").click();
    await createInvoice(a, "", "Tips jar", { fill: false });
    await expect(a.page.locator("section.twin")).toHaveAttribute("data-state", "ineligible");
    await expect(a.page.locator("section.twin")).toContainText("cannot have a PayPal twin");
    expect(a.api.calls.length).toBe(calls);
    await clean(a);
  });
});

// ------------------------------------------------------------------------------------------- rail chooser and till

test.describe("pay: the rail chooser (F2, F3) and the till (F4)", () => {
  let link: string;
  let key: InvoiceKey;
  let pyusdLink: string;

  test.beforeAll(async ({ browser }) => {
    const payee = await actor(browser);
    link = await createInvoice(payee, "120", "Logo design");
    key = await lastKey(payee.page);
    pyusdLink = await createInvoice(payee, "12.5", "Icon set", { token: "PYUSD" });
    await payee.context.close();
  });

  async function payPage(browser: Browser, url: string, answer: ApiAnswer, options: { phone?: boolean; scheme?: "light" | "dark" } = {}): Promise<Actor> {
    const a = await actor(browser, ACCOUNTS.payer, options);
    a.api.on("rails.get", answer);
    await a.page.goto(url);
    await expect(a.page.locator(".vstrip > li").nth(3)).toHaveAttribute("data-lamp", "ok");
    return a;
  }

  test("both rails: Pay with PayPal beside the token key, once the lamps are green; it goes top level to PayPal's page", async ({ browser }) => {
    const a = await payPage(browser, link, ok(rails({ status: "open", amount: "120.00", currency: "USD", url: PAYER_PAGE, checkedAt: new Date().toISOString() })));
    const chooser = a.page.locator(".rails");
    await expect(chooser).toHaveAttribute("data-rails", "both");
    const paypal = chooser.locator("[data-action=pay-paypal]");
    await expect(paypal).toHaveAttribute("href", PAYER_PAGE);
    await expect(paypal).toHaveAttribute("rel", "noopener noreferrer");
    await expect(paypal).not.toHaveAttribute("target", /.+/);
    await expect(paypal).toContainText("Pay with PayPal");
    await expect(chooser.locator(".route-note")).toContainText("On PayPal's page · sandbox · 120.00 USD checked against the signed invoice");
    await expect(chooser.locator(".rails-or")).toHaveText("or in USDC from your wallet");
    // PayPal is the primary key; the token rail is the page's own key, the second way (a payer without a wallet, the
    // judges' path B, meets PayPal first). The page asked the public route about this link's key only.
    await expect(paypal).toHaveClass(/\bkey-primary\b/);
    const tokenKey = a.page.locator(".payform > .key");
    await expect(tokenKey).toHaveClass(/\bkey-line\b/);
    await expect(tokenKey).not.toHaveClass(/\bkey-primary\b/);
    await expect(tokenKey).toHaveText("Or pay in USDC from a wallet");
    await expect(tokenKey).toBeEnabled();
    expect(await paypal.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(await tokenKey.evaluate((el) => el.getBoundingClientRect().top));
    expect(a.api.to("rails.get").map((c) => c.params["key"])).toEqual([key]);
    expect(a.api.to("rails.get")[0]?.token).toBeNull();
    await noAiOnMoneyScreens(a.page);
    await snap(a, "rails-both");
    await clean(a);
    // A top-level navigation (no frame, no window name): COOP same-origin, form-action 'none' and frame-ancestors 'none'
    // do not stand in its way (docs/paypal/SPEC.md §12.3).
    await paypal.click();
    await a.page.waitForURL(PAYER_PAGE);
    await expect(a.page.locator("p")).toHaveText("PayPal's payer page");
  });

  test("withheld: a host that is not PayPal's sandbox, plain http, a port or another amount hide PayPal and say why", async ({ browser }) => {
    for (const [url, amount] of [
      ["https://www.paypal.com.evil.example/invoice/p/#X", "120.00"],
      ["https://www.paypal.com/invoice/p/#X", "120.00"],
      ["http://www.sandbox.paypal.com/invoice/p/#X", "120.00"],
      ["https://www.sandbox.paypal.com:8443/invoice/p/#X", "120.00"],
      [PAYER_PAGE, "12.00"],
      [PAYER_PAGE, "120.001"],
    ] as const) {
      const a = await payPage(browser, link, ok(rails({ status: "open", amount, currency: "USD", url, checkedAt: new Date().toISOString() })));
      const chooser = a.page.locator(".rails");
      const reason = url === PAYER_PAGE ? "amount" : "host";
      await expect(chooser, `${url} ${amount}`).toHaveAttribute("data-rails", `hidden-${reason}`);
      await expect(chooser.locator(`[data-withheld=${reason}]`)).toContainText("PayPal option withheld.");
      await expect(chooser.locator("a")).toHaveCount(0);
      await expect(a.page.locator(".payform > .key")).toBeEnabled();
      if (reason === "host" && url.includes("evil")) {
        await snap(a, "rails-withheld");
      }
      await a.context.close();
    }
  });

  test("hidden: no twin, or the API not answering, leaves the token rail alone", async ({ browser }) => {
    for (const answer of [ok(rails({ status: "none" })), { abort: true } as const, problem("internal", 500), ok(rails({ status: "closed" }))]) {
      const a = await payPage(browser, link, answer);
      const chooser = a.page.locator(".rails");
      await expect(chooser).toHaveAttribute("data-rails", /^hidden-(none|closed)$/);
      await expect(chooser).toHaveText("");
      await expect(a.page.locator(".payform > .key")).toBeEnabled();
      await a.context.close();
    }
  });

  test("PayPal says paid (advisory): the token key waits until the payer says they did not pay on PayPal", async ({ browser }) => {
    const a = await payPage(browser, link, ok(rails({ status: "paid", amount: "120.00", currency: "USD", url: null, checkedAt: new Date().toISOString() })));
    const chooser = a.page.locator(".rails");
    await expect(chooser).toHaveAttribute("data-rails", "paid");
    await expect(chooser.locator("[data-hold=paid]")).toContainText("PayPal says this invoice is paid.");
    const key = a.page.locator(".payform > .key");
    await expect(key).toHaveText(/Payment locked/);
    await snap(a, "rails-paid");
    await chooser.locator("[data-action=not-paid-on-paypal]").check();
    await expect(key).not.toHaveText(/Payment locked/);
    await chooser.locator("[data-action=not-paid-on-paypal]").uncheck();
    await expect(key).toHaveText(/Payment locked/);
    await clean(a);
  });

  test("a PayPal payment in flight: neither rail until it completes", async ({ browser }) => {
    const a = await payPage(browser, link, ok(rails({ status: "pending", amount: "120.00", currency: "USD", url: null, checkedAt: new Date().toISOString() })));
    const chooser = a.page.locator(".rails");
    await expect(chooser).toHaveAttribute("data-rails", "pending");
    await expect(chooser.locator("[data-hold=pending]")).toContainText("A PayPal payment is in progress.");
    await expect(chooser.locator("a")).toHaveCount(0);
    await expect(a.page.locator(".payform > .key")).toHaveText(/Payment locked/);
    await snap(a, "rails-pending");
    await clean(a);
  });

  test("the token paused or an address frozen by its issuer: fixed words, and the token key waits", async ({ browser }) => {
    for (const [selector, hold, words] of [
      ["0x5c975abb", "paused", "USDC is paused by its issuer."],
      ["0xfe575a87", "frozen", "Address frozen by the issuer."],
    ] as const) {
      const a = await actor(browser, ACCOUNTS.payer);
      a.api.on("rails.get", ok(rails({ status: "open", amount: "120.00", currency: "USD", url: PAYER_PAGE, checkedAt: new Date().toISOString() })));
      // USDC's own controls, answered as the issuer set them: paused(), or isBlacklisted(payee).
      a.rpc.current = ({ method, params }) => {
        const call = params[0] as { to?: string; data?: string } | undefined;
        if (method === "eth_call" && call?.to?.toLowerCase() === USDC.address.toLowerCase() && call.data?.startsWith(selector) === true) {
          return `0x${"0".repeat(63)}1`;
        }
        return undefined;
      };
      await a.page.goto(link);
      const chooser = a.page.locator(".rails");
      await expect(chooser.locator(`[data-hold=${hold}]`)).toContainText(words);
      await expect(a.page.locator(".payform > .key")).toHaveText(/Payment locked/);
      await snap(a, `rails-${hold}`);
      await a.context.close();
    }
  });

  test("pays in PayPal USD from the payer's own wallet on Ethereum Sepolia: one authorisation, one transaction, the receipt", async ({ browser }) => {
    const a = await payPage(browser, pyusdLink, ok(rails({ status: "none" })));
    const before = await chain.balanceOf(PYUSD.address, ACCOUNTS.payee);
    const key = a.page.locator(".payform > .key");
    await key.click(); // connect
    await expect(key).toContainText("Pay 12.50 PYUSD");
    await expect(a.page.locator(".route-note")).toHaveText("One signature, then one transaction with your own network fee.");
    await key.click();
    await expect(a.page.locator(".receipt-slot .receipt")).toContainText("Approved");
    expect((await chain.balanceOf(PYUSD.address, ACCOUNTS.payee)) - before).toBe(12_500_000n);
    expect(await chain.balanceOf(PYUSD.address, ACCOUNTS.payer)).toBeLessThan(PAYER_FUNDS);
    const tx = a.wallet.sent()[0]?.params[0] as { to: string; data: Hex };
    expect(tx.to.toLowerCase()).toBe(PAYLINK.toLowerCase());
    expect(decodeFunctionData({ abi: payLinkAbi, data: tx.data }).functionName).toBe("payWithAuthorization");
    await noAiOnMoneyScreens(a.page);
    await snap(a, "pay-pyusd-receipt");
    await clean(a);
  });

  test("the till lights via PAYPAL only on PayPal's own PAID at the exact amount, never on an echo, and names it", async ({ browser }) => {
    const a = await actor(browser);
    const states = [
      ok(twin(key)),
      ok(twin(key, { status: "PAID", statusClass: "paid", situation: "S8" })),
      ok(twin(key, { status: "PAID", statusClass: "paid", situation: "S2", amount: "119.00" })),
      ok(twin(key, { status: "PAID", statusClass: "paid", situation: "S2", checkedAt: "2026-10-22T11:02:31.000Z" })),
    ];
    a.api.sequence("twin.get", states);
    const fragment = link.split("#")[1] ?? "";
    await a.page.goto(`${server.origin}/paypal/till/#${fragment}`);
    const line = a.page.locator(".till-paypal");
    // No session on this device yet: one key opens it (a signature, no transaction); nothing is read before.
    await expect(line).toHaveAttribute("data-paypal", "no-session");
    await line.locator("[data-action=watch-paypal]").click();
    await expect(line).toHaveAttribute("data-paypal", "watching");
    expect(a.api.to("twin.get")).toHaveLength(0);
    await a.page.locator(".view-till > .key-primary").click();
    const till = a.page.locator(".till");
    await expect(till).toHaveAttribute("data-state", "paid", { timeout: 30_000 });
    await expect(a.page.locator(".till-source")).toHaveAttribute("data-source", "PAYPAL");
    await expect(a.page.locator(".till-source")).toContainText("via PAYPAL · verified with PayPal");
    await expect(a.page.locator(".till-figure")).toContainText("120.00");
    await expect(a.page.locator(".till-figure .unit")).toHaveText("USD");
    // Three reads did not light it (open, an echo, another amount); the fourth did.
    expect(a.api.to("twin.get").length).toBe(4);
    expect(sent(a.wallet)).toBe(0);
    await noAiOnMoneyScreens(a.page);
    await snap(a, "till-paid-paypal");
    await clean(a);
  });

  test("the till lights via the token from the chain's own receipt, and names it", async ({ browser }) => {
    const payee = await actor(browser);
    const fresh = await createInvoice(payee, "33", "Poster print");
    await payee.page.goto(`${server.origin}/paypal/till/#${fresh.split("#")[1] ?? ""}`);
    // Without a desk session the PayPal line offers one; the chain is watched either way.
    await expect(payee.page.locator(".till-paypal")).toHaveAttribute("data-paypal", /^(no-session|watching)$/);
    await payee.page.locator(".view-till > .key-primary").click();
    await expect(payee.page.locator(".till")).toHaveAttribute("data-state", "waiting");
    const payer = await payPage(browser, fresh, ok(rails({ status: "none" })));
    const key = payer.page.locator(".payform > .key");
    await key.click();
    await expect(key).toContainText("Pay 33.00 USDC");
    await key.click();
    await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
    await expect(payee.page.locator(".till")).toHaveAttribute("data-state", "paid", { timeout: 30_000 });
    await expect(payee.page.locator(".till-source")).toHaveAttribute("data-source", "USDC");
    await expect(payee.page.locator(".till-source")).toHaveText("via USDC · on the chain");
    expect(payee.api.to("twin.get")).toHaveLength(0);
    await noAiOnMoneyScreens(payee.page);
    await snap(payee, "till-paid-chain");
    await clean(payee);
    await clean(payer);
  });
});

// ------------------------------------------------------------------------------------------- desk

test.describe("desk (F5)", () => {
  const A = keyOf(0xa1);
  const B = keyOf(0xb2);
  const C = keyOf(0xc3);
  const D = keyOf(0xd4);
  const MESSAGE = "Bonjour Claire, petit rappel pour la facture PL-11155111-c3c3c3c3c3c3 de 120.00 USD. Merci !";

  function fullDesk(): ReturnType<typeof desk> {
    return desk({
      alerts: [alert(D), alert(C, { situation: "S0", code: "amount-mismatch" })],
      proposals: [
        proposal(A, { kind: "cancel_paypal", reasonCode: "chain-cancelled" }),
        proposal(B, { kind: "send_reminder", reasonCode: "reminder-due", situation: "S1", exact: [{ label: "invoice", value: numberOf(B) }, { label: "amount", value: "120.00 USD" }, { label: "action", value: "send_reminder" }, { label: "effect", value: "paypal-sends-its-reminder" }, { label: "due", value: "2026-10-30" }] }),
        proposal(C, {
          kind: "share_reminder_text",
          reasonCode: "share-reminder",
          origin: "assistant",
          situation: "S1",
          message: { text: MESSAGE, language: "fr", grounded: true },
          exact: [{ label: "invoice", value: numberOf(C) }, { label: "amount", value: "120.00 USD" }, { label: "action", value: "share_reminder_text" }, { label: "effect", value: "you-share-the-text" }],
        }),
      ],
      autoRecords: [autoRecord(keyOf(0xe5)), autoRecord(keyOf(0xf6), { id: "r_EXTR-OLD", paymentId: "EXTR-OLD", undoUntil: new Date(Date.now() - 3_600_000).toISOString() })],
    });
  }

  test("no session: one signature opens the desk (no transaction, no fee), then it reads", async ({ browser }) => {
    const a = await actor(browser);
    a.api.on("desk.get", ok(desk()));
    await a.page.goto(`${server.origin}/paypal/desk/`);
    const view = a.page.locator(".view-desk");
    await view.locator("[data-action=connect]").click();
    await expect(view).toHaveAttribute("data-desk", "no-session");
    await expect(view.locator(".empty-state")).toContainText("no transaction, no fee, valid 12 hours");
    await snap(a, "desk-no-session");
    await view.locator("[data-action=open-session]").click();
    await expect(view).toHaveAttribute("data-desk", "ready");
    await expect(view.locator(".desk-empty")).toHaveText("Nothing to approve. Every invoice agrees on both rails.");
    expect(a.api.to("session.create")).toHaveLength(1);
    expect(a.api.to("desk.get")[0]?.token).toMatch(/^ps1\.e2e-/);
    expect(sent(a.wallet)).toBe(0);
    await clean(a);
  });

  test("lists alerts first, then the proposals with their exact values, then the records; the assistant's words sit apart (AI-4)", async ({ browser }) => {
    const a = await actor(browser);
    a.api.on("desk.get", ok(fullDesk()));
    const view = await openDesk(a);
    const lists = view.locator(".desk-cards");
    await expect(lists).toHaveCount(3);
    await expect(lists.nth(0).locator("> li")).toHaveCount(2);
    await expect(lists.nth(0).locator("> li").first()).toHaveAttribute("data-situation", "S4");
    await expect(lists.nth(0).locator("> li").first()).toContainText("This invoice was paid on PayPal and on the chain.");
    await expect(lists.nth(0).locator("> li").first().locator(".desk-guide li")).toHaveCount(3);
    await expect(lists.nth(0).locator("> li").first().locator("button")).toHaveCount(0);
    await expect(lists.nth(0).locator("> li").nth(1)).toHaveAttribute("data-code", "amount-mismatch");
    const cards = lists.nth(1).locator("> li");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0).locator("[data-exact] [data-label=action] dd")).toHaveText("Cancel the PayPal invoice");
    await expect(cards.nth(0).locator("[data-action=approve]")).toHaveText("Cancel on PayPal");
    await expect(cards.nth(1).locator("[data-action=approve]")).toHaveText("Send PayPal's reminder");
    await expect(cards.nth(1).locator("[data-exact] [data-label=effect] dd")).toHaveText("PayPal emails your client its standard reminder");
    await expect(cards.nth(1)).toContainText("PayPal sends its own standard wording: custom text cannot go through PayPal's reminder.");
    await expect(cards.nth(2)).toHaveAttribute("data-origin", "assistant");
    const note = cards.nth(2).locator("[data-ai=message]");
    await expect(note).toHaveAttribute("lang", "fr");
    await expect(note.locator(".ai-text")).toHaveText(MESSAGE);
    await expect(cards.nth(2).locator("[data-exact]")).not.toContainText("Bonjour");
    const records = lists.nth(2).locator("> li");
    await expect(records.nth(0)).toHaveAttribute("data-state", "undo-open");
    await expect(records.nth(0).locator("[data-action=undo]")).toHaveText(/Undo \(2[23] hours left\)/);
    await expect(records.nth(1)).toHaveAttribute("data-state", "final");
    await expect(records.nth(1).locator("button")).toHaveCount(0);
    await noAiOnMoneyScreens(a.page, [MESSAGE]);
    await snap(a, "desk-full");
    await clean(a);
  });

  test("approve: approving, then done; the request carries the proposal's own hash and approval token", async ({ browser }) => {
    const a = await actor(browser);
    const p = proposal(A);
    a.api.on("desk.get", ok(desk({ proposals: [p] })));
    a.api.on("desk.approve", ok({ state: "done", proposalId: p.id }, 200, 1200));
    const view = await openDesk(a);
    const card = view.locator(`li[data-id="${p.id}"]`);
    await card.locator("[data-action=approve]").click();
    await expect(card).toHaveAttribute("data-state", "approving");
    await expect(card.locator("[data-action=approve]")).toHaveAttribute("aria-busy", "true");
    await snap(a, "desk-approving", card);
    await expect(card).toHaveAttribute("data-state", "done");
    await expect(card.locator(".status")).toHaveText("Done. PayPal and the chain were read again first.");
    await expect(card.locator("button")).toHaveCount(0);
    await snap(a, "desk-done", card);
    const [approve] = a.api.to("desk.approve");
    expect(approve?.params).toEqual({ id: p.id });
    expect(approve?.body).toEqual({ hash: p.hash, token: p.token });
    expect(sent(a.wallet)).toBe(0);
    await clean(a);
  });

  test("stale (409): the situation changed; the card says so and reads the desk again on request", async ({ browser }) => {
    const a = await actor(browser);
    const p = proposal(A);
    a.api.sequence("desk.get", [ok(desk({ proposals: [p] })), ok(desk())]);
    a.api.on("desk.approve", problem("stale", 409, "E_STALE"));
    const view = await openDesk(a);
    const card = view.locator(`li[data-id="${p.id}"]`);
    await card.locator("[data-action=approve]").click();
    await expect(card).toHaveAttribute("data-state", "stale");
    await expect(card.locator(".status")).toContainText("The situation changed since this was proposed. Read the desk again.");
    await snap(a, "desk-stale", card);
    await card.locator("[data-action=reload]").click();
    await expect(view.locator(".desk-empty")).toBeVisible();
    expect(a.api.to("desk.get")).toHaveLength(2);
    await clean(a);
  });

  test("reject: the card closes, nothing is done on PayPal or the chain", async ({ browser }) => {
    const a = await actor(browser);
    const p = proposal(B, { kind: "send_reminder", reasonCode: "reminder-due" });
    a.api.on("desk.get", ok(desk({ proposals: [p] })));
    a.api.on("desk.reject", ok({ state: "rejected", proposalId: p.id }));
    const view = await openDesk(a);
    const card = view.locator(`li[data-id="${p.id}"]`);
    await card.locator("[data-action=reject]").click();
    await expect(card).toHaveAttribute("data-state", "rejected");
    await expect(card.locator("button")).toHaveCount(0);
    await snap(a, "desk-rejected", card);
    expect(a.api.to("desk.approve")).toHaveLength(0);
    expect(a.api.to("desk.reject")[0]?.params).toEqual({ id: p.id });
    await clean(a);
  });

  test("share a reminder: after the tap, the assistant's labelled draft goes to the payee's share sheet or clipboard, never to PayPal", async ({ browser }) => {
    const a = await actor(browser);
    await a.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
    const p = proposal(C, { kind: "share_reminder_text", reasonCode: "share-reminder", origin: "assistant", message: { text: MESSAGE, language: "fr", grounded: true } });
    a.api.on("desk.get", ok(desk({ proposals: [p] })));
    a.api.on("desk.approve", ok({ state: "done", proposalId: p.id }));
    const view = await openDesk(a);
    const card = view.locator(`li[data-id="${p.id}"]`);
    await expect(card.locator("[data-action=share]")).toHaveCount(0);
    await card.locator("[data-action=approve]").click();
    await expect(card).toHaveAttribute("data-state", "done");
    await expect(card.locator(".status")).toHaveText("Approved. Share the message with your client.");
    const share = card.locator("[data-action=share]");
    await expect(share).toHaveText(/^(Share message|Copy message)$/);
    if ((await share.textContent()) === "Copy message") {
      await share.click();
      expect(await a.page.evaluate(async () => await navigator.clipboard.readText())).toBe(MESSAGE);
    }
    // The approval sent the proposal's hash and token only: the text never goes to the API, nor to PayPal (P9 ignores it).
    expect(JSON.stringify(a.api.to("desk.approve")[0]?.body)).not.toContain("Bonjour");
    await snap(a, "desk-share", card);
    await clean(a);
  });

  test("cancel the token rail: approving asks the payee's own cancel transaction, and the chain shows the link cancelled", async ({ browser }) => {
    const a = await actor(browser);
    const link = await createInvoice(a, "75", "Website audit");
    const key = await lastKey(a.page);
    const p = proposal(key, {
      kind: "cancel_paylink",
      reasonCode: "paid-on-paypal",
      situation: "S2",
      rail: "USDC",
      amount: "75.00",
      exact: [{ label: "invoice", value: numberOf(key) }, { label: "amount", value: "75.00 USD" }, { label: "action", value: "cancel_paylink" }, { label: "effect", value: "closes-the-token-rail" }, { label: "rail", value: "USDC" }],
    });
    a.api.on("desk.get", ok(desk({ proposals: [p] })));
    a.api.on("desk.approve", ok({ state: "signature-required", proposalId: p.id, cancel: { key, deadline: String(Math.floor(Date.now() / 1000) + 3600) } }));
    const view = await openDesk(a);
    const card = view.locator(`li[data-id="${p.id}"]`);
    await expect(card.locator("[data-action=approve]")).toHaveText("Approve and cancel the link");
    expect(await chain.cancelled(key)).toBe(false);
    await card.locator("[data-action=approve]").click();
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(card.locator(".status")).toHaveText("The link is cancelled on the chain. The desk closes this at its next check.");
    expect(await chain.cancelled(key)).toBe(true);
    const txs = a.wallet.sent();
    expect(txs).toHaveLength(1);
    const tx = txs[0]?.params[0] as { to: string; data: Hex; from: string };
    expect(tx.to.toLowerCase()).toBe(PAYLINK.toLowerCase());
    expect(tx.from.toLowerCase()).toBe(ACCOUNTS.payee.toLowerCase());
    expect(decodeFunctionData({ abi: payLinkAbi, data: tx.data }).functionName).toBe("cancel");
    await snap(a, "desk-cancel-done", card);
    await clean(a);
    // The chain closed the link: whatever the API says about PayPal, the pay page offers no rail (the lamps decide).
    a.api.on("rails.get", ok(rails({ status: "open", amount: "75.00", currency: "USD", url: PAYER_PAGE, checkedAt: new Date().toISOString() })));
    await a.page.goto(link);
    await expect(a.page.locator(".vstrip > li").nth(3)).toHaveAttribute("data-lamp", "err");
    await expect(a.page.locator(".rails")).toHaveAttribute("data-rails", "waiting");
    await expect(a.page.locator("[data-action=pay-paypal]")).toHaveCount(0);
  });

  test("Undo an automatic record within 24 hours: PayPal is asked to remove it, and the card says it was undone", async ({ browser }) => {
    const a = await actor(browser);
    const r = autoRecord(keyOf(0xe5));
    a.api.on("desk.get", ok(desk({ autoRecords: [r] })));
    a.api.on("desk.undo", ok({ state: "undone", key: r.key, paymentId: r.paymentId }, 200, 800));
    const view = await openDesk(a);
    const card = view.locator(`li[data-id="${r.id}"]`);
    await expect(card).toContainText(`Recorded on PayPal invoice ${r.invoiceNumber}`);
    await expect(card).toContainText("recorded on PayPal by PayLink's rules, not by the assistant");
    await snap(a, "desk-record-undo", card);
    await card.locator("[data-action=undo]").click();
    await expect(card.locator("[data-action=undo]")).toBeDisabled();
    await expect(card).toHaveAttribute("data-state", "undone");
    await expect(card.locator(".status")).toHaveText("Undone on PayPal.");
    expect(a.api.to("desk.undo")[0]?.params).toEqual({ id: r.id });
    await clean(a);
  });

  test("Check my invoices: every open twin read again, and how many; the assistant resting keeps the reconciler's own proposals", async ({ browser }) => {
    const a = await actor(browser);
    a.api.on("desk.get", ok(desk({ assistant: { available: false, reason: "resting" }, proposals: [proposal(A)] })));
    a.api.on("desk.sweep", ok({ ...desk({ proposals: [proposal(A), proposal(B, { kind: "send_reminder", reasonCode: "reminder-due" })] }), sweep: { checked: 3, remaining: 0 } }, 200, 1000));
    const view = await openDesk(a);
    await expect(view.locator(".desk-tools .pill")).toHaveText("Assistant resting");
    await expect(view.locator(".desk-tools + .field-hint")).toBeVisible();
    await snap(a, "desk-assistant-resting");
    await view.locator("[data-action=sweep]").click();
    await expect(view).toHaveAttribute("data-desk", "loading");
    await expect(view.locator(".loading")).toHaveText("Reading every open invoice again on PayPal and on the chain…");
    await expect(view).toHaveAttribute("data-desk", "ready");
    await expect(view.locator("[data-meta]")).toContainText("3 invoices read again, 0 left");
    await expect(view.locator(".desk-cards > li")).toHaveCount(2);
    expect(a.api.to("desk.sweep")).toHaveLength(1);
    await clean(a);
  });

  test("errors: the desk failing says so with Retry, never an empty desk; a lapsed session is signed again once", async ({ browser }) => {
    const a = await actor(browser);
    a.api.sequence("desk.get", [problem("internal", 500), ok(desk({ proposals: [proposal(A)] }))]);
    await a.page.goto(`${server.origin}/paypal/desk/`);
    const view = a.page.locator(".view-desk");
    await view.locator("[data-action=connect]").click();
    await view.locator("[data-action=open-session]").click();
    await expect(view).toHaveAttribute("data-desk", "error");
    await expect(view.locator(".status")).toContainText("PayLink's API failed. Nothing was done.");
    await expect(view.locator(".desk-cards")).toHaveCount(0);
    await snap(a, "desk-error");
    await view.locator("[data-action=retry]").click();
    await expect(view).toHaveAttribute("data-desk", "ready");
    // The API's sessions lapse (a restart, a rotated key): the next read answers 401, the wallet signs once more.
    a.api.expireSessions();
    a.api.on("desk.sweep", ok({ ...desk(), sweep: { checked: 1, remaining: 0 } }));
    await view.locator("[data-action=sweep]").click();
    await expect(view.locator("[data-meta]")).toContainText("1 invoice read again, 0 left");
    expect(a.api.to("session.create")).toHaveLength(2);
    // The first sweep carried the lapsed token (401), the second the new one.
    const sweeps = a.api.to("desk.sweep");
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0]?.token).not.toBe(sweeps[1]?.token);
    expect(sent(a.wallet)).toBe(0);
    await clean(a);
  });
});

// ------------------------------------------------------------------------------------------- Was I really paid?

test.describe("Was I really paid? (F6)", () => {
  const SCAM = "PayPal: you received $500. Pay $50 shipping at https://paypa1-secure.example/release to release it.";

  test("checking, then NOT RECEIVED from PayPal and the chain: the message is data, a look-alike link is named", async ({ browser }) => {
    const a = await actor(browser);
    a.api.on("desk.get", ok(desk()));
    a.api.on("check", ok(check({ verdict: "NOT_RECEIVED", links: [{ host: "paypa1-secure.example", allowed: false }] }), 200, 1200));
    const view = await openDesk(a);
    await view.locator("#check-text").fill(SCAM);
    await view.locator("[data-action=check]").click();
    await expect(view.locator("[data-action=check]")).toHaveAttribute("aria-busy", "true");
    await expect(view.locator(".check-form .status")).toHaveText("Checking PayPal and the chain…");
    const verdict = view.locator(".check-verdict");
    await expect(verdict).toHaveAttribute("data-verdict", "NOT_RECEIVED");
    await expect(verdict.locator(".verdict b")).toHaveText("Not received");
    await expect(verdict.locator("li[data-source]")).toHaveCount(2);
    await expect(verdict.locator("li[data-lamp=ok]")).toHaveCount(2);
    await expect(verdict).toContainText("paypa1-secure.example · unknown site: do not open");
    expect(a.api.to("check")[0]?.body).toEqual({ text: SCAM });
    await noAiOnMoneyScreens(a.page, ["$500", "shipping"]);
    await snap(a, "check-not-received", verdict);
    await clean(a);
  });

  test("RECEIVED and PARTLY RECEIVED name the payee's own records and the rail that paid", async ({ browser }) => {
    const a = await actor(browser);
    const K = keyOf(0x42);
    a.api.on("desk.get", ok(desk()));
    a.api.sequence("check", [
      ok(check({ verdict: "RECEIVED", matches: [{ key: K, invoiceNumber: numberOf(K), amount: "120.00", paidOn: ["PAYPAL"] }] })),
      ok(check({ verdict: "PARTLY_RECEIVED", matches: [{ key: K, invoiceNumber: numberOf(K), amount: "120.00", paidOn: [] }] })),
    ]);
    const view = await openDesk(a);
    await view.locator("#check-text").fill("Sarah: I paid invoice PL-11155111-424242424242 on PayPal");
    await view.locator("[data-action=check]").click();
    const verdict = view.locator(".check-verdict");
    await expect(verdict).toHaveAttribute("data-verdict", "RECEIVED");
    await expect(verdict).toContainText(numberOf(K));
    await expect(verdict).toContainText("120.00 USD · paid on PAYPAL");
    await snap(a, "check-received", verdict);
    await view.locator("[data-action=check]").click();
    await expect(verdict).toHaveAttribute("data-verdict", "PARTLY_RECEIVED");
    await expect(verdict.locator(".verdict b")).toHaveText("Partly received");
    await snap(a, "check-partly", verdict);
    await clean(a);
  });

  test("a source not answering, or the API, gives Can't check now: never a guess", async ({ browser }) => {
    const a = await actor(browser);
    a.api.on("desk.get", ok(desk()));
    a.api.sequence("check", [ok(check({ verdict: "NOT_RECEIVED", sources: { paypal: "unavailable", chain: "checked" } })), problem("paypal-unavailable", 503)]);
    const view = await openDesk(a);
    await view.locator("#check-text").fill("Payment received, see attachment");
    await view.locator("[data-action=check]").click();
    const verdict = view.locator(".check-verdict");
    await expect(verdict).toHaveAttribute("data-verdict", "UNAVAILABLE");
    await expect(verdict.locator(".verdict b")).toHaveText("Can't check now");
    await expect(verdict.locator("li[data-source][data-lamp=wait]")).toHaveCount(1);
    await snap(a, "check-unavailable", verdict);
    await view.locator("[data-action=check]").click();
    await expect(view.locator(".check-form .status")).toContainText("Can't check now. Nothing is concluded from the message.");
    await expect(view.locator(".check-verdict")).toHaveCount(0);
    await clean(a);
  });
});

// ------------------------------------------------------------------------------------------- ledger and status

test.describe("ledger (F7) and status (F8)", () => {
  test("the ledger's rail column: PAYPAL and the token, the twin's number, the rail that paid; the CSV adds rail and paypal_invoice", async ({ browser }) => {
    const a = await actor(browser);
    await createInvoice(a, "120", "Logo design");
    const key = await lastKey(a.page);
    a.api.on("twin.create", ok(twin(key), 201));
    await a.page.locator("section.twin [data-action=make-twin]").click();
    await expect(a.page.locator("section.twin")).toHaveAttribute("data-state", "created");
    // With the desk session open, the ledger reads the twin again: PayPal now says PAID.
    a.api.on("twin.get", ok(twin(key, { status: "PAID", statusClass: "paid", situation: "S2" })));
    await a.page.goto(`${server.origin}/paypal/ledger/`);
    const cell = a.page.locator(`[data-rail-cell="${key}"]`);
    await expect(cell.locator(".rail-tag")).toHaveText(["PAYPAL", "USDC"]);
    await expect(cell.locator(".twin-no")).toHaveText(numberOf(key));
    await expect(cell).toHaveAttribute("data-paid", "PAYPAL");
    await expect(cell.locator(".rail-tag.is-on")).toHaveText("PAYPAL");
    // Paid on PayPal (S2) while the chain is open: the row says so, never "Awaiting payment", and its amount adds up as
    // received on PayPal, apart from the chain's totals (the review of 2026-10-22).
    const row = a.page.locator("ul.links > li", { has: cell });
    await expect(row).toHaveClass(/\bis-paid\b/);
    await expect(row.locator(".row-main > .pill")).toHaveText("Paid on PayPal");
    await expect(row.locator(".row-meta")).toHaveText(`Paid on PayPal · ${numberOf(key)}`);
    await expect(a.page.locator(".tally [data-paypal-total]")).toContainText("120.00");
    await expect(a.page.locator(".tally [data-paypal-total]")).toContainText("On PayPal");
    await expect(a.page.locator(".tally-label")).toHaveText("Received on chain, all invoices");
    expect(a.api.to("twin.get").map((c) => c.params["key"])).toContain(key);
    await snap(a, "ledger-rails");
    const download = a.page.waitForEvent("download");
    await a.page.getByRole("button", { name: "Export CSV" }).click();
    const csv = await (await download).createReadStream().then(async (stream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString("utf8");
    });
    const [header, ...rows] = csv.trim().split(/\r?\n/);
    expect(header?.split(",").slice(-2)).toEqual(["rail", "paypal_invoice"]);
    expect(rows.some((row) => row.endsWith(`,PAYPAL,${numberOf(key)}`))).toBe(true);
    await clean(a);
  });

  test("Status: the API, PayPal sandbox, webhook, assistant and store rows from /v1/health, and amber when the API is silent", async ({ browser }) => {
    const a = await actor(browser);
    await a.page.goto(`${server.origin}/paypal/status/`);
    const rows = a.page.locator(".view-status > .vstrip").first().locator("li");
    await expect(rows.locator(".vstrip-name")).toHaveText(["Relayer", "History service", "PayLink API", "PayPal sandbox", "PayPal webhook", "Assistant", "API store"]);
    await expect(rows.nth(2)).toContainText("Online · 0.1.0 · contract 1");
    await expect(rows.nth(3)).toHaveAttribute("data-lamp", "ok");
    await expect(rows.nth(3)).toContainText("Last read from PayPal");
    await expect(rows.nth(4)).toContainText("Last verified webhook");
    await expect(rows.nth(5)).toContainText("Cloudflare Workers AI · @cf/google/gemma-4-26b-a4b-it · 7,450 of 9,000 neurons left today");
    await expect(rows.nth(6)).toContainText("Readable");
    await snap(a, "status-rows");
    // Today's allowance spent: the assistant row says it rests, and the manual paths keep working.
    a.api.on("health", ok(health({ rows: health().rows.map((r) => (r.id === "assistant" ? { ...r, state: "degraded" as const, code: "resting", values: { dailyNeuronBudget: 9000, neuronsLeft: 12 } } : r)) })));
    await a.page.reload();
    await expect(rows.nth(5)).toHaveAttribute("data-lamp", "wait");
    await expect(rows.nth(5)).toContainText("Resting until 00:00 UTC: today's 9,000 neurons are spent. Every manual path works.");
    a.api.on("health", { abort: true });
    await a.page.reload();
    await expect(rows.nth(2)).toHaveAttribute("data-lamp", "err");
    for (const i of [3, 4, 5, 6]) {
      await expect(rows.nth(i)).toHaveAttribute("data-lamp", "wait");
      await expect(rows.nth(i)).toContainText("Unknown");
    }
    await clean(a);
  });
});

// ------------------------------------------------------------------------------------------- accessibility

for (const locale of ["en", "fr", "mg"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`axe at 320 px in ${locale}, ${scheme}: the draft card, the twin, both rails, the full desk with a verdict, the till and Status`, async ({ browser }) => {
      test.setTimeout(180_000);
      const a = await actor(browser, ACCOUNTS.payee, { phone: true, scheme });
      await a.page.goto(`${server.origin}/paypal/`);
      await setLocale(a.page, locale);
      const audit = async (where: string): Promise<void> => {
        expect(await axe(a.page), `${where} ${locale} ${scheme}`).toEqual([]);
        expect(await horizontalOverflow(a.page), `${where} ${locale} ${scheme}`).toBeLessThanOrEqual(0);
      };
      // Create: the assistant sheet with a draft and its questions.
      a.api.on("ai.draft", ok(draftAnswer({ clarifications: ["due_date_unclear"] })));
      await a.page.goto(`${server.origin}/paypal/`);
      await a.page.locator("[data-action=assistant]").click();
      await a.page.locator("#assist-text").fill("Love it! Send me the invoice, $120.");
      await a.page.locator("dialog[open] [data-action=draft]").click();
      await expect(a.page.locator("dialog[open] [data-ai=draft]")).toBeVisible();
      await audit("assistant draft");
      await a.page.locator("dialog[open] [data-action=use-draft]").click();
      await a.page.locator("#amount").fill("120");
      const link = await createInvoice(a, "120", "", { fill: false });
      const key = await lastKey(a.page);
      // The twin panel ready (its key the primary one, the longest label of the page in Malagasy), then created.
      await expect(a.page.locator("section.twin")).toHaveAttribute("data-state", "ready");
      await audit("twin ready");
      a.api.on("twin.create", ok(twin(key), 201));
      await a.page.locator("section.twin [data-action=make-twin]").click();
      await expect(a.page.locator("section.twin")).toHaveAttribute("data-state", "created");
      await audit("twin created");
      // The ledger with that invoice paid on PayPal (S2).
      a.api.on("twin.get", ok(twin(key, { status: "PAID", statusClass: "paid", situation: "S2" })));
      await a.page.goto(`${server.origin}/paypal/ledger/`);
      await expect(a.page.locator(`[data-rail-cell="${key}"]`)).toHaveAttribute("data-paid", "PAYPAL");
      await audit("ledger");
      // Pay: both rails.
      a.api.on("rails.get", ok(rails({ status: "open", amount: "120.00", currency: "USD", url: PAYER_PAGE, checkedAt: new Date().toISOString() })));
      await a.page.goto(link);
      await expect(a.page.locator(".rails")).toHaveAttribute("data-rails", "both");
      await audit("pay, both rails");
      // Till, armed, with the PayPal line.
      await a.page.goto(`${server.origin}/paypal/till/#${link.split("#")[1] ?? ""}`);
      await expect(a.page.locator(".till-paypal")).toHaveAttribute("data-paypal", /^(watching|no-session)$/);
      await audit("till");
      // Desk: alerts, proposals with the assistant's note, records, and a verdict.
      const D = keyOf(0xd4);
      a.api.on("desk.get", ok(desk({
        alerts: [alert(D), alert(keyOf(0xc3), { situation: "S0", code: "paypal-unreadable" }), alert(keyOf(0x97), { situation: "S3", code: "record-missing" })],
        proposals: [
          proposal(keyOf(0xa1)),
          proposal(keyOf(0xb2), { kind: "share_reminder_text", origin: "assistant", reasonCode: "share-reminder", message: { text: "Hello Sarah, a friendly reminder about invoice PL-11155111-b2b2b2b2b2b2 for 120.00 USD.", language: "en", grounded: true } }),
          // PayPal's own reminder: its key is the desk's longest label in Malagasy ("Alefaso ny fampahatsiahivan'ny PayPal").
          proposal(keyOf(0xf6), { kind: "send_reminder", situation: "S1", reasonCode: "reminder-due" }),
        ],
        autoRecords: [autoRecord(keyOf(0xe5))],
      })));
      a.api.on("check", ok(check({ links: [{ host: "paypa1-secure.example", allowed: false }] })));
      const view = await openDesk(a);
      await view.locator("#check-text").fill("PayPal: you received $500");
      await view.locator("[data-action=check]").click();
      await expect(view.locator(".check-verdict")).toBeVisible();
      await audit("desk");
      await a.page.goto(`${server.origin}/paypal/status/`);
      await expect(a.page.locator(".view-status > .vstrip").first().locator("li").nth(3)).toHaveAttribute("data-lamp", "ok");
      await audit("status");
      await clean(a);
    });
  }
}
