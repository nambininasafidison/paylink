// SPDX-License-Identifier: MIT
/**
 * Submission artwork (docs/submissions/README.md), rendered by Chromium from the sources in packages/design/brand/:
 *
 * - `logo-1024.png` and `logo-512.png`: the master mark (`mark.svg`), transparent corners;
 * - `social-card.png`: the 1200 × 630 card (`social-card.html`), with the pay screenshot in a phone;
 * - `screen-N-*.png`: each product screenshot of `01-screens.spec.ts` in a 390 px phone frame (`frame.html`), with its
 *   title and its provenance (production build, local fork, fork block) burned in under it.
 *
 * Offline: the repository is served at a placeholder origin through request routing, so the fonts and pictures load
 * as same-origin files. The screenshots must exist (run `01-screens.spec.ts` first, or keep the committed ones).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { REPO } from "../fixtures/server.ts";

const OUT = join(REPO, "docs/submissions/assets");
const ARTWORK = "https://artwork.paylink.invalid";
const BRAND = `${ARTWORK}/packages/design/brand`;
const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** The repository as a read-only site (only the brand sources, the fonts and the screenshots are ever asked for). */
async function serveRepo(page: Page): Promise<void> {
  await page.route(`${ARTWORK}/**`, async (route: Route) => {
    const path = normalize(join(REPO, decodeURIComponent(new URL(route.request().url()).pathname)));
    if (!path.startsWith(REPO + sep) || !existsSync(path) || !statSync(path).isFile()) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    await route.fulfill({ status: 200, headers: { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }, body: readFileSync(path) });
  });
}

interface Capture {
  readonly forks: Readonly<Record<string, { readonly block: string }>>;
  readonly captured: string;
  readonly screens: readonly { readonly file: string; readonly what: string }[];
}

const FRAMES = [
  { file: "screen-1-monad-create.png", edition: "Monad edition", chain: "10143", title: "Create: an invoice signed with a passkey, no gas" },
  { file: "screen-2-monad-pay.png", edition: "Monad edition", chain: "10143", title: "Pay: one fingerprint approves exactly this" },
  { file: "screen-3-monad-receipt.png", edition: "Monad edition", chain: "10143", title: "Receipt: re-verified on chain at every opening" },
  { file: "screen-4-monad-till.png", edition: "Monad edition", chain: "10143", title: "Till: lights only for this invoice's payment" },
  { file: "screen-5-base-pay.png", edition: "Base edition", chain: "84532", title: "Base: gasless USDC with one wallet signature" },
] as const;
const NETWORK: Readonly<Record<string, string>> = { "10143": "Monad testnet", "84532": "Base Sepolia" };

test("logo, social card and framed screenshots", async ({ page }) => {
  await serveRepo(page);
  const capture = JSON.parse(readFileSync(join(OUT, "capture.json"), "utf8")) as Capture;

  // The logo, at 1024 and 512 px, transparent outside the tile.
  for (const size of [1024, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.goto(`${BRAND}/frame.html`);
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><img src="${BRAND}/mark.svg" width="${String(size)}" height="${String(size)}" alt="" style="display:block"></body></html>`);
    await page.locator("img").evaluate(async (img: HTMLImageElement) => {
      await img.decode();
    });
    await page.screenshot({ path: join(OUT, `logo-${String(size)}.png`), omitBackground: true });
  }

  // The social card.
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto(`${BRAND}/social-card.html`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map(async (img) => {
        await img.decode();
      }),
    );
  });
  expect(await page.evaluate(() => document.fonts.check("640 58px Archivo") && document.fonts.check("400 15px 'Martian Mono'"))).toBe(true);
  await page.screenshot({ path: join(OUT, "social-card.png") });

  // Each screenshot in a phone frame, with its provenance under it.
  await page.setViewportSize({ width: 1080, height: 2160 });
  const day = capture.captured.slice(0, 10);
  for (const frame of FRAMES) {
    const block = capture.forks[frame.chain]?.block;
    if (block === undefined || !capture.screens.some((s) => s.file === `screens/${frame.file}`)) {
      throw new Error(`run capture/01-screens.spec.ts first: ${frame.file} is not in capture.json`);
    }
    await page.goto(`${BRAND}/frame.html`);
    await page.evaluate(
      async ({ src, edition, title, provenance }) => {
        const set = (id: string, text: string): void => {
          const element = document.getElementById(id);
          if (element !== null) {
            element.textContent = text;
          }
        };
        set("edition", edition);
        set("title", title);
        set("provenance", provenance);
        const img = document.getElementById("shot") as HTMLImageElement;
        img.src = src;
        await img.decode();
        await document.fonts.ready;
      },
      {
        src: `${ARTWORK}/docs/submissions/assets/screens/${frame.file}`,
        edition: frame.edition,
        title: frame.title,
        provenance: `Production build of paylink-mg.pages.dev against a local fork of ${NETWORK[frame.chain] ?? frame.chain} (block ${Number(block).toLocaleString("en-US")}), ${day}. What it shows as sent exists only on that fork; on-screen timings are the fork's.`,
      },
    );
    await page.screenshot({ path: join(OUT, frame.file) });
  }
});
