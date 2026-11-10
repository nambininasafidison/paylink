// SPDX-License-Identifier: MIT
/**
 * Records the raw material of the Mezo Buildathon wave 2 pitch video: two phones, the seller on the left and the client
 * on the right, driving the production build of branch mezo (apps/web/dist) served at its origin
 * https://mezo.paylink-mg.pages.dev by the local Pages server, against an anvil fork of Mezo testnet with the real MUSD
 * and the recorded PayLinkV2 deployment (fixtures/mezo.ts). Wallets are the fork's test accounts (fixtures/wallet.ts).
 * Frames, captions and taps are logged on one clock for the compositor (video/compose/), like record.spec.ts.
 * VIDEO_OUT=<dir>.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, CDPSession, Locator, Page, Route } from "@playwright/test";
import { parseUnits } from "viem";
import type { Address } from "viem";
import { MEZO, routeMezo, startMezoFork } from "../fixtures/mezo.ts";
import type { MezoFork } from "../fixtures/mezo.ts";
import { servePages, SITE } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { REPO } from "../fixtures/server.ts";
import { installWallet } from "../fixtures/wallet.ts";

const ORIGIN = "https://mezo.paylink-mg.pages.dev";
const SITE_URL = `${ORIGIN}/mezo`;
const OUT = process.env["VIDEO_OUT"] ?? "/tmp/paylink-video-mezo";
const FRAMES = join(OUT, "frames");
const SHOTS = join(OUT, "shots");
const PHONE = { width: 390, height: 844 } as const;
/** The wave 1 payment (2026-10, Mezo testnet) and its payee, read from its receipt's Paid event. */
const WAVE1_TX = "0xf44cf47b2b6290ae1014dedbe1b0bf8adf590974a619808b47560b4eed6d22cd";
const WAVE1_PAYEE: Address = "0x3fE5F968b61523CCCE599b99BD4c0cfC39C666Ca";
const now = (): number => Date.now() / 1000;
const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

type Side = "L" | "R";
const events: { t: number; kind: string; side?: Side; id?: string; x?: number; y?: number; value?: string }[] = [];
const frames: Record<Side, { t: number; f: string }[]> = { L: [], R: [] };
let counter = 0;
const contexts: BrowserContext[] = [];
let mezo: MezoFork;
let site: StaticServer;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  mkdirSync(FRAMES, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  if (process.env["VIDEO_SKIP_BUILD"] !== "1") {
    execFileSync(process.execPath, ["--conditions=@paylink/source", "scripts/build.ts"], { cwd: join(REPO, "apps/web"), stdio: ["ignore", "ignore", "inherit"] });
  }
  site = await servePages(SITE);
  mezo = await startMezoFork();
});

test.afterAll(async () => {
  for (const context of contexts) {
    await context.close().catch(() => undefined);
  }
  await site.close();
  const forkBlock = mezo.fork.forkBlock.toString();
  await mezo.stop();
  writeFileSync(join(OUT, "events.json"), JSON.stringify({ route: "fork", forkBlock, events, frames }, null, 1));
});

interface Phone {
  readonly context: BrowserContext;
  page: Page;
  readonly side: Side;
  cdp: CDPSession | null;
}

async function phone(browser: Browser, side: Side, account: Address): Promise<Phone> {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", locale: "en-US", serviceWorkers: "block", timezoneId: "Indian/Antananarivo", permissions: ["clipboard-read", "clipboard-write"] });
  contexts.push(context);
  await context.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const response = await fetch(`${site.origin}${url.pathname}${url.search}`, { redirect: "manual" });
    const headers = Object.fromEntries(response.headers.entries());
    if (headers["location"]?.startsWith(site.origin) === true) {
      headers["location"] = headers["location"].replace(site.origin, ORIGIN);
    }
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });
  await routeMezo(context, mezo);
  const page = await context.newPage();
  await installWallet(page, { account, chainId: MEZO.chainId, endpoints: new Map<number, string | null>([[MEZO.chainId, mezo.fork.url]]), known: [MEZO.chainId] });
  page.on("pageerror", (e) => {
    console.log(`[${side}] pageerror: ${e.message.slice(0, 200)}`);
  });
  return { context, page, side, cdp: null };
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
  test.setTimeout(900_000);
  const payee = mezo.fork.accounts[1];
  const payerAccount = mezo.fork.accounts[2];
  if (payee === undefined || payerAccount === undefined) {
    throw new Error("the fork has too few accounts");
  }
  await mezo.mintMusd(payerAccount, parseUnits("100", 18));
  await mezo.setBtc(payerAccount, parseUnits("0.005", 18));
  await mezo.setBtc(payee, parseUnits("0.005", 18));

  const seller = await phone(browser, "L", payee);
  await seller.page.goto(`${SITE_URL}/`);
  await expect(seller.page.locator("#amount")).toBeVisible();
  const paste = seller.page.locator(".paste");
  await paste.evaluate((e) => {
    e.scrollIntoView({ block: "start" });
  });
  await seller.page.evaluate(() => {
    window.scrollBy(0, -90);
  });
  await sleep(800);
  await film(seller);
  await sleep(1000);

  // 01: the client's message fills the amount and the link's validity by fixed rules: no AI, nothing signed.
  await cap("m01", 9);
  await tap(seller, paste.locator("summary"), 700);
  await typeIn(seller, seller.page.locator("#paste-text"), "Love it! Send me the invoice, 25 MUSD, I'll pay by Friday", 30);
  await tap(seller, seller.page.getByRole("button", { name: "Fill the form" }), 900);
  await expect(seller.page.locator("#amount")).toHaveValue(/^25/u);
  value("amount", await seller.page.locator("#amount").inputValue());
  value("pasteOut", (await seller.page.locator(".paste-out").innerText()).replace(/\s+/gu, " "));
  await show(seller.page.locator(".paste-out"), "center", 1800);
  await shot(seller, "01-paste");
  await settle();

  // 02: a memo, then the invoice is signed in the wallet: a signature, no gas.
  await cap("m02", 9);
  await typeIn(seller, seller.page.locator("#memo"), "Logo design", 45);
  await tap(seller, seller.page.locator(".view-create > .key-primary"), 900);
  const signing = seller.page.locator(".signing");
  await expect(signing).toContainText("You are about to sign this invoice");
  await show(signing, "start", 1800);
  await tap(seller, seller.page.locator(".signing + .key-row .key-primary"), 300);
  const ticket = seller.page.locator(".ticket");
  await expect(ticket).toBeVisible();
  const link = await seller.page.locator(".share input").inputValue();
  await show(ticket, "start", 1600);
  await shot(seller, "02-ticket");
  await settle();

  // 03: the client pays in MUSD: one signature, one transaction, the network fee in BTC.
  const client = await phone(browser, "R", payerAccount);
  await client.page.goto("about:blank");
  await film(client);
  await cap("m03", 12);
  await client.page.goto(link);
  await expect(client.page.locator(".vstrip > li").nth(0)).toHaveAttribute("data-lamp", "ok", { timeout: 30_000 });
  await sleep(1300);
  await show(client.page.locator(".vstrip"), "center", 1300);
  const key = client.page.locator(".payform .key-primary");
  for (let i = 0; i < 4; i += 1) {
    const text = ((await key.textContent()) ?? "").trim();
    if (/^Pay /u.test(text)) {
      break;
    }
    if (/^Connect|^Switch/u.test(text)) {
      await tap(client, key, 700);
    } else {
      await sleep(500);
    }
  }
  await expect(key).toHaveText(/^Pay 25(\.00)? MUSD/u);
  value("route", (await client.page.locator(".route-note").first().innerText()).trim());
  value("fee", (await client.page.locator(".fee-note").innerText()).trim());
  await show(client.page.locator(".route-note").first(), "center", 1800);
  await shot(client, "03-pay");
  await tap(client, key, 300);
  await expect(client.page.locator(".receipt-slot .receipt")).toContainText("Approved", { timeout: 60_000 });
  await show(client.page.locator(".receipt-slot"), "center", 1800);
  await shot(client, "03-approved");
  await settle();

  // 04: the receipt, verified again on the chain each time it opens.
  await cap("m04", 8);
  await tap(client, client.page.locator(".receipt-slot a.key").first(), 600);
  await expect(client.page.locator(".view-receipt .receipt")).toContainText("Matches the invoice", { timeout: 30_000 });
  await sleep(1000);
  await show(client.page.locator(".view-receipt .receipt"), "start", 1800);
  value("receipt", (await client.page.locator(".view-receipt .receipt").innerText()).replace(/\s+/gu, " ").slice(0, 400));
  await shot(client, "04-receipt");
  await settle();

  // 05: new in wave 2: "Was I really paid?" with the wave 1 payment's real hash, from its payee's wallet.
  await cut(seller);
  const owner = await phone(browser, "L", WAVE1_PAYEE);
  await owner.page.goto(`${SITE_URL}/ledger/`);
  const checkHead = owner.page.locator("#check-head");
  await expect(checkHead).toHaveText("Was I really paid?", { timeout: 30_000 });
  // Off camera: the payee's wallet connects (the header's key), as the merchant's would be.
  const header = owner.page.locator("button.connect").first();
  if (/Connect/u.test((await header.textContent()) ?? "")) {
    await header.click();
    await sleep(600);
    const choice = owner.page.locator("dialog[open]").getByRole("button", { name: /Test Wallet/u });
    if (await choice.isVisible().catch(() => false)) {
      await choice.click();
    }
  }
  await expect(owner.page.locator("button.connect").first()).not.toHaveText(/Connect/u, { timeout: 15_000 });
  await checkHead.evaluate((e) => {
    e.scrollIntoView({ block: "start" });
  });
  await sleep(600);
  await film(owner);
  await cap("m05", 11);
  await typeIn(owner, owner.page.locator("#check-text"), WAVE1_TX, 8);
  await tap(owner, owner.page.getByRole("button", { name: "Check on Mezo testnet" }), 300);
  const result = owner.page.locator(".check-result");
  await expect(result).toHaveAttribute("data-verdict", /^(paid|not-received|unknown|pending)$/u, { timeout: 60_000 });
  value("verdict1", (await result.innerText()).replace(/\s+/gu, " ").slice(0, 400));
  await show(result, "start", 2600);
  await shot(owner, "05-paid");
  await settle();

  // 06: a message with nothing the chain can check.
  await cap("m06", 9);
  await typeIn(owner, owner.page.locator("#check-text"), "I paid you yesterday, here is my receipt", 28);
  await tap(owner, owner.page.getByRole("button", { name: "Check on Mezo testnet" }), 300);
  await expect(result).toHaveAttribute("data-verdict", "unknown", { timeout: 60_000 });
  value("verdict2", (await result.innerText()).replace(/\s+/gu, " ").slice(0, 400));
  await show(result, "start", 2600);
  await shot(owner, "06-unknown");
  await settle();
  await sleep(400);
  await cut(owner);
  await cut(client);
  events.push({ t: now(), kind: "end" });
});
