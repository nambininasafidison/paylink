// SPDX-License-Identifier: MIT
/**
 * Records the PayLink Twin demo's raw material (the PayPal edition): two phones, the seller on the left and the client
 * on the right, driving the deployed production build at https://paypal.paylink-mg.pages.dev/paypal/ with its real
 * API (Cloudflare Workers AI, the PayPal sandbox), like record.spec.ts. The wallets are video/key-wallet.ts: test keys
 * that sign in Node. VIDEO_ROUTE=live sends their transactions to the real Ethereum Sepolia; VIDEO_ROUTE=fork to an
 * anvil fork of it (the page's Sepolia RPC is routed there too). Each phone's screen is captured with CDP screencast
 * frames (timestamped); captions, taps and the values shown on screen are logged on the same clock, for the
 * compositor (video/compose/). VIDEO_KEYS=<dir with seller.json, client.json>, VIDEO_OUT=<dir>, VIDEO_STOP=<beat>.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devices, expect, test } from "@playwright/test";
import type { Browser, BrowserContext, CDPSession, Locator, Page, Route } from "@playwright/test";
import { installKeyWallet } from "./key-wallet.ts";
import type { KeyWallet } from "./key-wallet.ts";

const ORIGIN = "https://paypal.paylink-mg.pages.dev";
const SITE = `${ORIGIN}/paypal`;
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const ROUTE = process.env["VIDEO_ROUTE"] ?? "live";
const KEYS = process.env["VIDEO_KEYS"] ?? "";
const OUT = process.env["VIDEO_OUT"] ?? "/tmp/paylink-video";
const STOP = Number(process.env["VIDEO_STOP"] ?? "99");
const FRAMES = join(OUT, "frames");
const SHOTS = join(OUT, "shots");
const PHONE = { width: 390, height: 844 } as const;
const now = (): number => Date.now() / 1000;
const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

type Side = "L" | "R";
const events: { t: number; kind: string; side?: Side; id?: string; x?: number; y?: number; value?: string }[] = [];
const frames: Record<Side, { t: number; f: string }[]> = { L: [], R: [] };
let counter = 0;
const contexts: BrowserContext[] = [];
let anvil: ChildProcess | null = null;
let rpcUrl = SEPOLIA_RPC;

test.describe.configure({ mode: "serial" });

async function jsonRpc(url: string, method: string, params: readonly unknown[] = []): Promise<unknown> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) {
    throw new Error(`${method}: ${body.error.message}`);
  }
  return body.result;
}

test.beforeAll(async () => {
  mkdirSync(FRAMES, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  if (ROUTE === "fork") {
    const port = 18545;
    rpcUrl = `http://127.0.0.1:${String(port)}`;
    anvil = spawn(`${process.env["HOME"] ?? "/root"}/.foundry/bin/anvil`, ["--fork-url", SEPOLIA_RPC, "--port", String(port), "--block-time", "2", "--silent"], { stdio: "ignore" });
    for (let i = 0; ; i += 1) {
      try {
        await jsonRpc(rpcUrl, "eth_chainId");
        break;
      } catch (error) {
        if (i > 120) {
          throw error;
        }
        await sleep(500);
      }
    }
    const seller = process.env["VIDEO_SELLER"] ?? "";
    const client = process.env["VIDEO_CLIENT"] ?? "";
    await jsonRpc(rpcUrl, "anvil_setBalance", [seller, "0xE35FA931A000"]); // 0.00025 ETH
    await jsonRpc(rpcUrl, "anvil_setBalance", [client, "0xE35FA931A000"]);
    await jsonRpc(rpcUrl, "anvil_dealERC20", ["0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", client, "0x1312D00"]); // 20.00 USDC
  }
});

test.afterAll(async () => {
  for (const context of contexts) {
    await context.close().catch(() => undefined);
  }
  anvil?.kill();
  writeFileSync(join(OUT, "events.json"), JSON.stringify({ route: ROUTE, events, frames }, null, 1));
});

interface Phone {
  readonly context: BrowserContext;
  page: Page;
  readonly side: Side;
  cdp: CDPSession | null;
  wallet: KeyWallet | null;
}

async function phone(browser: Browser, side: Side, key: string | null): Promise<Phone> {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", locale: "en-US", serviceWorkers: "block", timezoneId: "Indian/Antananarivo", userAgent: devices["Pixel 7"].userAgent, permissions: ["clipboard-read", "clipboard-write"] });
  contexts.push(context);
  if (ROUTE === "fork") {
    await context.route(`${SEPOLIA_RPC}/**`, async (route: Route) => {
      const request = route.request();
      const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: request.postData() ?? "{}" });
      await route.fulfill({ status: response.status, headers: { ...cors, "content-type": "application/json" }, body: await response.text() });
    });
  }
  const page = await context.newPage();
  const p: Phone = { context, page, side, cdp: null, wallet: null };
  if (key !== null) {
    p.wallet = await installKeyWallet(page, join(KEYS, `${key}.json`), rpcUrl);
  }
  page.on("pageerror", (e) => {
    console.log(`[${side}] pageerror: ${e.message.slice(0, 200)}`);
  });
  return p;
}

/** Starts the screencast of a phone's page; frames land in FRAMES with the browser's own timestamps. */
async function film(p: Phone): Promise<void> {
  const cdp = await p.context.newCDPSession(p.page);
  p.cdp = cdp;
  cdp.on("Page.screencastFrame", (e: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const f = `${p.side}-${String(counter++).padStart(6, "0")}.jpg`;
    writeFileSync(join(FRAMES, f), Buffer.from(e.data, "base64"));
    frames[p.side].push({ t: e.metadata.timestamp ?? now(), f });
    void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 });
}
async function cut(p: Phone): Promise<void> {
  await p.cdp?.send("Page.stopScreencast").catch(() => undefined);
  await p.cdp?.detach().catch(() => undefined);
  p.cdp = null;
}
/** After a cross-site navigation the renderer may change: film the page again. */
async function refilm(p: Phone): Promise<void> {
  await cut(p);
  await film(p);
}

let capStart = 0;
let capMin = 0;
/** A caption starts now; the previous one is held until its minimum time has passed. */
async function cap(id: string, minSeconds: number): Promise<void> {
  const rest = capStart + capMin - now();
  if (capStart > 0 && rest > 0) {
    await sleep(rest * 1000);
  }
  capStart = now();
  capMin = minSeconds;
  events.push({ t: capStart, kind: "cap", id });
}
async function settle(): Promise<void> {
  const rest = capStart + capMin - now();
  if (rest > 0) {
    await sleep(rest * 1000);
  }
}
/** The compositor plays real time faster from here (a wait: the chain, PayPal, the model), until speed 1 again. */
function speed(factor: number): void {
  events.push({ t: now(), kind: "speed", value: String(factor) });
}
function value(id: string, v: string): void {
  events.push({ t: now(), kind: "value", id, value: v });
  console.log(`value ${id}: ${v}`);
}
async function shot(p: Phone, name: string): Promise<void> {
  await p.page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => undefined);
}

async function show(locator: Locator, block: "center" | "start" | "end" = "center", wait = 700): Promise<void> {
  await locator.first().evaluate((e, b) => {
    e.scrollIntoView({ behavior: "smooth", block: b });
  }, block);
  await sleep(wait);
}
async function tap(p: Phone, locator: Locator, after = 500): Promise<void> {
  const el = locator.first();
  await el.scrollIntoViewIfNeeded();
  await sleep(250);
  const box = await el.boundingBox();
  if (box !== null) {
    events.push({ t: now(), kind: "tap", side: p.side, x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  await sleep(380);
  await el.click();
  await sleep(after);
}
async function typeIn(p: Phone, locator: Locator, text: string, delay = 45): Promise<void> {
  await tap(p, locator, 150);
  await locator.first().fill("");
  await locator.first().pressSequentially(text, { delay });
  await sleep(300);
}
/** Answers the wallet chooser if the page shows one (EIP-6963: the test wallet). */
async function chooseWallet(p: Phone): Promise<void> {
  const choice = p.page.locator("dialog[open]").getByRole("button", { name: /Test Wallet/u });
  if (await choice.isVisible().catch(() => false)) {
    await tap(p, choice, 400);
  }
}

test("record", async ({ browser }) => {
  test.skip(process.env["VIDEO_CLEANUP"] === "1");
  test.setTimeout(1_500_000);
  await recordTwin(browser);
  events.push({ t: now(), kind: "end" });
});

async function recordTwin(browser: Browser): Promise<void> {
  const seller = await phone(browser, "L", "seller");
  await seller.page.goto(`${SITE}/`);
  await expect(seller.page.locator("#amount")).toBeVisible();
  await seller.page.locator(".view-create").first().evaluate((e) => {
    e.scrollIntoView({ block: "start" });
  });
  await sleep(800);
  await film(seller);
  await sleep(1000);

  // 02: the assistant drafts from the client's message; the desk session is one typed-data signature.
  await cap("p02", 9);
  await tap(seller, seller.page.locator("[data-action=assistant]"), 700);
  const sheet = seller.page.locator("dialog.assist-dialog");
  await expect(sheet).toBeVisible();
  await typeIn(seller, sheet.locator("#assist-text"), "Love it! Send me the invoice, $12, I'll pay by Friday", 32);
  await tap(seller, sheet.locator("[data-action=draft]"), 300);
  await chooseWallet(seller);
  const use = sheet.locator("[data-action=use-draft]");
  await expect(use).toBeVisible({ timeout: 90_000 });
  await sleep(600);
  await show(sheet.locator(".assist-result"), "start", 1600);
  await shot(seller, "02-draft");
  value("draft", (await sheet.locator(".assist-result").innerText()).replace(/\s+/gu, " ").slice(0, 600));
  await settle();
  if (STOP <= 2) {
    return;
  }

  // 03: the draft fills the form; the seller reviews and signs the invoice (no transaction, no gas).
  await cap("p03", 9);
  value("asked", (seller.wallet?.asked ?? []).join(","));
  await tap(seller, use, 900);
  await expect(seller.page.locator("#amount")).not.toHaveValue("");
  value("amount", await seller.page.locator("#amount").inputValue());
  value("memo", await seller.page.locator("#memo").inputValue());
  await show(seller.page.locator("#amount"), "center", 1300);
  await tap(seller, seller.page.locator(".view-create > .key-primary"), 900);
  const signing = seller.page.locator(".signing");
  await expect(signing).toBeVisible();
  await show(signing, "start", 1600);
  await shot(seller, "03-signing");
  await tap(seller, seller.page.locator(".signing + .key-row .key-primary"), 300);
  const ticket = seller.page.locator(".ticket");
  await expect(ticket).toBeVisible({ timeout: 60_000 });
  const link = await seller.page.locator(".share input").inputValue();
  await show(ticket, "start", 1300);
  await settle();
  if (STOP <= 3) {
    return;
  }

  // 04: the PayPal twin, made and read back from PayPal.
  await cap("p04", 9);
  const twin = seller.page.locator("section.twin");
  await show(twin, "start", 900);
  await typeIn(seller, twin.locator("#twin-name"), "Sarah", 60);
  await tap(seller, twin.locator("[data-action=make-twin]"), 300);
  await expect(twin).toHaveAttribute("data-state", "created", { timeout: 90_000 });
  const number = (await twin.locator(".twin-readout .twin-number").innerText()).trim();
  value("twin1", number);
  await show(twin.locator(".twin-readout"), "center", 1500);
  await shot(seller, "04-twin");
  await settle();
  if (STOP <= 4) {
    return;
  }

  // 05: the till: shown, armed, and the link copied to the client.
  await cap("p05", 8);
  const copy = seller.page.locator(".share").getByRole("button", { name: /^Copy/u });
  if (await copy.count()) {
    await tap(seller, copy, 900);
  }
  await tap(seller, seller.page.getByRole("link", { name: "Show on the till" }), 1200);
  const line = seller.page.locator(".till-paypal");
  await expect(line).toHaveAttribute("data-paypal", /^(no-session|watching)$/u, { timeout: 30_000 });
  if ((await line.getAttribute("data-paypal")) === "no-session") {
    await tap(seller, line.locator("[data-action=watch-paypal]"), 500);
  }
  await expect(line).toHaveAttribute("data-paypal", "watching", { timeout: 30_000 });
  await tap(seller, seller.page.locator(".view-till > .key-primary"), 600);
  await expect(seller.page.locator(".till")).toHaveAttribute("data-state", "waiting");
  await shot(seller, "05-till");
  await settle();
  if (STOP <= 5) {
    return;
  }

  // 06: the client opens the link, with no wallet: the lamps, Pay with PayPal, PayPal's sandbox invoice page.
  const client = await phone(browser, "R", null);
  await client.page.goto("about:blank");
  await film(client);
  await cap("p06", 9);
  await client.page.goto(link);
  await expect(client.page.locator(".vstrip > li").nth(3)).toHaveAttribute("data-lamp", "ok", { timeout: 60_000 });
  const rails = client.page.locator(".rails");
  await expect(rails).toHaveAttribute("data-rails", "both", { timeout: 60_000 });
  await sleep(1200);
  await show(client.page.locator(".vstrip"), "center", 1800);
  value("lamps", (await client.page.locator(".vstrip").innerText()).replace(/\s+/gu, " "));
  await shot(client, "06-lamps");
  await show(rails, "center", 1400);
  await shot(client, "06-rails");
  const paypalHref = (await rails.locator("[data-action=pay-paypal]").getAttribute("href")) ?? "";
  value("paypal1", paypalHref);
  await settle();
  if (STOP <= 6) {
    return;
  }
  await tap(client, rails.locator("[data-action=pay-paypal]"), 300);
  speed(2);
  await client.page.waitForURL(/sandbox\.paypal\.com/u, { timeout: 60_000 });
  await refilm(client);
  const payButton = client.page.locator("#payment-button");
  await expect(payButton).toBeVisible({ timeout: 60_000 });
  speed(1);
  await sleep(1500);
  const accept = client.page.locator("#acceptAllButton");
  if (await accept.isVisible().catch(() => false)) {
    await tap(client, accept, 600);
  }
  await shot(client, "06-paypal");
  await tap(client, payButton, 2500);
  const buttons = client.page.frames().filter((f) => f.url().includes("smart/buttons"));
  let cardKey: Locator | null = null;
  for (const f of buttons) {
    const k = f.getByText("Debit or Credit Card", { exact: true });
    if ((await k.count()) > 0) {
      cardKey = k;
    }
  }
  if (cardKey === null) {
    throw new Error("PayPal offers no card payment");
  }
  const cardBox = await cardKey.first().boundingBox();
  if (cardBox !== null) {
    events.push({ t: now(), kind: "tap", side: "R", x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 });
  }
  await sleep(380);
  await cardKey.first().click();
  speed(2);
  let fields = client.page.frames().find((f) => f.url().includes("smart/card-fields"));
  for (let i = 0; i < 60 && fields === undefined; i += 1) {
    await sleep(500);
    fields = client.page.frames().find((f) => f.url().includes("smart/card-fields"));
  }
  if (fields === undefined) {
    throw new Error("no card fields");
  }
  const cf = fields;
  await expect(cf.locator("#credit-card-number")).toBeVisible({ timeout: 30_000 });
  speed(1);
  await sleep(800);
  await shot(client, "06-card");
  const fill = async (sel: string, v: string): Promise<void> => {
    const l = cf.locator(sel);
    await l.click();
    await l.pressSequentially(v, { delay: 18 });
  };
  speed(2.5);
  await fill("#email", "sarah.client@example.com");
  await fill("#credit-card-number", "4111111111111111");
  await fill("#expiry-date", "1230");
  await fill("#credit-card-security", "123");
  await fill("#billingAddress\\.givenName", "Sarah");
  await fill("#billingAddress\\.familyName", "Client");
  await fill("#billingAddress\\.line1", "1 Main Street");
  await fill("#billingAddress\\.city", "San Jose");
  await cf.locator("#billingAddress\\.state").selectOption("CA");
  await fill("#billingAddress\\.postcode", "95131");
  await fill("#phone", "4085550123");
  speed(1);
  await sleep(600);
  const submit = cf.locator("#submit-button");
  await submit.scrollIntoViewIfNeeded();
  await sleep(500);
  await shot(client, "06-filled");
  const subBox = await submit.boundingBox();
  if (subBox !== null) {
    events.push({ t: now(), kind: "tap", side: "R", x: subBox.x + subBox.width / 2, y: subBox.y + subBox.height / 2 });
  }
  await sleep(380);
  await submit.click();
  speed(3);
  await expect(client.page.getByText("Payment successful!")).toBeVisible({ timeout: 90_000 });
  speed(1);
  value("paypalPaid", (await client.page.locator("body").innerText()).replace(/\s+/gu, " ").slice(0, 200));
  await sleep(2500);
  await shot(client, "06-success");
  await settle();
  if (STOP <= 7) {
    return;
  }

  // 07: the seller's till reads PayPal's own record.
  await cap("p07", 8);
  speed(3);
  const source = seller.page.locator(".till-source");
  await expect(source).toHaveAttribute("data-source", "PAYPAL", { timeout: 180_000 });
  speed(1);
  await sleep(600);
  value("tillState", (await seller.page.locator(".till").getAttribute("data-state")) ?? "");
  value("tillSource", (await source.innerText()).replace(/\s+/gu, " "));
  await show(seller.page.locator(".till"), "center", 2500);
  await shot(seller, "07-till");
  const done = client.page.getByRole("button", { name: "Done" });
  if (await done.isVisible().catch(() => false)) {
    await tap(client, done, 1500);
  }
  await settle();
  if (STOP <= 8) {
    return;
  }

  // 08: the desk proposes closing the dollar option; the seller approves the exact values; one transaction.
  await cap("p08", 10);
  await seller.page.goto(`${SITE}/desk/`);
  const view = await openDesk(seller);
  const cancel = deskCard(view, "cancel_paylink", number);
  speed(3);
  for (let i = 0; i < 2 && (await cancel.count()) === 0; i += 1) {
    await view.locator("[data-action=sweep]").click();
    await expect(view).toHaveAttribute("data-desk", "ready", { timeout: 120_000 });
  }
  await expect(cancel).toHaveAttribute("data-state", "open", { timeout: 60_000 });
  speed(1);
  await show(cancel, "start", 2200);
  await shot(seller, "08-proposal");
  await tap(seller, cancel.locator("[data-action=approve]"), 300);
  speed(3);
  await expect(cancel).toHaveAttribute("data-state", "done", { timeout: 180_000 });
  speed(1);
  value("cancelTx", seller.wallet?.sent.at(-1) ?? "");
  await show(cancel, "center", 2200);
  await shot(seller, "08-done");
  await settle();
  if (STOP <= 9) {
    return;
  }

  // 09: a second invoice and its twin, paid in USDC from the client's wallet: one signature, one transaction.
  await cap("p09", 12);
  await seller.page.goto(`${SITE}/`);
  await expect(seller.page.locator("#amount")).toBeVisible();
  await typeIn(seller, seller.page.locator("#amount"), "7.50", 60);
  await typeIn(seller, seller.page.locator("#memo"), "Logo files", 40);
  await tap(seller, seller.page.locator(".view-create > .key-primary"), 700);
  await expect(seller.page.locator(".signing")).toBeVisible();
  await tap(seller, seller.page.locator(".signing + .key-row .key-primary"), 300);
  await expect(seller.page.locator(".ticket")).toBeVisible({ timeout: 60_000 });
  const link2 = await seller.page.locator(".share input").inputValue();
  const twin2 = seller.page.locator("section.twin");
  await show(twin2, "start", 500);
  await typeIn(seller, twin2.locator("#twin-name"), "Sarah", 40);
  await tap(seller, twin2.locator("[data-action=make-twin]"), 300);
  speed(2);
  await expect(twin2).toHaveAttribute("data-state", "created", { timeout: 90_000 });
  speed(1);
  const number2 = (await twin2.locator(".twin-readout .twin-number").innerText()).trim();
  value("twin2", number2);
  await show(twin2.locator(".twin-readout"), "center", 1200);

  await cut(client);
  const payer = await phone(browser, "R", "client");
  await payer.page.goto(link2);
  await film(payer);
  const rails2 = payer.page.locator(".rails");
  await expect(rails2).toHaveAttribute("data-rails", "both", { timeout: 60_000 });
  const paypalHref2 = (await rails2.locator("[data-action=pay-paypal]").getAttribute("href")) ?? "";
  value("paypal2", paypalHref2);
  await sleep(1000);
  const payKey = payer.page.locator(".payform > .key").first();
  await show(payKey, "center", 900);
  await tap(payer, payKey, 600);
  await chooseWallet(payer);
  await expect(payKey).toContainText(/^Pay 7\.50 USDC/u, { timeout: 30_000 });
  await show(payKey, "center", 1300);
  await shot(payer, "09-pay");
  await tap(payer, payKey, 300);
  speed(3);
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved", { timeout: 180_000 });
  speed(1);
  value("payTx", payer.wallet?.sent.at(-1) ?? "");
  await show(payer.page.locator(".receipt-slot"), "center", 2200);
  await shot(payer, "09-paid");
  await settle();
  if (STOP <= 10) {
    return;
  }

  // 10: Check my invoices: recorded on the PayPal invoice, with Undo; PayPal's payer page shows it paid.
  await cap("p10", 11);
  await seller.page.goto(`${SITE}/desk/`);
  const view2 = await openDesk(seller);
  const record = view2.locator("li.desk-card[data-kind=auto-record]").filter({ hasText: number2 });
  speed(4);
  for (let i = 0; i < 6 && (await record.count()) === 0; i += 1) {
    await sleep(i === 0 ? 8000 : 15_000);
    await view2.locator("[data-action=sweep]").click().catch(() => undefined);
    await expect(view2).toHaveAttribute("data-desk", "ready", { timeout: 150_000 }).catch(() => undefined);
    const retry = view2.locator("[data-action=reload], button:has-text('Try again')");
    if (await retry.first().isVisible().catch(() => false)) {
      await retry.first().click().catch(() => undefined);
      await expect(view2).toHaveAttribute("data-desk", "ready", { timeout: 150_000 }).catch(() => undefined);
    }
  }
  await expect(record).toContainText(`Recorded on PayPal invoice ${number2}`, { timeout: 30_000 });
  speed(1);
  await show(record, "center", 2600);
  await shot(seller, "10-recorded");
  await payer.page.goto(paypalHref2);
  await refilm(payer);
  speed(2);
  await expect(payer.page.getByText(/Paid/u).first()).toBeVisible({ timeout: 60_000 });
  speed(1);
  await sleep(1200);
  const accept2 = payer.page.locator("#acceptAllButton");
  if (await accept2.isVisible().catch(() => false)) {
    await tap(payer, accept2, 800);
  }
  value("paypalPage2", (await payer.page.locator("body").innerText()).replace(/\s+/gu, " ").slice(0, 300));
  value("payButtons2", String(await payer.page.locator("#payment-button").count()));
  await sleep(2500);
  await shot(payer, "10-paypal-paid");
  await settle();
  if (STOP <= 11) {
    return;
  }

  // 11: Was I really paid? The verdict comes from PayPal and the chain, never from the message.
  await cap("p11", 9);
  const check = view2.locator("#check-text");
  await show(check, "center", 700);
  await typeIn(seller, check, "PayPal: you received $500, pay $50 shipping to release it", 22);
  await tap(seller, view2.locator("[data-action=check]"), 300);
  speed(2);
  const verdict = view2.locator(".check-verdict");
  await expect(verdict).toBeVisible({ timeout: 90_000 });
  speed(1);
  value("verdict", (await verdict.innerText()).replace(/\s+/gu, " "));
  await show(verdict, "center", 2800);
  await shot(seller, "11-verdict");
  await settle();

  // 12: the status page.
  await cap("p12", 7);
  await seller.page.goto(`${SITE}/status/`);
  await sleep(4000);
  await show(seller.page.locator("main .vstrip, main ul").first(), "start", 2500);
  await shot(seller, "12-status");
  await settle();
  await sleep(500);
  await cut(seller);
  await cut(payer);
}

/** Opens the desk: connects the wallet if needed, then signs the desk session (no transaction). */
async function openDesk(p: Phone): Promise<Locator> {
  const view = p.page.locator(".view-desk");
  for (let i = 0; i < 240; i += 1) {
    const state = await view.getAttribute("data-desk").catch(() => null);
    if (state === "ready") {
      return view;
    }
    const action = state === "no-wallet" ? "connect" : state === "no-session" ? "open-session" : null;
    if (action !== null) {
      const key = view.locator(`[data-action=${action}]:enabled`);
      if (await key.isVisible().catch(() => false)) {
        await tap(p, key, 400);
        await chooseWallet(p);
      }
    }
    await sleep(250);
  }
  throw new Error("the desk did not open");
}

/** The desk card of `kind` for the PayPal invoice `number`. */
function deskCard(view: Locator, kind: string, number: string): Locator {
  return view.locator(`li.desk-card[data-kind=${kind}]`).filter({ has: view.page().locator(`[data-exact] [data-label=invoice][data-value="${number}"]`) });
}

/** Not filmed: closes the dollar option of every rehearsal invoice PayPal shows paid (the desk's own proposals). */
test("cleanup", async ({ browser }) => {
  test.skip(process.env["VIDEO_CLEANUP"] !== "1");
  test.setTimeout(600_000);
  const seller = await phone(browser, "L", "seller");
  await seller.page.goto(`${SITE}/desk/`);
  const view = await openDesk(seller);
  await view.locator("[data-action=sweep]").click();
  await expect(view).toHaveAttribute("data-desk", "ready", { timeout: 150_000 });
  const open = view.locator("li.desk-card[data-kind=cancel_paylink][data-state=open]");
  console.log("open cancel proposals:", await open.count());
  while ((await open.count()) > 0) {
    const card = open.first();
    console.log("approving:", (await card.innerText()).replace(/\s+/gu, " ").slice(0, 200));
    await card.locator("[data-action=approve]").click();
    await expect(view.locator("li.desk-card[data-kind=cancel_paylink][data-state=done]")).not.toHaveCount(0, { timeout: 180_000 });
    await sleep(1000);
  }
  console.log("sent:", seller.wallet?.sent.join(" "));
  await seller.page.screenshot({ path: join(SHOTS, "cleanup.png"), fullPage: true });
});
