// SPDX-License-Identifier: MIT
/**
 * Vite multi-page build of one edition (ADR 0006, ADR 0008). `VITE_EDITION` picks the edition (`all` at the root,
 * `monad` and `base` under their own path); scripts/build.ts builds every edition and assembles the site.
 *
 * Security-relevant settings: no asset is ever inlined as a data: URI (fonts and scripts stay `'self'`); the app's
 * Content-Security-Policy is also written into every page as a `<meta>` (defence in depth if a header is lost; the
 * header adds frame-ancestors); the service worker is generated with its runtime inlined (no `importScripts` under
 * Trusted Types), precaches only this edition's own build output, has no navigation fallback, and leaves RPC, relayer,
 * indexer and `/config.json` requests to the network.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Edition } from "@paylink/chains";
import { defaultClientConditions, defineConfig } from "vite";
import type { Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { appCsp, configOrigins, DEFAULT_EDITIONS, editionBase, rpcOrigins } from "./scripts/site.ts";

const EDITIONS: readonly Edition[] = ["all", "monad", "base", "mezo"];
const edition = (process.env["VITE_EDITION"] ?? "all") as Edition;
if (!EDITIONS.includes(edition)) {
  throw new Error(`VITE_EDITION must be one of ${EDITIONS.join(", ")}`);
}
const base = editionBase(edition);
const e2eChains = process.env["PAYLINK_E2E_CHAINS"] ?? null;

const PAGES: Readonly<Record<string, string>> = {
  create: "index.html",
  pay: "pay/index.html",
  receipt: "r/index.html",
  ledger: "ledger/index.html",
  send: "send/index.html",
  till: "till/index.html",
  status: "status/index.html",
  notfound: "404.html",
};

function gitCommit(): string {
  const fromPages = process.env["CF_PAGES_COMMIT_SHA"];
  if (fromPages !== undefined && /^[0-9a-f]{40}$/.test(fromPages)) {
    return fromPages;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

const version = (JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * The app's CSP as a `<meta>` in every page (same policy as `_headers`, minus frame-ancestors), placed right after
 * `<meta charset>`: a meta policy governs only what is parsed after it, so it must precede every script and style.
 */
function cspMeta(): Plugin {
  const editions = DEFAULT_EDITIONS.includes(edition) ? DEFAULT_EDITIONS : [...DEFAULT_EDITIONS, edition];
  const policy = appCsp([...rpcOrigins(editions), ...configOrigins()], true);
  const charset = '<meta charset="utf-8">';
  return {
    name: "paylink:csp-meta",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) => {
        if (!html.includes(charset)) {
          throw new Error("every page must declare <meta charset=\"utf-8\"> first");
        }
        return html.replace(charset, `${charset}\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
      },
    },
  };
}

/** Preloads the two text faces (v1 did), with their hashed file names from the bundle. */
function fontPreload(): Plugin {
  const faces = [/assets\/archivo-var-latin-[\w-]+\.woff2$/, /assets\/martian-mono-400-latin-[\w-]+\.woff2$/];
  return {
    name: "paylink:font-preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (_html, context) => {
        const files = Object.keys(context.bundle ?? {});
        return faces.flatMap((face) => {
          const file = files.find((f) => face.test(f));
          return file === undefined ? [] : [{ tag: "link", attrs: { rel: "preload", href: `${base}${file}`, as: "font", type: "font/woff2", crossorigin: "" }, injectTo: "head" as const }];
        });
      },
    },
  };
}

/**
 * The passkey relying party ID (PAYLINK-V2-SPEC §3.11, FACTS 2026-10-07): fixed for production builds, so a PayLink key
 * is created and used only on https://paylink-mg.pages.dev itself; the page's own host for `vite dev` and end-to-end
 * builds (127.0.0.1 under Playwright's virtual authenticator).
 */
export const PRODUCTION_RP_ID = "paylink-mg.pages.dev";

export default defineConfig(({ command }) => ({
  base,
  resolve: { conditions: ["@paylink/source", ...defaultClientConditions] },
  define: {
    __PAYLINK_EDITION__: JSON.stringify(edition),
    __PAYLINK_E2E_CHAINS__: JSON.stringify(e2eChains),
    __PAYLINK_RP_ID__: JSON.stringify(command === "build" && e2eChains === null ? PRODUCTION_RP_ID : null),
    __PAYLINK_BUILD__: JSON.stringify({ version, commit: gitCommit() }),
  },
  build: {
    outDir: `${process.env["PAYLINK_OUT"] ?? "dist"}${edition === "all" ? "" : `/${edition}`}`,
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    manifest: ".vite/manifest.json",
    sourcemap: false,
    // PAYLINK_ANALYZE=1 keeps module boundaries (`//#region` markers) for bundle analysis.
    minify: process.env["PAYLINK_ANALYZE"] === undefined,
    reportCompressedSize: false,
    rollupOptions: { input: Object.fromEntries(Object.entries(PAGES).map(([name, file]) => [name, new URL(file, import.meta.url).pathname])) },
  },
  plugins: [
    cspMeta(),
    fontPreload(),
    VitePWA({
      strategies: "generateSW",
      registerType: "prompt",
      injectRegister: null,
      filename: "sw.js",
      manifestFilename: "manifest.webmanifest",
      includeAssets: [],
      includeManifestIcons: false,
      manifest: {
        id: base,
        name: edition === "all" ? "PayLink" : `PayLink ${edition === "monad" ? "Monad" : edition === "base" ? "Base" : "Mezo"}`,
        short_name: "PayLink",
        description: "Signed dollar invoices: create, share and pay payment links, with receipts anyone can verify.",
        lang: "en",
        dir: "ltr",
        start_url: base,
        scope: base,
        display: "standalone",
        background_color: "#EEECE6",
        theme_color: "#161615",
        categories: ["finance", "business", "productivity"],
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icons/mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{html,js,css,woff2,svg,png,webmanifest}"],
        globIgnores: ["arc/**", "deploy/**", "v2/**", "monad/**", "base/**", "mezo/**", ".vite/**", "404.html"],
        navigateFallback: null,
        inlineWorkboxRuntime: true,
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        directoryIndex: "index.html",
        ignoreURLParametersMatching: [/^chain$/, /^preset$/, /^utm_/],
        dontCacheBustURLsMatching: /\/assets\/.+-[\w-]{8,}\./,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [],
        sourcemap: false,
        mode: "production",
      },
      devOptions: { enabled: false },
    }),
  ],
}));
