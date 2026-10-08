// SPDX-License-Identifier: MIT
/**
 * Every route renders in every language without a wallet and without a network: the frame (skip link, top bar,
 * terminal, footer), the page's own view, a translated title, and no untranslated key on screen. Network reads fail
 * here on purpose, so pages must show their "could not check" state instead of throwing. The flows themselves run
 * end to end in e2e/specs/app.spec.ts.
 */
import "fake-indexeddb/auto";
import { LOCALES } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/app/boot.ts";
import type { PageDefinition } from "../src/app/boot.ts";
import { prefs } from "../src/core/prefs.ts";
import { createPage } from "../src/pages/create.ts";
import { ledgerPage } from "../src/pages/ledger.ts";
import { notFoundPage } from "../src/pages/notfound.ts";
import { payPage } from "../src/pages/pay.ts";
import { receiptPage } from "../src/pages/receipt.ts";
import { sendPage } from "../src/pages/send.ts";
import { statusPage } from "../src/pages/status.ts";
import { tillPage } from "../src/pages/till.ts";

const ROUTES: readonly (readonly [string, PageDefinition, string])[] = [
  ["create", createPage, "/"],
  ["create (receive card preset)", createPage, "/?preset=card&chain=arb"],
  ["pay (empty)", payPage, "/pay/"],
  ["pay (tampered link)", payPage, "/pay/#2.10143.AAAA"],
  ["receipt (empty)", receiptPage, "/r/"],
  ["receipt (tampered link)", receiptPage, "/r/#2.10143.0x00.1"],
  ["ledger", ledgerPage, "/ledger/"],
  ["send", sendPage, "/send/"],
  ["till", tillPage, "/till/"],
  ["status", statusPage, "/status/"],
  ["not found", notFoundPage, "/nope/"],
];

/** A dotted lower-case key such as `pay.voice.bill.h1a` showing through untranslated. */
const RAW_KEY = /\b(app|create|pay|receipt|ledger|send|till|status|verify|share|ticket|wallet|chain|error|common|details|notFound)\.[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)*\b/;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/config.json")) {
        return Promise.resolve(new Response(JSON.stringify({ version: 1, banner: { level: "info", text: { en: "Testnet only." } }, relayer: null, indexer: null, rpc: {} }), { status: 200 }));
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
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://paylink-mg.pages.dev${path}`);
  await boot(page);
  // Let pending chain reads settle into their "could not check" states.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe.each(LOCALES)("routes in %s", (locale) => {
  it.each(ROUTES)("%s renders the frame and its view", async (_name, page, path) => {
    await render(page, path, locale);
    expect(document.documentElement.lang).not.toBe("");
    expect(document.title).toMatch(/ · PayLink$/);
    expect(document.querySelector("a.skip")?.getAttribute("href")).toBe("#terminal");
    expect(document.querySelector("header.top .brand")).not.toBeNull();
    expect(document.querySelector("main#terminal")).not.toBeNull();
    expect(document.querySelector("footer.foot")).not.toBeNull();
    expect(document.querySelector(".views")?.children.length).toBeGreaterThan(0);
    expect(document.querySelector(".intro h1")?.textContent).not.toBe("");
    expect(document.body.textContent).not.toMatch(RAW_KEY);
    // The incident banner from /config.json is shown on every page.
    expect(document.querySelector(".banner")?.textContent).toContain("Testnet only.");
  });
});

describe("payer pages", () => {
  it("refuse a tampered link with its support code, and offer to paste the full one", async () => {
    await render(payPage, "/pay/#2.10143.AAAA", "en");
    expect(document.querySelector(".status.err")?.textContent).toMatch(/Error code E_/);
    expect(document.querySelector("#paste")).not.toBeNull();
    expect(document.querySelector("#plate")?.textContent).not.toBe("");
  });

  it("have no mode switch: the payer never sees the seller's tabs", async () => {
    await render(payPage, "/pay/", "en");
    expect(document.querySelector("nav.tabs")).toBeNull();
    await render(createPage, "/", "en");
    expect(document.querySelectorAll("nav.tabs a")).toHaveLength(4);
    expect(document.querySelector("nav.tabs a[aria-current=page]")?.getAttribute("href")).toBe("/");
  });
});

describe("create terminal", () => {
  it("offers only the edition's chains, and names the ones without a deployment", async () => {
    await render(createPage, "/?chain=arb", "en");
    const bands = [...document.querySelectorAll<HTMLElement>(".band")];
    expect(bands.map((b) => b.querySelector(".band-label")?.textContent)).toEqual(["MONAD", "BASE", "ARB"]);
    expect(document.querySelector(".band[aria-checked=true] .band-label")?.textContent).toBe("ARB");
  });

  it("presets a receive card: unlimited payments, no expiry, which must be confirmed", async () => {
    await render(createPage, "/?preset=card", "en");
    expect(document.querySelector<HTMLInputElement>("input[name=payments][value=unlimited]")?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>("input[name=expiry][value=never]")?.checked).toBe(true);
    expect(document.querySelector<HTMLLabelElement>("label.check")?.hidden).toBe(false);
  });
});
