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
import { encodeFunctionResult, erc20Abi } from "viem";
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
    expect(hrefs).toEqual([MEZO_LINKS.faucet, MEZO_LINKS.discord, MEZO_LINKS.borrow, MEZO_LINKS.borrowAlt]);
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
  it("adds the MUSD and fee lines under Mezo testnet, and says why no payment is gasless; the relayer serves no Mezo chain", async () => {
    await render(statusPage, "/mezo/status/", "en");
    const mezo = document.querySelector(".board > li");
    expect(mezo?.querySelector(".board-name")?.textContent).toBe("MEZO");
    const names = [...(mezo?.querySelectorAll(".vstrip .vstrip-name") ?? [])].map((n) => n.textContent);
    expect(names).toEqual(["Network answers", "Genuine contract", "MUSD on the network", "Network fee"]);
    const services = [...document.querySelectorAll(".view-status > .vstrip")][0];
    expect([...(services?.querySelectorAll(".vstrip-name") ?? [])].map((n) => n.textContent)).toEqual(["Relayer", "Gasless payments", "History service"]);
    expect(services?.textContent).toContain("Not configured: payers use their own wallet.");
    expect(services?.textContent).toContain("MUSD has no signed transfers (EIP-3009)");
  });
});

/** A chain client that answers the token reads like MUSD on Mezo testnet (or with the changes asked for). */
function fakeToken(options: { readonly decimals?: number; readonly eip3009?: boolean; readonly down?: boolean } = {}): ChainClient {
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
    expect(lines.map((l) => l.getAttribute("data-lamp"))).toEqual(["ok", "ok"]);
    expect(lines[0]?.textContent).toContain("Mezo USD (MUSD), 18 decimals");
    expect(lines[1]?.textContent).toMatch(/about 0\.0\d+ sat per payment/);
    expect(services.textContent).toContain("Gasless payments");
  });
});

async function mezoApp(client: ChainClient): Promise<App> {
  const copy = await loadMezoCopy("en");
  return { edition: edition(), registry: appRegistry("mezo"), i18n: mezoTranslator("en", EN, copy), locale: "en", client: () => client } as unknown as App;
}

describe("payer rows", () => {
  it("send a payer short of MUSD to borrow it (no faucet), and one without BTC to Mezo's faucet", async () => {
    const app = await mezoApp(fakeToken());
    const chain = app.registry.getOrThrow(MEZO);
    const token = chain.tokens[0] as Erc20Token;
    const row = await fundsRow(app, { chain, token, owner: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", balance: 0n, onFunded: () => undefined });
    expect(row?.textContent).toContain("This account holds 0.00 MUSD.");
    expect(row?.textContent).toContain("MUSD has no faucet");
    expect([...(row?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual([MEZO_LINKS.borrow, MEZO_LINKS.faucet]);
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
