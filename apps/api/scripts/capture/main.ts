// SPDX-License-Identifier: MIT
/**
 * The owner's sandbox capture (docs/runbooks/paypal.md "Capture run"; docs/paypal/SPEC.md §15.1, D1 of §17.2), run
 * from apps/api on a machine that reaches api-m.sandbox.paypal.com:
 *
 *   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node --conditions=@paylink/source scripts/capture/main.ts \
 *     [--out paypal-capture.json] [--wait-payment 10] [--events] [--keep]
 *
 *   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node --conditions=@paylink/source scripts/capture/main.ts \
 *     subscribe --url https://paylink-api.raherizonambinina.workers.dev/v1/paypal/webhook
 *
 * The first form runs ./run.ts and writes the report (no secret, no personal data: ./report.ts). `--wait-payment N`
 * prints the payer link of one invoice and waits up to N minutes for the owner to pay it as a sandbox buyer; `--events`
 * then reads PayPal's recent `INVOICING.INVOICE.PAID` events to record their shape (needs the app's webhooks scope).
 * The second form subscribes a URL to the events PayLink acts on (P11) and prints the subscription's id once, for the
 * `PAYPAL_WEBHOOK_ID` secret; nothing is written to disk.
 *
 * Credentials come from the environment only, never from a flag or a file, and are never printed. The REST base is the
 * sandbox; `--base` accepts only a local fake (`http://127.0.0.1:…`, `http://localhost:…`) besides it, never live.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PAYPAL_SANDBOX_BASE } from "../../src/core/config.ts";
import { createLogger } from "../../src/core/log.ts";
import { isPayPalError } from "../../src/paypal/client.ts";
import { createHttpPayPalClient } from "../../src/paypal/http.ts";
import { requestIdFor } from "../../src/paypal/idempotency.ts";
import { SUBSCRIBED_EVENTS } from "../../src/paypal/types.ts";
import { runCapture } from "./run.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    "wait-payment": { type: "string" },
    events: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    base: { type: "string" },
    url: { type: "string" },
  },
});

const fail = (message: string): never => {
  console.error(`capture: ${message}`);
  process.exit(2);
};

const clientId = process.env["PAYPAL_CLIENT_ID"] ?? "";
const clientSecret = process.env["PAYPAL_CLIENT_SECRET"] ?? "";
if (clientId === "" || clientSecret === "") {
  fail("set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the environment (the sandbox app's credentials)");
}
const base = (values.base ?? PAYPAL_SANDBOX_BASE).replace(/\/+$/u, "");
if (base !== PAYPAL_SANDBOX_BASE && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/u.test(base)) {
  fail(`--base must be ${PAYPAL_SANDBOX_BASE} or a local fake; never PayPal live`);
}

const logger = createLogger({ sink: (line) => process.stderr.write(`${line}\n`), secrets: [clientId, clientSecret], minLevel: "warn" });
const paypal = createHttpPayPalClient({
  baseUrl: base,
  credentials: { clientId, clientSecret },
  transport: (input, init) => fetch(input, init),
  clock: Date.now,
  random: (n) => new Uint8Array(randomBytes(n)),
  logger,
});

if (positionals[0] === "subscribe") {
  const url = values.url ?? "";
  if (!/^https:\/\/[^\s/]+\/v1\/paypal\/webhook$/u.test(url)) {
    fail("subscribe needs --url https://<the API's host>/v1/paypal/webhook");
  }
  try {
    const hook = await paypal.createWebhook({ url, event_types: SUBSCRIBED_EVENTS.map((name) => ({ name })) }, { requestId: requestIdFor("subscribe", String(Date.now())) });
    console.log(`PAYPAL_WEBHOOK_ID=${hook.id ?? "(none returned)"}`);
    console.error("capture: set it as the Worker's secret PAYPAL_WEBHOOK_ID (dashboard: paylink-api > Settings > Variables and Secrets)");
  } catch (error) {
    fail(isPayPalError(error) ? `PayPal refused the subscription: ${String(error.status)} ${error.paypalName ?? ""} ${error.issue ?? ""}` : String(error));
  }
  process.exit(0);
}
if (positionals.length > 0) {
  fail(`unknown command ${positionals[0] ?? ""} (only "subscribe")`);
}

const waitMinutes = values["wait-payment"] === undefined ? 0 : Number(values["wait-payment"]);
if (!Number.isInteger(waitMinutes) || waitMinutes < 0 || waitMinutes > 60) {
  fail("--wait-payment takes whole minutes, 0 to 60");
}

const report = await runCapture({
  paypal,
  base: new URL(base).origin,
  hasWebhookId: (process.env["PAYPAL_WEBHOOK_ID"] ?? "") !== "",
  clock: Date.now,
  random: (n) => new Uint8Array(randomBytes(n)),
  say: (line) => {
    console.error(line);
  },
  waitForPayment:
    waitMinutes === 0
      ? null
      : async (url, invoiceId) => {
          console.error(`capture: open ${url} in a browser logged in as a sandbox buyer and pay; waiting up to ${String(waitMinutes)} min`);
          const until = Date.now() + waitMinutes * 60_000;
          while (Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 10_000));
            const invoice = await paypal.getInvoice(invoiceId).catch(() => null);
            if (invoice !== null && !["SENT", "SHARED", "UNPAID"].includes(invoice.status ?? "")) {
              return;
            }
          }
          console.error("capture: no payment seen; going on");
        },
  listEvents: values.events
    ? async (eventType) => {
        const token = await paypal.token();
        const response = await fetch(`${base}/v1/notifications/webhooks-events?event_type=${encodeURIComponent(eventType)}&page_size=10`, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" } });
        return (await response.json()) as unknown;
      }
    : null,
  keep: values.keep,
});

const out = values.out ?? `paypal-capture-${report.ranAt.replace(/[:.]/gu, "-")}.json`;
const text = `${JSON.stringify(report, null, 2)}\n`;
if (text.includes(clientSecret) || text.includes(clientId)) {
  fail("the report would contain a credential: not written (a bug; please report it)");
}
writeFileSync(out, text);
console.error(`capture: wrote ${out}`);
console.error(JSON.stringify(report.findings, null, 2));
