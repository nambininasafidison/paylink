// SPDX-License-Identifier: MIT
/**
 * The API on Node, for e2e, local development and the judges' offline path (docs/paypal/SPEC.md §15.2 "Run without
 * keys"):
 *
 *   pnpm --filter @paylink/api start:local --origin http://127.0.0.1:5173 [--port 8788]
 *   pnpm --filter @paylink/api dev:offline --origin http://127.0.0.1:5173      (PayPal fake, recorded AI answers)
 *
 * Offline only, for the end-to-end suites (src/node/server.ts): `--local-chain '<json>'` (an anvil fork of Ethereum
 * Sepolia with PayLinkV2 at its release address: `{"forkUrl", "deployment": {"address", "txHash", "blockNumber",
 * "deployer"}}`) and `--payer-origin <origin>` (the origin of the fake's payer pages). `--cron-seconds 0` turns the
 * Worker's minute cron off (it runs every 60 seconds by default, as deployed).
 *
 * Secrets come from the environment (names of .dev.vars.example), never from a file in the repository. Logs go to
 * stdout as JSON lines; the first line is `{"event":"listening","url":...}`.
 */
import { parseArgs } from "node:util";
import { parseLocalChain, secretsFromEnv, startNodeApi } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    origin: { type: "string", multiple: true },
    offline: { type: "boolean", default: false },
    "local-chain": { type: "string" },
    "payer-origin": { type: "string" },
    "cron-seconds": { type: "string", default: "60" },
  },
});
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
const port = values.port === undefined ? 8788 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  fail("--port must be an integer in [0, 65535]");
}
const cronSeconds = Number(values["cron-seconds"]);
if (!Number.isInteger(cronSeconds) || cronSeconds < 0 || cronSeconds > 3_600) {
  fail("--cron-seconds must be an integer in [0, 3600]");
}
if (!values.offline && (values["local-chain"] !== undefined || values["payer-origin"] !== undefined)) {
  fail("--local-chain and --payer-origin need --offline (the PayPal fake), never PayPal's sandbox");
}
let payerOrigin: string | undefined;
if (values["payer-origin"] !== undefined) {
  const url = new URL(values["payer-origin"]);
  if (url.origin !== values["payer-origin"]) {
    fail("--payer-origin must be an origin, such as https://www.sandbox.paypal.com");
  }
  payerOrigin = url.origin;
}
const api = await startNodeApi({
  allowedOrigins: values.origin ?? [],
  offline: values.offline,
  secrets: secretsFromEnv(process.env),
  port,
  ...(values.host === undefined ? {} : { host: values.host }),
  ...(values["local-chain"] === undefined ? {} : { localChain: parseLocalChain(values["local-chain"]) }),
  ...(payerOrigin === undefined ? {} : { payerOrigin }),
  ...(cronSeconds === 0 ? {} : { cronIntervalMs: cronSeconds * 1000 }),
  log: (line) => {
    console.log(line);
  },
});
console.log(JSON.stringify({ event: "listening", url: api.url, offline: values.offline }));
const stop = (): void => {
  void api.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
