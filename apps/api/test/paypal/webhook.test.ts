// SPDX-License-Identifier: MIT
/**
 * POST /v1/paypal/webhook (src/routes/webhook.ts, docs/paypal/SPEC.md §7.5) end to end in process: the PayPal fake
 * delivers signed events to the API's app, the route asks PayPal (the fake) to verify them (P10), records the event id,
 * reads the invoice (P5) and plans the twin's reconciliation. A forged or replayed webhook changes nothing (§3.2
 * "PayPal payment"); a webhook body never decides anything.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/core/app.ts";
import type { PayPalFake } from "../../src/paypal/fake/index.ts";
import { createPayPalFake, FAKE_WEBHOOK_ID } from "../../src/paypal/fake/index.ts";
import { AUTH_ALGO, sign, signatureInput } from "../../src/paypal/fake/signing.ts";
import { twinCreateBody } from "../../src/paypal/invoice.ts";
import { eventFacts, invoiceIdOf, readTransmission, TRANSMISSION_HEADERS } from "../../src/paypal/webhook.ts";
import type { TwinEventSink, VerifiedTwinEvent } from "../../src/routes/webhook.ts";
import { createWebhookHandlers } from "../../src/routes/webhook.ts";
import { KEY, OTHER_KEY, PAYEE, sharedTwin, twinInput } from "./fixtures.ts";
import type { RecordingGlobal } from "./support.ts";
import { fakeAndClient, recordingGlobal, spineApp, spineServices, T0 } from "./support.ts";

const HOOK = "http://api.test/v1/paypal/webhook";

interface Delivery {
  readonly headers: Headers;
  readonly body: string;
}

/** A fake that hands every delivery to the API's app, and remembers what it sent and what the app answered. */
function harness(options: { readonly offline?: boolean; readonly secrets?: Parameters<typeof spineServices>[0]["secrets"]; readonly sink?: TwinEventSink } = {}): {
  fake: PayPalFake;
  client: ReturnType<typeof fakeAndClient>["client"];
  global: RecordingGlobal;
  app: ReturnType<typeof spineApp>;
  sent: Delivery[];
  answers: { status: number; body: unknown }[];
  lines: string[];
} {
  const sent: Delivery[] = [];
  const answers: { status: number; body: unknown }[] = [];
  const lines: string[] = [];
  const global = recordingGlobal();
  let app: ReturnType<typeof spineApp> | null = null;
  const fake = createPayPalFake({
    clock: () => T0,
    deliver: async (url, init) => {
      const delivery = { headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : "" };
      sent.push(delivery);
      const response = await post(app, new URL(url).pathname, delivery);
      answers.push({ status: response.status, body: (await response.clone().json()) as unknown });
      return response;
    },
  });
  fake.connect({ webhookUrl: HOOK });
  const { client } = fakeAndClient({ global, client: { baseUrl: fake.baseUrl, credentials: fake.credentials, transport: fake.fetch } });
  const services = spineServices({ paypal: client, global, offline: options.offline ?? true, lines, ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });
  app = options.sink === undefined ? spineApp(services) : createApp(services, [createWebhookHandlers(options.sink)]);
  return { fake, client, global, app, sent, answers, lines };
}

async function post(app: ReturnType<typeof spineApp> | null, path: string, delivery: Delivery): Promise<Response> {
  if (app === null) {
    throw new Error("no app yet");
  }
  return await app.request(path, { method: "POST", headers: delivery.headers, body: delivery.body });
}

function replaced(headers: Headers, name: string, value: string): Headers {
  const copy = new Headers(headers);
  copy.set(name, value);
  return copy;
}

/** A delivery signed as the fake signs, for an arbitrary event (types the fake never emits on its own). */
async function signed(fake: PayPalFake, event: Readonly<Record<string, unknown>>): Promise<Delivery> {
  const body = JSON.stringify(event);
  const id = "8c5a2b8e-6d3f-4b0e-9d0b-6f9b0a1c2d3e";
  const time = new Date(T0).toISOString();
  return {
    body,
    headers: new Headers({
      "Content-Type": "application/json",
      [TRANSMISSION_HEADERS.auth_algo]: AUTH_ALGO,
      [TRANSMISSION_HEADERS.cert_url]: `${fake.baseUrl}/v1/notifications/certs/CERT-FAKE-PAYLINK-1`,
      [TRANSMISSION_HEADERS.transmission_id]: id,
      [TRANSMISSION_HEADERS.transmission_time]: time,
      [TRANSMISSION_HEADERS.transmission_sig]: await sign(signatureInput(id, time, FAKE_WEBHOOK_ID, body)),
    }),
  };
}

describe("a genuine delivery", () => {
  it("is verified (P10), recorded, read (P5) and handed to the cron for the twin's payee and key", async () => {
    const { fake, client, global, sent, answers } = harness();
    const twin = await sharedTwin(client);
    fake.pay(twin.id ?? "");
    await fake.flush();
    expect(sent).toHaveLength(1);
    expect(answers).toEqual([{ status: 200, body: { received: true, outcome: "processed" } }]);
    expect(global.checks).toEqual([{ payee: PAYEE, key: KEY, dueAt: T0 }]);
    expect([...global.events.keys()]).toEqual([(JSON.parse(sent[0]?.body ?? "{}") as { id: string }).id]);
    expect([...global.health.keys()].sort()).toEqual(["paypal-get", "webhook-verified"]);
    const after = fake.requests.slice(fake.requests.findIndex((r) => r.op === "P10"));
    expect(after.map((r) => r.op)).toEqual(["P10", "P5"]);
    expect(fake.state.deliveries[0]).toMatchObject({ state: "delivered", lastStatus: 200 });
  });

  it("gives the sink the invoice as P5 read it, never the event's copy", async () => {
    const seen: VerifiedTwinEvent[] = [];
    const sink: TwinEventSink = (_services, event) => {
      seen.push(event);
      return Promise.resolve("reconciled");
    };
    const { fake, client } = harness({ sink });
    const twin = await sharedTwin(client);
    fake.pay(twin.id ?? "");
    await fake.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ eventType: "INVOICING.INVOICE.PAID", key: KEY, payee: PAYEE, chainId: 11155111, invoice: { id: twin.id, status: "PAID" } });
  });

  it("answers a replay with `duplicate` and does nothing more", async () => {
    const { fake, client, global, app, sent } = harness();
    const twin = await sharedTwin(client);
    fake.pay(twin.id ?? "");
    await fake.flush();
    const reads = fake.requests.filter((r) => r.op === "P5").length;
    const replay = await post(app, "/v1/paypal/webhook", sent[0] ?? { headers: new Headers(), body: "" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, outcome: "duplicate" });
    expect(fake.requests.filter((r) => r.op === "P5")).toHaveLength(reads);
    expect(global.checks).toHaveLength(1);
  });
});

describe("a delivery PayPal did not make changes nothing", () => {
  it.each([
    ["a tampered body", (d: Delivery): Delivery => ({ headers: d.headers, body: d.body.replace('"PAID"', '"PAYD"') })],
    ["a re-serialised body", (d: Delivery): Delivery => ({ headers: d.headers, body: JSON.stringify(JSON.parse(d.body), null, 2) })],
    ["another signature", (d: Delivery): Delivery => ({ headers: replaced(d.headers, TRANSMISSION_HEADERS.transmission_sig, "c2lnbmF0dXJl"), body: d.body })],
    ["another certificate", (d: Delivery): Delivery => ({ headers: replaced(d.headers, TRANSMISSION_HEADERS.cert_url, "https://api.paypal.example/v1/notifications/certs/CERT-1"), body: d.body })],
  ])("%s: 400 E_WEBHOOK_SIGNATURE after P10, no read, no record", async (_label, forge) => {
    const { fake, client, global, app, sent } = harness();
    const twin = await sharedTwin(client);
    fake.pay(twin.id ?? "");
    await fake.flush();
    global.checks.length = 0;
    global.events.clear();
    const reads = fake.requests.filter((r) => r.op === "P5").length;
    const response = await post(app, "/v1/paypal/webhook", forge(sent[0] ?? { headers: new Headers(), body: "" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "webhook-rejected", rule: "E_WEBHOOK_SIGNATURE" });
    expect(fake.requests.filter((r) => r.op === "P5")).toHaveLength(reads);
    expect(global.checks).toEqual([]);
    expect(global.events.size).toBe(0);
  });

  it.each(Object.values(TRANSMISSION_HEADERS))("a delivery without %s: 400 E_WEBHOOK_MALFORMED before any call to PayPal", async (header) => {
    const { fake, client, app, sent } = harness();
    const twin = await sharedTwin(client);
    fake.pay(twin.id ?? "");
    await fake.flush();
    const before = fake.requests.length;
    const headers = new Headers(sent[0]?.headers);
    headers.delete(header);
    const response = await post(app, "/v1/paypal/webhook", { headers, body: sent[0]?.body ?? "" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "webhook-rejected", rule: "E_WEBHOOK_MALFORMED" });
    expect(fake.requests).toHaveLength(before);
  });

  it("refuses a body that is not one JSON object, and one over 64 KiB", async () => {
    const { fake, app } = harness();
    const genuine = await signed(fake, { id: "WH-1", event_type: "INVOICING.INVOICE.PAID" });
    for (const body of ["", "[1]", "not json"]) {
      const response = await post(app, "/v1/paypal/webhook", { headers: genuine.headers, body });
      expect(response.status, body).toBe(400);
    }
    const huge = await post(app, "/v1/paypal/webhook", { headers: genuine.headers, body: `{"pad":"${"x".repeat(64 * 1024)}"}` });
    expect(huge.status).toBe(413);
  });
});

describe("verified deliveries PayLink does not act on", () => {
  it.each<[string, (fake: PayPalFake, client: ReturnType<typeof fakeAndClient>["client"]) => Promise<Record<string, unknown>>, string]>([
    ["a payment event", () => Promise.resolve({ id: "WH-PAY-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPTURE1" } }), "ignored"],
    ["an invoicing event naming no invoice", () => Promise.resolve({ id: "WH-INV-1", event_type: "INVOICING.INVOICE.PAID", resource: {} }), "ignored"],
    ["an invoice PayPal does not know", () => Promise.resolve({ id: "WH-INV-2", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-NONE-NONE-NONE-NONE" } } }), "ignored"],
    [
      "an invoice that is not a twin (no PayLink memo)",
      async (_fake, client) => {
        const body = twinCreateBody(twinInput({ key: OTHER_KEY }));
        const plain = await client.createInvoice({ ...body, detail: { ...body.detail, memo: "made in the dashboard" } });
        return { id: "WH-INV-3", event_type: "INVOICING.INVOICE.UPDATED", resource: { invoice: { id: plain.id } } };
      },
      "ignored",
    ],
    [
      "a twin of another chain",
      async (_fake, client) => {
        const other = await client.createInvoice(twinCreateBody(twinInput({ key: OTHER_KEY, chainId: 1 })));
        return { id: "WH-INV-4", event_type: "INVOICING.INVOICE.UPDATED", resource: { id: other.id } };
      },
      "ignored",
    ],
  ])("%s: 200 %s, nothing planned", async (_label, event, outcome) => {
    const { fake, client, global, app } = harness();
    const delivery = await signed(fake, await event(fake, client));
    const response = await post(app, "/v1/paypal/webhook", delivery);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, outcome });
    expect(global.checks).toEqual([]);
  });
});

describe("when something is down", () => {
  it("PayPal cannot verify: 503, so PayPal delivers again later; nothing recorded", async () => {
    const { fake, client, global, app } = harness();
    const twin = await sharedTwin(client);
    const delivery = await signed(fake, { id: "WH-X-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: twin.id } } });
    fake.inject({ op: "P10", status: 503, times: 3 });
    const response = await post(app, "/v1/paypal/webhook", delivery);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "paypal-unavailable", rule: "E_WEBHOOK_UNVERIFIABLE", retryAfter: 60 });
    expect(global.events.size).toBe(0);
  });

  it("P5 fails after a verified delivery: 200 `deferred` (the cron reads the twin on its own schedule)", async () => {
    const { fake, client, global, app } = harness();
    const twin = await sharedTwin(client);
    const delivery = await signed(fake, { id: "WH-X-2", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: twin.id } } });
    fake.inject({ op: "P5", status: 503, times: 3 });
    const response = await post(app, "/v1/paypal/webhook", delivery);
    expect(await response.json()).toEqual({ received: true, outcome: "deferred" });
    expect(global.checks).toEqual([]);
  });

  it("the store is down: the delivery is processed anyway, and the planning failure is deferred", async () => {
    const { fake, client, global, app, lines } = harness();
    const twin = await sharedTwin(client);
    const delivery = await signed(fake, { id: "WH-X-3", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: twin.id } } });
    global.failing = true;
    const response = await post(app, "/v1/paypal/webhook", delivery);
    expect(await response.json()).toEqual({ received: true, outcome: "deferred" });
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining(["webhook.dedup-unavailable", "webhook.sink-failed"]));
  });

  it("a sandbox deployment without PAYPAL_WEBHOOK_ID: 503 E_WEBHOOK_NOT_CONFIGURED, nothing called", async () => {
    const { fake, app } = harness({ offline: false, secrets: { paypalClientId: "id-0123456789", paypalClientSecret: "secret-0123456789" } });
    const delivery = await signed(fake, { id: "WH-X-4", event_type: "INVOICING.INVOICE.PAID" });
    const before = fake.requests.length;
    const response = await post(app, "/v1/paypal/webhook", delivery);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "paypal-unavailable", rule: "E_WEBHOOK_NOT_CONFIGURED" });
    expect(fake.requests).toHaveLength(before);
  });
});

describe("logs", () => {
  it("carry the outcome and PayPal's ids, never the body, the signature or the key", async () => {
    const { fake, client, sent, lines, app } = harness();
    const twin = await sharedTwin(client);
    fake.pay(twin.id ?? "");
    await fake.flush();
    await post(app, "/v1/paypal/webhook", { headers: sent[0]?.headers ?? new Headers(), body: (sent[0]?.body ?? "").replace("PAID", "PAYD") });
    const text = lines.join("\n");
    expect(text).toContain('"event":"webhook.received"');
    expect(text).toContain('"outcome":"processed"');
    expect(text).toContain('"event":"webhook.rejected"');
    expect(text).not.toContain(sent[0]?.headers.get(TRANSMISSION_HEADERS.transmission_sig) ?? "unreachable");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("sarah@example.com");
  });
});

describe("event facts (shapes UNVERIFIED until the capture run)", () => {
  it("finds the invoice id in resource.invoice.id, resource.id, or an invoice link", () => {
    expect(invoiceIdOf({ resource: { invoice: { id: "INV2-A" } } })).toBe("INV2-A");
    expect(invoiceIdOf({ resource: { id: "INV2-B", status: "PAID" } })).toBe("INV2-B");
    expect(invoiceIdOf({ resource: { links: [{ href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-C", rel: "self" }] } })).toBe("INV2-C");
    expect(invoiceIdOf({ resource: {}, links: [{ href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-D/send", rel: "send" }] })).toBe("INV2-D");
    expect(invoiceIdOf({ resource: { invoice: { id: "../../v1/oauth2/token" } } })).toBeNull();
    expect(invoiceIdOf({ resource: { id: "x".repeat(31) } })).toBeNull();
    expect(invoiceIdOf({})).toBeNull();
  });

  it("acts on invoicing invoice events only, and keeps only an id it can store", () => {
    expect(eventFacts({ id: "WH-1", event_type: "INVOICING.INVOICE.CANCELLED", resource: { id: "INV2-A" } })).toEqual({ id: "WH-1", eventType: "INVOICING.INVOICE.CANCELLED", invoiceId: "INV2-A" });
    expect(eventFacts({ id: "WH 1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "INV2-A" } })).toEqual({ id: null, eventType: "PAYMENT.CAPTURE.COMPLETED", invoiceId: null });
  });

  it("reads the five transmission headers, refusing missing, oversized or malformed values", () => {
    const good: Record<string, string> = {
      [TRANSMISSION_HEADERS.auth_algo]: "SHA256withRSA",
      [TRANSMISSION_HEADERS.cert_url]: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      [TRANSMISSION_HEADERS.transmission_id]: "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
      [TRANSMISSION_HEADERS.transmission_sig]: "+lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz/Zjh3s3==",
      [TRANSMISSION_HEADERS.transmission_time]: "2016-02-18T20:01:35Z",
    };
    expect(readTransmission((name) => good[name])).toMatchObject({ ok: true });
    const bad: [string, string][] = [
      [TRANSMISSION_HEADERS.auth_algo, "SHA256-with-RSA"],
      [TRANSMISSION_HEADERS.cert_url, "ftp://x/y"],
      [TRANSMISSION_HEADERS.transmission_id, "x".repeat(51)],
      [TRANSMISSION_HEADERS.transmission_sig, "has space"],
      [TRANSMISSION_HEADERS.transmission_time, "yesterday"],
    ];
    for (const [name, value] of bad) {
      expect(readTransmission((n) => (n === name ? value : good[n])), name).toEqual({ ok: false, header: name });
    }
  });
});
