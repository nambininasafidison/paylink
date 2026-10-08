// SPDX-License-Identifier: MIT
/**
 * The web app (apps/web) end to end, as Cloudflare Pages serves it: the production build of the `all` edition (with
 * the local chain swapped in, see fixtures/app.ts) under its real `_headers` (strict CSP with Trusted Types), against
 * anvil on Monad testnet's chain id with the PayLinkV2 release at its CREATE2 address and a 6-decimal
 * EIP-2612 + EIP-3009 dollar. Two browser contexts are the payee and the payer, each with a mock EIP-1193 wallet
 * announced through EIP-6963; the wallets forward to anvil's unlocked accounts.
 *
 * Covered (PAYLINK-V2-SPEC §4.2, T0): create and sign an invoice, share it, open it as the payer, the four lamps,
 * switch network, pay from the wallet with the relayer down (one EIP-3009 authorisation sent as payWithAuthorization;
 * an EIP-2612-only token with permit), print the card and the receipt (A6, 80 mm), the receipt verified on chain, the payee's ledger from statesOf, the armed till,
 * refusals (tampered link, self-payment, already paid), the language switch, axe on every route in light and dark,
 * no horizontal scroll on a 390 px phone, no CSP violation, and the frozen v1 app and the deploy kit in their areas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { decodeFunctionData, parseAbi } from "viem";
import type { Hex } from "viem";
import { ACCOUNTS, buildE2eSite, CHAIN_ID, FOREIGN_CHAIN_ID, PAYER_FUNDS, PAYLINK, PERMIT_TOKEN, startAppChain, startForeignChain } from "../fixtures/app.ts";
import type { AppChain } from "../fixtures/app.ts";
import type { Anvil } from "../fixtures/anvil.ts";
import { brokenWords, focusRingContrast, horizontalOverflow, overlappingTargets, selectedMarkContrast, setLocale, truncatedText } from "../fixtures/layout.ts";
import { printedPageSize } from "../fixtures/print.ts";
import { servePages } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { REPO } from "../fixtures/server.ts";
import { installWallet, routeRegistry } from "../fixtures/wallet.ts";
import type { MockWallet } from "../fixtures/wallet.ts";

const axeSource = readFileSync(join(REPO, "e2e/node_modules/axe-core/axe.min.js"), "utf8");
const payLinkAbi = parseAbi([
  "function pay((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv, bytes payeeSig, uint128 amount, bytes32 payerRef)",
  "function payWithPermit((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv, bytes payeeSig, uint128 amount, bytes32 payerRef, (uint256,uint8,bytes32,bytes32) p)",
  "function payWithAuthorization((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv, bytes payeeSig, (address,uint128,bytes32,uint256,uint256,bytes32,uint8,bytes32,bytes32) auth)",
]);

let chain: AppChain;
let foreign: Anvil;
let server: StaticServer;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  chain = await startAppChain();
  foreign = await startForeignChain();
  server = await servePages(buildE2eSite());
});

test.afterAll(async () => {
  for (const context of contexts) {
    await context.close();
  }
  await server.close();
  await chain.anvil.stop();
  await foreign.stop();
});

interface Actor {
  readonly page: Page;
  readonly wallet: MockWallet;
  /** Console errors and CSP reports seen by this page. */
  readonly problems: string[];
}

async function actor(browser: Browser, account: string, options: { chainId?: number; width?: number; scheme?: "light" | "dark" } = {}): Promise<Actor> {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: 900 }, colorScheme: options.scheme ?? "light" });
  contexts.push(context);
  await routeRegistry(context, new Map([[CHAIN_ID, chain.anvil.url], [FOREIGN_CHAIN_ID, foreign.url]]));
  // The T0 suite runs without the gasless relayer (e2e/specs/editions.spec.ts runs with it): its origin refuses
  // connections, so payers take the wallet paths, as when the relayer is down.
  await context.route("https://paylink-relayer.raherizonambinina.workers.dev/**", async (route) => {
    await route.abort("connectionrefused");
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    // Expected: chains of the edition without a local anvil answer like an unreachable endpoint, and the 404 route
    // is served with status 404.
    const expected = message.text().includes("ERR_CONNECTION_REFUSED") || (message.text().includes("404") && message.location().url.includes("/does-not-exist/"));
    if (message.type() === "error" && !expected) {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  const known = options.chainId === undefined ? [CHAIN_ID, FOREIGN_CHAIN_ID] : [options.chainId, CHAIN_ID, FOREIGN_CHAIN_ID];
  const endpoints = new Map<number, string | null>([[CHAIN_ID, chain.anvil.url], [FOREIGN_CHAIN_ID, foreign.url], [1, null]]);
  const wallet = await installWallet(page, { account, chainId: options.chainId ?? CHAIN_ID, endpoints, known });
  return { page, wallet, problems };
}

/** Signs an invoice on the create terminal (in `token`, else the chain's default) and returns its payment link. */
async function createInvoice(payee: Actor, amount: string, memo: string, query = "", token?: string): Promise<string> {
  const { page } = payee;
  await page.goto(`${server.origin}/${query}`);
  if (token !== undefined) {
    await page.locator(".view-create .readout select").selectOption({ label: token });
  }
  await page.locator("#amount").fill(amount);
  await page.locator("#memo").fill(memo);
  await page.locator(".view-create > .key-primary").click();
  await expect(page.locator(".signing")).toContainText("You are about to sign this invoice");
  // One signal key on screen while reviewing: the signature ("Review and sign" steps aside).
  await expect(page.locator(".view-create > .key-primary")).toBeHidden();
  await expect(page.locator(".view-create .key-primary:visible")).toHaveText(["Sign in wallet"]);
  await page.locator(".signing + .key-row .key-primary").click();
  await expect(page.locator(".ticket")).toBeVisible();
  return await page.locator(".share input").inputValue();
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

test("hero flow: sign an invoice, pay it from the wallet with one authorisation (relayer down), verify the receipt, read the ledger", async ({ browser }) => {
  const payee = await actor(browser, ACCOUNTS.payee);
  const link = await createInvoice(payee, "25.50", "Logo design, invoice 042");
  expect(link).toMatch(new RegExp(`^${server.origin}/pay/#2\\.${String(CHAIN_ID)}\\.`));
  // The wallet only signed: no transaction, no gas.
  expect(payee.wallet.requests.map((r) => r.method)).toContain("eth_signTypedData_v4");
  expect(payee.wallet.sent()).toHaveLength(0);
  await expect(payee.page.locator(".ticket .qr path")).toHaveCount(1);
  // The printed link: in full on paper, as a short form with a visible ellipsis on screen (never a silent cut).
  const fragment = link.split("#")[1] ?? "";
  await expect(payee.page.locator(".ticket .printed-url-full")).toBeHidden();
  expect(await payee.page.locator(".ticket .printed-url-full").textContent()).toBe(link.replace(/^https?:\/\//, ""));
  await expect(payee.page.locator(".ticket .printed-url-short")).toHaveText(new RegExp(`#2\\.${String(CHAIN_ID)}\\.\\S{4}…${fragment.slice(-8).replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}$`));
  // Non-text contrast (WCAG 1.4.11) in both themes: the focus ring on the dark amount window, and the mark of the
  // selected key in the segmented controls, the language and theme dials and the mode tabs.
  for (const scheme of ["light", "dark"] as const) {
    await payee.page.emulateMedia({ colorScheme: scheme });
    expect(await focusRingContrast(payee.page.locator(".readout select")), `token select focus, ${scheme}`).toBeGreaterThanOrEqual(3);
    for (const selected of [".view-create .seg label:has(input:checked)", ".top .dial button[aria-pressed='true']", ".tabs > [aria-current='page']"]) {
      for (const one of await payee.page.locator(selected).all()) {
        expect(await selectedMarkContrast(one), `${selected}, ${scheme}`).toBeGreaterThanOrEqual(3);
      }
    }
  }
  await payee.page.emulateMedia({ colorScheme: "light" });
  // The receive card prints on an A6 page (105 × 148 mm), not on Chromium's default Letter.
  const card = await printedPageSize(payee.page, payee.page.getByRole("button", { name: "Print card" }), test.info().outputPath("card-a6.pdf"));
  expect(card.width).toBeCloseTo(105, 0);
  expect(card.height).toBeCloseTo(148, 0);
  expect(card.pages).toBe(1);
  expect(await payee.page.locator(".share-keys a[href^='https://wa.me/?text=']").getAttribute("href")).toContain(encodeURIComponent(link));

  // The payer's wallet starts on another network.
  const payer = await actor(browser, ACCOUNTS.payer, { chainId: 1 });
  const before = { payer: await chain.balanceOf(ACCOUNTS.payer), payee: await chain.balanceOf(ACCOUNTS.payee) };
  await payer.page.goto(link);
  await expect(payer.page.locator(".screen .amount")).toContainText("25.50");
  await expect(payer.page.locator(".screen-memo")).toContainText("Logo design, invoice 042");
  // Neutral names, the state in words: the lamp's meaning never rests on its colour.
  await expect(payer.page.locator(".vstrip .vstrip-name > span:first-child")).toHaveText(["Signature", "Network", "Contract", "Payable"]);
  await expect(lamp(payer.page, 0).locator(".vstrip-state")).toHaveText("OK");
  await expect(lamp(payer.page, 0)).toHaveAttribute("data-lamp", "ok");
  await expect(lamp(payer.page, 2)).toHaveAttribute("data-lamp", "ok");
  await expect(lamp(payer.page, 3)).toHaveAttribute("data-lamp", "ok");
  await expect(payer.page.locator(".warn-note").first()).toContainText("First payment to this address");

  const key = payer.page.locator(".payform .key-primary");
  await key.click(); // connect
  await expect(key).toContainText("Switch to");
  await key.click(); // switch network
  await expect(lamp(payer.page, 1)).toHaveAttribute("data-lamp", "ok");
  await expect(key).toContainText("Pay 25.50 AUSD");
  await expect(payer.page.locator(".route-note")).toHaveText("One signature, then one transaction with your own network fee.");
  // The assurance line and the lead's step 02 say what the route says: here the payer's wallet pays the fee.
  await expect(payer.page.locator(".assure")).toHaveText("Non-custodial: the dollars go straight from your wallet to the address above. Your wallet pays the network fee.");
  await expect(payer.page.locator(".steps li").nth(1).locator("p")).toHaveText("Your wallet asks you to approve the payment. It pays the small network fee too.");
  await key.click(); // pay
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  await expect(payer.page.locator(".status.ok")).toContainText("settled in");

  // The fee service is down: one EIP-3009 authorisation (the one a relayer would have sent), sent by the payer's
  // wallet as one payWithAuthorization with an explicit gas limit (Monad charges the limit), to the release address.
  expect(payer.wallet.requests.filter((r) => r.method === "eth_signTypedData_v4")).toHaveLength(1);
  const sent = payer.wallet.sent();
  expect(sent).toHaveLength(1);
  const tx = sent[0]?.params[0] as { to: string; data: Hex; gas?: string };
  expect(tx.to.toLowerCase()).toBe(PAYLINK.toLowerCase());
  expect(decodeFunctionData({ abi: payLinkAbi, data: tx.data }).functionName).toBe("payWithAuthorization");
  expect(tx.gas).toMatch(/^0x[0-9a-f]+$/);
  // Exactly the amount moved, payer to payee.
  expect(before.payer).toBe(PAYER_FUNDS);
  expect(await chain.balanceOf(ACCOUNTS.payer)).toBe(before.payer - 25_500_000n);
  expect(await chain.balanceOf(ACCOUNTS.payee)).toBe(before.payee + 25_500_000n);
  await expect(payer.page.locator(".warn-note").first()).toBeHidden();
  await expect(lamp(payer.page, 3)).toContainText("Paid by you just now");
  // Closed by this payment: a hollow lamp that says so, not a green "payable".
  await expect(lamp(payer.page, 3)).toHaveAttribute("data-lamp", "off");
  await expect(lamp(payer.page, 3).locator(".vstrip-state")).toHaveText("Closed");

  // The receipt link re-verifies on chain.
  await payer.page.locator(".receipt-slot a.key").first().click();
  await expect(payer.page.locator(".view-receipt .receipt")).toContainText("Payment found");
  await expect(payer.page.locator(".view-receipt .receipt")).toContainText("Matches the invoice");
  // The slip is light paper in both themes: its focus ring stays dark laterite on it in dark mode too.
  for (const scheme of ["light", "dark"] as const) {
    await payer.page.emulateMedia({ colorScheme: scheme });
    expect(await focusRingContrast(payer.page.locator(".view-receipt .receipt dd a").first()), `receipt link focus, ${scheme}`).toBeGreaterThanOrEqual(3);
  }
  await payer.page.emulateMedia({ colorScheme: "light" });
  // The slip prints on an 80 mm roll and on A6 (the keyword `A6` alone gave Letter in Chromium).
  const roll = await printedPageSize(payer.page, payer.page.getByRole("button", { name: "Print (80 mm)" }), test.info().outputPath("receipt-80mm.pdf"));
  expect([roll.width, roll.height].map(Math.round)).toEqual([80, 210]);
  const a6 = await printedPageSize(payer.page, payer.page.getByRole("button", { name: "Print (A6)" }), test.info().outputPath("receipt-a6.pdf"));
  expect([a6.width, a6.height].map(Math.round)).toEqual([105, 148]);
  expect(a6.pages).toBe(1);

  // Paid once: the link now refuses a second payment.
  await payer.page.goto(link);
  await expect(lamp(payer.page, 3)).toHaveAttribute("data-lamp", "err");
  await expect(lamp(payer.page, 3).locator(".vstrip-state")).toHaveText("Stop");
  await expect(payer.page.locator(".payform .key-primary")).toBeDisabled();
  // No lamp is left checking on a closed link: the network one says it is not needed.
  await expect(lamp(payer.page, 1)).toHaveAttribute("data-lamp", "off");
  await expect(lamp(payer.page, 1)).toContainText("Not checked: this link takes no payment here.");
  await expect(payer.page.locator(".vstrip > li[data-lamp='busy']")).toHaveCount(0);

  // The payee's books: state from statesOf, total from the chain.
  await payee.page.goto(`${server.origin}/ledger/`);
  const row = payee.page.locator(".view-ledger .links > li").first();
  await expect(row).toContainText("Logo design, invoice 042");
  await expect(row.locator(".lamp, .pill").first()).toContainText(/paid/i);
  await expect(payee.page.locator(".tally")).toContainText("25.50");
  const download = payee.page.waitForEvent("download");
  await payee.page.getByRole("button", { name: "Export CSV" }).click();
  const csv = readFileSync(await (await download).path(), "utf8");
  expect(csv.split("\r\n")[0]).toMatch(/^invoice_key,chain,contract,payee,token,/);
  expect(csv).toContain(`eip155:${String(CHAIN_ID)}:${ACCOUNTS.payee}`);
  expect(csv).toContain(",25.5,25500000,1,1,25.5,25500000,paid,");

  expect(payee.problems).toEqual([]);
  expect(payer.problems).toEqual([]);
});

test("an EIP-2612-only dollar (no authorisation rail can carry it) pays with permit: one signature, one transaction", async ({ browser }) => {
  const payee = await actor(browser, ACCOUNTS.payee);
  const link = await createInvoice(payee, "2.5", "Permit only", "", PERMIT_TOKEN.symbol);
  const payer = await actor(browser, ACCOUNTS.payer);
  const before = { payer: await chain.permitBalanceOf(ACCOUNTS.payer), payee: await chain.permitBalanceOf(ACCOUNTS.payee) };
  await payer.page.goto(link);
  await expect(payer.page.locator(".screen .amount")).toContainText("2.50");
  const key = payer.page.locator(".payform .key-primary");
  await key.click(); // connect
  await expect(key).toHaveText("Pay 2.50 MUSD");
  await expect(payer.page.locator(".route-note")).toHaveText("One signature, then one transaction from your wallet.");
  await key.click();
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
  const sent = payer.wallet.sent();
  expect(sent).toHaveLength(1);
  const tx = sent[0]?.params[0] as { to: string; data: Hex; gas?: string };
  expect(tx.to.toLowerCase()).toBe(PAYLINK.toLowerCase());
  expect(decodeFunctionData({ abi: payLinkAbi, data: tx.data }).functionName).toBe("payWithPermit");
  expect(tx.gas).toMatch(/^0x[0-9a-f]+$/);
  expect(await chain.permitBalanceOf(ACCOUNTS.payer)).toBe(before.payer - 2_500_000_000_000_000_000n);
  expect(await chain.permitBalanceOf(ACCOUNTS.payee)).toBe(before.payee + 2_500_000_000_000_000_000n);
  expect(payer.problems).toEqual([]);
  expect(payee.problems).toEqual([]);
});

/** Pays a link from the payer's wallet, already on the right network (connecting first if needed). */
async function pay(payer: Actor, link: string, label: string): Promise<void> {
  await payer.page.goto(link);
  await payer.page.reload();
  const key = payer.page.locator(".payform .key-primary");
  await expect(key).toBeEnabled();
  if ((await key.textContent())?.includes("Connect") === true) {
    await key.click();
  }
  await expect(key).toContainText(label);
  await key.click();
  await expect(payer.page.locator(".receipt-slot .receipt")).toContainText("Approved");
}

test("the armed till lights only for its invoice, at its amount", async ({ browser }) => {
  const payee = await actor(browser, ACCOUNTS.payee);
  const other = await createInvoice(payee, "0.01", "Not this one");
  const link = await createInvoice(payee, "3", "Coffee x2");
  const till = await actor(browser, ACCOUNTS.payee);
  await till.page.goto(link.replace("/pay/#", "/till/#"));
  const display = till.page.locator(".till");
  await expect(display).toHaveAttribute("data-state", "idle");
  await till.page.getByRole("button", { name: "Start the till" }).click();
  await expect(display).toHaveAttribute("data-state", "waiting");

  // A payment of another invoice of the same payee leaves the armed till dark.
  const payer = await actor(browser, ACCOUNTS.payer);
  await pay(payer, other, "Pay 0.01 AUSD");
  await till.page.waitForTimeout(3_000);
  await expect(display).toHaveAttribute("data-state", "waiting");

  // Waiting reads from a distance too: a breathing lamp and the state word in letters sized to the window.
  const verdict = till.page.locator(".till-verdict");
  const fontSize = async (): Promise<number> => await verdict.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  await expect(verdict).toHaveText("Waiting for payment");
  expect(await fontSize()).toBeGreaterThanOrEqual(20);

  await pay(payer, link, "Pay 3.00 AUSD");
  await expect(display).toHaveAttribute("data-state", "paid", { timeout: 15_000 });
  await expect(till.page.locator(".till-settled")).not.toBeEmpty();
  // Paid flips the window: PAID at 48 px or more, and a check glyph (a shape, not only a colour).
  await expect(verdict).toHaveText("Paid");
  expect(await fontSize()).toBeGreaterThanOrEqual(48);
  expect(await till.page.locator(".till-glyph").evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("data:image/svg+xml");
  // Full screen keeps only the till window and its keys; the window takes the height and the amount grows.
  const figure = till.page.locator(".till-figure .num");
  const before = await figure.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  await till.page.getByRole("button", { name: "Full screen" }).click();
  await expect.poll(async () => await till.page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe("terminal");
  await expect(till.page.locator("#terminal > .plate")).toBeHidden();
  await expect(till.page.locator("#terminal > .tabs")).toBeHidden();
  await expect(till.page.locator(".view-till .view-head")).toBeHidden();
  await expect(till.page.getByRole("button", { name: "Stop the till" })).toBeVisible();
  expect(await display.evaluate((el) => el.getBoundingClientRect().height / window.innerHeight)).toBeGreaterThan(0.6);
  expect(await figure.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(before);
  await till.page.screenshot({ path: test.info().outputPath("till-paid-fullscreen.png") });
  await till.page.evaluate(async () => { await document.exitFullscreen(); });
  expect(till.problems).toEqual([]);
});

test("cancel from the ledger: one transaction from the payee, and the link stops taking payments", async ({ browser }) => {
  const payee = await actor(browser, ACCOUNTS.payee);
  const link = await createInvoice(payee, "7", "To be cancelled");
  await payee.page.goto(`${server.origin}/ledger/`);
  const row = payee.page.locator(".view-ledger .links > li", { hasText: "To be cancelled" });
  const cancel = row.locator(".key-danger");
  await cancel.click(); // arms
  await expect(cancel).toContainText("Confirm cancel");
  await cancel.click(); // confirms
  await expect(payee.page.locator(".view-ledger .links > li", { hasText: "To be cancelled" })).toContainText(/cancelled/i);
  await expect(payee.page.locator("[aria-live=polite]").last()).toContainText(/cancelled/i);
  const sent = payee.wallet.sent();
  expect(sent).toHaveLength(1);
  expect((sent[0]?.params[0] as { to: string }).to.toLowerCase()).toBe(PAYLINK.toLowerCase());

  const payer = await actor(browser, ACCOUNTS.payer);
  await payer.page.goto(link);
  await expect(lamp(payer.page, 3)).toHaveAttribute("data-lamp", "err");
  await expect(lamp(payer.page, 3)).toContainText("Cancelled");
  await expect(payer.page.locator(".payform .key-primary")).toBeDisabled();
  await expect(lamp(payer.page, 1)).toHaveAttribute("data-lamp", "off");
  await expect(payer.page.locator(".vstrip > li[data-lamp='busy']")).toHaveCount(0);
});

test("an impostor contract at the registry address turns the genuine lamp red and locks Pay", async ({ browser }) => {
  const payee = await actor(browser, ACCOUNTS.payee);
  const link = await createInvoice(payee, "5", "Impostor", "?chain=base");
  expect(link).toContain(`#2.${String(FOREIGN_CHAIN_ID)}.`);
  const payer = await actor(browser, ACCOUNTS.payer, { chainId: FOREIGN_CHAIN_ID });
  await payer.page.goto(link);
  await expect(lamp(payer.page, 2)).toHaveAttribute("data-lamp", "err");
  await expect(lamp(payer.page, 2)).toContainText("not the genuine release");
  await expect(lamp(payer.page, 2).locator(".vstrip-state")).toHaveText("Stop");
  await expect(lamp(payer.page, 1)).toHaveAttribute("data-lamp", "off");
  await expect(payer.page.locator(".payform .key-primary")).toBeDisabled();
  await expect(payer.page.locator("#plate")).not.toBeEmpty();
  expect(payer.wallet.sent()).toHaveLength(0);
});

test("refusals: tampered link, own invoice, unknown chain", async ({ browser }) => {
  const payee = await actor(browser, ACCOUNTS.payee);
  const link = await createInvoice(payee, "10", "Tamper test");
  const [base = "", fragment = ""] = link.split("#");
  const parts = fragment.split(".");
  // Change the amount bytes inside the packed invoice: the decoder accepts the shape, the signature lamp goes red.
  const inv = parts[2] ?? "";
  const tampered = [...parts.slice(0, 2), `${inv.slice(0, 60)}${inv[60] === "A" ? "B" : "A"}${inv.slice(61)}`, ...parts.slice(3)].join(".");
  await payee.page.goto(`${base}#${tampered}`);
  await expect(payee.page.locator(".view-pay")).toBeVisible();
  const refused = payee.page.locator(".status.err, .vstrip > li[data-lamp='err']");
  await expect(refused.first()).toBeVisible();
  await expect(payee.page.locator(".payform .key-primary")).toBeDisabled();

  // The payee opening their own link cannot pay it.
  await payee.page.goto(link);
  await payee.page.locator(".payform .key-primary").click();
  await expect(payee.page.locator(".state-note")).toContainText("your own invoice");
  await expect(payee.page.locator(".payform .key-primary")).toBeDisabled();

  // Refused by the strict decoder before anything is read: another chain, a memo that does not hash to memoHash,
  // trailing data, and a link over the 1,200-character cap.
  const refusedLinks = [
    ["2", "1", ...parts.slice(2)].join("."),
    [...parts.slice(0, 4), Buffer.from("Pay the other account", "utf8").toString("base64url")].join("."),
    `${fragment}.AAAA`,
    `${fragment}${"A".repeat(1_300 - fragment.length)}`,
  ];
  for (const refusedLink of refusedLinks) {
    await payee.page.goto(`${base}#${refusedLink}`);
    await payee.page.reload();
    await expect(payee.page.locator(".status.err"), refusedLink.slice(0, 40)).toContainText("Error code");
    await expect(payee.page.locator(".vstrip")).toHaveCount(0);
  }
});

test("framing: the header blocks it, and the JavaScript lock keeps Pay disabled if the header were lost", async ({ browser }) => {
  const payee = await actor(browser, ACCOUNTS.payee);
  const link = await createInvoice(payee, "2", "Framed");
  // The host is a page of another origin without a policy of its own (about:blank), so only PayLink's headers decide.
  const host = await actor(browser, ACCOUNTS.payer);
  await host.page.setContent(`<iframe title="framed" src="${link}" width="1000" height="800"></iframe>`);
  await host.page.waitForTimeout(1_500);
  await expect(host.page.frameLocator("iframe[title=framed]").locator("main#terminal")).toHaveCount(0);

  // Without frame-ancestors and X-Frame-Options (as if the headers were lost), the page loads but stays locked.
  const framed = await actor(browser, ACCOUNTS.payer);
  await framed.page.context().route(`${server.origin}/pay/**`, async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["x-frame-options"];
    headers["content-security-policy"] = (headers["content-security-policy"] ?? "").replace("; frame-ancestors 'none'", "");
    await route.fulfill({ response, headers });
  });
  await framed.page.setContent(`<iframe title="framed" src="${link}" width="1000" height="800"></iframe>`);
  const inner = framed.page.frameLocator("iframe[title=framed]");
  await expect(inner.locator("main#terminal")).toBeVisible();
  await expect(inner.locator(".banner.is-err")).toContainText("inside another site");
  await expect(inner.locator(".vstrip > li").nth(3)).toHaveAttribute("data-lamp", "ok");
  await expect(inner.locator(".payform .key-primary")).toBeDisabled();
  expect(framed.wallet.sent()).toHaveLength(0);
});

test("language switch EN → FR → MG keeps the page and sets lang", async ({ browser }) => {
  const { page, problems } = await actor(browser, ACCOUNTS.payee);
  await page.goto(`${server.origin}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const h1 = await page.locator(".intro h1").textContent();
  await page.locator(".top .dial button", { hasText: "FR" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", /^fr/);
  expect(await page.locator(".intro h1").textContent()).not.toBe(h1);
  await page.locator(".top .dial button", { hasText: "MG" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "mg");
  await expect(page.locator("main#terminal")).toBeVisible();
  expect(problems).toEqual([]);
});

test.describe("production site", () => {
  const ROUTES = ["/", "/pay/", "/r/", "/ledger/", "/send/", "/till/", "/status/", "/does-not-exist/"];

  // Every route, in every language and both themes: axe at desktop, phone and the 320 px reflow width; at 768 px (the
  // tablet layout, where the footer has three columns) and at the three others, no horizontal scroll, no footer link
  // drawn over another or over its label, no word broken inside itself and no copy cut by an ellipsis (spec §3.9
  // "visual tests cover text expansion in FR and MG", §3.10).
  const WIDTHS = [1280, 768, 390, 320] as const;
  for (const scheme of ["light", "dark"] as const) {
    test(`axe and reflow (${scheme}): every route in EN, FR and MG at 1280, 768, 390 and 320 px`, async ({ browser }) => {
      test.setTimeout(600_000);
      const visitor = await actor(browser, ACCOUNTS.payee, { scheme });
      const { page } = visitor;
      for (const locale of ["en", "fr", "mg"] as const) {
        await page.goto(`${server.origin}/`);
        await setLocale(page, locale);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          for (const route of ROUTES) {
            const where = `${route} ${locale} ${scheme} ${String(width)}`;
            await page.goto(`${server.origin}${route}`);
            await expect(page.locator("main#terminal")).toBeVisible();
            await expect(page.locator("html")).toHaveAttribute("lang", locale === "fr" ? /^fr/ : locale);
            await page.waitForTimeout(200);
            expect(await horizontalOverflow(page), `${where}: horizontal scroll`).toBeLessThanOrEqual(0);
            expect(await overlappingTargets(page), `${where}: footer links`).toEqual([]);
            expect(await brokenWords(page), `${where}: words broken inside`).toEqual([]);
            expect(await truncatedText(page), `${where}: copy cut`).toEqual([]);
            if (width !== 768) {
              expect(await axe(page), where).toEqual([]);
            }
          }
        }
      }
      expect(visitor.problems).toEqual([]);
    });
  }

  test("the status page checks each chain live: genuine release, impostor, unreachable", async ({ browser }) => {
    const { page } = await actor(browser, ACCOUNTS.payee);
    await page.goto(`${server.origin}/status/`);
    const board = page.locator(".board > li");
    const monad = board.filter({ hasText: "MONAD" });
    await expect(monad.locator(".vstrip > li").nth(0)).toHaveAttribute("data-lamp", "ok");
    await expect(monad.locator(".vstrip > li").nth(1)).toHaveAttribute("data-lamp", "ok");
    const base = board.filter({ hasText: "BASE" });
    await expect(base.locator(".vstrip > li").nth(0)).toHaveAttribute("data-lamp", "ok");
    await expect(base.locator(".vstrip > li").nth(1)).toHaveAttribute("data-lamp", "err");
    const arb = board.filter({ hasText: "ARB" });
    await expect(arb.locator(".vstrip > li").nth(0)).toHaveAttribute("data-lamp", "err");
  });

  test("serves each area under its own policy, and the frozen v1 app byte for byte", async ({ request }) => {
    const app = await request.get(`${server.origin}/`);
    const csp = app.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(app.headers()["x-content-type-options"]).toBe("nosniff");
    expect(app.headers()["referrer-policy"]).toBe("no-referrer");

    const v1 = await request.get(`${server.origin}/arc/`);
    expect(v1.status()).toBe(200);
    expect(await v1.body()).toEqual(readFileSync(join(REPO, "web/index.html")));
    const v1Csp = v1.headers()["content-security-policy"] ?? "";
    expect(v1Csp).toContain("https://rpc.mainnet.arc.io");
    expect(v1Csp).not.toContain("trusted-types");
    expect(v1Csp).not.toContain(",");
    for (const file of ["app.js", "paylink.css", "deploy.html", "config.js"]) {
      expect((await (await request.get(`${server.origin}/arc/${file}`)).body()).equals(readFileSync(join(REPO, "web", file))), file).toBe(true);
    }

    for (const kit of ["/deploy/", "/v2/deploy/"]) {
      const page = await request.get(`${server.origin}${kit}`);
      expect(page.status(), kit).toBe(200);
      expect(await page.text()).toContain('href="/arc/paylink.css"');
      expect(page.headers()["content-security-policy"], kit).not.toContain("trusted-types");
    }
    const missing = await request.get(`${server.origin}/nope/`);
    expect(missing.status()).toBe(404);
    expect(await missing.text()).toContain("<!doctype html>");
  });

  test("loads under Trusted Types without a CSP violation, and installs the service worker", async ({ browser }) => {
    const { page, problems } = await actor(browser, ACCOUNTS.payee);
    const violations: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { __violations?: string[] }).__violations ??= [];
        (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    for (const route of ["/", "/pay/", "/ledger/", "/status/"]) {
      await page.goto(`${server.origin}${route}`);
      await expect(page.locator("main#terminal")).toBeVisible();
      violations.push(...(await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])));
    }
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe(`${server.origin}/`);
    expect(violations).toEqual([]);
    expect(problems).toEqual([]);

    // Offline, the precached app shell still opens and signs nothing it cannot check; /config.json is network-only.
    await page.reload();
    await expect.poll(async () => await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await page.context().setOffline(true);
    await page.goto(`${server.origin}/ledger/`);
    await expect(page.locator("main#terminal")).toBeVisible();
    await page.goto(`${server.origin}/status/`);
    await expect(page.locator(".vstrip > li", { hasText: "Configuration" })).toHaveAttribute("data-lamp", /wait|err/);
    await page.context().setOffline(false);

    const v1 = await actor(browser, ACCOUNTS.payee);
    await v1.page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { __violations?: string[] }).__violations ??= [];
        (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    await v1.page.goto(`${server.origin}/arc/`);
    await v1.page.waitForTimeout(500);
    expect(await v1.page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])).toEqual([]);
  });
});
