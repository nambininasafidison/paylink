// SPDX-License-Identifier: MIT
/**
 * The editions end to end (PAYLINK-V2-SPEC §2.1, §2.2, §4.2; tier T1), against the production build under its real
 * headers, two anvil chains, the relayer itself (Node adapter) and Chromium's WebAuthn virtual authenticator with PRF.
 *
 * Monad edition (`/monad/`), Mera passkeys as the only account layer:
 * - the seller creates a PayLink key (passkey + PRF → Mera account), signs an invoice after the signing display, and
 *   arms the till;
 * - the payer, on a phone, creates their own key, gets test AUSD through the relayer's faucet onboarding, reads what
 *   the fingerprint approves, and pays with one fingerprint: the relayer submits `payWithAuthorization`; the payer never
 *   holds MON; the receipt is verified on chain; the till lights green;
 * - the seller cancels another invoice gaslessly (`cancelBySig` through the relayer), from the ledger;
 * - a receive card on Send, paid by a contact for an amount they choose.
 *
 * Base edition (`/base/`), EIP-6963 wallets:
 * - an EOA pays USDC gaslessly: one EIP-3009 signature in the wallet, no transaction;
 * - a smart account (EIP-5792 `atomic: supported`) pays with "Pay with Base": one `wallet_sendCalls([approve, pay])`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { decodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { ACCOUNTS, PAYER_FUNDS, PAYLINK, TOKEN } from "../fixtures/app.ts";
import { addAuthenticator, BASE, buildEditionsSite, DRIP, MONAD, RELAYER_ORIGIN, routeRelayer, startEditionChains, startRelayer } from "../fixtures/editions.ts";
import type { EditionChains, LocalRelayer } from "../fixtures/editions.ts";
import { servePages } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { REPO } from "../fixtures/server.ts";
import { installWallet, routeRegistry } from "../fixtures/wallet.ts";
import type { MockWallet } from "../fixtures/wallet.ts";

const axeSource = readFileSync(join(REPO, "e2e/node_modules/axe-core/axe.min.js"), "utf8");
const erc20 = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const payLinkAbi = parseAbi([
  "function pay((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv, bytes payeeSig, uint128 amount, bytes32 payerRef)",
  "function payWithAuthorization((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv, bytes payeeSig, (address,uint128,bytes32,uint256,uint256,bytes32,uint8,bytes32,bytes32) auth)",
]);

let chains: EditionChains;
let server: StaticServer;
let relayer: LocalRelayer;
/** WebAuthn needs a domain, not an IP address: the site is opened as http://localhost:<port>. */
let origin: string;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  chains = await startEditionChains();
  server = await servePages(await buildEditionsSite());
  origin = server.origin.replace("127.0.0.1", "localhost");
  relayer = await startRelayer(chains, origin);
});

test.afterAll(async () => {
  for (const context of contexts) {
    await context.close();
  }
  await relayer.stop();
  await server.close();
  await chains.monad.anvil.stop();
  await chains.base.anvil.stop();
});

interface Person {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly problems: string[];
  readonly relayed: { method: string; path: string; status: number }[];
  readonly wallet: MockWallet | null;
}

async function person(browser: Browser, options: { readonly phone?: boolean; readonly scheme?: "light" | "dark"; readonly wallet?: { account: Address; chainId: number; batch?: boolean } } = {}): Promise<Person> {
  const context = await browser.newContext({
    viewport: options.phone === true ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    ...(options.phone === true ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    colorScheme: options.scheme ?? "light",
  });
  contexts.push(context);
  await routeRegistry(context, new Map([[MONAD, chains.monad.anvil.url], [BASE, chains.base.anvil.url]]));
  const relayed = await routeRelayer(context, relayer);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    // Arbitrum Sepolia has no local chain here and answers like an unreachable endpoint.
    if (message.type() === "error" && !message.text().includes("ERR_CONNECTION_REFUSED")) {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  const wallet =
    options.wallet === undefined
      ? null
      : await installWallet(page, {
          account: options.wallet.account,
          chainId: options.wallet.chainId,
          endpoints: new Map([[MONAD, chains.monad.anvil.url], [BASE, chains.base.anvil.url]]),
          known: [MONAD, BASE],
          ...(options.wallet.batch === true ? { batch: true } : {}),
        });
  return { context, page, problems, relayed, wallet };
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return await page.evaluate(async () => {
    const run = (window as unknown as { axe: { run: (ctx: Document, o: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run;
    const result = await run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  });
}

const lamp = (page: Page, index: number) => page.locator(".vstrip > li").nth(index);
const balance = async (chain: EditionChains["monad"], owner: Address): Promise<bigint> => await chain.balanceOf(owner);
const native = async (chain: EditionChains["monad"], owner: Address): Promise<bigint> => BigInt(await chain.anvil.rpc<string>("eth_getBalance", [owner, "latest"]));

/** Creates a PayLink key through the KeyCard (the dialog is open) and returns the account it derived. */
async function createKey(page: Page, name: string): Promise<Address> {
  const dialog = page.locator("dialog.modal-key");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".keycard-face")).toContainText("Your phone is the vault");
  await dialog.locator("#key-label").fill(name);
  await dialog.getByRole("button", { name: "Create my PayLink key" }).click();
  await expect(dialog).toBeHidden();
  const account = await page.locator(".connect").getAttribute("title");
  expect(account).toMatch(/^0x[0-9a-fA-F]{40}$/);
  return account as Address;
}

/** The seller's invoice on the Monad terminal: amount, memo, KeyCard if needed, signing display, one fingerprint. */
async function sellerInvoice(page: Page, amount: string, memo: string, first: boolean): Promise<string> {
  await page.goto(`${origin}/monad/`);
  await page.locator("#amount").fill(amount);
  await page.locator("#memo").fill(memo);
  const key = page.locator(".view-create > .key-primary");
  if (first) {
    await expect(key).toHaveText("Use my PayLink key to sign");
    await key.click();
    await createKey(page, "Rakoto Design");
    await key.click();
  } else {
    await key.click();
  }
  const signing = page.locator(".signing");
  await expect(signing).toContainText("You are about to sign this invoice");
  await expect(signing.locator(".signing-note")).toContainText("Your fingerprint signs this invoice, not a payment");
  await page.locator(".signing + .key-row .key-primary").click();
  await expect(page.locator(".ticket")).toBeVisible();
  return await page.locator(".share input").inputValue();
}

test("Monad: two PayLink keys, onboarding, a gasless fingerprint payment, the till lights, a gasless cancel", async ({ browser }) => {
  const seller = await person(browser);
  await addAuthenticator(seller.context, seller.page);
  await seller.page.goto(`${origin}/monad/`);
  // Passkeys are the only account layer: the frame offers a PayLink key, never a wallet.
  await expect(seller.page.locator(".connect")).toHaveText("Use my PayLink key");
  await expect(seller.page.locator(".edition-tag")).toHaveText("Monad");
  const link = await sellerInvoice(seller.page, "25.50", "Logo design, invoice 042", true);
  expect(link).toMatch(new RegExp(`^${origin}/monad/pay/#2\\.${String(MONAD)}\\.`));
  const sellerAddress = (await seller.page.locator(".connect").getAttribute("title")) as Address;
  expect(await native(chains.monad, sellerAddress)).toBe(0n);

  // The till, armed with this invoice, on the seller's counter display.
  const till = await seller.context.newPage();
  await till.goto(link.replace("/pay/#", "/till/#"));
  await till.getByRole("button", { name: "Start the till" }).click();
  await expect(till.locator(".till")).toHaveAttribute("data-state", "waiting");

  // The payer, on a phone, with their own passkey.
  const payer = await person(browser, { phone: true });
  const authenticator = await addAuthenticator(payer.context, payer.page);
  await payer.page.goto(link);
  await expect(payer.page.locator(".screen .amount")).toContainText("25.50");
  await expect(payer.page.locator(".screen-fx")).toContainText(/≈\s\S.*\sAr · estimate · rate of/);
  for (const i of [0, 2, 3]) {
    await expect(lamp(payer.page, i)).toHaveAttribute("data-lamp", "ok");
  }
  const key = payer.page.locator(".payform .key-primary");
  await expect(key).toHaveText("Use my PayLink key to pay");
  await key.click();
  const payerAddress = await createKey(payer.page, "My phone");
  expect(await authenticator.credentials()).toBe(1);
  expect(payerAddress.toLowerCase()).not.toBe(sellerAddress.toLowerCase());
  await expect(lamp(payer.page, 1)).toContainText("Your PayLink key signs for it");

  // No test dollars yet: the relayer asks the AUSD faucet (the payer needs no MON for that either).
  const funds = payer.page.locator(".funds");
  await expect(funds).toContainText("This account holds 0.00 AUSD.");
  await funds.getByRole("button", { name: "Get 10,000 test AUSD" }).click();
  await expect(payer.page.locator(".bill > .status")).toContainText("Test AUSD received.");
  await expect(funds).toBeHidden();
  await expect.poll(async () => await balance(chains.monad, payerAddress)).toBe(DRIP);

  // What the fingerprint approves, before it is asked.
  await expect(key).toHaveText("Pay 25.50 AUSD");
  const display = payer.page.locator(".sign-slot .signing");
  await expect(display).toContainText("Pay exactly this, once");
  await expect(display).toContainText("25.50");
  await expect(display).toContainText("Covered by PayLink");
  await expect(payer.page.locator(".route-note")).toHaveText("One signature; the fee is covered.");
  expect(await axe(payer.page)).toEqual([]);

  const sellerBefore = await balance(chains.monad, sellerAddress);
  await key.click();
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  await expect(payer.page.locator(".verdict .verdict-time")).toContainText(/Settled in \d/);
  // Gasless: the payer never held MON; the relayer sent payWithAuthorization; exactly the amount moved.
  expect(await native(chains.monad, payerAddress)).toBe(0n);
  expect(await balance(chains.monad, payerAddress)).toBe(DRIP - 25_500_000n);
  expect(await balance(chains.monad, sellerAddress)).toBe(sellerBefore + 25_500_000n);
  expect(payer.relayed.filter((r) => r.method === "POST").map((r) => [r.path, r.status])).toEqual([
    [`/v1/${String(MONAD)}/onboard`, 202],
    [`/v1/${String(MONAD)}/pay`, 202],
  ]);
  // The authorisation kept for retries is gone once the receipt is verified.
  expect(await payer.page.evaluate(async () => await new Promise<number>((resolve) => {
    const open = indexedDB.open("paylink");
    open.onsuccess = () => {
      const count = open.result.transaction("authorizations").objectStore("authorizations").count();
      count.onsuccess = () => { resolve(count.result); };
    };
  }))).toBe(0);

  // The seller's till lit green for this invoice, at its amount.
  await expect(till.locator(".till")).toHaveAttribute("data-state", "paid");
  await expect(till.locator(".till-figure")).toContainText("25.50");

  // Gasless cancel: a second invoice, cancelled from the ledger with one fingerprint, cancelBySig through the relayer.
  await sellerInvoice(seller.page, "9", "Deposit, to cancel", false);
  await seller.page.goto(`${origin}/monad/ledger/`);
  const row = seller.page.locator(".view-ledger .links > li", { hasText: "Deposit, to cancel" });
  const cancel = row.locator("button.key-danger");
  await expect(cancel).toHaveText("Cancel");
  await cancel.click();
  await expect(cancel).toHaveText("Confirm cancel");
  await cancel.click();
  await expect(seller.page.locator(".view-ledger .status.ok, .view-ledger").first()).toContainText(/Cancelled/);
  expect(seller.relayed.filter((r) => r.method === "POST").map((r) => r.path)).toContain(`/v1/${String(MONAD)}/cancel`);
  expect(await native(chains.monad, sellerAddress)).toBe(0n);

  expect(seller.problems).toEqual([]);
  expect(payer.problems).toEqual([]);
});

test("Monad: the receive card on Send, and a contact paying it any amount", async ({ browser }) => {
  const seller = await person(browser);
  await addAuthenticator(seller.context, seller.page);
  await seller.page.goto(`${origin}/monad/send/`);
  await seller.page.getByRole("button", { name: "Use my account" }).click();
  await createKey(seller.page, "Counter");
  await seller.page.goto(`${origin}/monad/?preset=card`);
  // A receive card never expires: the terminal asks to confirm that on purpose.
  await seller.page.locator(".view-create input[type=checkbox]").check();
  await seller.page.locator(".view-create > .key-primary").click();
  await seller.page.locator(".signing + .key-row .key-primary").click();
  await expect(seller.page.locator(".ticket")).toBeVisible();
  await seller.page.goto(`${origin}/monad/send/`);
  const card = seller.page.locator(".my-card .ticket");
  await expect(card).toContainText("Receive card");
  await expect(card).toContainText("Any amount");
  await expect(card.locator(".qr path")).toHaveCount(1);
  const cardLink = `${origin}/monad/pay/#${(await card.locator(".printed-url").textContent())?.split("#")[1] ?? ""}`;
  expect(await axe(seller.page)).toEqual([]);

  const sender = await person(browser, { phone: true });
  await addAuthenticator(sender.context, sender.page);
  await sender.page.goto(`${origin}/monad/send/`);
  await sender.page.locator("#contact-name").fill("Rakoto counter");
  await sender.page.locator("#contact-card").fill(cardLink);
  await sender.page.getByRole("button", { name: "Save contact" }).click();
  await sender.page.getByRole("link", { name: "Send to Rakoto counter" }).click();
  await expect(sender.page.locator(".saved")).toContainText("Rakoto counter");
  const key = sender.page.locator(".payform .key-primary");
  await key.click();
  const senderAddress = await createKey(sender.page, "Sender");
  // The faucet keeps one 60 s cooldown for everyone, and the previous test used it: move the chain clock past it.
  await chains.monad.advance(61);
  await sender.page.locator(".funds").getByRole("button", { name: /Get 10,000 test AUSD/ }).click();
  await expect(sender.page.locator(".bill > .status")).toContainText("Test AUSD received.");
  await sender.page.locator("#pay-amount").fill("12,5");
  await expect(sender.page.locator(".readout-fx")).toContainText("Ar");
  await expect(sender.page.locator(".sign-slot .signing")).toContainText("12.50");
  await key.click();
  await expect(sender.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  expect(await native(chains.monad, senderAddress)).toBe(0n);
  expect(sender.problems).toEqual([]);
  expect(seller.problems).toEqual([]);
});

test("Base: gasless USDC for an EOA (one signature, no transaction), and Pay with Base for a smart account", async ({ browser }) => {
  const seller = await person(browser, { wallet: { account: ACCOUNTS.payee, chainId: BASE } });
  await seller.page.goto(`${origin}/base/`);
  await seller.page.locator("#amount").fill("4.20");
  await seller.page.locator("#memo").fill("Sticker pack");
  await seller.page.locator(".view-create > .key-primary").click();
  await seller.page.locator(".signing + .key-row .key-primary").click();
  await expect(seller.page.locator(".ticket")).toBeVisible();
  const link = await seller.page.locator(".share input").inputValue();
  expect(link).toMatch(new RegExp(`^${origin}/base/pay/#2\\.${String(BASE)}\\.`));

  // An EOA payer: the router picks the relayer; the wallet signs EIP-3009 and sends nothing.
  const eoa = await person(browser, { wallet: { account: ACCOUNTS.payer, chainId: BASE } });
  const gasBefore = await native(chains.base, ACCOUNTS.payer);
  await eoa.page.goto(link);
  const key = eoa.page.locator(".payform .key-primary");
  await key.click(); // connect
  await expect(key).toHaveText("Pay 4.20 USDC");
  await expect(eoa.page.locator(".route-note")).toHaveText("One signature; the fee is covered.");
  await key.click();
  await expect(eoa.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  expect(eoa.wallet?.sent()).toHaveLength(0);
  expect(eoa.wallet?.requests.map((r) => r.method)).toContain("eth_signTypedData_v4");
  expect(await native(chains.base, ACCOUNTS.payer)).toBe(gasBefore);
  expect(await balance(chains.base, ACCOUNTS.payer)).toBe(PAYER_FUNDS - 4_200_000n);
  expect(eoa.relayed.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/v1/${String(BASE)}/pay`]);

  // A smart-account payer (EIP-5792 atomic batches): "Pay with Base", one approval for [approve, pay].
  const second = await (async () => {
    await seller.page.goto(`${origin}/base/`);
    await seller.page.locator("#amount").fill("1.50");
    await seller.page.locator(".view-create > .key-primary").click();
    await seller.page.locator(".signing + .key-row .key-primary").click();
    return await seller.page.locator(".share input").inputValue();
  })();
  const smart = await person(browser, { wallet: { account: ACCOUNTS.tokenOwner, chainId: BASE, batch: true } });
  await chains.base.anvil.rpc("anvil_setBalance", [ACCOUNTS.tokenOwner, "0x8ac7230489e80000"]);
  const funded = await balance(chains.base, ACCOUNTS.tokenOwner);
  expect(funded).toBe(0n);
  // Give the smart account some USDC from the payer (a plain transfer on anvil).
  await chains.base.anvil.rpc("eth_sendTransaction", [{ from: ACCOUNTS.payer, to: TOKEN.address, data: `0xa9059cbb${ACCOUNTS.tokenOwner.slice(2).toLowerCase().padStart(64, "0")}${(10_000_000n).toString(16).padStart(64, "0")}` }]);
  await expect.poll(async () => await balance(chains.base, ACCOUNTS.tokenOwner)).toBe(10_000_000n);
  await smart.page.goto(second);
  const smartKey = smart.page.locator(".payform .key-primary");
  await smartKey.click(); // connect
  await expect(smartKey).toHaveText("Pay with Base");
  await expect(smart.page.locator(".route-note")).toContainText("One approval in your Base Account");
  await smartKey.click();
  await expect(smart.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  const batch = smart.wallet?.requests.find((r) => r.method === "wallet_sendCalls");
  const calls = (batch?.params[0] as { atomicRequired: boolean; calls: { to: string; data: Hex }[] } | undefined);
  expect(calls?.atomicRequired).toBe(true);
  expect(calls?.calls.map((c) => c.to.toLowerCase())).toEqual([TOKEN.address.toLowerCase(), PAYLINK.toLowerCase()]);
  const approve = decodeFunctionData({ abi: erc20, data: calls?.calls[0]?.data ?? "0x" });
  expect(approve.args).toEqual([PAYLINK, 1_500_000n]);
  expect(decodeFunctionData({ abi: payLinkAbi, data: calls?.calls[1]?.data ?? "0x" }).functionName).toBe("pay");
  expect(await balance(chains.base, ACCOUNTS.tokenOwner)).toBe(10_000_000n - 1_500_000n);
  expect(smart.relayed.filter((r) => r.method === "POST")).toHaveLength(0);

  expect(seller.problems).toEqual([]);
  expect(eoa.problems).toEqual([]);
  expect(smart.problems).toEqual([]);
});

test("all: the relayer fails after the signature; the payer sends the same authorisation with their own fee, also after a reload", async ({ browser }) => {
  const seller = await person(browser, { wallet: { account: ACCOUNTS.payee, chainId: MONAD } });
  const invoice = async (amount: string, memo: string): Promise<string> => {
    await seller.page.goto(`${origin}/`);
    await seller.page.locator("#amount").fill(amount);
    await seller.page.locator("#memo").fill(memo);
    await seller.page.locator(".view-create > .key-primary").click();
    await seller.page.locator(".signing + .key-row .key-primary").click();
    await expect(seller.page.locator(".ticket")).toBeVisible();
    return await seller.page.locator(".share input").inputValue();
  };
  const first = await invoice("1.25", "Relayer drops it");
  expect(first).toMatch(new RegExp(`^${origin}/pay/#2\\.${String(MONAD)}\\.`));

  const payer = await person(browser, { wallet: { account: ACCOUNTS.payer, chainId: MONAD } });
  // The fee service reports itself ready, but the payment never reaches it: the connection is refused after the signature.
  let refused = 0;
  await payer.context.route(`${RELAYER_ORIGIN}/v1/${String(MONAD)}/pay`, async (route) => {
    if (route.request().method() === "POST") {
      refused += 1;
      await route.abort("connectionrefused");
    } else {
      await route.fallback();
    }
  });
  const signatures = (): number => payer.wallet?.requests.filter((r) => r.method === "eth_signTypedData_v4").length ?? 0;
  const settlements = (): string[] => (payer.wallet?.sent() ?? []).map((r) => {
    const tx = r.params[0] as { to: string; data: Hex };
    expect(tx.to.toLowerCase()).toBe(PAYLINK.toLowerCase());
    return decodeFunctionData({ abi: payLinkAbi, data: tx.data }).functionName;
  });
  const payeeStart = await balance(chains.monad, ACCOUNTS.payee);
  const payerStart = await balance(chains.monad, ACCOUNTS.payer);

  await payer.page.goto(first);
  const key = payer.page.locator(".payform .key-primary");
  await key.click(); // connect
  await expect(key).toHaveText("Pay 1.25 AUSD");
  await expect(payer.page.locator(".route-note")).toHaveText("One signature; the fee is covered.");
  await key.click();
  await expect(payer.page.locator(".bill > .status")).toContainText("The service that covers the network fee did not answer.");
  expect(refused).toBe(1);
  expect(signatures()).toBe(1);
  const own = payer.page.locator(".fallback-slot button");
  await expect(own).toHaveText("Pay with my own MON fee");
  await own.click();
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  // The very authorisation signed for the relayer, sent by the payer: no second signature, one payWithAuthorization.
  expect(signatures()).toBe(1);
  expect(settlements()).toEqual(["payWithAuthorization"]);
  expect(await balance(chains.monad, ACCOUNTS.payee)).toBe(payeeStart + 1_250_000n);
  expect(await balance(chains.monad, ACCOUNTS.payer)).toBe(payerStart - 1_250_000n);

  // Signed again for another invoice, refused again, and then the fee service is gone altogether; the payer reloads.
  const second = await invoice("2.40", "Relayer gone");
  await payer.page.goto(second);
  await expect(key).toHaveText("Pay 2.40 AUSD");
  await key.click();
  await expect(payer.page.locator(".bill > .status")).toContainText("did not answer");
  expect(signatures()).toBe(2);
  await payer.context.route(`${RELAYER_ORIGIN}/**`, async (route) => {
    await route.abort("connectionrefused");
  });
  await payer.page.reload();
  // The stored authorisation is still live (invoice spec §8.6): it is the only way to pay, and the payer can send it.
  await expect(key).toHaveText("Pay 2.40 AUSD");
  await expect(payer.page.locator(".route-note")).toHaveText("Your signature from a moment ago is still valid: it is sent again, nothing new is signed.");
  await key.click();
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  expect(signatures()).toBe(2);
  expect(settlements()).toEqual(["payWithAuthorization", "payWithAuthorization"]);
  expect(await balance(chains.monad, ACCOUNTS.payee)).toBe(payeeStart + 3_650_000n);
  expect(refused).toBe(2);

  expect(seller.problems).toEqual([]);
  expect(payer.problems).toEqual([]);
});

test("Monad: the KeyCard and the pay view in dark mode on a phone, without axe violations or horizontal scroll", async ({ browser }) => {
  const visitor = await person(browser, { phone: true, scheme: "dark" });
  await addAuthenticator(visitor.context, visitor.page);
  await visitor.page.goto(`${origin}/monad/`);
  await visitor.page.locator(".connect").click();
  await expect(visitor.page.locator("dialog.modal-key")).toBeVisible();
  expect(await axe(visitor.page)).toEqual([]);
  expect(await visitor.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await visitor.page.screenshot({ path: test.info().outputPath("monad-keycard-390-dark.png"), fullPage: true });
  expect(visitor.problems).toEqual([]);
});
