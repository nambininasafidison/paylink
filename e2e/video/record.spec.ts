// SPDX-License-Identifier: MIT
/**
 * Records the demo videos' raw material: two phones (seller on the left, client on the right) driving the production
 * build at its production origin, against anvil forks of Monad testnet and Base Sepolia (capture/fork.ts), the relayer
 * through its Node adapter and Chromium's virtual authenticator with PRF. Each phone's screen is captured with CDP
 * screencast frames (timestamped); captions, taps and fingerprints are logged on the same clock. The compositor turns
 * frames + events into the video. VIDEO=monad|base, VIDEO_OUT=<dir>.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, CDPSession, Locator, Page } from "@playwright/test";
import type { Address } from "viem";
import { addAuthenticator } from "../fixtures/editions.ts";
import { servePages, SITE } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { installWallet, routeRegistry } from "../fixtures/wallet.ts";
import { BASE, mintUsdc, MONAD, ORIGIN, routeForkRelayer, routeSite, startFork, startForkRelayer } from "../capture/fork.ts";
import type { Fork, ForkRelayer } from "../capture/fork.ts";

const WHICH = process.env["VIDEO"] ?? "monad";
const OUT = process.env["VIDEO_OUT"] ?? "/tmp/paylink-video";
const FRAMES = join(OUT, "frames");
const PHONE = { width: 390, height: 844 } as const;
const now = (): number => Date.now() / 1000;
const sleep = async (ms: number): Promise<void> => { await new Promise((r) => setTimeout(r, ms)); };

type Side = "L" | "R";
const events: { t: number; kind: string; side?: Side; id?: string; x?: number; y?: number }[] = [];
const frames: Record<Side, { t: number; f: string }[]> = { L: [], R: [] };
let counter = 0;

let monad: Fork;
let base: Fork;
let site: StaticServer;
let relayer: ForkRelayer;
const contexts: BrowserContext[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(FRAMES, { recursive: true });
  [monad, base] = await Promise.all([startFork(MONAD.chainId, MONAD.rpc), startFork(BASE.chainId, BASE.rpc)]);
  site = await servePages(SITE);
  relayer = await startForkRelayer(monad, base);
  await monad.rpc("evm_increaseTime", [61]);
  await monad.rpc("evm_mine");
});

test.afterAll(async () => {
  for (const context of contexts) {
    await context.close().catch(() => undefined);
  }
  await relayer.stop();
  await site.close();
  await monad.stop();
  await base.stop();
  writeFileSync(join(OUT, "events.json"), JSON.stringify({ video: WHICH, events, frames, forks: { monad: monad.forkBlock.toString(), base: base.forkBlock.toString() } }, null, 1));
});

interface Phone { readonly context: BrowserContext; readonly page: Page; readonly side: Side; cdp: CDPSession | null }

async function phone(browser: Browser, side: Side): Promise<Phone> {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", locale: "en-US", serviceWorkers: "block" });
  contexts.push(context);
  await routeSite(context, site);
  await routeRegistry(context, new Map([[MONAD.chainId, monad.url], [BASE.chainId, base.url]]));
  await routeForkRelayer(context, relayer);
  return { context, page: await context.newPage(), side, cdp: null };
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

async function show(locator: Locator, block: "center" | "start" | "end" = "center", wait = 700): Promise<void> {
  await locator.first().evaluate((e, b) => { e.scrollIntoView({ behavior: "smooth", block: b }); }, block);
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
function finger(p: Phone): void {
  events.push({ t: now(), kind: "fp", side: p.side });
}
async function typeIn(p: Phone, locator: Locator, text: string): Promise<void> {
  await tap(p, locator, 150);
  await locator.first().fill("");
  await locator.first().pressSequentially(text, { delay: 85 });
  await sleep(300);
}
async function createKey(p: Phone, label: string): Promise<Address> {
  const dialog = p.page.locator("dialog.modal-key");
  await expect(dialog).toBeVisible();
  await sleep(1600);
  await typeIn(p, dialog.locator("#key-label"), label);
  finger(p);
  await tap(p, dialog.getByRole("button", { name: "Create my PayLink key" }), 200);
  await expect(dialog).toBeHidden();
  return (await p.page.locator(".connect").getAttribute("title")) as Address;
}

test("record", async ({ browser }) => {
  if (WHICH === "monad") {
    await recordMonad(browser);
  } else {
    await recordBase(browser);
  }
  events.push({ t: now(), kind: "end" });
});

async function recordMonad(browser: Browser): Promise<void> {
  const seller = await phone(browser, "L");
  await addAuthenticator(seller.context, seller.page);
  await seller.page.goto(`${ORIGIN}/monad/`);
  await expect(seller.page.locator("#amount")).toBeVisible();
  await sleep(800);
  await film(seller);
  await sleep(1200);

  await cap("m01", 6.5);
  await typeIn(seller, seller.page.locator("#amount"), "12.50");
  await typeIn(seller, seller.page.locator("#memo"), "Logo design, invoice 042");
  await settle();

  await cap("m02", 7);
  await tap(seller, seller.page.locator(".view-create > .key-primary"));
  await createKey(seller, "Rakoto Design");
  await settle();

  await cap("m03", 7);
  const signing = seller.page.locator(".signing");
  await expect(signing).toContainText("You are about to sign this invoice");
  await show(signing, "start", 1200);
  await settle();

  await cap("m04", 7.5);
  finger(seller);
  await tap(seller, seller.page.locator(".signing + .key-row .key-primary"), 300);
  const ticket = seller.page.locator(".ticket");
  await expect(ticket).toBeVisible();
  const link = await seller.page.locator(".share input").inputValue();
  await show(ticket, "start", 1500);
  await settle();

  await cap("m05", 6);
  await tap(seller, seller.page.getByRole("link", { name: "Show on the till" }), 900);
  await tap(seller, seller.page.getByRole("button", { name: "Start the till" }), 400);
  await expect(seller.page.locator(".till")).toHaveAttribute("data-state", "waiting");
  await settle();

  const payer = await phone(browser, "R");
  await addAuthenticator(payer.context, payer.page);
  await film(payer);
  await cap("m06", 8.5);
  await payer.page.goto(link);
  await expect(payer.page.locator(".screen .amount")).toContainText("12.50");
  for (let i = 0; i < 4; i += 1) {
    await expect(payer.page.locator(".vstrip > li").nth(i)).toHaveAttribute("data-lamp", /ok|wait|idle|off/u);
  }
  await sleep(1500);
  await show(payer.page.locator(".vstrip"), "center", 1200);
  await settle();

  await cap("m07", 7);
  const key = payer.page.locator(".payform .key-primary");
  await tap(payer, key);
  await createKey(payer, "My phone");
  await settle();

  await cap("m08", 7.5);
  const funds = payer.page.locator(".funds");
  await expect(funds).toContainText("This account holds 0.00 AUSD.");
  await show(funds, "center", 1400);
  await tap(payer, funds.getByRole("button", { name: /Get 10,000 test AUSD/ }), 300);
  await expect(payer.page.locator(".bill > .status")).toContainText("Test AUSD received.");
  await settle();

  await cap("m09", 8);
  await expect(key).toHaveText("Pay 12.50 AUSD");
  const display = payer.page.locator(".sign-slot .signing");
  await expect(display).toContainText("Pay exactly this, once");
  await show(display, "start", 1500);
  await settle();

  await cap("m10", 9);
  finger(payer);
  await tap(payer, key, 200);
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  await show(payer.page.locator(".receipt-slot"), "center", 600);
  await expect(seller.page.locator(".till")).toHaveAttribute("data-state", "paid");
  await settle();

  await cap("m11", 8);
  await tap(payer, payer.page.locator(".receipt-slot a.key-line"), 600);
  await expect(payer.page.locator("main")).toContainText(/Verified on the network/u);
  await sleep(1200);
  await show(payer.page.locator(".receipt"), "start", 1500);
  await settle();

  await cap("m12", 8);
  await seller.page.goto(`${ORIGIN}/monad/`);
  await typeIn(seller, seller.page.locator("#amount"), "9");
  await typeIn(seller, seller.page.locator("#memo"), "Deposit, to cancel");
  await tap(seller, seller.page.locator(".view-create > .key-primary"), 600);
  finger(seller);
  await tap(seller, seller.page.locator(".signing + .key-row .key-primary"), 300);
  await expect(seller.page.locator(".ticket")).toBeVisible();
  await settle();

  await cap("m13", 9);
  await seller.page.goto(`${ORIGIN}/monad/ledger/`);
  const paidRow = seller.page.locator(".view-ledger .links > li", { hasText: "Logo design, invoice 042" });
  await expect(paidRow).toBeVisible();
  const row = seller.page.locator(".view-ledger .links > li", { hasText: "Deposit, to cancel" });
  await show(row, "center", 1300);
  const cancel = row.locator("button.key-danger");
  await tap(seller, cancel, 500);
  await expect(cancel).toHaveText("Confirm cancel");
  finger(seller);
  await tap(seller, cancel, 300);
  await expect(seller.page.locator(".view-ledger").first()).toContainText(/Cancelled/u);
  await sleep(600);
  await show(seller.page.locator(".view-ledger .links").first(), "start", 1200);
  await settle();

  await cap("m14", 8);
  const panel = seller.page.locator(".view-books");
  await show(panel, "center", 1200);
  finger(seller);
  await tap(seller, panel.getByRole("button", { name: "Back up my ledger" }), 300);
  await expect(panel.locator(".status.ok")).toContainText("Backup saved");
  await show(panel, "center", 600);
  await settle();

  await cap("m15", 7);
  await seller.page.goto(`${ORIGIN}/monad/status/`);
  await expect(seller.page.locator("main")).toContainText("Genuine contract");
  await sleep(2500);
  await show(seller.page.locator("main").getByText("Genuine contract").first(), "center", 1200);
  await settle();
  await sleep(600);
  await cut(seller);
  await cut(payer);
}

async function recordBase(browser: Browser): Promise<void> {
  const [payee, eoa, smart] = [base.accounts[1], base.accounts[2], base.accounts[3]];
  if (payee === undefined || eoa === undefined || smart === undefined) {
    throw new Error("the Base fork has too few accounts");
  }
  await mintUsdc(base, eoa, 100_000_000n);
  await mintUsdc(base, smart, 50_000_000n);
  await base.rpc("anvil_setBalance", [eoa, "0x0"]);
  const endpoints = new Map<number, string | null>([[MONAD.chainId, monad.url], [BASE.chainId, base.url]]);

  const seller = await phone(browser, "L");
  await installWallet(seller.page, { account: payee, chainId: BASE.chainId, endpoints, known: [BASE.chainId] });
  await seller.page.goto(`${ORIGIN}/base/`);
  await expect(seller.page.locator("#amount")).toBeVisible();
  await sleep(800);
  await film(seller);
  await sleep(1200);

  await cap("b01", 6.5);
  await typeIn(seller, seller.page.locator("#amount"), "25.00");
  await typeIn(seller, seller.page.locator("#memo"), "Website hosting, October");
  await settle();

  await cap("b02", 8);
  await tap(seller, seller.page.locator(".view-create > .key-primary"), 900);
  const signing = seller.page.locator(".signing");
  await expect(signing).toContainText("You are about to sign this invoice");
  await show(signing, "start", 1400);
  await settle();

  await cap("b03", 8);
  await tap(seller, seller.page.locator(".signing + .key-row .key-primary"), 300);
  const ticket = seller.page.locator(".ticket");
  await expect(ticket).toBeVisible();
  const link = await seller.page.locator(".share input").inputValue();
  await show(ticket, "start", 1500);
  await settle();

  const payer = await phone(browser, "R");
  await installWallet(payer.page, { account: eoa, chainId: BASE.chainId, endpoints, known: [BASE.chainId] });
  await film(payer);
  await cap("b04", 9);
  await payer.page.goto(link);
  await expect(payer.page.locator(".screen .amount")).toContainText("25.00");
  await sleep(1500);
  await show(payer.page.locator(".vstrip"), "center", 1200);
  await settle();

  await cap("b05", 8.5);
  const key = payer.page.locator(".payform .key-primary");
  await tap(payer, key, 600);
  await expect(key).toHaveText("Pay 25.00 USDC");
  await expect(payer.page.locator(".route-note")).toHaveText("One signature; the fee is covered.");
  await show(payer.page.locator(".route-note"), "center", 1300);
  await settle();

  await cap("b06", 8);
  await tap(payer, key, 200);
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  await show(payer.page.locator(".receipt-slot"), "center", 800);
  await settle();

  await cap("b07", 8);
  await tap(payer, payer.page.locator(".receipt-slot a.key-line"), 600);
  await expect(payer.page.locator("main")).toContainText(/Verified on the network/u);
  await sleep(1200);
  await show(payer.page.locator(".receipt"), "start", 1500);
  await settle();

  await cap("b08", 8);
  await seller.page.goto(`${ORIGIN}/base/`);
  await typeIn(seller, seller.page.locator("#amount"), "2.25");
  await typeIn(seller, seller.page.locator("#memo"), "Sticker pack");
  await tap(seller, seller.page.locator(".view-create > .key-primary"), 700);
  await tap(seller, seller.page.locator(".signing + .key-row .key-primary"), 300);
  await expect(seller.page.locator(".ticket")).toBeVisible();
  const link2 = await seller.page.locator(".share input").inputValue();
  await show(seller.page.locator(".ticket"), "start", 900);
  await settle();

  await cut(payer);
  const smartPayer = await phone(browser, "R");
  await installWallet(smartPayer.page, { account: smart, chainId: BASE.chainId, endpoints, known: [BASE.chainId], batch: true });
  await smartPayer.page.goto(link2);
  await expect(smartPayer.page.locator(".screen .amount")).toContainText("2.25");
  await film(smartPayer);
  await cap("b09", 10);
  await sleep(1200);
  const key2 = smartPayer.page.locator(".payform .key-primary");
  await tap(smartPayer, key2, 700);
  await expect(key2).toHaveText("Pay 2.25 USDC");
  await show(smartPayer.page.locator(".route-note"), "center", 1500);
  await tap(smartPayer, key2, 200);
  await expect(smartPayer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  await show(smartPayer.page.locator(".receipt-slot"), "center", 800);
  await settle();

  await cap("b10", 8);
  await seller.page.goto(`${ORIGIN}/base/ledger/`);
  const rows = seller.page.locator(".view-ledger .links > li");
  await expect(rows.first()).toBeVisible();
  await sleep(1500);
  await show(seller.page.locator(".view-ledger .links").first(), "start", 1200);
  await tap(seller, seller.page.getByRole("button", { name: "Export CSV" }), 600);
  await settle();

  await cap("b11", 7.5);
  await seller.page.goto(`${ORIGIN}/base/status/`);
  await expect(seller.page.locator("main")).toContainText("Genuine contract");
  await sleep(2500);
  await show(seller.page.locator("main").getByText("Genuine contract").first(), "center", 1200);
  await settle();
  await sleep(600);
  await cut(seller);
  await cut(smartPayer);
}
