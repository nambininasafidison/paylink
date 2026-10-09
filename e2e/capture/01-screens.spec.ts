// SPDX-License-Identifier: MIT
/**
 * Product screenshots for the submissions (docs/submissions/README.md), from the production build on its production
 * origin, against anvil forks of Monad testnet and Base Sepolia with the deployed PayLinkV2, the real AUSD (and its
 * faucet) and the real USDC (`capture/fork.ts`). A 390 × 844 phone, dark theme, English:
 *
 * 1. Monad, the seller: an invoice signed with a PayLink key (Mera passkey), as the printed card with its QR code.
 * 2. Monad, the payer on a phone: their own PayLink key, test AUSD from the faucet through the relayer, four lamps,
 *    and the signing display that says what the fingerprint approves.
 * 3. Monad, the receipt the payer opens after paying with one fingerprint (gasless), verified on the fork.
 * 4. Monad, the seller's till, armed with that invoice, lit for its verified payment.
 * 5. Base, a payer with an EOA wallet: the gasless USDC route, before the one signature.
 *
 * Run: `pnpm --filter @paylink/e2e capture` (needs egress to the two testnet RPCs). The pictures go to
 * docs/submissions/assets/, with `capture.json` saying when, from which commit and at which fork blocks.
 * The transactions they show exist only on the forks; timings on screen are the fork's, never Monad's or Base's.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import type { Address } from "viem";
import { settleAnimations } from "../fixtures/axe.ts";
import { addAuthenticator } from "../fixtures/editions.ts";
import { servePages, SITE } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { REPO } from "../fixtures/server.ts";
import { installWallet, routeRegistry } from "../fixtures/wallet.ts";
import { BASE, mintUsdc, MONAD, ORIGIN, routeForkRelayer, routeSite, startFork, startForkRelayer } from "./fork.ts";
import type { Fork, ForkRelayer } from "./fork.ts";

const OUT = join(REPO, "docs/submissions/assets");
const SCREENS = join(OUT, "screens");
const PHONE = { width: 390, height: 844 } as const;

let monad: Fork;
let base: Fork;
let site: StaticServer;
let relayer: ForkRelayer;
const contexts: BrowserContext[] = [];
const shots: { file: string; what: string }[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // The production build, exactly as Cloudflare Pages builds it (registry, config and rpId unchanged).
  execFileSync(process.execPath, ["--conditions=@paylink/source", "scripts/build.ts"], { cwd: join(REPO, "apps/web"), stdio: ["ignore", "ignore", "inherit"] });
  [monad, base] = await Promise.all([startFork(MONAD.chainId, MONAD.rpc), startFork(BASE.chainId, BASE.rpc)]);
  site = await servePages(SITE);
  relayer = await startForkRelayer(monad, base);
  // The AUSD faucet's cooldown is global: let anyone's last drip on the network expire on the fork.
  await monad.rpc("evm_increaseTime", [61]);
  await monad.rpc("evm_mine");
  mkdirSync(SCREENS, { recursive: true });
});

test.afterAll(async () => {
  for (const context of contexts) {
    await context.close();
  }
  await relayer.stop();
  await site.close();
  await monad.stop();
  await base.stop();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  writeFileSync(
    join(OUT, "capture.json"),
    `${JSON.stringify(
      {
        captured: new Date().toISOString(),
        commit,
        build: "apps/web/dist (production build, scripts/build.ts)",
        origin: ORIGIN,
        viewport: { ...PHONE, deviceScaleFactor: 2, colorScheme: "dark", locale: "en" },
        forks: { [String(MONAD.chainId)]: { rpc: MONAD.rpc, block: monad.forkBlock.toString() }, [String(BASE.chainId)]: { rpc: BASE.rpc, block: base.forkBlock.toString() } },
        note: "Transactions shown exist only on local anvil forks; on-screen timings are the fork's, not the network's.",
        screens: shots,
      },
      null,
      2,
    )}\n`,
  );
});

async function phone(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", locale: "en-US", serviceWorkers: "block" });
  contexts.push(context);
  await routeSite(context, site);
  await routeRegistry(context, new Map([[MONAD.chainId, monad.url], [BASE.chainId, base.url]]));
  await routeForkRelayer(context, relayer);
  return { context, page: await context.newPage() };
}

/**
 * A viewport screenshot with `anchor` `offset` CSS pixels below the top of the phone screen, into
 * docs/submissions/assets/screens/. `PAYLINK_CAPTURE_FULL=1` also writes the whole page to test-results/capture/full/,
 * to choose a framing.
 */
async function shot(page: Page, file: string, what: string, anchor: Locator, offset = 12): Promise<void> {
  await settleAnimations(page);
  if (process.env["PAYLINK_CAPTURE_FULL"] === "1") {
    await page.screenshot({ path: join(REPO, "e2e/test-results/capture/full", file), fullPage: true, animations: "disabled", caret: "hide" });
  }
  await anchor.evaluate((element, top) => {
    window.scrollTo({ top: Math.max(0, element.getBoundingClientRect().top + window.scrollY - top), behavior: "instant" });
  }, offset);
  await settleAnimations(page);
  await page.screenshot({ path: join(SCREENS, file), animations: "disabled", caret: "hide" });
  shots.push({ file: `screens/${file}`, what });
}

async function createKey(page: Page, label: string): Promise<Address> {
  const dialog = page.locator("dialog.modal-key");
  await expect(dialog).toBeVisible();
  await dialog.locator("#key-label").fill(label);
  await dialog.getByRole("button", { name: "Create my PayLink key" }).click();
  await expect(dialog).toBeHidden();
  return (await page.locator(".connect").getAttribute("title")) as Address;
}

test("Monad edition: create, pay with a passkey, the receipt, the till; Base edition: pay", async ({ browser }) => {
  // 1. The seller signs an invoice with a new PayLink key.
  const seller = await phone(browser);
  await addAuthenticator(seller.context, seller.page);
  await seller.page.goto(`${ORIGIN}/monad/`);
  await seller.page.locator("#amount").fill("12.50");
  await seller.page.locator("#memo").fill("Logo design, invoice 042");
  await seller.page.locator(".view-create > .key-primary").click();
  await createKey(seller.page, "Rakoto Design");
  await seller.page.locator(".signing + .key-row .key-primary").click();
  const ticket = seller.page.locator(".ticket");
  await expect(ticket).toBeVisible();
  const link = await seller.page.locator(".share input").inputValue();
  expect(link.startsWith(`${ORIGIN}/monad/pay/#2.${String(MONAD.chainId)}.`)).toBe(true);
  await shot(seller.page, "screen-1-monad-create.png", "Monad edition, seller: an invoice for 12.50 AUSD signed with a PayLink key (Mera passkey), shown as the card with its QR code and share keys. No transaction, no gas.", ticket, 50);

  // The till, armed with this invoice, on the seller's phone.
  const till = await seller.context.newPage();
  await till.goto(link.replace("/pay/#", "/till/#"));
  await till.getByRole("button", { name: "Start the till" }).click();
  await expect(till.locator(".till")).toHaveAttribute("data-state", "waiting");

  // 2. The payer: own PayLink key, test AUSD through the relayer's onboarding, the signing display.
  const payer = await phone(browser);
  await addAuthenticator(payer.context, payer.page);
  await payer.page.goto(link);
  await expect(payer.page.locator(".screen .amount")).toContainText("12.50");
  const key = payer.page.locator(".payform .key-primary");
  await key.click();
  await createKey(payer.page, "My phone");
  await payer.page.locator(".funds").getByRole("button", { name: /Get 10,000 test AUSD/ }).click();
  await expect(payer.page.locator(".bill > .status")).toContainText("Test AUSD received.");
  await expect(key).toHaveText("Pay 12.50 AUSD");
  for (let i = 0; i < 4; i += 1) {
    await expect(payer.page.locator(".vstrip > li").nth(i)).toHaveAttribute("data-lamp", "ok");
  }
  const display = payer.page.locator(".sign-slot .signing");
  await expect(display).toContainText("Pay exactly this, once");
  await shot(payer.page, "screen-2-monad-pay.png", "Monad edition, payer on a phone with their own PayLink key and test AUSD from the faucet: the signing display states what one fingerprint approves (this amount, this address, 10 minutes, fee covered), then the Pay key.", payer.page.locator(".sign-slot"), 16);

  // 3. One fingerprint, gasless; then the receipt page, re-verified on the fork.
  await key.click();
  const slip = payer.page.locator(".receipt-slot .receipt");
  await expect(slip).toContainText("Approved");
  const receiptLink = await payer.page.locator(".receipt-slot a.key-line").getAttribute("href");
  expect(receiptLink).not.toBeNull();
  await payer.page.goto(new URL(receiptLink ?? "", ORIGIN).toString());
  const receipt = payer.page.locator(".receipt");
  await expect(receipt).toContainText("Approved");
  await expect(payer.page.locator("main")).toContainText(/Verified on the network/);
  await shot(payer.page, "screen-3-monad-receipt.png", "Monad edition: the receipt, re-verified against the chain on every opening (Paid event, genuine contract, matching invoice), payee and payer in full.", receipt, 16);

  // 4. The armed till lit for this invoice's verified payment.
  await expect(till.locator(".till")).toHaveAttribute("data-state", "paid");
  await shot(till, "screen-4-monad-till.png", "Monad edition, the seller's till: armed with the invoice, lit green for its verified Paid event at its exact amount.", till.locator(".till"), 16);

  // 5. Base edition: an EOA payer, gasless USDC (one EIP-3009 signature, no transaction).
  const [payee, eoa] = [base.accounts[1], base.accounts[2]];
  if (payee === undefined || eoa === undefined) {
    throw new Error("the Base fork has too few accounts");
  }
  await mintUsdc(base, eoa, 100_000_000n);
  const endpoints = new Map<number, string | null>([[MONAD.chainId, monad.url], [BASE.chainId, base.url]]);
  const baseSeller = await phone(browser);
  await installWallet(baseSeller.page, { account: payee, chainId: BASE.chainId, endpoints, known: [BASE.chainId] });
  await baseSeller.page.goto(`${ORIGIN}/base/`);
  await baseSeller.page.locator("#amount").fill("25.00");
  await baseSeller.page.locator("#memo").fill("Website hosting, October");
  await baseSeller.page.locator(".view-create > .key-primary").click();
  await baseSeller.page.locator(".signing + .key-row .key-primary").click();
  await expect(baseSeller.page.locator(".ticket")).toBeVisible();
  const baseLink = await baseSeller.page.locator(".share input").inputValue();
  const basePayer = await phone(browser);
  await installWallet(basePayer.page, { account: eoa, chainId: BASE.chainId, endpoints, known: [BASE.chainId] });
  await basePayer.page.goto(baseLink);
  const baseKey = basePayer.page.locator(".payform .key-primary");
  await baseKey.click(); // connect
  await expect(baseKey).toHaveText("Pay 25.00 USDC");
  await expect(basePayer.page.locator(".route-note")).toHaveText("One signature; the fee is covered.");
  for (let i = 0; i < 4; i += 1) {
    await expect(basePayer.page.locator(".vstrip > li").nth(i)).toHaveAttribute("data-lamp", "ok");
  }
  await shot(basePayer.page, "screen-5-base-pay.png", "Base edition, payer with a browser wallet (EOA): the four lamps and the gasless USDC route, one EIP-3009 signature and no transaction.", basePayer.page.locator(".screen").first(), 16);
});
