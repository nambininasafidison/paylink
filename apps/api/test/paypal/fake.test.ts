// SPDX-License-Identifier: MIT
/**
 * The PayPal fake (src/paypal/fake/): its status machine (model.ts, row by row), its switchable behaviours, its error
 * bodies, OAuth, the signed webhook deliveries and the postback check (P10) that accepts exactly the bytes delivered,
 * the payer's page, the controls, and being mounted under another server's path.
 */
import { describe, expect, it } from "vitest";
import { isPayPalError } from "../../src/paypal/client.ts";
import type { PayPalFake } from "../../src/paypal/fake/index.ts";
import { createPayPalFake, FAKE_WEBHOOK_ID, operationOf } from "../../src/paypal/fake/index.ts";
import { escapeHtml } from "../../src/paypal/fake/page.ts";
import { crc32, signatureInput, sign, verify } from "../../src/paypal/fake/signing.ts";
import { CANCEL_SILENTLY, REMIND_RECIPIENT, SHARE_LINK, twinCreateBody } from "../../src/paypal/invoice.ts";
import { readTransmission, verifyDelivery } from "../../src/paypal/webhook.ts";
import { echoNoteFor, KEY, OTHER_KEY, sharedTwin, twinInput } from "./fixtures.ts";
import { fakeAndClient, manualClock, T0 } from "./support.ts";

async function issue(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isPayPalError(error)) {
      return `${String(error.status)} ${error.issue ?? error.paypalName ?? ""}`;
    }
    throw error;
  }
  return "ok";
}

describe("status machine", () => {
  it("DRAFT → share link → SHARED (the expected status, UNVERIFIED), or SENT when sent to the recipient", async () => {
    const { client } = fakeAndClient();
    const shared = await sharedTwin(client);
    expect(shared.status).toBe("SHARED");
    expect(shared.detail.metadata?.recipient_view_url).toBe(`http://paypal.fake.invalid/invoice/p/${shared.id ?? ""}`);
    const draft = await client.createInvoice(twinCreateBody(twinInput({ key: OTHER_KEY })));
    expect(draft.detail.metadata?.recipient_view_url).toBeUndefined();
    await client.sendInvoice(draft.id ?? "", { send_to_recipient: true, send_to_invoicer: false });
    expect((await client.getInvoice(draft.id ?? "")).status).toBe("SENT");
    const other = fakeAndClient({ fake: { behaviour: { statusAfterShare: "SENT" } } });
    expect((await sharedTwin(other.client)).status).toBe("SENT");
  });

  it("the payer pays: PAID (or PAYMENT_PENDING, then PAID), with a PAYPAL transaction and nothing due", async () => {
    const { fake, client } = fakeAndClient();
    const twin = await sharedTwin(client);
    const paymentId = fake.pay(twin.id ?? "");
    const paid = await client.getInvoice(twin.id ?? "");
    expect(paid).toMatchObject({ status: "PAID", due_amount: { value: "0.00" }, payments: { paid_amount: { value: "120.00" }, transactions: [{ type: "PAYPAL", payment_id: paymentId, method: "PAYPAL", amount: { value: "120.00" } }] } });
    expect(paymentId).toMatch(/^[0-9A-Z]{17}$/u);

    const held = fakeAndClient({ fake: { behaviour: { payerPaymentStatus: "PAYMENT_PENDING" } } });
    const pending = await sharedTwin(held.client);
    held.fake.pay(pending.id ?? "");
    expect((await held.client.getInvoice(pending.id ?? "")).status).toBe("PAYMENT_PENDING");
    held.fake.clearPending(pending.id ?? "");
    expect((await held.client.getInvoice(pending.id ?? "")).status).toBe("PAID");
  });

  it.each(["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"] as const)("P6 of the whole amount leaves %s when switched to it (UNVERIFIED, K4); P7 restores the open status", async (statusAfterRecord) => {
    const { client } = fakeAndClient({ fake: { behaviour: { statusAfterRecord } } });
    const twin = await sharedTwin(client);
    const id = twin.id ?? "";
    const recorded = await client.recordPayment(id, { method: "OTHER", note: echoNoteFor(KEY) });
    const after = await client.getInvoice(id);
    expect(after).toMatchObject({ status: statusAfterRecord, due_amount: { value: "0.00" }, payments: { transactions: [{ type: "EXTERNAL", method: "OTHER", payment_id: recorded.payment_id, note: echoNoteFor(KEY), amount: { value: "120.00" } }] } });
    expect(recorded.payment_id).toMatch(/^EXTR-[0-9A-Z]{17}$/u);
    await client.deletePayment(id, recorded.payment_id);
    expect((await client.getInvoice(id)).status).toBe("SHARED");
  });

  it("a part payment leaves PARTIALLY_PAID, and the rest pays it", async () => {
    const { fake, client } = fakeAndClient();
    const twin = await sharedTwin(client);
    const id = twin.id ?? "";
    await client.recordPayment(id, { method: "OTHER", amount: { currency_code: "USD", value: "20.00" } });
    expect(await client.getInvoice(id)).toMatchObject({ status: "PARTIALLY_PAID", due_amount: { value: "100.00" } });
    fake.pay(id);
    expect(await client.getInvoice(id)).toMatchObject({ status: "PAID", due_amount: { value: "0.00" }, payments: { paid_amount: { value: "120.00" } } });
    expect(await issue(client.deletePayment(id, (await client.getInvoice(id)).payments?.transactions?.[1]?.payment_id ?? ""))).toBe("422 CANNOT_DELETE_EXTERNAL_PAYMENT");
  });

  it("a future issue date schedules (202, SCHEDULED), which cannot be cancelled", async () => {
    const { client } = fakeAndClient();
    const body = twinCreateBody(twinInput());
    const scheduled = await client.createInvoice({ ...body, detail: { ...body.detail, invoice_date: "2026-10-22" } });
    expect((await client.sendInvoice(scheduled.id ?? "", SHARE_LINK)).status).toBe(202);
    expect(await issue(client.cancelInvoice(scheduled.id ?? "", CANCEL_SILENTLY))).toBe("422 CANNOT_CANCEL_SCHEDULED_INVOICE");
  });

  it("cancel: open → CANCELLED; refused for a draft, a paid, a refunded or a cancelled invoice (the issues of the file)", async () => {
    const { fake, client } = fakeAndClient();
    const twin = await sharedTwin(client);
    const id = twin.id ?? "";
    await client.cancelInvoice(id, CANCEL_SILENTLY);
    expect(await client.getInvoice(id)).toMatchObject({ status: "CANCELLED", detail: { metadata: { cancel_time: new Date(T0).toISOString() } } });
    expect(await issue(client.cancelInvoice(id, CANCEL_SILENTLY))).toBe("422 INVOICE_CANCELED_ALREADY");
    expect(await issue(client.recordPayment(id, { method: "OTHER" }))).toBe("422 CANNOT_PROCESS_PAYMENTS");
    const draft = await client.createInvoice(twinCreateBody(twinInput({ key: OTHER_KEY })));
    expect(await issue(client.cancelInvoice(draft.id ?? "", CANCEL_SILENTLY))).toBe("422 CANNOT_CANCEL_DRAFT_INVOICE");
    await client.sendInvoice(draft.id ?? "", SHARE_LINK);
    fake.pay(draft.id ?? "");
    expect(await issue(client.cancelInvoice(draft.id ?? "", CANCEL_SILENTLY))).toBe("422 CANNOT_CANCEL_PAID_INVOICE");
    fake.forceStatus(draft.id ?? "", "REFUNDED");
    expect(await issue(client.cancelInvoice(draft.id ?? "", CANCEL_SILENTLY))).toBe("422 CANNOT_CANCEL_REFUNDED_INVOICE");
  });

  it("remind: open invoices with an email, at most twice a day (S), never a draft or a paid one", async () => {
    const clock = manualClock();
    const { fake, client } = fakeAndClient({ clock: clock.now });
    const twin = await sharedTwin(client);
    const id = twin.id ?? "";
    await client.remindInvoice(id, REMIND_RECIPIENT);
    await client.remindInvoice(id, REMIND_RECIPIENT);
    expect(await issue(client.remindInvoice(id, REMIND_RECIPIENT))).toBe("422 CANNOT_REMIND_INVOICE");
    clock.advance(24 * 60 * 60 * 1000);
    await client.remindInvoice(id, REMIND_RECIPIENT);
    fake.pay(id);
    expect(await issue(client.remindInvoice(id, REMIND_RECIPIENT))).toBe("422 CANNOT_REMIND_INVOICE");
    const noEmail = await sharedTwin(client, { key: OTHER_KEY, recipient: { givenName: "Tom" } });
    expect(await issue(client.remindInvoice(noEmail.id ?? "", REMIND_RECIPIENT))).toBe("422 CANNOT_REMIND_INVOICE");
    const lenient = fakeAndClient({ fake: { behaviour: { remindRequiresEmail: false } } });
    const tom = await sharedTwin(lenient.client, { recipient: null });
    expect(await issue(lenient.client.remindInvoice(tom.id ?? "", REMIND_RECIPIENT))).toBe("ok");
  });

  it("P6 refuses more than is due, a zero amount, a missing or unknown method, and the read-only type", async () => {
    const { fake, client } = fakeAndClient();
    const twin = await sharedTwin(client);
    const id = twin.id ?? "";
    expect(await issue(client.recordPayment(id, { method: "OTHER", amount: { currency_code: "USD", value: "120.01" } }))).toBe("422 PAYMENT_AMOUNT_GREATER_THAN_AMOUNT_DUE");
    expect(await issue(client.recordPayment(id, { method: "OTHER", amount: { currency_code: "USD", value: "0.00" } }))).toBe("400 VALUE_CANNOT_BE_ZERO");
    expect(await issue(client.recordPayment(id, { method: "OTHER", type: "EXTERNAL" }))).toBe("400 INVALID_PARAMETER_SYNTAX");
    expect(await issue(client.recordPayment(id, { method: "BITCOIN" as "OTHER" }))).toBe("400 INVALID_PAYMENT_METHOD");
    expect(await issue(client.recordPayment(id, {} as { method: "OTHER" }))).toBe("400 MISSING_REQUIRED_PARAMETER");
    expect(fake.invoice(id)).toMatchObject({ status: "SHARED" });
  });

  it("P3 refuses read-only members, both payment terms at once, a bad email and a reused number", async () => {
    const { client } = fakeAndClient();
    const body = twinCreateBody(twinInput());
    expect(await issue(client.createInvoice({ ...body, status: "PAID" } as typeof body))).toBe("400 INVALID_PARAMETER_SYNTAX");
    expect(await issue(client.createInvoice({ ...body, detail: { ...body.detail, payment_term: { term_type: "NET_10", due_date: "2026-11-06" } as never } }))).toBe("400 INVALID_PARAMETER_SYNTAX");
    expect(await issue(client.createInvoice({ ...body, primary_recipients: [{ billing_info: { email_address: "nope" } }] }))).toBe("400 INVALID_PARAMETER_SYNTAX");
    expect(await issue(client.createInvoice({ ...body, detail: { ...body.detail, reference: "x".repeat(121) } }))).toBe("400 INVALID_STRING_MAX_LENGTH");
    await client.createInvoice(body);
    expect(await issue(client.createInvoice(body))).toBe("422 UNPROCESSABLE_ENTITY");
  });

  it("P2 matches the reference partly by default (pessimistic, UNVERIFIED) or exactly when switched", async () => {
    const { client } = fakeAndClient();
    await sharedTwin(client);
    expect((await client.searchInvoices({ reference: KEY.slice(0, 20) })).items).toHaveLength(1);
    const exact = fakeAndClient({ fake: { behaviour: { referenceSearch: "exact" } } });
    await sharedTwin(exact.client);
    expect((await exact.client.searchInvoices({ reference: KEY.slice(0, 20) })).items).toHaveLength(0);
    expect((await exact.client.searchInvoices({ reference: KEY })).items).toHaveLength(1);
  });

  it("P13 pages the invoices newest first and counts them on request", async () => {
    const { client } = fakeAndClient();
    const first = await sharedTwin(client);
    const second = await sharedTwin(client, { key: OTHER_KEY });
    const page = await client.listInvoices({ page: 1, page_size: 1, total_required: true });
    expect(page).toMatchObject({ total_items: 2, total_pages: 2 });
    expect(page.items?.map((i) => i.id)).toEqual([second.id]);
    expect((await client.listInvoices({ page: 2, page_size: 1 })).items?.map((i) => i.id)).toEqual([first.id]);
  });
});

describe("OAuth", () => {
  it("issues tokens for the right credentials only, and refuses an expired one", async () => {
    const clock = manualClock();
    const fake = createPayPalFake({ clock: clock.now, behaviour: { tokenLifetimeSeconds: 60 } });
    const basic = `Basic ${btoa(`${fake.credentials.clientId}:${fake.credentials.clientSecret}`)}`;
    const form = { "Content-Type": "application/x-www-form-urlencoded" };
    const ok = await fake.fetch(`${fake.baseUrl}/v1/oauth2/token`, { method: "POST", headers: { Authorization: basic, ...form }, body: "grant_type=client_credentials" });
    const token = (await ok.json()) as { access_token: string; expires_in: number; token_type: string };
    expect(token).toMatchObject({ token_type: "Bearer", expires_in: 60 });
    const wrong = await fake.fetch(`${fake.baseUrl}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${btoa("a:b")}`, ...form }, body: "grant_type=client_credentials" });
    expect(wrong.status).toBe(401);
    const grant = await fake.fetch(`${fake.baseUrl}/v1/oauth2/token`, { method: "POST", headers: { Authorization: basic, ...form }, body: "grant_type=password" });
    expect(grant.status).toBe(400);
    const list = (): Promise<Response> => fake.fetch(`${fake.baseUrl}/v2/invoicing/invoices`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    expect((await list()).status).toBe(200);
    clock.advance(60_000);
    const expired = await list();
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ name: "AUTHENTICATION_FAILURE" });
  });
});

describe("webhooks", () => {
  function recording(behaviour: Parameters<typeof createPayPalFake>[0] = {}): { fake: PayPalFake; delivered: { url: string; headers: Headers; body: string }[]; status: { value: number } } {
    const delivered: { url: string; headers: Headers; body: string }[] = [];
    const status = { value: 200 };
    const fake = createPayPalFake({
      clock: () => T0,
      ...behaviour,
      deliver: (url, init) => {
        delivered.push({ url, headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : "" });
        return Promise.resolve(new Response(null, { status: status.value }));
      },
    });
    fake.connect({ webhookUrl: "https://api.example/v1/paypal/webhook" });
    return { fake, delivered, status };
  }

  it("delivers each subscribed event, signed, with the five transmission headers", async () => {
    const { fake, delivered } = recording();
    const twin = await sharedTwin(fakeClient(fake));
    fake.pay(twin.id ?? "");
    await fake.flush();
    // The first subscription listens to PAID, CANCELLED and UPDATED only (SENT is not delivered).
    expect(delivered.map((d) => (JSON.parse(d.body) as { event_type: string }).event_type)).toEqual(["INVOICING.INVOICE.PAID"]);
    const delivery = delivered[0];
    const transmission = readTransmission((name) => delivery?.headers.get(name));
    expect(transmission.ok).toBe(true);
    expect(delivery?.headers.get("paypal-auth-algo")).toBe("SHA256withRSA");
    const event = JSON.parse(delivery?.body ?? "{}") as { id: string; resource: { invoice: { id: string; status: string } }; resource_type: string };
    expect(event).toMatchObject({ resource_type: "invoices", resource: { invoice: { id: twin.id, status: "PAID" } } });
    expect(fake.state.deliveries).toEqual([{ eventId: event.id, subscriptionId: FAKE_WEBHOOK_ID, attempts: 1, state: "delivered", lastStatus: 200 }]);
  });

  it("P10 confirms exactly the bytes delivered: a re-serialised, tampered or misattributed delivery fails", async () => {
    const { fake, delivered } = recording();
    const client = fakeClient(fake);
    const twin = await sharedTwin(client);
    fake.pay(twin.id ?? "");
    await fake.flush();
    const delivery = delivered[0];
    const read = readTransmission((name) => delivery?.headers.get(name));
    if (delivery === undefined || !read.ok) {
      throw new Error("no delivery");
    }
    const check = async (raw: string, webhookId = FAKE_WEBHOOK_ID, transmission = read.transmission): Promise<boolean> => (await verifyDelivery(client, webhookId, transmission, raw)).verified;
    expect(await check(delivery.body)).toBe(true);
    expect(await check(JSON.stringify(JSON.parse(delivery.body), null, 1))).toBe(false);
    expect(await check(delivery.body.replace('"PAID"', '"PAYD"'))).toBe(false);
    expect(await check(delivery.body, "0OTHERWEBHOOK0")).toBe(false);
    expect(await check(delivery.body, FAKE_WEBHOOK_ID, { ...read.transmission, transmission_time: "2026-10-21T12:00:01.000Z" })).toBe(false);
    expect(await check(delivery.body, FAKE_WEBHOOK_ID, { ...read.transmission, cert_url: "https://evil.example/cert" })).toBe(false);
    expect(await check(delivery.body, FAKE_WEBHOOK_ID, { ...read.transmission, transmission_sig: "not-base64!" })).toBe(false);
  });

  it("keeps a failed delivery pending, retries it, and gives up after three attempts", async () => {
    const { fake, delivered, status } = recording();
    const twin = await sharedTwin(fakeClient(fake));
    fake.pay(twin.id ?? "");
    status.value = 500;
    await fake.flush();
    expect(fake.state.deliveries[0]).toMatchObject({ attempts: 1, state: "pending", lastStatus: 500 });
    await fake.flush();
    await fake.flush();
    expect(fake.state.deliveries[0]).toMatchObject({ attempts: 3, state: "failed" });
    await fake.flush();
    expect(delivered).toHaveLength(3);
  });

  it("carries the invoice flat in `resource` when switched to (the other shape PayPal may use, UNVERIFIED)", async () => {
    const { fake, delivered } = recording({ behaviour: { eventResource: "flat" } });
    const twin = await sharedTwin(fakeClient(fake));
    fake.pay(twin.id ?? "");
    await fake.flush();
    expect(JSON.parse(delivered[0]?.body ?? "{}")).toMatchObject({ resource: { id: twin.id, status: "PAID" } });
  });

  it("delivers on its own after each change when asked to (the offline demo)", async () => {
    const delivered: string[] = [];
    const fake = createPayPalFake({
      clock: () => T0,
      autoDeliver: true,
      deliver: (_url, init) => {
        delivered.push(typeof init.body === "string" ? init.body : "");
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    });
    fake.connect({ webhookUrl: "https://api.example/hook" });
    const twin = await sharedTwin(fakeClient(fake));
    fake.pay(twin.id ?? "");
    await fake.settled();
    expect(delivered).toHaveLength(1);
  });

  it("signs with RSA-SHA256 over id|time|webhook id|CRC32(body), the CRC32 of IEEE 802.3", async () => {
    expect(crc32("")).toBe(0);
    expect(crc32("123456789")).toBe(0xcbf43926);
    expect(crc32("é")).toBe(crc32("é"));
    const input = signatureInput("t-1", "2026-10-21T12:00:00Z", "WH1", '{"a":1}');
    expect(input).toBe(`t-1|2026-10-21T12:00:00Z|WH1|${String(crc32('{"a":1}'))}`);
    const signature = await sign(input);
    expect(await verify(input, signature)).toBe(true);
    expect(await verify(`${input}x`, signature)).toBe(false);
  });
});

describe("faults, controls, mounting and the payer's page", () => {
  it("drops a connection before or after processing, and answers injected statuses with PayPal's body", async () => {
    const { fake, client } = fakeAndClient();
    const twin = await sharedTwin(client);
    fake.inject({ op: "P8", noAnswer: "after" });
    expect(await issue(client.cancelInvoice(twin.id ?? "", CANCEL_SILENTLY))).toBe("0 E_PAYPAL_NO_ANSWER");
    expect(fake.invoice(twin.id ?? "")).toMatchObject({ status: "CANCELLED" });
    fake.inject({ op: "P5", status: 503, times: 3 });
    expect(await issue(client.getInvoice(twin.id ?? ""))).toBe("503 SERVICE_UNAVAILABLE");
  });

  it("deduplicates writes by PayPal-Request-Id only when switched to (UNVERIFIED for Invoicing)", async () => {
    const strict = fakeAndClient();
    const twin = await sharedTwin(strict.client);
    await strict.client.recordPayment(twin.id ?? "", { method: "OTHER", amount: { currency_code: "USD", value: "10.00" } }, { requestId: "pl-record-a" });
    await strict.client.recordPayment(twin.id ?? "", { method: "OTHER", amount: { currency_code: "USD", value: "10.00" } }, { requestId: "pl-record-a" });
    expect(strict.fake.invoice(twin.id ?? "")).toMatchObject({ payments: { paid_amount: { value: "20.00" } } });
    const honouring = fakeAndClient({ fake: { behaviour: { honourRequestId: true } } });
    const other = await sharedTwin(honouring.client);
    const first = await honouring.client.recordPayment(other.id ?? "", { method: "OTHER", amount: { currency_code: "USD", value: "10.00" } }, { requestId: "pl-record-a" });
    const again = await honouring.client.recordPayment(other.id ?? "", { method: "OTHER", amount: { currency_code: "USD", value: "10.00" } }, { requestId: "pl-record-a" });
    expect(again).toEqual(first);
    expect(honouring.fake.invoice(other.id ?? "")).toMatchObject({ payments: { paid_amount: { value: "10.00" } } });
  });

  it("serves the payer's page, whose button pays and announces it", async () => {
    const { fake, delivered } = (() => {
      const sent: string[] = [];
      const f = createPayPalFake({
        clock: () => T0,
        deliver: (_url, init) => {
          sent.push(typeof init.body === "string" ? init.body : "");
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      });
      f.connect({ publicUrl: "http://127.0.0.1:9999/__paypal-fake", webhookUrl: "https://api.example/hook" });
      return { fake: f, delivered: sent };
    })();
    const twin = await sharedTwin(fakeClient(fake), { description: "<script>alert(1)</script>" });
    expect(twin.detail.metadata?.recipient_view_url).toBe(`http://127.0.0.1:9999/__paypal-fake/invoice/p/${twin.id ?? ""}`);
    const page = await fake.fetch(`${fake.baseUrl}/invoice/p/${twin.id ?? ""}`);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("PL-11155111-3fa9c0e17b2d");
    expect(html).toContain(`action="http://127.0.0.1:9999/__paypal-fake/invoice/p/${twin.id ?? ""}/pay"`);
    expect(html).not.toContain("<script");
    const paid = await fake.fetch(`${fake.baseUrl}/invoice/p/${twin.id ?? ""}/pay`, { method: "POST" });
    expect(paid.status).toBe(303);
    expect(fake.invoice(twin.id ?? "")).toMatchObject({ status: "PAID" });
    expect(delivered).toHaveLength(1);
    expect((await fake.fetch(`${fake.baseUrl}/invoice/p/INV2-NONE`)).status).toBe(404);
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  });

  it("routes by path under a mount prefix, whatever the origin", async () => {
    const fake = createPayPalFake({ clock: () => T0, mountPath: "/__paypal-fake" });
    const response = await fake.handle(new Request("http://127.0.0.1:8788/__paypal-fake/v1/notifications/certs/CERT-FAKE-PAYLINK-1"));
    expect(await response.text()).toMatch(/^-----BEGIN PUBLIC KEY-----\n/u);
    expect((await fake.handle(new Request("http://127.0.0.1:8788/__paypal-fake/v2/nothing"))).status).toBe(401);
    expect((await fake.handle(new Request("http://127.0.0.1:8788/__paypal-fake/nothing"))).status).toBe(404);
  });

  it("knows which operation a request is", () => {
    expect(operationOf("POST", "/v2/invoicing/invoices")).toBe("P3");
    expect(operationOf("GET", "/v2/invoicing/invoices")).toBe("P13");
    expect(operationOf("GET", "/v2/invoicing/invoices/INV2-1")).toBe("P5");
    expect(operationOf("DELETE", "/v2/invoicing/invoices/INV2-1/payments/EXTR-1")).toBe("P7");
    expect(operationOf("POST", "/v1/notifications/verify-webhook-signature")).toBe("P10");
    expect(operationOf("GET", "/v1/notifications/webhooks-events/WH-1")).toBe("P14");
    expect(operationOf("POST", "/v2/invoicing/invoices/INV2-1/refunds")).toBeNull();
  });
});

/** A client over an existing fake. */
function fakeClient(fake: PayPalFake): ReturnType<typeof fakeAndClient>["client"] {
  return fakeAndClient({ client: { baseUrl: fake.baseUrl, credentials: fake.credentials, transport: fake.fetch } }).client;
}
