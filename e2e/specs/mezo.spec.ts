// SPDX-License-Identifier: MIT
/**
 * The Mezo edition (`/mezo/`, PAYLINK-V2-SPEC §9; facts: docs/research/mezo.md) end to end, on its production build
 * under its real `_headers`, against an anvil fork of Mezo testnet itself: the real MUSD (18 decimals, EIP-2612, no
 * EIP-3009), the real CREATE2 factory, and PayLinkV2 2.0.0 put at its release address through it on the fork
 * (fixtures/mezo.ts). Browser wallets are the mock EIP-1193 wallet announced through EIP-6963, forwarding to the fork's
 * unlocked accounts (random mnemonic). Nothing reaches Mezo testnet.
 *
 * - The hero flow: a freelancer in Antananarivo signs a 12.50 MUSD invoice (one signature, no transaction; the wallet
 *   adds Mezo testnet from the registry), arms the till, shares the link; the client pays with `payWithPermit` (one
 *   EIP-2612 permit under MUSD's own domain, then one transaction with an explicit gas limit, BTC for the fee); exactly
 *   12.50 MUSD moves, PayLink keeps none and no allowance is left; the receipt re-verifies on chain; the till lights;
 *   the ledger shows it paid.
 * - A smart account (code at its address) approves exactly the amount, then pays (two transactions); one whose wallet
 *   offers EIP-5792 batches approves once (`wallet_sendCalls([approve, pay])`).
 * - A payer without BTC is told the fee is BTC and sent to Mezo's faucet, and pays once funded; a payer without MUSD is
 *   told test MUSD is borrowed, not dispensed.
 * - Mezo testnet's RPC answers `null` for mined transactions (research §2), which a fork never does: with lookups that
 *   answer `null` first, the payment still reads "Approved", the receipt still verifies and the till still lights.
 * - The payee cancels an invoice from the ledger with one `cancel` transaction (no relayer serves Mezo).
 * - Status: Mezo testnet answers, the contract is the genuine release, MUSD read live matches the registry, the BTC fee
 *   in sats, and why no payment is gasless here.
 * - Headers: `/mezo/` under its own policy (Mezo's RPC), the root's without it; no CSP violation under Trusted Types;
 *   the service worker and the manifest scoped to `/mezo/`.
 * - Every route in EN, FR and MG, light and dark, at 320, 390 and 1280 px: axe-core WCAG 2.2 AA zero violations, no
 *   sideways scroll, no word broken inside itself, no copy cut by an ellipsis.
 *
 * The fork needs egress to https://rpc.test.mezo.org. Without it the spec is skipped and says why, unless
 * PAYLINK_E2E_REQUIRE_MEZO=1, which makes that a failure.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { decodeFunctionData, parseAbi, parseUnits } from "viem";
import type { Address, Hex } from "viem";
import { axe } from "../fixtures/axe.ts";
import { brokenWords, horizontalOverflow, overlappingTargets, setLocale, truncatedText } from "../fixtures/layout.ts";
import { buildMezoSite, MEZO, mezoChains, MezoUnreachable, MUSD_DOMAIN, PAYLINK, routeMezo, startMezoFork } from "../fixtures/mezo.ts";
import type { MezoFork } from "../fixtures/mezo.ts";
import { nullLookups } from "../fixtures/null-lookups.ts";
import type { NullLookups } from "../fixtures/null-lookups.ts";
import { servePages } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { REPO } from "../fixtures/server.ts";
import { installWallet } from "../fixtures/wallet.ts";
import type { MockWallet } from "../fixtures/wallet.ts";

const payLinkAbi = parseAbi([
  "function pay((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv, bytes payeeSig, uint128 amount, bytes32 payerRef)",
  "function payWithPermit((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv, bytes payeeSig, uint128 amount, bytes32 payerRef, (uint256,uint8,bytes32,bytes32) p)",
]);
const erc20 = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const SCREENS = join(REPO, "e2e/test-results/mezo-screens");
const MUSD = (value: string): bigint => parseUnits(value, 18);

let mezo: MezoFork | null = null;
let server: StaticServer;
let unreachable: string | null = null;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  try {
    mezo = await startMezoFork();
  } catch (error) {
    if (!(error instanceof MezoUnreachable) || process.env["PAYLINK_E2E_REQUIRE_MEZO"] === "1") {
      throw error;
    }
    unreachable = error.message;
    return;
  }
  server = await servePages(await buildMezoSite(mezoChains(mezo.deployment)));
  mkdirSync(SCREENS, { recursive: true });
});

test.beforeEach(() => {
  test.skip(unreachable !== null, `Mezo testnet's RPC cannot be forked from here: ${unreachable ?? ""}`);
});

// Each test's browsers close with it: a page left open keeps polling the fork while the next test runs.
test.afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.close().catch(() => undefined);
  }
});

test.afterAll(async () => {
  if (mezo !== null) {
    await server.close();
    await mezo.stop();
  }
});

const fork = (): MezoFork => {
  if (mezo === null) {
    throw new Error("no Mezo fork");
  }
  return mezo;
};

interface Actor {
  readonly page: Page;
  readonly wallet: MockWallet;
  readonly problems: string[];
  /** Requests the page made to the production relayer (it serves no Mezo chain: there must be none). */
  readonly relayer: string[];
}

/** A person at a browser with a wallet on `account`; the wallet starts on Ethereum and does not know Mezo testnet. */
async function actor(browser: Browser, account: Address, options: { phone?: boolean; scheme?: "light" | "dark"; batch?: boolean; known?: boolean; nulls?: NullLookups } = {}): Promise<Actor> {
  const context = await browser.newContext({
    viewport: options.phone === true ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    ...(options.phone === true ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    colorScheme: options.scheme ?? "light",
  });
  contexts.push(context);
  await routeMezo(context, fork(), options.nulls === undefined ? {} : { nulls: options.nulls });
  // The relayer serves no Mezo chain: nothing on /mezo/ may ask it anything.
  const relayer: string[] = [];
  await context.route("https://paylink-relayer.raherizonambinina.workers.dev/**", async (route) => {
    relayer.push(route.request().url());
    await route.abort("connectionrefused");
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_CONNECTION_REFUSED") && !(message.text().includes("404") && message.location().url.includes("/nope/"))) {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  const wallet = await installWallet(page, {
    account,
    chainId: options.known === true ? MEZO.chainId : 1,
    endpoints: new Map<number, string | null>([[MEZO.chainId, fork().fork.url], [1, null]]),
    known: options.known === true ? [MEZO.chainId] : [1],
    ...(options.batch === true ? { batch: true } : {}),
  });
  return { page, wallet, problems, relayer };
}

const account = (index: number): Address => {
  const found = fork().fork.accounts[index];
  if (found === undefined) {
    throw new Error(`the fork has no account ${String(index)}`);
  }
  return found;
};
const lamp = (page: Page, index: number) => page.locator(".vstrip > li").nth(index);

/** Signs an invoice on the Mezo terminal and returns its payment link. */
async function createInvoice(payee: Actor, amount: string, memo: string): Promise<string> {
  const { page } = payee;
  await page.goto(`${server.origin}/mezo/`);
  await page.locator("#amount").fill(amount);
  await page.locator("#memo").fill(memo);
  await page.locator(".view-create > .key-primary").click();
  await expect(page.locator(".signing")).toContainText("You are about to sign this invoice");
  await page.locator(".signing + .key-row .key-primary").click();
  await expect(page.locator(".ticket")).toBeVisible();
  return await page.locator(".share input").inputValue();
}

/** Opens `link` as `payer`, connects, and returns the Pay key once it reads `label`. */
async function openToPay(payer: Actor, link: string, label: string | RegExp): Promise<ReturnType<Page["locator"]>> {
  await payer.page.goto(link);
  const key = payer.page.locator(".payform .key-primary");
  await expect(lamp(payer.page, 0)).toHaveAttribute("data-lamp", "ok");
  // Connect, then switch the wallet to Mezo testnet, as each step's key appears.
  for (const step of [/^Connect a wallet to pay$/, /^Switch to /]) {
    await expect(key).toHaveText(new RegExp(`${step.source}|${typeof label === "string" ? label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : label.source}`));
    if (step.test((await key.textContent()) ?? "")) {
      await key.click();
    }
  }
  await expect(key).toHaveText(label);
  return key;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SCREENS, `${name}.png`), fullPage: true });
}

test("hero flow: a 12.50 MUSD invoice, signed without gas, paid with one permit and BTC for the fee; receipt, till and ledger", async ({ browser }) => {
  test.setTimeout(240_000);
  const m = fork();
  const payeeAddress = account(1);
  const payerAddress = account(2);
  await m.mintMusd(payerAddress, MUSD("100"));

  // The freelancer's terminal speaks MUSD and BTC, and walks a tester to test funds on Mezo's own pages.
  const payee = await actor(browser, payeeAddress);
  await payee.page.goto(`${server.origin}/mezo/`);
  await expect(payee.page.locator(".edition-tag")).toHaveText("Mezo");
  await expect(payee.page.locator(".intro .kicker")).toHaveText("Bitcoin-backed dollar invoices");
  await expect(payee.page.locator(".intro h1")).toContainText("Get paid in MUSD");
  await expect(payee.page.locator(".band .band-label")).toHaveText(["MEZO"]);
  await expect(payee.page.locator(".band[aria-checked=true] .band-id")).toHaveText("Testnet · 31611");
  await expect(payee.page.locator(".readout-top")).toContainText("MUSD");
  await expect(payee.page.locator("#mezo-notes")).toHaveText("MUSD and BTC on Mezo");
  expect(await payee.page.locator(".lead-aside a.ext").evaluateAll((links) => links.map((a) => a.getAttribute("href")))).toEqual([
    "https://faucet.test.mezo.org",
    "https://discord.com/invite/mezo",
    "https://testnet.mezo.org/feature/borrow",
  ]);
  await payee.page.locator("#amount").fill("12.50");
  // The ariary estimate (display only): MUSD is a dollar.
  await expect(payee.page.locator(".readout-fx")).toContainText("Ar");
  await shot(payee.page, "01-create-1280-light");

  const link = await createInvoice(payee, "12.50", "Logo design · Antananarivo");
  expect(link).toMatch(new RegExp(`^${server.origin}/mezo/pay/#2\\.${String(MEZO.chainId)}\\.`));
  // The wallet learned Mezo testnet from the registry (EIP-3085), and only signed: no transaction, no gas.
  const added = payee.wallet.requests.find((r) => r.method === "wallet_addEthereumChain")?.params[0] as {
    chainId: string;
    chainName: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    rpcUrls: string[];
    blockExplorerUrls?: string[];
  };
  expect(added.chainId).toBe("0x7b7b");
  expect(added.nativeCurrency).toEqual({ name: "Bitcoin", symbol: "BTC", decimals: 18 });
  expect(added.rpcUrls).toEqual([MEZO.registryRpc]);
  expect(added.blockExplorerUrls).toEqual([MEZO.explorer]);
  expect(payee.wallet.requests.filter((r) => r.method === "eth_signTypedData_v4")).toHaveLength(1);
  expect(payee.wallet.sent()).toHaveLength(0);
  await shot(payee.page, "02-issued-1280-light");

  // The till, armed for this invoice.
  const till = await actor(browser, payeeAddress, { known: true });
  await till.page.goto(link.replace("/mezo/pay/#", "/mezo/till/#"));
  await till.page.getByRole("button", { name: "Start the till" }).click();
  const display = till.page.locator(".till");
  await expect(display).toHaveAttribute("data-state", "waiting");

  // The client, on a phone in the dark.
  const payer = await actor(browser, payerAddress, { phone: true, scheme: "dark" });
  const before = { payer: await m.musd("balanceOf", payerAddress), payee: await m.musd("balanceOf", payeeAddress), btc: await m.btc(payerAddress), contract: await m.musd("balanceOf", PAYLINK) };
  await payer.page.goto(link);
  await expect(payer.page.locator(".screen .amount")).toContainText("12.50");
  await expect(payer.page.locator(".screen .amount")).toContainText("MUSD");
  await expect(payer.page.locator(".screen-memo")).toContainText("Logo design · Antananarivo");
  for (const index of [0, 2, 3]) {
    await expect(lamp(payer.page, index)).toHaveAttribute("data-lamp", "ok");
  }
  await expect(payer.page.locator(".assure")).toHaveText("Non-custodial: the MUSD go straight from your wallet to the address above. Your wallet pays the network fee, in BTC.");
  await shot(payer.page, "03-pay-390-dark");
  const key = await openToPay(payer, link, "Pay 12.50 MUSD");
  await expect(lamp(payer.page, 1)).toHaveAttribute("data-lamp", "ok");
  await expect(payer.page.locator(".route-note").first()).toHaveText("One signature, then one transaction from your wallet.");
  await expect(payer.page.locator(".fee-note")).toHaveText(/^Network fee: about \d+(\.\d+)? sat, paid in BTC by your wallet\.$/);
  await shot(payer.page, "04-pay-ready-390-dark");
  await key.click();
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  await shot(payer.page, "05-paid-390-dark");

  // One EIP-2612 permit under MUSD's own domain, for exactly the amount, PayLinkV2 as spender; then one payWithPermit
  // to the release address with an explicit gas limit (Mezo charges at least half of it).
  const signed = payer.wallet.requests.filter((r) => r.method === "eth_signTypedData_v4");
  expect(signed).toHaveLength(1);
  const typed = JSON.parse(signed[0]?.params[1] as string) as { domain: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
  expect(typed.primaryType).toBe("Permit");
  expect({ ...typed.domain, verifyingContract: String(typed.domain["verifyingContract"]).toLowerCase() }).toEqual({ name: MUSD_DOMAIN.name, version: MUSD_DOMAIN.version, chainId: MEZO.chainId, verifyingContract: MEZO.musd.toLowerCase() });
  expect(String(typed.message["owner"]).toLowerCase()).toBe(payerAddress.toLowerCase());
  expect(String(typed.message["spender"]).toLowerCase()).toBe(PAYLINK.toLowerCase());
  expect(BigInt(String(typed.message["value"]))).toBe(MUSD("12.5"));
  const sent = payer.wallet.sent();
  expect(sent).toHaveLength(1);
  const tx = sent[0]?.params[0] as { to: string; data: Hex; gas?: string };
  expect(tx.to.toLowerCase()).toBe(PAYLINK.toLowerCase());
  expect(decodeFunctionData({ abi: payLinkAbi, data: tx.data }).functionName).toBe("payWithPermit");
  expect(BigInt(tx.gas ?? "0x0")).toBeGreaterThan(0n);
  // Exactly the amount, payer to payee; PayLink holds nothing and no allowance is left; the payer paid BTC for gas.
  expect(await m.musd("balanceOf", payerAddress)).toBe(before.payer - MUSD("12.5"));
  expect(await m.musd("balanceOf", payeeAddress)).toBe(before.payee + MUSD("12.5"));
  expect(await m.musd("balanceOf", PAYLINK)).toBe(before.contract);
  expect(await m.allowance(payerAddress, PAYLINK)).toBe(0n);
  expect(await m.btc(payerAddress)).toBeLessThan(before.btc);

  // The till lights for its invoice.
  await expect(display).toHaveAttribute("data-state", "paid", { timeout: 20_000 });
  await expect(till.page.locator(".till-verdict")).toHaveText("Paid");
  await shot(till.page, "06-till-paid-1280-light");

  // The receipt re-verifies on chain, and says whose payment it is.
  await payer.page.locator(".receipt-slot a.key").first().click();
  await expect(payer.page).toHaveURL(new RegExp(`/mezo/r/#2\\.${String(MEZO.chainId)}\\.0x[0-9a-f]{64}\\.\\d+`));
  await expect(payer.page.locator(".view-receipt .receipt")).toContainText("Payment found");
  await expect(payer.page.locator(".view-receipt .receipt")).toContainText("Matches the invoice");
  await expect(payer.page.locator(".view-receipt .receipt-who")).toHaveText("Paid by you: the From address is your account.");
  await shot(payer.page, "07-receipt-390-dark");

  // The ledger: paid, with its total.
  await payee.page.goto(`${server.origin}/mezo/ledger/`);
  const row = payee.page.locator(".view-ledger .links > li").first();
  await expect(row).toContainText("Logo design · Antananarivo");
  await expect(row.locator(".lamp, .pill").first()).toContainText(/paid/i);
  await expect(payee.page.locator(".tally")).toContainText("12.50");
  await expect(payee.page.locator(".view-ledger .activity .links > li").first()).toContainText("Logo design · Antananarivo");
  await shot(payee.page, "08-ledger-1280-light");

  expect(payee.problems).toEqual([]);
  expect(payer.problems).toEqual([]);
  expect(till.problems).toEqual([]);
  expect([...payee.relayer, ...payer.relayer, ...till.relayer]).toEqual([]);
});

test("Mezo testnet's RPC answers null for mined transactions: the payment, its receipt and the till still check out", async ({ browser }) => {
  test.setTimeout(180_000);
  const m = fork();
  const payeeAddress = account(1);
  const payerAddress = account(9);
  await m.mintMusd(payerAddress, MUSD("10"));
  const payee = await actor(browser, payeeAddress);
  const link = await createInvoice(payee, "2.75", "Lookups that answer null");

  // The till: the payment's receipt answers null ten times, more than one check asks (eight). The first check cannot
  // read it, so the till says the network is lost, keeps the log, and lights on the next poll of the same blocks.
  const tillNulls = nullLookups("N".repeat(10));
  const till = await actor(browser, payeeAddress, { known: true, nulls: tillNulls });
  await till.page.goto(link.replace("/mezo/pay/#", "/mezo/till/#"));
  await till.page.getByRole("button", { name: "Start the till" }).click();
  const display = till.page.locator(".till");
  await expect(display).toHaveAttribute("data-state", "waiting");

  // The payer: the wait for the receipt sees three nulls, the check before "Approved" two, and the receipt page one.
  const payerNulls = nullLookups("NNNRNNRNR");
  const payer = await actor(browser, payerAddress, { known: true, nulls: payerNulls });
  const key = await openToPay(payer, link, "Pay 2.75 MUSD");
  await key.click();
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved", { timeout: 60_000 });
  await expect(payer.page.locator(".status")).not.toContainText("Error code");
  expect(await m.musd("balanceOf", payerAddress)).toBe(MUSD("10") - MUSD("2.75"));

  await expect(display).toHaveAttribute("data-state", "paid", { timeout: 60_000 });
  await expect(till.page.locator(".till-verdict")).toHaveText("Paid");
  expect(tillNulls.nulled()).toBe(10);

  await payer.page.locator(".receipt-slot a.key").first().click();
  await expect(payer.page.locator(".view-receipt .receipt")).toContainText("Payment found");
  await expect(payer.page.locator(".view-receipt .receipt")).toContainText("Matches the invoice");
  expect(payerNulls.nulled()).toBe(6);
  expect([...payee.problems, ...payer.problems, ...till.problems]).toEqual([]);
});

test("a smart account approves exactly the amount then pays; one whose wallet batches approves once", async ({ browser }) => {
  const m = fork();
  const payee = await actor(browser, account(1));
  const smart = account(3);
  const batched = account(4);
  await m.mintMusd(smart, MUSD("50"));
  await m.mintMusd(batched, MUSD("50"));
  // An EIP-7702 delegation designator: the account has code, so the router treats it as a smart account (its
  // permit could not be checked by ERC-1271 on MUSD, which checks ECDSA only).
  await m.fork.rpc("anvil_setCode", [smart, `0xef0100${"11".repeat(20)}`]);

  const first = await createInvoice(payee, "7", "Two transactions");
  const payer = await actor(browser, smart);
  const key = await openToPay(payer, first, "Pay 7.00 MUSD");
  await expect(payer.page.locator(".route-note").first()).toHaveText("Two transactions: approve exactly this amount, then pay.");
  await expect(payer.page.locator(".fee-note")).toHaveText(/^Network fee: about \d+(\.\d+)? sat, paid in BTC by your wallet\.$/);
  const before = await m.musd("balanceOf", account(1));
  await key.click();
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  const sent = payer.wallet.sent().map((r) => r.params[0] as { to: string; data: Hex; gas?: string });
  expect(sent.map((tx) => tx.to.toLowerCase())).toEqual([MEZO.musd.toLowerCase(), PAYLINK.toLowerCase()]);
  const approve = decodeFunctionData({ abi: erc20, data: sent[0]?.data ?? "0x" });
  expect(approve.functionName).toBe("approve");
  expect(approve.args).toEqual([PAYLINK, MUSD("7")]);
  expect(decodeFunctionData({ abi: payLinkAbi, data: sent[1]?.data ?? "0x" }).functionName).toBe("pay");
  expect(payer.wallet.requests.filter((r) => r.method === "eth_signTypedData_v4")).toHaveLength(0);
  expect(await m.allowance(smart, PAYLINK)).toBe(0n);
  expect(await m.musd("balanceOf", account(1))).toBe(before + MUSD("7"));

  const second = await createInvoice(payee, "3", "One approval");
  const batch = await actor(browser, batched, { batch: true });
  const batchKey = await openToPay(batch, second, "Pay 3.00 MUSD");
  await expect(batch.page.locator(".route-note").first()).toHaveText("One approval in your wallet: it approves exactly this amount and pays, together.");
  await batchKey.click();
  await expect(batch.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  const calls = batch.wallet.requests.filter((r) => r.method === "wallet_sendCalls");
  expect(calls).toHaveLength(1);
  const request = calls[0]?.params[0] as { chainId: string; atomicRequired: boolean; calls: { to: string }[] };
  expect(request.chainId).toBe("0x7b7b");
  expect(request.atomicRequired).toBe(true);
  expect(request.calls.map((c) => c.to.toLowerCase())).toEqual([MEZO.musd.toLowerCase(), PAYLINK.toLowerCase()]);
  expect(batch.wallet.sent()).toHaveLength(0);
  expect(payer.problems).toEqual([]);
  expect(batch.problems).toEqual([]);
});

test("a payer without BTC is sent to Mezo's faucet and pays once funded; one without MUSD is told it is borrowed", async ({ browser }) => {
  const m = fork();
  const payee = await actor(browser, account(1));
  const noBtc = account(5);
  const noMusd = account(6);
  await m.mintMusd(noBtc, MUSD("20"));
  await m.setBtc(noBtc, 0n);
  const link = await createInvoice(payee, "4.25", "No fee coin yet");

  const payer = await actor(browser, noBtc, { phone: true });
  await payer.page.goto(link);
  const key = payer.page.locator(".payform .key-primary");
  await expect(key).toHaveText("Connect a wallet to pay");
  await key.click();
  await expect(key).toHaveText(/^Switch to /);
  await key.click();
  await expect(payer.page.locator(".route-note").first()).toHaveText("No BTC for the network fee: on Mezo, your wallet pays it.");
  await expect(key).toHaveText("Check my BTC again");
  const row = payer.page.locator(".funds-btc");
  await expect(row).toContainText("The network fee is paid in BTC, and this wallet holds none.");
  expect(await row.locator("a").evaluateAll((links) => links.map((a) => a.getAttribute("href")))).toEqual(["https://faucet.test.mezo.org", "https://discord.com/invite/mezo"]);
  await expect(payer.page.locator(".fee-note")).toHaveText("");
  await shot(payer.page, "09-pay-no-btc-390-light");
  // Funded from the faucet (here: the fork), the payer checks again and pays.
  await m.setBtc(noBtc, 10n ** 15n);
  await key.click();
  await expect(key).toHaveText("Pay 4.25 MUSD");
  await expect(payer.page.locator(".funds-btc")).toHaveCount(0);
  await key.click();
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");

  const fresh = await createInvoice(payee, "9", "No MUSD yet");
  const poor = await actor(browser, noMusd, { phone: true });
  await openToPay(poor, fresh, "Pay 9.00 MUSD");
  const funds = poor.page.locator(".funds");
  await expect(funds).toContainText("This account holds 0.00 MUSD.");
  await expect(funds).toContainText("MUSD has no faucet");
  expect(await funds.locator("a").evaluateAll((links) => links.map((a) => a.getAttribute("href")))).toEqual(["https://testnet.mezo.org/feature/borrow", "https://faucet.test.mezo.org"]);
  // Read from MUSD's own contracts on the fork (BorrowerOperations, its PriceFeed and TroveManager): the smallest loan
  // that covers the invoice, and the test BTC it locks at Mezo's minimum ratio.
  await expect(funds.locator(".funds-borrow")).toHaveText(
    /^Or borrow MUSD without selling bitcoin: Mezo's smallest loan that covers this is 1,800\.00 MUSD\. It needs at least 0\.0\d+ test BTC locked as collateral: 110% of the 2,001\.80 MUSD debt, at [\d,]+ USD per BTC on Mezo's price feed, read now\. Lock more to stay clear of liquidation\.$/,
  );
  await shot(poor.page, "10-pay-no-musd-390-light");
  expect(payer.problems).toEqual([]);
});

test("cancel from the ledger: one cancel transaction from the payee's wallet (BTC fee, no relayer), and the link stops taking payments", async ({ browser }) => {
  const payee = await actor(browser, account(1), { known: true });
  const link = await createInvoice(payee, "5", "Withdrawn quote");
  await payee.page.goto(`${server.origin}/mezo/ledger/`);
  const row = payee.page.locator(".view-ledger .links > li", { hasText: "Withdrawn quote" });
  const cancel = row.locator(".key-danger");
  await cancel.click(); // arms
  await expect(cancel).toContainText("Confirm cancel");
  await cancel.click(); // confirms
  await expect(payee.page.locator("[aria-live=polite]").last()).toContainText(/cancelled/i);
  await expect(payee.page.locator(".view-ledger .links > li", { hasText: "Withdrawn quote" }).locator(".lamp, .pill").first()).toContainText(/cancelled/i);
  const sent = payee.wallet.sent().map((r) => r.params[0] as { to: string });
  expect(sent.map((tx) => tx.to.toLowerCase())).toEqual([PAYLINK.toLowerCase()]);
  const payer = await actor(browser, account(2));
  await payer.page.goto(link);
  await expect(lamp(payer.page, 3)).toHaveAttribute("data-lamp", "err");
  await expect(lamp(payer.page, 3)).toContainText("Cancelled");
  await expect(payer.page.locator(".payform .key-primary")).toBeDisabled();
  expect([...payee.relayer, ...payer.relayer]).toEqual([]);
  expect(payee.problems).toEqual([]);
});

test("status: Mezo testnet answers, the genuine release, MUSD read live as the registry says, the BTC fee, no gasless payment", async ({ browser }) => {
  const { page, problems, relayer } = await actor(browser, account(1));
  await page.goto(`${server.origin}/mezo/status/`);
  const board = page.locator(".board > li");
  await expect(board).toHaveCount(1);
  await expect(board.locator(".board-name")).toHaveText("MEZO");
  const lights = board.locator(".vstrip > li");
  await expect(lights.locator(".vstrip-name")).toHaveText(["Network answers", "Genuine contract", "MUSD on the network", "Network fee", "Borrowing MUSD"]);
  for (const index of [0, 1, 2, 3, 4]) {
    await expect(lights.nth(index)).toHaveAttribute("data-lamp", "ok");
  }
  await expect(lights.nth(2)).toHaveText(/Mezo USD \(MUSD\), 18 decimals · permit \(EIP-2612\): yes · signed transfers \(EIP-3009\): no, as the registry says\./);
  await expect(lights.nth(3)).toHaveText(/Paid in BTC by the payer: about \d+(\.\d+)? sat per payment at the current gas price\./);
  await expect(lights.nth(4)).toHaveText(/Smallest loan 1,800\.00 MUSD: at least 0\.0\d+ test BTC of collateral \(110% of a 2,001\.80 MUSD debt\), at [\d,]+ USD per BTC on Mezo's price feed\./);
  const services = page.locator(".view-status > .vstrip").first();
  await expect(services.locator(".vstrip-name")).toHaveText(["Relayer", "Gasless payments", "History service"]);
  await expect(services).toContainText("Does not serve Mezo testnet: each payer's wallet sends the payment.");
  await expect(services).toContainText("Not on Mezo: MUSD has no signed transfers (EIP-3009)");
  await expect(page.locator(".view-status")).toContainText("edition mezo");
  await expect(page.locator("footer .foot-links a.ext")).toHaveAttribute("href", "https://github.com/nambininasafidison/paylink/tree/mezo");
  await shot(page, "11-status-1280-light");
  expect(problems).toEqual([]);
  expect(relayer).toEqual([]);
});

test("headers: /mezo/ under its own policy with Mezo's RPC only, the root's without it; no CSP violation; worker and manifest scoped to /mezo/", async ({ browser, request }) => {
  const mezoPage = await request.get(`${server.origin}/mezo/`);
  const csp = mezoPage.headers()["content-security-policy"] ?? "";
  expect(csp).toContain(MEZO.registryRpc);
  // Mezo's RPC only: config.json's relayer serves no Mezo chain, so the Mezo pages cannot reach it.
  expect(/connect-src ([^;]*)/.exec(csp)?.[1]).toBe(`'self' ${MEZO.registryRpc}`);
  expect(csp).not.toContain("paylink-relayer");
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain(",");
  const root = await request.get(`${server.origin}/`);
  expect(root.headers()["content-security-policy"] ?? "").not.toContain(MEZO.registryRpc);
  const manifest = (await (await request.get(`${server.origin}/mezo/manifest.webmanifest`)).json()) as { name: string; scope: string; start_url: string };
  expect(manifest).toMatchObject({ name: "PayLink Mezo", scope: "/mezo/", start_url: "/mezo/" });

  const { page, problems } = await actor(browser, account(1));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations?: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const violations: string[] = [];
  for (const route of ["/mezo/", "/mezo/pay/", "/mezo/ledger/", "/mezo/send/", "/mezo/till/", "/mezo/status/"]) {
    await page.goto(`${server.origin}${route}`);
    await expect(page.locator("main#terminal")).toBeVisible();
    await page.waitForTimeout(300);
    violations.push(...(await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])));
  }
  expect(violations).toEqual([]);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(`${server.origin}/mezo/`);
  expect(problems).toEqual([]);
});

test.describe("reflow and accessibility", () => {
  const WIDTHS = [1280, 390, 320] as const;
  for (const scheme of ["light", "dark"] as const) {
    test(`axe and reflow (${scheme}): every Mezo route in EN, FR and MG at 320, 390 and 1280 px`, async ({ browser }) => {
      test.setTimeout(600_000);
      const m = fork();
      const payee = await actor(browser, account(1), { scheme, known: true });
      const payerAddress = account(scheme === "light" ? 7 : 8);
      await m.mintMusd(payerAddress, MUSD("10"));
      // Filled states: an issued card, a live bill, and a real receipt.
      const link = await createInvoice(payee, "1.50", "Sample invoice");
      const open = await createInvoice(payee, "2", "Open invoice");
      const payer = await actor(browser, payerAddress, { scheme, known: true });
      await (await openToPay(payer, link, "Pay 1.50 MUSD")).click();
      await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
      const receipt = new URL((await payer.page.locator(".receipt-slot a.key").first().getAttribute("href")) ?? "", server.origin).toString();
      const routes = ["/mezo/", open.replace(server.origin, ""), receipt.replace(server.origin, ""), "/mezo/ledger/", "/mezo/send/", "/mezo/till/", "/mezo/status/"];
      const { page } = payee;
      for (const locale of ["en", "fr", "mg"] as const) {
        await page.goto(`${server.origin}/mezo/`);
        await setLocale(page, locale);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          for (const route of routes) {
            const where = `${route.slice(0, 24)} ${locale} ${scheme} ${String(width)}`;
            await page.goto(`${server.origin}${route}`);
            await expect(page.locator("main#terminal")).toBeVisible();
            await expect(page.locator("html")).toHaveAttribute("lang", locale === "fr" ? /^fr/ : locale);
            await page.waitForTimeout(250);
            expect(await horizontalOverflow(page), `${where}: horizontal scroll`).toBeLessThanOrEqual(0);
            expect(await overlappingTargets(page), `${where}: footer links`).toEqual([]);
            expect(await brokenWords(page), `${where}: words broken inside`).toEqual([]);
            expect(await truncatedText(page), `${where}: copy cut`).toEqual([]);
            expect(await axe(page), where).toEqual([]);
          }
        }
      }
      // The pay view with its fee line, and the create terminal, as a phone shows them.
      await setLocale(page, "en");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${server.origin}/mezo/`);
      await shot(page, `12-create-390-${scheme}`);
      await payer.page.setViewportSize({ width: 320, height: 720 });
      await openToPay(payer, open, "Pay 2.00 MUSD");
      await shot(payer.page, `13-pay-320-${scheme}`);
      expect(payee.problems).toEqual([]);
      expect(payer.problems).toEqual([]);
    });
  }
});
