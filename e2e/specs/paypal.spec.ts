// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's shell (`/paypal/`, docs/paypal/SPEC.md §6.4 with the decisions of 2026-10-21, ADR 0018) on its
 * production build under its real `_headers`, with the edition's API (apps/api's Node entry, offline) behind the
 * production API origin of `/config.json` (fixtures/paypal.ts):
 *
 * - Headers: `/paypal/` under a policy of its own whose `connect-src` is exactly Ethereum Sepolia's RPC and the API; the
 *   root's policy has neither; the manifest and the service worker are scoped to `/paypal/`.
 * - The four tabs (create, ledger, desk, till); the desk is a "coming" placeholder whose only live part is the API's
 *   health, read through the CSP and the API's own CORS allowlist; no CSP violation under Trusted Types.
 * - Create offers Ethereum Sepolia alone and says PayLinkV2 is not deployed there yet (the owner deploys it later).
 * - Desk and create in EN, FR and MG, light and dark, at 320 px: axe-core WCAG 2.2 AA zero violations, no sideways scroll.
 */
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { axe } from "../fixtures/axe.ts";
import { horizontalOverflow, setLocale } from "../fixtures/layout.ts";
import { servePages } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { API_ORIGIN, buildPaypalSite, routeApi, SEPOLIA_RPC, startApi } from "../fixtures/paypal.ts";
import type { LocalApi } from "../fixtures/paypal.ts";

let server: StaticServer;
let api: LocalApi;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  server = await servePages(await buildPaypalSite());
  api = await startApi(server.origin);
});

test.afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.close().catch(() => undefined);
  }
});

test.afterAll(async () => {
  await api.stop();
  await server.close();
});

async function open(browser: Browser, options: { phone?: boolean; scheme?: "light" | "dark" } = {}): Promise<{ page: Page; problems: string[]; calls: { method: string; path: string; status: number }[] }> {
  const context = await browser.newContext({
    viewport: options.phone === true ? { width: 320, height: 720 } : { width: 1280, height: 900 },
    colorScheme: options.scheme ?? "light",
  });
  contexts.push(context);
  const calls = await routeApi(context, api);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_CONNECTION_REFUSED")) {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations?: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return { page, problems, calls };
}

const violations = async (page: Page): Promise<string[]> => await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []);

test("serves /paypal/ under a policy of its own: Ethereum Sepolia's RPC and the API, nothing else; the root's has neither", async ({ request }) => {
  for (const path of ["/paypal/", "/paypal/desk/"]) {
    const response = await request.get(`${server.origin}${path}`);
    expect(response.status(), path).toBe(200);
    const csp = response.headers()["content-security-policy"] ?? "";
    expect(csp, path).not.toContain(",");
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1]?.split(" ") ?? [];
    expect(new Set(connect), path).toEqual(new Set(["'self'", SEPOLIA_RPC, API_ORIGIN]));
    expect(csp, path).toContain("require-trusted-types-for 'script'");
  }
  const root = (await request.get(`${server.origin}/`)).headers()["content-security-policy"] ?? "";
  expect(root).not.toContain(API_ORIGIN);
  expect(root).not.toContain(SEPOLIA_RPC);
  // The desk exists in the PayPal edition only.
  expect((await request.get(`${server.origin}/desk/`)).status()).toBe(404);
  const manifest = (await (await request.get(`${server.origin}/paypal/manifest.webmanifest`)).json()) as { name: string; scope: string; start_url: string };
  expect(manifest).toMatchObject({ name: "PayLink PayPal", scope: "/paypal/", start_url: "/paypal/" });
});

test("shows the four tabs and the desk's placeholder, and reads the API's health through the CSP and the API's CORS", async ({ browser }) => {
  const { page, problems, calls } = await open(browser);
  await page.goto(`${server.origin}/paypal/desk/`);
  await expect(page.locator("header.top .edition-tag")).toHaveText("PayPal");
  await expect(page.locator("nav.tabs a")).toHaveText(["Create", "Ledger", "Desk", "Till"]);
  await expect(page.locator("nav.tabs a[aria-current=page]")).toHaveText("Desk");
  const view = page.locator(".view-desk");
  await expect(view).toHaveAttribute("data-coming", "");
  await expect(view.locator(".pill")).toHaveText("Coming");
  await expect(view.locator(".note-list li")).toHaveCount(3);
  await expect(view.locator("button")).toHaveCount(0);
  // The API answers; "degraded" (amber) while its stores are the scaffold's stubs, green once they read.
  const row = view.locator(".vstrip > li");
  await expect(row).toHaveAttribute("data-lamp", /^(ok|wait)$/);
  await expect(row).toContainText("Online · 0.1.0");
  expect(calls).toEqual([{ method: "GET", path: "/v1/health", status: 200 }]);
  for (const route of ["/paypal/", "/paypal/ledger/", "/paypal/till/", "/paypal/status/"]) {
    await page.goto(`${server.origin}${route}`);
    await expect(page.locator("main#terminal")).toBeVisible();
    await page.waitForTimeout(300);
  }
  expect(await violations(page)).toEqual([]);
  expect(problems).toEqual([]);
  await expect(page.locator("footer .foot-links a.ext")).toHaveAttribute("href", "https://github.com/nambininasafidison/paylink/tree/paypal");
});

test("offers Ethereum Sepolia alone and says PayLinkV2 is not deployed there yet", async ({ browser }) => {
  const { page } = await open(browser);
  await page.goto(`${server.origin}/paypal/`);
  await expect(page.locator(".band")).toHaveCount(1);
  await expect(page.locator(".band[aria-checked=true] .band-id")).toHaveText("Not deployed");
  await expect(page.locator(".view-create .warn-note a")).toHaveAttribute("href", "/deploy/?chain=eth");
});

for (const locale of ["en", "fr", "mg"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`desk and create pass axe at 320 px in ${locale}, ${scheme}`, async ({ browser }) => {
      const { page } = await open(browser, { phone: true, scheme });
      await page.goto(`${server.origin}/paypal/desk/`);
      await setLocale(page, locale);
      for (const route of ["/paypal/desk/", "/paypal/"]) {
        await page.goto(`${server.origin}${route}`);
        await expect(page.locator("main#terminal")).toBeVisible();
        if (route === "/paypal/desk/") {
          await expect(page.locator(".view-desk .vstrip > li")).toHaveAttribute("data-lamp", /^(ok|wait)$/);
        }
        expect(await axe(page), `${route} ${locale} ${scheme}`).toEqual([]);
        expect(await horizontalOverflow(page), `${route} ${locale} ${scheme}`).toBeLessThanOrEqual(0);
      }
    });
  }
}
