// SPDX-License-Identifier: MIT
/**
 * The API on Node, for e2e, local development and the judges' offline path (docs/paypal/SPEC.md §15.2 "Run without
 * keys"):
 *
 *   pnpm --filter @paylink/api start:local --origin http://127.0.0.1:5173 [--port 8788]
 *   pnpm --filter @paylink/api dev:offline --origin http://127.0.0.1:5173      (PayPal fake, recorded AI answers)
 *
 * Secrets come from the environment (names of .dev.vars.example), never from a file in the repository. Logs go to
 * stdout as JSON lines; the first line is `{"event":"listening","url":...}`.
 */
import { parseArgs } from "node:util";
import { secretsFromEnv, startNodeApi } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    origin: { type: "string", multiple: true },
    offline: { type: "boolean", default: false },
  },
});
const port = values.port === undefined ? 8788 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error("--port must be an integer in [0, 65535]");
  process.exit(2);
}
const api = await startNodeApi({
  allowedOrigins: values.origin ?? [],
  offline: values.offline,
  secrets: secretsFromEnv(process.env),
  port,
  ...(values.host === undefined ? {} : { host: values.host }),
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
