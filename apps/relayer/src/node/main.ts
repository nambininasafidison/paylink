// SPDX-License-Identifier: MIT
/**
 * Local relayer for demo recording and manual e2e against anvil:
 *
 *   RELAYER_PK=<an anvil test key> pnpm --filter @paylink/relayer start:local --config local.json
 *
 * The config describes local chains only (see `localChainsFromJson`); the key comes from the environment, never
 * from the config file. Logs go to stdout as JSON lines.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createRegistry } from "@paylink/chains";
import { localChainsFromJson } from "./local-config.ts";
import { startNodeRelayer } from "./server.ts";

const { values } = parseArgs({ options: { config: { type: "string" }, port: { type: "string" } } });
if (values.config === undefined) {
  console.error("usage: start:local --config <local.json> [--port 8787]   (RELAYER_PK in the environment)");
  process.exit(2);
}
const privateKey = process.env["RELAYER_PK"];
if (privateKey === undefined) {
  console.error("RELAYER_PK is not set (use one of anvil's public test keys)");
  process.exit(2);
}
const config = localChainsFromJson(JSON.parse(readFileSync(values.config, "utf8")) as unknown);
const relayer = await startNodeRelayer({
  registry: createRegistry(config.chains),
  privateKey,
  port: Number(values.port ?? config.port ?? 8787),
  allowedOrigins: config.allowedOrigins,
  log: (line) => {
    console.log(line);
  },
});
console.log(JSON.stringify({ event: "listening", url: relayer.url }));
const stop = (): void => {
  void relayer.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
