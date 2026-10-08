// SPDX-License-Identifier: MIT
/**
 * Production build of the whole site into apps/web/dist (docs/runbooks/cloudflare-pages.md):
 *
 *   1. one Vite build per edition (`all` at the root, then `monad` and `base` under their paths);
 *   2. assembly: the frozen v1 app under /arc/, the deploy kit under /deploy/ and /v2/deploy/, `_headers`;
 *   3. gates: `public/_headers` is up to date, the pay route stays within 110 kB of gzipped JavaScript
 *      (PAYLINK-V2-SPEC §4.4), no end-to-end hook is left in the bundle, and no source map is shipped.
 *
 * Usage (from apps/web):  node --conditions=@paylink/source scripts/build.ts
 *   PAYLINK_EDITIONS=all,monad   editions to build (default all,monad,base)
 *   PAYLINK_E2E_CHAINS=<json>    end-to-end builds only: requires --e2e and writes dist-e2e/ instead
 *   PAYLINK_E2E_OUT=dist-e2e-x   end-to-end builds only: the output folder (default dist-e2e)
 */
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Edition } from "@paylink/chains";
import { build } from "vite";
import { APP_DIR, assemble, DEFAULT_EDITIONS, editionBase, PUBLIC, renderHeaders } from "./site.ts";

export const PAY_ROUTE_BUDGET_BYTES = 110_000;
const E2E_MARKER = "e2e-local";

interface ManifestChunk {
  readonly file: string;
  readonly imports?: readonly string[];
  readonly isEntry?: boolean;
}

/** Gzipped bytes of an HTML entry's JavaScript: its chunk and every static import, transitively (dynamic imports excluded). */
export function entryJsBytes(dist: string, manifestPath: string, entry: string): number {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestChunk>;
  const seen = new Set<string>();
  const visit = (key: string): void => {
    const chunk = manifest[key];
    if (chunk === undefined || seen.has(chunk.file)) {
      return;
    }
    seen.add(chunk.file);
    for (const dependency of chunk.imports ?? []) {
      visit(dependency);
    }
  };
  visit(entry);
  if (seen.size === 0) {
    throw new Error(`manifest has no entry ${entry}`);
  }
  return [...seen].filter((f) => f.endsWith(".js")).reduce((sum, file) => sum + gzipSync(readFileSync(join(dist, file)), { level: 9 }).length, 0);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const e2e = argv.includes("--e2e");
  if (process.env["PAYLINK_E2E_CHAINS"] !== undefined && !e2e) {
    throw new Error("PAYLINK_E2E_CHAINS is set: production builds refuse end-to-end chain overrides (pass --e2e for a test build)");
  }
  const editions = (process.env["PAYLINK_EDITIONS"]?.split(",").map((e) => e.trim()) ?? [...DEFAULT_EDITIONS]) as Edition[];
  if (editions[0] !== "all") {
    throw new Error("the first edition must be `all` (it is served at the root)");
  }
  const headers = renderHeaders();
  if (readFileSync(join(PUBLIC, "_headers"), "utf8") !== headers && editions.join() === DEFAULT_EDITIONS.join()) {
    throw new Error("apps/web/public/_headers is stale: run `pnpm --filter @paylink/web run headers` and commit it");
  }
  // End-to-end builds may name their own folder (dist-e2e-<suite>), so suites with different chain overrides coexist.
  const e2eOut = process.env["PAYLINK_E2E_OUT"] ?? "dist-e2e";
  if (e2e && !/^dist-e2e(-[a-z]+)?$/.test(e2eOut)) {
    throw new Error("PAYLINK_E2E_OUT must be dist-e2e or dist-e2e-<name>");
  }
  const outName = e2e ? e2eOut : "dist";
  const DIST = join(APP_DIR, outName);
  process.env["PAYLINK_OUT"] = outName;
  for (const edition of editions) {
    process.env["VITE_EDITION"] = edition;
    // "native": Node imports the config itself, with this process's @paylink/source condition and type stripping.
    await build({ configFile: join(APP_DIR, "vite.config.ts"), configLoader: "native", mode: "production", logLevel: "warn" });
  }
  assemble(DIST, editions);
  for (const edition of editions) {
    const out = edition === "all" ? DIST : join(DIST, edition);
    const bytes = entryJsBytes(out, join(out, ".vite/manifest.json"), "pay/index.html");
    console.log(`${editionBase(edition)}pay/: ${(bytes / 1000).toFixed(1)} kB gzipped JavaScript (budget ${String(PAY_ROUTE_BUDGET_BYTES / 1000)} kB)`);
    if (bytes > PAY_ROUTE_BUDGET_BYTES) {
      throw new Error(`the pay route of edition ${edition} is over budget`);
    }
    rmSync(join(out, ".vite"), { recursive: true, force: true });
  }
  for (const file of files(DIST)) {
    const rel = relative(DIST, file);
    if (rel.endsWith(".map")) {
      throw new Error(`source map shipped: ${rel}`);
    }
    if (!e2e && rel.endsWith(".js") && !rel.startsWith("arc/") && readFileSync(file, "utf8").includes(E2E_MARKER)) {
      throw new Error(`end-to-end hook left in ${rel}`);
    }
  }
  console.log(`site assembled in ${relative(process.cwd(), DIST) || "."}: ${String(files(DIST).length)} files`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
