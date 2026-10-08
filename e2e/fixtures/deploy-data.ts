// SPDX-License-Identifier: MIT
/** The deploy kit's chain data as a page receives it, for specs that need it as it was before a deployment was recorded. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import { WEB_ROOT } from "./server.ts";

/**
 * Serves data/chains.json as it was before a chain's deployment was recorded (protocol/deployments/<id>.json), so the
 * fresh-deployment flow stays covered on that chain's own gas model after the record ships. Only the page's data
 * changes; the page, the release and the registry RPC routing are the real ones.
 */
export async function withoutRecord(context: BrowserContext, chainId: number): Promise<void> {
  const raw = JSON.parse(readFileSync(join(WEB_ROOT, "v2/deploy/data/chains.json"), "utf8")) as { chains: { chainId: number; deployment: unknown }[] };
  const body = JSON.stringify({ ...raw, chains: raw.chains.map((c) => (c.chainId === chainId ? { ...c, deployment: null } : c)) });
  await context.route("**/v2/deploy/data/chains.json", async (route) => {
    await route.fulfill({ status: 200, headers: { "content-type": "application/json", "cache-control": "no-cache" }, body });
  });
}
