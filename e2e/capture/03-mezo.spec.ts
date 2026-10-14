// SPDX-License-Identifier: MIT
/**
 * Product screenshots of the Mezo edition for its submission (docs/submissions/mezo.md §3), from the production build
 * on its production origin, against an anvil fork of Mezo testnet with the real MUSD, MUSD's lending contracts and the
 * recorded PayLinkV2 deployment (`fixtures/mezo.ts`). A 390 × 844 phone, dark theme, English:
 *
 * 6. The seller: a 12.50 MUSD invoice signed in a browser wallet, as the card with its QR code.
 * 7. The payer: four lamps, the permit route and the BTC fee line, then the Pay key.
 * 8. The receipt, re-verified on the fork.
 * 9. Status: Mezo testnet, the genuine contract, MUSD read live, the fee, the smallest MUSD loan.
 * 10. A payer without MUSD: no faucet, Mezo's testnet borrow page, and the smallest loan that covers the invoice.
 *
 * The production build shows Mezo testnet's real name and the registry's deployment, so this runs once
 * protocol/deployments/31611.json is recorded (submission pack §10 step 5); before that it is skipped. Then:
 * `pnpm --filter @paylink/e2e capture 03-mezo` (egress to https://rpc.test.mezo.org). The pictures go to
 * docs/submissions/assets/screens/, with `capture-mezo.json` saying when, from which commit and at which fork block.
 * The transactions they show exist only on the fork.
 *
 * `PAYLINK_CAPTURE_MEZO_DRYRUN=1` runs the same steps now, on the end-to-end build (the fork's deployment, chain
 * labelled "e2e-local"), and writes the pictures to e2e/test-results/capture/mezo-dryrun/ only, never to the assets.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { parseUnits } from "viem";
import type { Address } from "viem";
import { settleAnimations } from "../fixtures/axe.ts";
import { buildMezoSite, MEZO, mezoChains, routeMezo, startMezoFork } from "../fixtures/mezo.ts";
import type { MezoFork } from "../fixtures/mezo.ts";
import { servePages, SITE } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { REPO } from "../fixtures/server.ts";
import { installWallet } from "../fixtures/wallet.ts";
import { ORIGIN, routeSite } from "./fork.ts";

const DRY_RUN = process.env["PAYLINK_CAPTURE_MEZO_DRYRUN"] === "1";
const RECORD = join(REPO, "protocol/deployments/31611.json");
const OUT = join(REPO, "docs/submissions/assets");
const SCREENS = DRY_RUN ? join(REPO, "e2e/test-results/capture/mezo-dryrun") : join(OUT, "screens");
const PHONE = { width: 390, height: 844 } as const;
const MUSD = (value: string): bigint => parseUnits(value, 18);

let mezo: MezoFork | null = null;
let site: StaticServer | null = null;
let origin = ORIGIN;
const contexts: BrowserContext[] = [];
const shots: { file: string; what: string }[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (!DRY_RUN && !existsSync(RECORD)) {
    return;
  }
  test.setTimeout(600_000);
  mezo = await startMezoFork();
  if (DRY_RUN) {
    site = await servePages(await buildMezoSite(mezoChains(mezo.deployment)));
    origin = site.origin;
  } else {
    // The production build, exactly as Cloudflare Pages builds it, with the recorded Mezo deployment in its registry.
    execFileSync(process.execPath, ["--conditions=@paylink/source", "scripts/build.ts"], { cwd: join(REPO, "apps/web"), stdio: ["ignore", "ignore", "inherit"] });
    site = await servePages(SITE);
  }
  mkdirSync(SCREENS, { recursive: true });
});

test.afterAll(async () => {
  for (const context of contexts) {
    await context.close();
  }
  await site?.close();
  if (mezo === null) {
    return;
  }
  const forkBlock = mezo.fork.forkBlock.toString();
  await mezo.stop();
  if (DRY_RUN) {
    return;
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  writeFileSync(
    join(OUT, "capture-mezo.json"),
    `${JSON.stringify(
      {
        captured: new Date().toISOString(),
        commit,
        build: "apps/web/dist (production build, scripts/build.ts)",
        origin: ORIGIN,
        viewport: { ...PHONE, deviceScaleFactor: 2, colorScheme: "dark", locale: "en" },
        forks: { [String(MEZO.chainId)]: { rpc: MEZO.upstream, block: forkBlock } },
        note: "Fork captures: the transactions shown exist only on a local anvil fork of Mezo testnet; the BTC price and the suggested tip are Mezo testnet's own, read when the fork started.",
        screens: shots,
      },
      null,
      2,
    )}\n`,
  );
});

const fork = (): MezoFork => {
  if (mezo === null) {
    throw new Error("no Mezo fork");
  }
  return mezo;
};

const account = (index: number): Address => {
  const found = fork().fork.accounts[index];
  if (found === undefined) {
    throw new Error(`the fork has no account ${String(index)}`);
  }
  return found;
};

/** A phone with a browser wallet on `owner`, already on Mezo testnet. */
async function phone(browser: Browser, owner: Address): Promise<Page> {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", locale: "en-US", serviceWorkers: "block" });
  contexts.push(context);
  if (!DRY_RUN && site !== null) {
    await routeSite(context, site);
  }
  await routeMezo(context, fork());
  const page = await context.newPage();
  await installWallet(page, { account: owner, chainId: MEZO.chainId, endpoints: new Map<number, string | null>([[MEZO.chainId, fork().fork.url]]), known: [MEZO.chainId] });
  return page;
}

/** A viewport screenshot with `anchor` `offset` CSS pixels below the top of the phone screen. */
async function shot(page: Page, file: string, what: string, anchor: Locator, offset = 16): Promise<void> {
  await settleAnimations(page);
  await anchor.evaluate((element, top) => {
    window.scrollTo({ top: Math.max(0, element.getBoundingClientRect().top + window.scrollY - top), behavior: "instant" });
  }, offset);
  await settleAnimations(page);
  await page.screenshot({ path: join(SCREENS, file), animations: "disabled", caret: "hide" });
  shots.push({ file: `screens/${file}`, what });
}

/** Opens `link`, connects the wallet, and returns the Pay key once it reads `label`. */
async function openToPay(page: Page, link: string, label: string): Promise<Locator> {
  await page.goto(link);
  const key = page.locator(".payform .key-primary");
  await expect(key).toHaveText(/^Connect a wallet to pay$/);
  await key.click();
  await expect(key).toHaveText(label);
  return key;
}

test("Mezo edition: create, pay with a permit, the receipt, Status, and a payer who borrows MUSD", async ({ browser }) => {
  test.skip(mezo === null, "PayLinkV2 is not recorded on Mezo testnet yet (protocol/deployments/31611.json): capture after the deployment, or set PAYLINK_CAPTURE_MEZO_DRYRUN=1");
  test.setTimeout(600_000);
  const m = fork();
  await m.mintMusd(account(2), MUSD("100"));

  // 6. The seller signs a 12.50 MUSD invoice in a browser wallet: no transaction, no gas.
  const seller = await phone(browser, account(1));
  await seller.goto(`${origin}/mezo/`);
  await seller.locator("#amount").fill("12.50");
  await seller.locator("#memo").fill("Logo design, invoice 042");
  await seller.locator(".view-create > .key-primary").click();
  await seller.locator(".signing + .key-row .key-primary").click();
  const ticket = seller.locator(".ticket");
  await expect(ticket).toBeVisible();
  const link = await seller.locator(".share input").inputValue();
  await shot(seller, "screen-6-mezo-create.png", "Mezo edition, seller: an invoice for 12.50 MUSD signed in a browser wallet (one EIP-712 signature, no transaction, no gas), shown as the card with its QR code.", ticket, 50);

  // 7. The payer: four lamps, the permit route, the BTC fee line.
  const payer = await phone(browser, account(2));
  const key = await openToPay(payer, link, "Pay 12.50 MUSD");
  for (let i = 0; i < 4; i += 1) {
    await expect(payer.locator(".vstrip > li").nth(i)).toHaveAttribute("data-lamp", "ok");
  }
  await expect(payer.locator(".route-note").first()).toHaveText("One signature, then one transaction from your wallet.");
  await expect(payer.locator(".fee-note")).toHaveText(/^Network fee: about \d+(\.\d+)? sat, paid in BTC by your wallet\.$/);
  await shot(payer, "screen-7-mezo-pay.png", "Mezo edition, payer: four lamps read from Mezo testnet, the route (one EIP-2612 permit for exactly the amount, then one payWithPermit transaction) and the network fee in sats, paid in BTC by the payer's wallet.", payer.locator(".vstrip").first(), 16);

  // 8. One permit and one transaction; the receipt, re-verified.
  await key.click();
  await expect(payer.locator(".receipt-slot .receipt")).toContainText("Approved");
  const receiptLink = await payer.locator(".receipt-slot a.key").first().getAttribute("href");
  await payer.goto(new URL(receiptLink ?? "", origin).toString());
  const receipt = payer.locator(".view-receipt .receipt");
  await expect(receipt).toContainText("Payment found");
  await shot(payer, "screen-8-mezo-receipt.png", "Mezo edition: the receipt of a 12.50 MUSD payment, re-verified against Mezo testnet (on a fork) on every opening: Paid event, genuine contract, matching invoice.", receipt, 16);

  // 9. Status: MUSD read live, the fee, the smallest loan.
  await seller.goto(`${origin}/mezo/status/`);
  const board = seller.locator(".board > li").first();
  for (let i = 0; i < 5; i += 1) {
    await expect(board.locator(".vstrip > li").nth(i)).toHaveAttribute("data-lamp", "ok");
  }
  await shot(seller, "screen-9-mezo-status.png", "Mezo edition, Status: Mezo testnet answers, the genuine PayLinkV2 release, MUSD read live (permit yes, EIP-3009 no), the BTC fee per payment, and the smallest MUSD loan read from MUSD's own contracts.", board, 16);

  // 10. A payer without MUSD, on another invoice: borrowed against bitcoin, never from a faucet; the smallest loan.
  await seller.goto(`${origin}/mezo/`);
  await seller.locator("#amount").fill("40.00");
  await seller.locator("#memo").fill("Website, invoice 043");
  await seller.locator(".view-create > .key-primary").click();
  await seller.locator(".signing + .key-row .key-primary").click();
  await expect(seller.locator(".ticket")).toBeVisible();
  const second = await seller.locator(".share input").inputValue();
  const poor = await phone(browser, account(6));
  await openToPay(poor, second, "Pay 40.00 MUSD");
  const funds = poor.locator(".funds");
  await expect(funds.locator(".funds-borrow")).toContainText("Or borrow MUSD without selling bitcoin");
  await shot(poor, "screen-10-mezo-borrow.png", "Mezo edition, a payer without MUSD: no faucet, Mezo's testnet borrow page, and the smallest Mezo loan that covers the invoice with the test BTC it locks, read live from MUSD's BorrowerOperations, PriceFeed and TroveManager.", funds, 16);
});
