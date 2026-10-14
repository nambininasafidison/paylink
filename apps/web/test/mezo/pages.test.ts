// SPDX-License-Identifier: MIT
/**
 * The Mezo edition's pages render in every language without a wallet and without a network (as test/pages.test.ts does
 * for the root edition): its words on MUSD and the BTC fee, the test-MUSD walkthrough with Mezo's own links, Mezo
 * testnet alone in the band ("Not deployed" until the registry records a deployment), the funds rows, and the Status
 * lines read live from the token (a fake chain here).
 */
import "fake-indexeddb/auto";
import type { Erc20Token } from "@paylink/chains";
import { createTranslator, EN, LOCALES, loadMessages } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";
import { encodeFunctionResult, erc20Abi, pad } from "viem";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../../src/app/boot.ts";
import type { PageDefinition } from "../../src/app/boot.ts";
import type { App } from "../../src/app/context.ts";
import { fundsRow } from "../../src/app/funds.ts";
import type { ChainClient } from "../../src/core/clients.ts";
import { prefs } from "../../src/core/prefs.ts";
import { appRegistry } from "../../src/core/registry.ts";
import { edition } from "../../src/editions/index.ts";
import { loadMezoCopy, mezoTranslator } from "../../src/editions/mezo/copy.ts";
import { MEZO_LINKS } from "../../src/editions/mezo/links.ts";
import { loanParams, readLoanTerms, smallestLoan } from "../../src/editions/mezo/borrow.ts";
import { mezoStatus, readToken } from "../../src/editions/mezo/status.ts";
import { btcFundsRow, mezoNotes, mezoTestSteps, showFee } from "../../src/editions/mezo/ui.ts";
import { createPage } from "../../src/pages/create.ts";
import { ledgerPage } from "../../src/pages/ledger.ts";
import { payPage } from "../../src/pages/pay.ts";
import { receiptPage } from "../../src/pages/receipt.ts";
import { sendPage } from "../../src/pages/send.ts";
import { statusPage } from "../../src/pages/status.ts";
import { tillPage } from "../../src/pages/till.ts";

const MEZO = 31611;
const ROUTES: readonly (readonly [string, PageDefinition, string])[] = [
  ["create", createPage, "/mezo/"],
  ["pay (empty)", payPage, "/mezo/pay/"],
  ["pay (another chain's link)", payPage, "/mezo/pay/#2.10143.AAAA"],
  ["receipt (empty)", receiptPage, "/mezo/r/"],
  ["ledger", ledgerPage, "/mezo/ledger/"],
  ["send", sendPage, "/mezo/send/"],
  ["till", tillPage, "/mezo/till/"],
  ["status", statusPage, "/mezo/status/"],
];

/** A dotted key showing through untranslated, the Mezo catalogue's included (the host mezo.org is not a key). */
const RAW_KEY = /\b(app|create|pay|receipt|ledger|send|till|status|verify|share|ticket|wallet|chain|error|common|details|mezo|funds)\.(?!org\b)[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)*\b/;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/config.json")) {
        return Promise.resolve(new Response(JSON.stringify({ version: 1, banner: null, relayer: { url: "https://relayer.example", chains: [10143] }, indexer: null, rpc: {} }), { status: 200 }));
      }
      return Promise.reject(new TypeError("network disabled in unit tests"));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  prefs.locale.set(null);
  document.body.className = "";
  document.body.replaceChildren();
});

async function render(page: PageDefinition, path: string, locale: Locale): Promise<void> {
  prefs.locale.set(locale);
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://mezo.paylink-mg.pages.dev${path}`);
  await boot(page);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe.each(LOCALES)("Mezo routes in %s", (locale) => {
  it.each(ROUTES)("%s renders in the Mezo edition's words", async (_name, page, path) => {
    await render(page, path, locale);
    expect(document.querySelector("header.top .edition-tag")?.textContent).toBe("Mezo");
    expect(document.querySelector("main#terminal")).not.toBeNull();
    expect(document.querySelector(".intro h1")?.textContent).not.toBe("");
    expect(document.body.textContent).not.toMatch(RAW_KEY);
    expect(document.querySelector("footer .coords")?.textContent).toBe("MEZO");
    // The Mezo work is on the branch mezo, not on main (which the repository root shows).
    expect(document.querySelector("footer .foot-links a.ext")?.getAttribute("href")).toBe("https://github.com/nambininasafidison/paylink/tree/mezo");
  });
});

describe("create terminal", () => {
  it("speaks of MUSD and the BTC fee, walks a tester to test BTC and borrowed MUSD, and offers Mezo testnet alone", async () => {
    await render(createPage, "/mezo/", "en");
    expect(document.querySelector(".intro .kicker")?.textContent).toBe("Bitcoin-backed dollar invoices");
    expect(document.querySelector(".intro h1")?.textContent).toContain("Get paid in MUSD");
    expect(document.querySelector("#mezo-notes")?.textContent).toBe("MUSD and BTC on Mezo");
    expect(document.querySelector("#mezo-test")?.textContent).toBe("Test MUSD, step by step");
    const hrefs = [...document.querySelectorAll<HTMLAnchorElement>(".lead-aside a.ext")].map((a) => a.getAttribute("href"));
    // Testnet pages only: Mezo's own guide calls mezo.org/feature/borrow the Mainnet app, where real BTC backs real MUSD.
    expect(hrefs).toEqual([MEZO_LINKS.faucet, MEZO_LINKS.discord, MEZO_LINKS.borrow]);
    expect(hrefs).not.toContain("https://mezo.org/feature/borrow");
    for (const a of document.querySelectorAll<HTMLAnchorElement>(".lead-aside a.ext")) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    const bands = [...document.querySelectorAll<HTMLElement>(".band")];
    expect(bands.map((b) => b.querySelector(".band-label")?.textContent)).toEqual(["MEZO"]);
    expect(document.querySelector(".readout-top")?.textContent).toContain("MUSD");
  });

  it("says plainly that PayLink is not deployed on Mezo testnet until the registry records it", async () => {
    await render(createPage, "/mezo/", "en");
    if (appRegistry("mezo").v2Target(MEZO) === undefined) {
      expect(document.querySelector(".band[aria-checked=true] .band-id")?.textContent).toBe("Not deployed");
      const notice = document.querySelector(".view-create .warn-note");
      expect(notice?.textContent).toContain("Mezo testnet");
      expect(notice?.querySelector("a")?.getAttribute("href")).toBe("/deploy/?chain=mezo");
    } else {
      expect(document.querySelector(".band[aria-checked=true] .band-id")?.textContent).toBe("Testnet · 31611");
    }
  });

  it("refuses a link of another edition's chain", async () => {
    await render(payPage, "/mezo/pay/#2.10143.AAAA", "en");
    expect(document.querySelector(".status.err")?.textContent).toMatch(/Error code E_/);
  });
});

describe("status page", () => {
  it("adds the MUSD, fee and borrowing lines under Mezo testnet, and says why no payment is gasless; the relayer serves no Mezo chain", async () => {
    await render(statusPage, "/mezo/status/", "en");
    const mezo = document.querySelector(".board > li");
    expect(mezo?.querySelector(".board-name")?.textContent).toBe("MEZO");
    const names = [...(mezo?.querySelectorAll(".vstrip .vstrip-name") ?? [])].map((n) => n.textContent);
    expect(names).toEqual(["Network answers", "Genuine contract", "MUSD on the network", "Network fee", "Borrowing MUSD"]);
    const services = [...document.querySelectorAll(".view-status > .vstrip")][0];
    expect([...(services?.querySelectorAll(".vstrip-name") ?? [])].map((n) => n.textContent)).toEqual(["Relayer", "Gasless payments", "History service"]);
    // config.json names a relayer, but it serves no Mezo chain: never "not configured".
    expect(services?.textContent).toContain("Does not serve Mezo testnet: each payer's wallet sends the payment.");
    expect(services?.textContent).not.toContain("payers use their own wallet");
    expect(services?.textContent).toContain("MUSD has no signed transfers (EIP-3009)");
  });

  it("says the relayer is not configured only when config.json names none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url.endsWith("/config.json")
          ? Promise.resolve(new Response(JSON.stringify({ version: 1, banner: null, relayer: null, indexer: null, rpc: {} }), { status: 200 }))
          : Promise.reject(new TypeError("network disabled in unit tests"));
      }),
    );
    await render(statusPage, "/mezo/status/", "en");
    const services = [...document.querySelectorAll(".view-status > .vstrip")][0];
    expect(services?.textContent).toContain("Not configured: payers use their own wallet.");
  });
});

/** MUSD's lending terms on Mezo testnet as read on 2026-10-14 (research §4): BorrowerOperations, PriceFeed, TroveManager. */
const TERMS = { minNetDebt: 1_800n * 10n ** 18n, gasCompensation: 200n * 10n ** 18n, borrowingRate: 10n ** 15n, mcr: 11n * 10n ** 17n, ccr: 15n * 10n ** 17n, price: 83_339_209_550_000_000_000_000n } as const;
const PRICE_FEED = "0x86bCF0841622a5dAC14A313a15f96A95421b9366";
const TROVE_MANAGER = "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0";

/**
 * A chain client that answers the token reads like MUSD on Mezo testnet, and MUSD's lending reads like its
 * BorrowerOperations, PriceFeed and TroveManager (or with the changes asked for).
 */
function fakeToken(options: { readonly decimals?: number; readonly eip3009?: boolean; readonly down?: boolean; readonly recovery?: boolean; readonly lends?: Hex } = {}): ChainClient {
  const token = appRegistry("mezo").getOrThrow(MEZO).tokens[0] as Erc20Token;
  const domainAbi = [
    {
      type: "function",
      name: "eip712Domain",
      stateMutability: "view",
      inputs: [],
      outputs: [
        { name: "fields", type: "bytes1" },
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
        { name: "salt", type: "bytes32" },
        { name: "extensions", type: "uint256[]" },
      ],
    },
  ] as const;
  const revert = (): never => {
    throw Object.assign(new Error("execution reverted"), { name: "CallExecutionError" });
  };
  return {
    call: ({ data }: { data: Hex }) => {
      if (options.down === true) {
        return Promise.reject(new TypeError("network down"));
      }
      const selector = data.slice(0, 10);
      const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;
      const answers: Record<string, () => Hex> = {
        "0x95d89b41": () => encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: "MUSD" }),
        "0x313ce567": () => encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: options.decimals ?? 18 }),
        "0x84b0196e": () => encodeFunctionResult({ abi: domainAbi, functionName: "eip712Domain", result: ["0x0f", "Mezo USD", "1", BigInt(MEZO), token.address, `0x${"0".repeat(64)}`, []] }),
        "0x7ecebe00": () => word(0n),
        "0x3644e515": () => word(1n),
        "0xe94a0102": () => (options.eip3009 === true ? word(0n) : revert()),
        // MUSD's lending system (borrow.ts).
        "0xcab666d0": () => pad(options.lends ?? token.address),
        "0x969c2452": () => word(TERMS.minNetDebt),
        "0x7af110ba": () => word(TERMS.gasCompensation),
        "0xb5b8453e": () => word(TERMS.borrowingRate),
        "0x794e5724": () => word(TERMS.mcr),
        "0x5733d58f": () => word(TERMS.ccr),
        "0x741bef1a": () => pad(PRICE_FEED),
        "0x3d83908a": () => pad(TROVE_MANAGER),
        "0x0fdb11cf": () => word(TERMS.price),
        "0x4e443d9e": () => word(options.recovery === true ? 1n : 0n),
      };
      const answer = answers[selector];
      return answer === undefined ? Promise.reject(new Error(`unexpected call ${selector}`)) : Promise.resolve({ data: answer() });
    },
    estimateFees: () => Promise.resolve({ maxFeePerGas: 276n, maxPriorityFeePerGas: 16n }),
  } as unknown as ChainClient;
}

describe("MUSD read live", () => {
  const chain = appRegistry("mezo").getOrThrow(MEZO);
  const token = chain.tokens[0] as Erc20Token;

  it("agrees with the registry when the token answers as MUSD does: permit yes, EIP-3009 no, Mezo USD/1", async () => {
    expect(await readToken(fakeToken(), chain, token)).toEqual({ name: "Mezo USD", symbol: "MUSD", decimals: 18, permit: true, authorization: false, matches: true });
  });

  it("disagrees when a fact differs: other decimals, or an EIP-3009 function the registry does not list", async () => {
    expect((await readToken(fakeToken({ decimals: 6 }), chain, token)).matches).toBe(false);
    expect((await readToken(fakeToken({ eip3009: true }), chain, token)).matches).toBe(false);
    await expect(readToken(fakeToken({ down: true }), chain, token)).rejects.toThrow();
  });

  it("lights the Status lines from those reads", async () => {
    const app = await mezoApp(fakeToken());
    const board = document.createElement("ul");
    const item = document.createElement("li");
    item.append(Object.assign(document.createElement("ul"), { className: "vstrip" }));
    board.append(item);
    const services = document.createElement("ul");
    const relayer = document.createElement("li");
    services.append(relayer);
    mezoStatus(app, board, relayer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = [...item.querySelectorAll("li")];
    expect(lines.map((l) => l.getAttribute("data-lamp"))).toEqual(["ok", "ok", "ok"]);
    expect(lines[0]?.textContent).toContain("Mezo USD (MUSD), 18 decimals");
    expect(lines[1]?.textContent).toMatch(/about 0\.0\d+ sat per payment/);
    expect(lines[2]?.textContent).toBe(
      "Borrowing MUSDSmallest loan 1,800.00 MUSD: at least 0.02643 test BTC of collateral (110% of a 2,001.80 MUSD debt), at 83,339 USD per BTC on Mezo's price feed.",
    );
    expect(services.textContent).toContain("Gasless payments");
  });
});

async function mezoApp(client: ChainClient): Promise<App> {
  const copy = await loadMezoCopy("en");
  return { edition: edition(), registry: appRegistry("mezo"), i18n: mezoTranslator("en", EN, copy), locale: "en", client: () => client } as unknown as App;
}

describe("borrowing MUSD (borrow.ts)", () => {
  const chain = appRegistry("mezo").getOrThrow(MEZO);
  const token = chain.tokens[0] as Erc20Token;
  const MUSD = (n: bigint): bigint => n * 10n ** 18n;
  /** LiquityMath._computeCR: collateral × price / debt. */
  const cr = (collateral: bigint, debt: bigint): bigint => (collateral * TERMS.price) / debt;

  it("reads the terms from the registry's BorrowerOperations and the PriceFeed and TroveManager it names", async () => {
    expect(await readLoanTerms(fakeToken(), chain, token)).toEqual({ ...TERMS, recovery: false });
    expect((await readLoanTerms(fakeToken({ recovery: true }), chain, token)).recovery).toBe(true);
    // Another token's lending system, or a chain without one, gives no estimate.
    await expect(readLoanTerms(fakeToken({ lends: "0x7b7C000000000000000000000000000000000000" }), chain, token)).rejects.toThrow(/does not lend/);
    await expect(readLoanTerms(fakeToken(), { ...chain, contracts: {} }, token)).rejects.toThrow(/no MUSD BorrowerOperations/);
  });

  it("asks at least Mezo's minimum loan, in whole MUSD, and books the fee and the reserve as the contract does", () => {
    const terms = { ...TERMS, recovery: false };
    const small = smallestLoan(terms, MUSD(12n) + 5n * 10n ** 17n);
    expect([small.loan, small.debt, small.ratio]).toEqual([MUSD(1_800n), MUSD(2_001n) + 8n * 10n ** 17n, TERMS.mcr]);
    expect(small.collateral).toBe(26_430_000_000_000_000n);
    const large = smallestLoan(terms, MUSD(2_500n) + 3n * 10n ** 17n);
    expect(large.loan).toBe(MUSD(2_501n));
    expect(large.debt).toBe(MUSD(2_501n) + (MUSD(2_501n) * TERMS.borrowingRate) / 10n ** 18n + TERMS.gasCompensation);
    for (const estimate of [small, large, smallestLoan(terms, 0n)]) {
      // Enough to open: collateral × price / debt reaches MCR, and 0.00001 BTC less would not always.
      expect(cr(estimate.collateral, estimate.debt)).toBeGreaterThanOrEqual(TERMS.mcr);
      expect(cr(estimate.collateral - 10n ** 13n, estimate.debt)).toBeLessThan(TERMS.mcr);
    }
  });

  it("in recovery mode books no fee and asks CCR", () => {
    const estimate = smallestLoan({ ...TERMS, recovery: true }, 1n);
    expect([estimate.loan, estimate.debt, estimate.ratio]).toEqual([MUSD(1_800n), MUSD(2_000n), TERMS.ccr]);
    expect(cr(estimate.collateral, estimate.debt)).toBeGreaterThanOrEqual(TERMS.ccr);
  });

  it("writes the figures in each language's number format", () => {
    const estimate = smallestLoan({ ...TERMS, recovery: false }, 1n);
    expect(loanParams(estimate, "en")).toEqual({ loan: "1,800.00", debt: "2,001.80", btc: "0.02643", ratio: "110", price: "83,339" });
    const fr = loanParams(estimate, "fr");
    expect(fr.btc).toBe("0,02643");
    expect(fr.debt.replace(/\s/g, " ")).toBe("2 001,80");
  });
});

describe("payer rows", () => {
  it("send a payer short of MUSD to borrow it (no faucet), and one without BTC to Mezo's faucet", async () => {
    const app = await mezoApp(fakeToken());
    const chain = app.registry.getOrThrow(MEZO);
    const token = chain.tokens[0] as Erc20Token;
    const row = await fundsRow(app, { chain, token, owner: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", balance: 0n, needed: 12_500_000_000_000_000_000n, onFunded: () => undefined });
    expect(row?.textContent).toContain("This account holds 0.00 MUSD.");
    expect(row?.textContent).toContain("MUSD has no faucet");
    expect([...(row?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual([MEZO_LINKS.borrow, MEZO_LINKS.faucet]);
    // Then, read live from MUSD's own contracts: the smallest loan that covers the 12.50 MUSD, and the BTC it locks.
    await vi.waitFor(() => {
      expect(row?.querySelector(".funds-borrow")?.textContent).toBe(
        "Or borrow MUSD without selling bitcoin: Mezo's smallest loan that covers this is 1,800.00 MUSD. It needs at least 0.02643 test BTC locked as collateral: 110% of the 2,001.80 MUSD debt, at 83,339 USD per BTC on Mezo's price feed, read now. Lock more to stay clear of liquidation.",
      );
    });
    // A network that does not answer leaves that line out.
    const quiet = await fundsRow(await mezoApp(fakeToken({ down: true })), { chain, token, owner: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", balance: 0n, needed: 1n, onFunded: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(quiet?.querySelector(".funds-borrow")).toBeNull();
    const btc = btcFundsRow(app, chain);
    expect(btc.textContent).toContain("BTC");
    expect([...btc.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([MEZO_LINKS.faucet, MEZO_LINKS.discord]);
  });

  it("put the fee line under the route note, and take it away when there is no route", async () => {
    const app = await mezoApp(fakeToken());
    const chain = app.registry.getOrThrow(MEZO);
    const parent = document.createElement("div");
    const routeNote = document.createElement("p");
    parent.append(routeNote);
    const link = { token: chain.tokens[0], target: { chain, deployment: { address: "0x448eCce9711860502806A3d5B021a4f9Ba715082" } } } as never;
    showFee(app, routeNote, { chain, client: app.client(chain), path: "permit", link, payer: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", amount: 1n });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fee = routeNote.nextElementSibling;
    expect(fee?.classList.contains("fee-note")).toBe(true);
    expect(fee?.textContent).toMatch(/^Network fee: about 0\.0\d+ sat, paid in BTC by your wallet\.$/);
    expect(fee?.getAttribute("title")).toContain("upper estimate");
    showFee(app, routeNote, { chain, client: app.client(chain), path: null, link, payer: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", amount: 1n });
    expect(routeNote.nextElementSibling).toBe(fee);
    expect(fee?.textContent).toBe("");
  });

  it("build the lead's notes and walkthrough in each language without a raw key", async () => {
    for (const locale of LOCALES) {
      const copy = await loadMezoCopy(locale);
      const app = { i18n: mezoTranslator(locale, await loadMessages(locale), copy), locale } as unknown as App;
      const text = `${mezoNotes(app).textContent} ${mezoTestSteps(app).textContent}`;
      expect(text, locale).not.toMatch(RAW_KEY);
    }
    expect(createTranslator("en", EN).t("create.h1b")).toBe("Get paid in dollars");
  });
});
