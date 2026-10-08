// SPDX-License-Identifier: MIT
/**
 * The production site for Cloudflare Pages (docs/runbooks/cloudflare-pages.md), assembled into one folder:
 *
 *   /            the v2 app, edition `all`            /monad/, /base/   the v2 editions (same routes)
 *   /arc/        the frozen v1 app (web/), untouched   /deploy/          the browser deploy kit (web/v2/deploy)
 *   /v2/deploy/  the deploy kit at the URL it was first published under (kept working)
 *   /_headers    response headers for every path above (generated here, committed as public/_headers)
 *
 * Content-Security-Policy, one per area, none of them overlapping (Cloudflare applies every matching `_headers` rule
 * in order and joins duplicate headers with a comma, which would intersect two policies; the deploy kit and v1 rules
 * therefore detach the app's policy first with `! Content-Security-Policy`, the documented "detach" operator):
 *
 * - app: `script-src 'self'`, `style-src 'self'`, Trusted Types with the single `paylink-sw` policy, and `connect-src`
 *   limited to the registry RPCs of the built editions and the endpoints of public/config.json;
 * - deploy kit: exactly its own meta policy (web/v2/deploy/index.html) plus `frame-ancestors 'none'`;
 * - v1: what the frozen pages need and nothing more: their own scripts plus the SHA-256 of deploy.html's one inline
 *   script, inline styles (v1 sets `style` attributes), and `connect-src` to the RPC of web/config.js.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registry, scopeToEdition } from "@paylink/chains";
import type { Edition } from "@paylink/chains";

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = resolve(APP_DIR, "../..");
export const WEB = join(REPO, "web");
export const KIT = join(WEB, "v2/deploy");
export const PUBLIC = join(APP_DIR, "public");
export const DIST = join(APP_DIR, "dist");

/** Editions built by default, the first at the root. */
export const DEFAULT_EDITIONS: readonly Edition[] = ["all", "monad", "base"];

export function editionBase(edition: Edition): string {
  return edition === "all" ? "/" : `/${edition}/`;
}

/** Origins of every registry RPC the built editions may call (enabled chains only, as the app's registry). */
export function rpcOrigins(editions: readonly Edition[] = DEFAULT_EDITIONS): string[] {
  const origins = new Set<string>();
  for (const edition of editions) {
    for (const chain of scopeToEdition(registry, edition).chains) {
      for (const rpc of chain.rpc) {
        origins.add(new URL(rpc.url).origin);
      }
    }
  }
  return [...origins];
}

interface ConfigShape {
  readonly relayer: { readonly url: string } | null;
  readonly indexer: { readonly url: string } | null;
  readonly rpc: Readonly<Record<string, readonly string[]>>;
}

/** Origins of the endpoints in public/config.json (relayer, indexer, preferred RPCs). */
export function configOrigins(config: ConfigShape = JSON.parse(readFileSync(join(PUBLIC, "config.json"), "utf8")) as ConfigShape): string[] {
  const urls = [config.relayer?.url, config.indexer?.url, ...Object.values(config.rpc).flat()].filter((u): u is string => typeof u === "string");
  return [...new Set(urls.map((u) => new URL(u).origin))];
}

/** The app's policy; `meta` leaves out what a `<meta>` policy cannot carry (frame-ancestors). */
export function appCsp(connect: readonly string[], meta = false): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${[...connect].sort().join(" ")}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    ...(meta ? [] : ["frame-ancestors 'none'"]),
    "require-trusted-types-for 'script'",
    "trusted-types paylink-sw",
  ].join("; ");
}

/** SHA-256 sources of every inline `<script>` in the v1 pages, as CSP hash sources. */
export function v1ScriptHashes(): string[] {
  const hashes: string[] = [];
  for (const file of readdirSync(WEB).filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(join(WEB, file), "utf8");
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      hashes.push(`'sha256-${createHash("sha256").update(match[1] ?? "", "utf8").digest("base64")}'`);
    }
  }
  return hashes;
}

/** The RPC the frozen v1 app is configured with (web/config.js). */
export function v1RpcOrigin(): string {
  const config = readFileSync(join(WEB, "config.js"), "utf8");
  const rpc = /"rpc":\s*"(https:\/\/[^"]+)"/.exec(config)?.[1];
  if (rpc === undefined) {
    throw new Error("web/config.js: no https rpc");
  }
  return new URL(rpc).origin;
}

export function v1Csp(): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${v1ScriptHashes().join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${v1RpcOrigin()}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The deploy kit's own meta policy, plus frame-ancestors (web/_headers serves the same for /v2/*). */
export function deployCsp(): string {
  const html = readFileSync(join(KIT, "index.html"), "utf8");
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
  if (meta === undefined) {
    throw new Error("web/v2/deploy/index.html: no meta Content-Security-Policy");
  }
  return `${meta}; frame-ancestors 'none'`;
}

const PERMISSIONS = [
  "accelerometer=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
  "fullscreen=(self)",
  "screen-wake-lock=(self)",
  "publickey-credentials-create=(self)",
  "publickey-credentials-get=(self)",
].join(", ");

/** The `_headers` file (Cloudflare Pages syntax: a path, then indented `Name: value` lines; `! Name` detaches). */
export function renderHeaders(editions: readonly Edition[] = DEFAULT_EDITIONS): string {
  const connect = [...rpcOrigins(editions), ...configOrigins()];
  const immutable = "public, max-age=31536000, immutable";
  const lines = [
    "# Generated by apps/web/scripts/headers.ts (pnpm --filter @paylink/web run headers). Do not edit by hand.",
    "# Cloudflare Pages applies every matching rule in order; `! Name` detaches a header set by an earlier rule.",
    "# Areas: the v2 app and its editions (default), /arc/ (frozen v1), /deploy/ and /v2/deploy/ (deploy kit).",
    "/*",
    `  Content-Security-Policy: ${appCsp(connect)}`,
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: no-referrer",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Resource-Policy: same-origin",
    "  Strict-Transport-Security: max-age=63072000; includeSubDomains",
    `  Permissions-Policy: ${PERMISSIONS}`,
    "/arc/*",
    "  ! Content-Security-Policy",
    `  Content-Security-Policy: ${v1Csp()}`,
    "/deploy/*",
    "  ! Content-Security-Policy",
    `  Content-Security-Policy: ${deployCsp()}`,
    "/v2/deploy/*",
    "  ! Content-Security-Policy",
    `  Content-Security-Policy: ${deployCsp()}`,
    ...editions.flatMap((edition) => [`${editionBase(edition)}assets/*`, `  Cache-Control: ${immutable}`]),
    ...editions.flatMap((edition) => [`${editionBase(edition)}sw.js`, "  Cache-Control: no-cache"]),
    "/config.json",
    "  Cache-Control: no-cache",
    "",
  ];
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------- assembly

/** Every file of the frozen v1 app: web/ without the v2 deploy kit (web/v2/) and its headers file (web/_headers). */
export function v1Files(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(WEB, path);
      if (rel === "v2" || rel === "_headers") {
        continue;
      }
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        files.push(rel);
      }
    }
  };
  walk(WEB);
  return files.sort();
}

/**
 * The deploy kit's page, served from /deploy/ and /v2/deploy/: identical except that its two links to v1's stylesheet
 * and fonts (`../../paylink.css`, `../../fonts/`) point at the copy under /arc/. Every other kit file is copied as is.
 */
export function kitIndexHtml(): string {
  const html = readFileSync(join(KIT, "index.html"), "utf8");
  const rewritten = html.replaceAll('href="../../paylink.css"', 'href="/arc/paylink.css"').replaceAll('href="../../fonts/', 'href="/arc/fonts/');
  if (rewritten.includes("../../")) {
    throw new Error("web/v2/deploy/index.html links another ../../ path: update kitIndexHtml()");
  }
  return rewritten;
}

function copyTree(from: string, to: string, skip: (rel: string) => boolean = () => false): void {
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(from, path);
      if (skip(rel)) {
        continue;
      }
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        mkdirSync(dirname(join(to, rel)), { recursive: true });
        cpSync(path, join(to, rel));
      }
    }
  };
  walk(from);
}

/** Adds v1 and the deploy kit to a built `dist/`, writes `_headers`, and removes per-edition copies of root-only files. */
export function assemble(dist: string = DIST, editions: readonly Edition[] = DEFAULT_EDITIONS): void {
  for (const area of ["arc", "deploy", "v2"]) {
    rmSync(join(dist, area), { recursive: true, force: true });
  }
  for (const file of v1Files()) {
    mkdirSync(dirname(join(dist, "arc", file)), { recursive: true });
    cpSync(join(WEB, file), join(dist, "arc", file));
  }
  for (const target of [join(dist, "deploy"), join(dist, "v2/deploy")]) {
    copyTree(KIT, target, (rel) => rel === "index.html");
    writeFileSync(join(target, "index.html"), kitIndexHtml());
  }
  for (const edition of editions.filter((e) => e !== "all")) {
    for (const rootOnly of ["_headers", "_redirects", "config.json", "robots.txt"]) {
      rmSync(join(dist, edition, rootOnly), { force: true });
    }
  }
  writeFileSync(join(dist, "_headers"), renderHeaders(editions));
  if (!existsSync(join(dist, "index.html")) || !existsSync(join(dist, "404.html"))) {
    throw new Error("dist/ lacks the root edition (index.html, 404.html)");
  }
}
