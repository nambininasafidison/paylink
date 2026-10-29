// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's shell (`/paypal/`, ADR 0018) renders in every language without a wallet and without a network:
 * the edition tag, its four tabs with the desk, Ethereum Sepolia alone ("Not deployed" until the registry records
 * PayLinkV2 there, as it has since 2026-10-29), the desk's "coming" placeholder with the API's health row, the Status
 * page without a relayer, and
 * the footer's source link to the branch paypal. Runs with `__PAYLINK_EDITION__ = "paypal"` (vitest project "paypal").
 */
import "fake-indexeddb/auto";
import { EN, LOCALES, loadEditionMessages, loadMessages, placeholders } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../../src/app/boot.ts";
import type { PageDefinition } from "../../src/app/boot.ts";
import { prefs } from "../../src/core/prefs.ts";
import { appRegistry } from "../../src/core/registry.ts";
import { edition } from "../../src/editions/index.ts";
import { loadPaypalCopy, PAYPAL_COPY, paypalTranslator } from "../../src/editions/paypal/copy.ts";
import { createPage } from "../../src/pages/create.ts";
import { apiUrl, deskPage } from "../../src/pages/desk.ts";
import { ledgerPage } from "../../src/pages/ledger.ts";
import { payPage } from "../../src/pages/pay.ts";
import { receiptPage } from "../../src/pages/receipt.ts";
import { statusPage } from "../../src/pages/status.ts";
import { tillPage } from "../../src/pages/till.ts";

const SEPOLIA = 11155111;
const API = "https://api.example";
const ROUTES: readonly (readonly [string, PageDefinition, string])[] = [
  ["create", createPage, "/paypal/"],
  ["pay (empty)", payPage, "/paypal/pay/"],
  ["receipt (empty)", receiptPage, "/paypal/r/"],
  ["ledger", ledgerPage, "/paypal/ledger/"],
  ["desk", deskPage, "/paypal/desk/"],
  ["till", tillPage, "/paypal/till/"],
  ["status", statusPage, "/paypal/status/"],
];

/** A dotted key showing through untranslated, the PayPal catalogue's included. */
const RAW_KEY = /\b(app|create|pay|receipt|ledger|send|till|status|verify|share|ticket|wallet|chain|error|common|details|paypal|funds)\.[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)*\b/;

type Health = "ok" | "down" | "unreachable";

function stubNetwork(options: { readonly api?: unknown; readonly health?: Health } = {}): string[] {
  const calls: string[] = [];
  const config = { version: 1, banner: null, relayer: { url: "https://relayer.example", chains: [10143] }, indexer: null, ...(options.api === undefined ? {} : { api: options.api }), rpc: {} };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.endsWith("/config.json")) {
        return Promise.resolve(new Response(JSON.stringify(config), { status: 200 }));
      }
      if (url === `${API}/v1/health` && options.health === "ok") {
        return Promise.resolve(new Response(JSON.stringify({ status: "ok", service: "paylink-api", version: "0.1.0", contract: 1, time: "2026-10-21T12:00:00.000Z", paypalEnvironment: "sandbox", rows: [] }), { status: 200 }));
      }
      if (url === `${API}/v1/health` && options.health === "down") {
        return Promise.resolve(new Response("{}", { status: 503 }));
      }
      return Promise.reject(new TypeError("network disabled in unit tests"));
    }),
  );
  return calls;
}

beforeEach(() => {
  stubNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
  prefs.locale.set(null);
  document.body.className = "";
  document.body.replaceChildren();
});

async function render(page: PageDefinition, path: string, locale: Locale): Promise<void> {
  prefs.locale.set(locale);
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://paypal.paylink-mg.pages.dev${path}`);
  await boot(page);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("the PayPal edition's profile and registry", () => {
  it("offers EIP-6963 wallets, the payer's own authorisation then the wallet (no relayer), and the desk tab", () => {
    const profile = edition();
    expect(profile.id).toBe("paypal");
    expect(profile.base).toBe("/paypal/");
    expect(profile.tag).toBe("PayPal");
    expect(profile.tabs).toEqual(["create", "ledger", "desk", "till"]);
    expect(profile.accountLayers.map((layer) => layer.kind)).toEqual(["injected"]);
    expect(profile.rails.map((rail) => rail.id)).toEqual(["self-authorization", "wallet"]);
    expect(profile.testFunds).toEqual({ kind: "link", url: "https://faucet.circle.com", name: "Circle Faucet" });
  });

  it("carries Ethereum Sepolia alone, with USDC preselected and PayPal USD offered", () => {
    const registry = appRegistry("paypal");
    expect(registry.chains.map((chain) => chain.chainId)).toEqual([SEPOLIA]);
    const sepolia = registry.chains[0];
    expect(sepolia?.tokens.map((token) => [token.symbol, token.listing])).toEqual([
      ["USDC", "default"],
      ["PYUSD", "listed"],
    ]);
  });
});

describe("the PayPal words", () => {
  it("rewords existing core sentences with the same placeholders, in every language", async () => {
    expect(Object.keys(PAYPAL_COPY).length).toBeGreaterThanOrEqual(10);
    for (const locale of LOCALES) {
      const core = locale === "en" ? EN : await loadMessages(locale);
      const own = await loadEditionMessages("paypal", locale);
      for (const [key, paypal] of Object.entries(PAYPAL_COPY)) {
        const original = (core as Readonly<Record<string, string>>)[key];
        const reworded = own[paypal];
        expect(original, `${locale} ${key}`).toBeDefined();
        expect(reworded, `${locale} ${paypal}`).toBeDefined();
        expect(placeholders(reworded ?? "").sort(), `${locale} ${key}`).toEqual(placeholders(original ?? "").sort());
      }
    }
  });

  it("names PayPal where the core says the client pays only from a wallet, and never claims Status is uncached", async () => {
    for (const locale of LOCALES) {
      const t = paypalTranslator(locale, locale === "en" ? EN : await loadMessages(locale), await loadPaypalCopy(locale)).t;
      for (const key of ["create.kicker", "create.h1b", "create.lede", "create.step3.text", "pay.voice.bill.lede", "pay.step2.text", "till.lede", "status.lede"] as const) {
        expect(t(key), `${locale} ${key}`).toContain("PayPal");
      }
      expect(t("ticket.scanSub", { symbol: "USDC" }), `${locale} ticket.scanSub`).toContain("PayPal");
    }
    const t = paypalTranslator("en", EN, await loadPaypalCopy("en")).t;
    expect(`${t("create.h1a")} ${t("create.h1b")}`).toBe("One invoice. Paid on PayPal or in dollars on chain");
    expect(t("create.lede")).not.toContain("straight to your wallet");
    expect(t("ticket.scanSub", { symbol: "USDC" })).toBe("Pay on PayPal, or in USDC from any wallet. The first payment closes the invoice.");
    expect(t("status.lede")).not.toContain("nothing here is cached");
    expect(t("ledger.tally")).toBe("Received on chain, all invoices");
    // Untouched keys stay the core's.
    expect(t("create.step1.title")).toBe(EN["create.step1.title"]);
  });
});

// Before any page renders: a page rendered earlier keeps reading its chain for a moment after its test, and those
// reads would land in the next stub (the desk without an API must call no one, which only a clean slate can show).
describe("desk", () => {
  it("needs the edition's API: without one it says so, signs and approves nothing, and calls no one", async () => {
    const calls = stubNetwork();
    await render(deskPage, "/paypal/desk/", "en");
    const view = document.querySelector(".view-desk");
    expect(view?.getAttribute("data-desk")).toBe("no-api");
    expect(view?.querySelector(".empty-state")?.textContent).toContain("The desk needs this edition's API");
    expect(view?.querySelector("button")).toBeNull();
    expect(view?.querySelector(".desk-foot li")?.textContent).toBe("PayLink APINot configured");
    // Same-origin configuration and the ariary rate only: nothing else is called.
    expect(calls.filter((url) => !url.endsWith("/config.json") && !url.endsWith("/fx.json"))).toEqual([]);
  });

  it("asks for the payee's wallet first, and reads the API's health when config.json names it for Ethereum Sepolia", async () => {
    stubNetwork({ api: { url: API, chains: [SEPOLIA] }, health: "ok" });
    await render(deskPage, "/paypal/desk/", "en");
    const view = document.querySelector(".view-desk");
    expect(view?.getAttribute("data-desk")).toBe("no-wallet");
    expect(view?.querySelector("[data-action=connect]")?.textContent).toBe("Connect wallet");
    const row = view?.querySelector(".desk-foot li");
    expect(row?.getAttribute("data-lamp")).toBe("ok");
    expect(row?.textContent).toBe("PayLink APIOnline · 0.1.0");
  });

  it("says unreachable when the API fails or answers something else, and ignores an API for another chain", async () => {
    stubNetwork({ api: { url: API, chains: [SEPOLIA] }, health: "down" });
    await render(deskPage, "/paypal/desk/", "en");
    expect(document.querySelector(".view-desk .desk-foot li")?.getAttribute("data-lamp")).toBe("err");
    document.body.replaceChildren();
    stubNetwork({ api: { url: API, chains: [SEPOLIA] }, health: "unreachable" });
    await render(deskPage, "/paypal/desk/", "fr");
    expect(document.querySelector(".view-desk .desk-foot li")?.textContent).toBe("API PayLinkInjoignable");
    expect(apiUrl({ config: { version: 1, banner: null, relayer: null, indexer: null, api: { url: API, chains: [84532] }, rpc: {} } })).toBeNull();
    expect(apiUrl({ config: { version: 1, banner: null, relayer: null, indexer: null, rpc: {} } })).toBeNull();
  });
});

describe.each(LOCALES)("PayPal routes in %s", (locale) => {
  it.each(ROUTES)("%s renders in the edition's frame", async (_name, page, path) => {
    await render(page, path, locale);
    expect(document.querySelector("header.top .edition-tag")?.textContent).toBe("PayPal");
    expect(document.querySelector("main#terminal")).not.toBeNull();
    expect(document.querySelector(".intro h1")?.textContent).not.toBe("");
    expect(document.body.textContent).not.toMatch(RAW_KEY);
    expect(document.querySelector("footer .foot-links a.ext")?.getAttribute("href")).toBe("https://github.com/nambininasafidison/paylink/tree/paypal");
  });
});

describe("the sandbox banner (docs/paypal/SPEC.md §14.1)", () => {
  it.each([
    ["en", "PayPal sandbox and testnets only. No real money."],
    ["fr", "Sandbox PayPal et réseaux de test uniquement. Aucun argent réel."],
    ["mg", "Sandbox PayPal sy tambajotra fitsapana ihany. Tsy misy vola tena izy."],
  ] as const)("says on every page, in %s, that no real money moves", async (locale, text) => {
    for (const [, page, path] of ROUTES) {
      document.body.replaceChildren();
      await render(page, path, locale);
      expect([...document.querySelectorAll(".banners .banner.is-info")].map((b) => b.textContent)).toContain(text);
    }
  });
});

describe("tabs", () => {
  it("lead to create, ledger, desk and till under /paypal/", async () => {
    await render(deskPage, "/paypal/desk/", "en");
    const tabs = [...document.querySelectorAll<HTMLAnchorElement>("nav.tabs a")];
    expect(tabs.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Create", "/paypal/"],
      ["Ledger", "/paypal/ledger/"],
      ["Desk", "/paypal/desk/"],
      ["Till", "/paypal/till/"],
    ]);
    expect(tabs[2]?.getAttribute("aria-current")).toBe("page");
  });
});

describe("create, ledger and status", () => {
  it("offer the assistant above the create form", async () => {
    await render(createPage, "/paypal/", "en");
    expect(document.querySelector(".view-create [data-action=assistant]")?.textContent).toBe("Assistant");
    expect(document.querySelector(".view-create .assist-row .field-hint")?.textContent).toContain("you check it and sign");
  });

  it("show the API and PayPal rows on the Status page, from the API's health rows", async () => {
    stubNetwork({ api: { url: API, chains: [SEPOLIA] }, health: "ok" });
    await render(statusPage, "/paypal/status/", "en");
    const rows = [...document.querySelectorAll(".view-status > .vstrip")][0]?.querySelectorAll("li") ?? [];
    expect([...rows].map((li) => li.querySelector(".vstrip-name")?.textContent)).toEqual(["Relayer", "History service", "PayLink API", "PayPal sandbox", "PayPal webhook", "Assistant", "API store"]);
    expect(rows[2]?.textContent).toBe("PayLink APIOnline · 0.1.0 · contract 1");
    expect(rows[3]?.getAttribute("data-lamp")).toBe("wait");
  });
});

describe("create and status, without an API", () => {
  it("say plainly that PayLink is not deployed on Ethereum Sepolia until the registry records it", async () => {
    await render(createPage, "/paypal/", "en");
    const bands = [...document.querySelectorAll<HTMLElement>(".band")];
    expect(bands).toHaveLength(1);
    if (appRegistry("paypal").v2Target(SEPOLIA) === undefined) {
      expect(document.querySelector(".band[aria-checked=true] .band-id")?.textContent).toBe("Not deployed");
      // The deploy kit resolves `?chain=` by the registry label (web/v2/deploy/app.js): ETH is Ethereum Sepolia there.
      expect(document.querySelector(".view-create .warn-note a")?.getAttribute("href")).toBe("/deploy/?chain=eth");
    } else {
      // Recorded since 2026-10-29 (protocol/deployments/11155111.json): the band names the testnet, and no notice sends
      // the payee to the deploy kit.
      expect(document.querySelector(".band[aria-checked=true] .band-id")?.textContent).toBe("Testnet · 11155111");
      expect(document.querySelector(".view-create .warn-note")).toBeNull();
    }
  });

  it("show no relayer on the Status page, though config.json names one for other chains", async () => {
    await render(statusPage, "/paypal/status/", "en");
    const services = [...document.querySelectorAll(".view-status > .vstrip")][0];
    expect(services?.textContent).toContain("Not configured: payers use their own wallet.");
  });
});
