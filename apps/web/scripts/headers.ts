// SPDX-License-Identifier: MIT
/**
 * Writes `public/_headers` (Cloudflare Pages response headers for the whole site) from scripts/site.ts, the single
 * source for every Content-Security-Policy: registry RPCs, public/config.json endpoints, the deploy kit's own policy
 * and the hashes of v1's inline scripts. The build writes the same text into dist/_headers.
 *
 * Usage (from apps/web):  node --conditions=@paylink/source scripts/headers.ts          write
 *                         node --conditions=@paylink/source scripts/headers.ts --check  exit 1 if stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC, renderHeaders } from "./site.ts";

const path = join(PUBLIC, "_headers");
const content = renderHeaders();
let current: string;
try {
  current = readFileSync(path, "utf8");
} catch {
  current = "";
}
if (current === content) {
  process.exitCode = 0;
} else if (process.argv.includes("--check")) {
  console.error("stale: apps/web/public/_headers (run: pnpm --filter @paylink/web run headers)");
  process.exitCode = 1;
} else {
  writeFileSync(path, content);
  console.log("wrote apps/web/public/_headers");
}
