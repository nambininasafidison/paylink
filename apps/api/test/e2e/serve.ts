// SPDX-License-Identifier: MIT
/**
 * The API of the L3 suite's injection case (e2e/specs/paypal-rails.spec.ts): the offline Node entry with the options of
 * `src/node/main.ts --offline` (the PayPal fake, an anvil fork of Ethereum Sepolia, the payer pages' origin), and the
 * obedient model of ./obedient.ts standing in for the Workers AI binding, so the desk's real provider, agent, grounding
 * and fence face a model that tries to act on every injected instruction. Each request the model receives is appended
 * to `--ai-log` as one JSON line `{ model, inputs }`, for the suite's AI-7 check. Test code: the Worker never bundles
 * it (scripts/build.ts bundles src/worker/ only).
 *
 *   node --conditions=@paylink/source test/e2e/serve.ts --port <n> --origin <site> --local-chain '<json>' \
 *     --payer-origin https://www.sandbox.paypal.com --ai-log <file>
 *
 * The first line on stdout is `{"event":"listening","url":...}`, as main.ts prints it.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseLocalChain, startNodeApi } from "../../src/node/server.ts";
import { obedientModel } from "./obedient.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    origin: { type: "string", multiple: true },
    "local-chain": { type: "string" },
    "payer-origin": { type: "string" },
    "ai-log": { type: "string" },
  },
});
const port = Number(values.port ?? "0");
const log = values["ai-log"];
if (!Number.isInteger(port) || values["local-chain"] === undefined || values["payer-origin"] === undefined || log === undefined) {
  throw new Error("serve.ts needs --port, --local-chain, --payer-origin and --ai-log");
}
writeFileSync(log, "");
const api = await startNodeApi({
  allowedOrigins: values.origin ?? [],
  offline: true,
  port,
  localChain: parseLocalChain(values["local-chain"]),
  payerOrigin: new URL(values["payer-origin"]).origin,
  aiBinding: obedientModel((model, inputs) => {
    appendFileSync(log, `${JSON.stringify({ model, inputs })}\n`);
  }),
  log: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
process.stdout.write(`${JSON.stringify({ event: "listening", url: api.url, offline: true, ai: "obedient" })}\n`);
const stop = (): void => {
  void api.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
