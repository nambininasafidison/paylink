// SPDX-License-Identifier: MIT
/**
 * The Durable Objects in workerd (src/worker/durable.ts): a test Worker exporting `Payee` and `Global` with a fetch
 * handler that runs the store script (./script.ts) through `durableStores`, i.e. Workers RPC into SQLite-backed objects
 * using `ctx.storage.kv` inside `ctx.storage.transactionSync`, is bundled with rolldown and served by `wrangler dev
 * --local` (wrangler 4.148.0, the catalog's pin, with its own workerd). Its answers must equal the in-memory stores'
 * answers to the same script, call for call. Starting workerd takes a while, so it runs on request:
 *
 *   PAYLINK_WORKERD=1 pnpm --filter @paylink/api exec vitest run test/store/workerd.test.ts
 *
 * Nothing leaves the machine: the test Worker binds no AI, no secret and no cron.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStores } from "../../src/store/memory.ts";
import { storeScript } from "./script.ts";

const enabled = process.env["PAYLINK_WORKERD"] === "1";
const API_DIR = fileURLToPath(new URL("../../", import.meta.url));

const WRANGLER_TOML = `name = "paylink-api-store-test"
main = "worker.js"
no_bundle = true
find_additional_modules = false
compatibility_date = "2026-10-01"

[[durable_objects.bindings]]
name = "PAYEE"
class_name = "Payee"

[[durable_objects.bindings]]
name = "GLOBAL"
class_name = "Global"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Payee", "Global"]
`;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

describe.skipIf(!enabled)("the Durable Objects in workerd", () => {
  let dir: string;
  let child: ChildProcess;
  let url: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "api-workerd-"));
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      [
        `import { durableStores } from ${JSON.stringify(join(API_DIR, "src/worker/durable.ts"))};`,
        `import { storeScript } from ${JSON.stringify(join(API_DIR, "test/store/script.ts"))};`,
        `export { Global, Payee } from ${JSON.stringify(join(API_DIR, "src/worker/durable.ts"))};`,
        // Only GET /run runs the script (the readiness probe must not).
        'export default { fetch: async (request, env) => (new URL(request.url).pathname === "/run" ? Response.json(await storeScript(durableStores(env))) : new Response(null, { status: 204 })) };',
      ].join("\n"),
    );
    const bundle = await rolldown({ input: entry, cwd: API_DIR, platform: "browser", external: [/^cloudflare:/u], logLevel: "warn", resolve: { conditionNames: ["@paylink/source", "workerd", "worker", "browser", "import", "default"] } });
    const { output } = await bundle.generate({ format: "es", codeSplitting: false });
    await bundle.close();
    writeFileSync(join(dir, "worker.js"), output[0].code);
    writeFileSync(join(dir, "wrangler.toml"), WRANGLER_TOML);
    const port = await freePort();
    url = `http://127.0.0.1:${String(port)}`;
    child = spawn(join(API_DIR, "node_modules/.bin/wrangler"), ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", join(dir, "state")], {
      cwd: dir,
      stdio: "ignore",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
    });
    for (let i = 0; ; i += 1) {
      try {
        await fetch(`${url}/`, { method: "HEAD" });
        return;
      } catch (error) {
        if (i > 600 || child.exitCode !== null) {
          throw error;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, 120_000);

  afterAll(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers the store script exactly as the in-memory stores do", async () => {
    const expected = JSON.parse(JSON.stringify(await storeScript(createMemoryStores()))) as unknown[];
    const response = await fetch(`${url}/run`);
    expect(response.status).toBe(200);
    const actual = (await response.json()) as unknown[];
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, i) => {
      expect(actual[i], `call ${String(i)}`).toEqual(value);
    });
  });
});
