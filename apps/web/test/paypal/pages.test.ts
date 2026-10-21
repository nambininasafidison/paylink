// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's shell (`/paypal/`, ADR 0018) renders in every language without a wallet and without a network:
 * the edition tag, its four tabs with the desk, Ethereum Sepolia alone ("Not deployed" until the registry records
 * PayLinkV2 there), the desk's "coming" placeholder with the API's health row, the Status page without a relayer, and
 * the footer's source link to the branch paypal. Runs with `__PAYLINK_EDITION__ = "paypal"` (vitest project "paypal").
 */
import "fake-indexeddb/auto";
import { LOCALES } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../../src/app/boot.ts";
import type { PageDefinition } from "../../src/app/boot.ts";
import { prefs } from "../../src/core/prefs.ts";
import { appRegistry } from "../../src/core/registry.ts";
import { edition } from "../../src/editions/index.ts";
import { PAYPAL_COPY } from "../../src/editions/paypal/copy.ts";
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
    expect(PAYPAL_COPY).toEqual({});
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

describe("desk", () => {
  it("says what is coming, signs and approves nothing, and reads 'not configured' without an API in config.json", async () => {
    const calls = stubNetwork();
    await render(deskPage, "/paypal/desk/", "en");
    const view = document.querySelector(".view-desk");
    expect(view?.hasAttribute("data-coming")).toBe(true);
    expect(view?.querySelector(".pill")?.textContent).toBe("Coming");
    expect(view?.querySelectorAll(".note-list li")).toHaveLength(3);
    expect(view?.textContent).toContain("The assistant never signs and never moves money.");
    expect(view?.querySelector("button")).toBeNull();
    expect(view?.querySelector(".vstrip li")?.textContent).toBe("PayLink APINot configured");
    // Same-origin configuration and the ariary rate only: nothing else is called.
    expect(calls.filter((url) => !url.endsWith("/config.json") && !url.endsWith("/fx.json"))).toEqual([]);
  });

  it("reads the API's health when config.json names it for Ethereum Sepolia", async () => {
    stubNetwork({ api: { url: API, chains: [SEPOLIA] }, health: "ok" });
    await render(deskPage, "/paypal/desk/", "en");
    const row = document.querySelector(".view-desk .vstrip li");
    expect(row?.getAttribute("data-lamp")).toBe("ok");
    expect(row?.textContent).toBe("PayLink APIOnline · 0.1.0");
  });

  it("says unreachable when the API fails or answers something else, and ignores an API for another chain", async () => {
    stubNetwork({ api: { url: API, chains: [SEPOLIA] }, health: "down" });
    await render(deskPage, "/paypal/desk/", "en");
    expect(document.querySelector(".view-desk .vstrip li")?.getAttribute("data-lamp")).toBe("err");
    document.body.replaceChildren();
    stubNetwork({ api: { url: API, chains: [SEPOLIA] }, health: "unreachable" });
    await render(deskPage, "/paypal/desk/", "fr");
    expect(document.querySelector(".view-desk .vstrip li")?.textContent).toBe("API PayLinkInjoignable");
    expect(apiUrl({ config: { version: 1, banner: null, relayer: null, indexer: null, api: { url: API, chains: [84532] }, rpc: {} } })).toBeNull();
    expect(apiUrl({ config: { version: 1, banner: null, relayer: null, indexer: null, rpc: {} } })).toBeNull();
  });
});

describe("create and status", () => {
  it("say plainly that PayLink is not deployed on Ethereum Sepolia until the registry records it", async () => {
    await render(createPage, "/paypal/", "en");
    const bands = [...document.querySelectorAll<HTMLElement>(".band")];
    expect(bands).toHaveLength(1);
    if (appRegistry("paypal").v2Target(SEPOLIA) === undefined) {
      expect(document.querySelector(".band[aria-checked=true] .band-id")?.textContent).toBe("Not deployed");
      // The deploy kit resolves `?chain=` by the registry label (web/v2/deploy/app.js): ETH is Ethereum Sepolia there.
      expect(document.querySelector(".view-create .warn-note a")?.getAttribute("href")).toBe("/deploy/?chain=eth");
    }
  });

  it("show no relayer on the Status page, though config.json names one for other chains", async () => {
    await render(statusPage, "/paypal/status/", "en");
    const services = [...document.querySelectorAll(".view-status > .vstrip")][0];
    expect(services?.textContent).toContain("Not configured: payers use their own wallet.");
  });
});
