// SPDX-License-Identifier: MIT
/**
 * The HTTP client (src/paypal/http.ts) against the PayPal fake: the OAuth token and its cache (§7.1 P1), the retry
 * rules of src/paypal/client.ts (reads on no answer, 429 and 5xx; writes on 429 only; one fresh token after a 401),
 * `PayPal-Request-Id` on writes, ids checked before they enter a URL, PayPal's errors reduced to name, debug id and
 * issue, and logs that carry none of the token, the secret or a body.
 */
import { describe, expect, it } from "vitest";
import type { PayPalError } from "../../src/paypal/client.ts";
import { isPayPalError } from "../../src/paypal/client.ts";
import { createHttpPayPalClient, spliceVerification } from "../../src/paypal/http.ts";
import { CANCEL_SILENTLY, REMIND_RECIPIENT, SHARE_LINK, twinCreateBody } from "../../src/paypal/invoice.ts";
import { TOKEN_MARGIN_MS } from "../../src/paypal/token.ts";
import { echoNoteFor, KEY, sharedTwin, twinInput } from "./fixtures.ts";
import { fakeAndClient, manualClock, recordingGlobal, T0 } from "./support.ts";

async function failure(promise: Promise<unknown>): Promise<PayPalError> {
  try {
    await promise;
  } catch (error) {
    if (isPayPalError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a PayPalError");
}

describe("OAuth token (P1)", () => {
  it("fetches one token for many calls and caches it until expires_in − 10 min", async () => {
    const { fake, client, global } = fakeAndClient();
    const twin = await sharedTwin(client);
    await client.getInvoice(twin.id ?? "");
    expect(fake.requests.filter((r) => r.op === "P1")).toHaveLength(1);
    expect(fake.requests.find((r) => r.op === "P1")).toMatchObject({ method: "POST", authorization: "basic", body: "grant_type=client_credentials" });
    expect(fake.requests.filter((r) => r.op !== "P1").every((r) => r.authorization === "bearer")).toBe(true);
    expect(global.tokens).toHaveLength(1);
    expect(global.tokens[0]?.expiresAtMs).toBe(T0 + 32_400_000 - TOKEN_MARGIN_MS);
  });

  it("shares the token through the Global store: a second isolate fetches none", async () => {
    const first = fakeAndClient();
    await first.client.listInvoices();
    const second = createHttpPayPalClient({
      baseUrl: first.fake.baseUrl,
      credentials: first.fake.credentials,
      transport: first.fake.fetch,
      clock: () => T0,
      random: (n) => new Uint8Array(n),
      logger: { log: () => undefined, child: () => ({ log: () => undefined, child: () => undefined as never }) },
      tokenStore: first.global.store,
    });
    await second.listInvoices();
    expect(first.fake.requests.filter((r) => r.op === "P1")).toHaveLength(1);
  });

  it("fetches a new token once the cached one is past its margin", async () => {
    const clock = manualClock();
    const { fake, client } = fakeAndClient({ clock: clock.now });
    await client.listInvoices();
    clock.advance(32_400_000 - TOKEN_MARGIN_MS - 1);
    await client.listInvoices();
    expect(fake.requests.filter((r) => r.op === "P1")).toHaveLength(1);
    clock.advance(1);
    await client.listInvoices();
    expect(fake.requests.filter((r) => r.op === "P1")).toHaveLength(2);
  });

  it("drops a token PayPal refuses (401) and retries once with a fresh one", async () => {
    const { fake, client } = fakeAndClient();
    await client.listInvoices();
    fake.revokeTokens();
    await client.listInvoices();
    expect(fake.requests.map((r) => `${r.op ?? "?"}:${String(r.status)}`)).toEqual(["P1:200", "P13:200", "P13:401", "P1:200", "P13:200"]);
  });

  it("fails after a second 401 with the fresh token", async () => {
    const { fake, client } = fakeAndClient();
    fake.inject({ op: "P13", status: 401, times: 2 });
    const error = await failure(client.listInvoices());
    expect(error).toMatchObject({ operation: "P13", status: 401, paypalName: "AUTHENTICATION_FAILURE", retryable: false, ambiguous: false });
    expect(fake.requests.filter((r) => r.op === "P1")).toHaveLength(2);
  });

  it("does not retry refused credentials, and reports the token endpoint's code", async () => {
    const { fake, client } = fakeAndClient({ client: { credentials: { clientId: "FAKE-CLIENT-ID-PAYLINK-TWIN", clientSecret: "wrong-secret-0123456789" } } });
    const error = await failure(client.listInvoices());
    expect(error).toMatchObject({ operation: "P1", status: 401, paypalName: "invalid_client", retryable: false });
    expect(fake.requests).toHaveLength(1);
  });

  it("sends nothing without credentials", async () => {
    const { fake, client } = fakeAndClient({ client: { credentials: null } });
    const error = await failure(client.getInvoice("INV2-AAAA-BBBB-CCCC-DDDD"));
    expect(error).toMatchObject({ status: 0, paypalName: "E_PAYPAL_NOT_CONFIGURED", retryable: false });
    expect(fake.requests).toHaveLength(0);
  });

  it("keeps working when the shared store is down, and says so once", async () => {
    const global = recordingGlobal();
    global.failing = true;
    const { fake, client, log } = fakeAndClient({ global });
    await client.listInvoices();
    await client.listInvoices();
    expect(fake.requests.filter((r) => r.op === "P1")).toHaveLength(1);
    expect(log.events().filter((e) => e["event"] === "paypal.token.store-unavailable")).toHaveLength(1);
  });

  it("makes one token request for concurrent callers", async () => {
    const { fake, client } = fakeAndClient();
    await Promise.all([client.listInvoices(), client.listInvoices(), client.listInvoices(), client.listInvoices()]);
    expect(fake.requests.filter((r) => r.op === "P1")).toHaveLength(1);
  });
});

describe("retries", () => {
  it("retries a read on 5xx with exponential back-off and jitter", async () => {
    const { fake, client, sleeps } = fakeAndClient();
    fake.inject({ op: "P13", status: 503, times: 2 });
    await client.listInvoices();
    expect(fake.requests.filter((r) => r.op === "P13").map((r) => r.status)).toEqual([503, 503, 200]);
    // random() = 128/255: each wait is 0.5 + 0.5 × 128/255 ≈ 75.1 % of the step (250 ms, then 500 ms), rounded.
    expect(sleeps).toEqual([188, 375]);
  });

  it("retries a read that got no answer", async () => {
    const { fake, client } = fakeAndClient();
    fake.inject({ op: "P13", noAnswer: "before" });
    await client.listInvoices();
    expect(fake.requests.filter((r) => r.op === "P13").map((r) => r.status)).toEqual([0, 200]);
  });

  it("gives up on a read after three attempts", async () => {
    const { fake, client } = fakeAndClient();
    fake.inject({ op: "P13", status: 500, times: 5 });
    const error = await failure(client.listInvoices());
    expect(error).toMatchObject({ operation: "P13", status: 500, paypalName: "INTERNAL_SERVER_ERROR", retryable: true, ambiguous: false });
    expect(fake.requests.filter((r) => r.op === "P13")).toHaveLength(3);
  });

  it("waits a short Retry-After, and returns a long one to the caller", async () => {
    const { fake, client, sleeps } = fakeAndClient();
    fake.inject({ op: "P13", status: 429, retryAfterSeconds: 2 });
    await client.listInvoices();
    expect(sleeps).toEqual([2_000]);
    fake.inject({ op: "P13", status: 429, retryAfterSeconds: 60 });
    const error = await failure(client.listInvoices());
    expect(error).toMatchObject({ status: 429, retryable: true, retryAfterMs: 60_000 });
  });

  it("never repeats a write that may have reached PayPal: 5xx and no answer are ambiguous", async () => {
    const { fake, client } = fakeAndClient();
    const twin = await sharedTwin(client);
    const id = twin.id ?? "";
    fake.inject({ op: "P6", status: 500 });
    const server = await failure(client.recordPayment(id, { method: "OTHER", note: echoNoteFor(KEY) }));
    expect(server).toMatchObject({ operation: "P6", status: 500, ambiguous: true });
    fake.inject({ op: "P6", noAnswer: "after" });
    const lost = await failure(client.recordPayment(id, { method: "OTHER", note: echoNoteFor(KEY) }));
    expect(lost).toMatchObject({ operation: "P6", status: 0, paypalName: "E_PAYPAL_NO_ANSWER", ambiguous: true, retryable: true });
    expect(fake.requests.filter((r) => r.op === "P6")).toHaveLength(2);
    // The lost answer's write happened: only a read can tell (src/paypal/client.ts).
    expect((await client.getInvoice(id)).payments?.transactions).toHaveLength(1);
  });

  it("repeats a throttled write (429: not processed) with the same PayPal-Request-Id", async () => {
    const { fake, client } = fakeAndClient();
    const twin = await sharedTwin(client);
    fake.inject({ op: "P8", status: 429 });
    await client.cancelInvoice(twin.id ?? "", CANCEL_SILENTLY, { requestId: "pl-cancel-3fa9c0e17b2daaaaaaaaaaaa" });
    const cancels = fake.requests.filter((r) => r.op === "P8");
    expect(cancels.map((r) => r.status)).toEqual([429, 204]);
    expect(new Set(cancels.map((r) => r.requestId))).toEqual(new Set(["pl-cancel-3fa9c0e17b2daaaaaaaaaaaa"]));
  });

  it("gives every write a request id and no read one", async () => {
    const { fake, client } = fakeAndClient();
    await sharedTwin(client);
    for (const request of fake.requests) {
      if (request.op === "P3" || request.op === "P4") {
        expect(request.requestId).toMatch(/^pl-[0-9a-f]{32}$/u);
      } else {
        expect(request.requestId, request.op ?? "").toBeNull();
      }
    }
  });

  it("times out an attempt that never answers", async () => {
    const { fake } = fakeAndClient();
    const hanging: typeof fetch = (input, init) =>
      new Promise((_resolve, reject) => {
        if (String(input instanceof Request ? input.url : input).endsWith("/v1/oauth2/token")) {
          void fake.fetch(input, init).then(_resolve, reject);
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      });
    const { client } = fakeAndClient({ client: { transport: hanging, policy: { timeoutMs: 5 } } });
    const error = await failure(client.listInvoices());
    expect(error).toMatchObject({ operation: "P13", status: 0, paypalName: "E_PAYPAL_NO_ANSWER", ambiguous: false });
  });
});

describe("operations", () => {
  it("P3 asks for the representation and returns the draft", async () => {
    const { fake, client } = fakeAndClient();
    const invoice = await client.createInvoice(twinCreateBody(twinInput()));
    expect(invoice).toMatchObject({ status: "DRAFT", detail: { reference: KEY, invoice_number: "PL-11155111-3fa9c0e17b2d" } });
    expect(fake.requests.find((r) => r.op === "P3")?.prefer).toBe("return=representation");
  });

  it("P3 follows a minimal answer (a link) with P5", async () => {
    const { fake } = fakeAndClient();
    const noPreference: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      request.headers.delete("prefer");
      return await fake.fetch(request);
    };
    const { client } = fakeAndClient({ client: { transport: noPreference } });
    const invoice = await client.createInvoice(twinCreateBody(twinInput()));
    expect(invoice.detail.reference).toBe(KEY);
    expect(fake.requests.map((r) => r.op)).toEqual(["P1", "P3", "P5"]);
  });

  it("P4 answers 200 when the issue date is today and 202 when it is in the future", async () => {
    const { client } = fakeAndClient();
    const now = await client.createInvoice(twinCreateBody(twinInput()));
    expect(await client.sendInvoice(now.id ?? "", SHARE_LINK)).toMatchObject({ status: 200, link: { rel: "payer-view" } });
    const body = twinCreateBody(twinInput({ key: `0x${"ab".repeat(32)}` }));
    const later = await client.createInvoice({ ...body, detail: { ...body.detail, invoice_date: "2026-12-01" } });
    expect((await client.sendInvoice(later.id ?? "", SHARE_LINK)).status).toBe(202);
    expect((await client.getInvoice(later.id ?? "")).status).toBe("SCHEDULED");
  });

  it("P2, P13 and P14 read; P6, P7, P8, P9, P11 write; P10 verifies", async () => {
    const { fake, client } = fakeAndClient();
    const twin = await sharedTwin(client);
    const id = twin.id ?? "";
    expect((await client.searchInvoices({ reference: KEY }, { page: 1, page_size: 10, total_required: true })).items?.map((i) => i.id)).toEqual([id]);
    expect(fake.requests.at(-1)?.query).toBe("?page=1&page_size=10&total_required=true");
    expect((await client.listInvoices({ page_size: 5 })).items).toHaveLength(1);
    await client.remindInvoice(id, REMIND_RECIPIENT);
    const recorded = await client.recordPayment(id, { method: "OTHER", payment_date: "2026-10-21", amount: { currency_code: "USD", value: "120.00" }, note: echoNoteFor(KEY) });
    expect(recorded.payment_id).toMatch(/^[0-9A-Za-z_-]{1,22}$/u);
    expect((await client.getInvoice(id)).status).toBe("MARKED_AS_PAID");
    await client.deletePayment(id, recorded.payment_id);
    expect((await client.getInvoice(id)).status).toBe("SHARED");
    await client.cancelInvoice(id, CANCEL_SILENTLY);
    expect((await client.getInvoice(id)).status).toBe("CANCELLED");
    const hook = await client.createWebhook({ url: "https://paylink-api.example/v1/paypal/webhook", event_types: [{ name: "INVOICING.INVOICE.PAID" }] });
    expect(hook.id).toMatch(/^[A-Za-z0-9]+$/u);
    const event = fake.state.eventOrder.at(-1) ?? "";
    expect((await client.getWebhookEvent(event)).event_type).toBe("INVOICING.INVOICE.CANCELLED");
  });

  it("maps PayPal's errors to name, debug id and first issue", async () => {
    const { client } = fakeAndClient();
    const draft = await client.createInvoice(twinCreateBody(twinInput()));
    const error = await failure(client.cancelInvoice(draft.id ?? "", CANCEL_SILENTLY));
    expect(error).toMatchObject({ operation: "P8", status: 422, paypalName: "UNPROCESSABLE_ENTITY", issue: "CANNOT_CANCEL_DRAFT_INVOICE", retryable: false, ambiguous: false });
    expect(error.debugId).toMatch(/^[0-9a-f]{13}$/u);
    expect((await failure(client.getInvoice("INV2-NONE-NONE-NONE-NONE"))).status).toBe(404);
  });

  it("refuses ids, pages and request ids it would not put on the wire, before sending anything", async () => {
    const { fake, client } = fakeAndClient();
    for (const bad of ["../v1/oauth2/token", "INV2 1", "", "a".repeat(129), "INV2-%2F"]) {
      expect(await failure(client.getInvoice(bad)), bad).toMatchObject({ paypalName: "E_PAYPAL_INVALID_INPUT", status: 0 });
    }
    expect(await failure(client.listInvoices({ page: 0 }))).toMatchObject({ paypalName: "E_PAYPAL_INVALID_INPUT" });
    expect(await failure(client.listInvoices({ page_size: 101 }))).toMatchObject({ paypalName: "E_PAYPAL_INVALID_INPUT" });
    expect(await failure(client.cancelInvoice("INV2-AAAA-BBBB-CCCC-DDDD", CANCEL_SILENTLY, { requestId: "has space" }))).toMatchObject({ paypalName: "E_PAYPAL_INVALID_INPUT" });
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an answer it cannot read", async () => {
    const { fake } = fakeAndClient();
    const garbled: typeof fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      return new URL(new Request(input, init).url).pathname.endsWith("/token") ? response : new Response('{"items": "not a list"}', { status: 200 });
    };
    const { client } = fakeAndClient({ client: { transport: garbled } });
    expect(await failure(client.listInvoices())).toMatchObject({ operation: "P13", status: 200, paypalName: "E_PAYPAL_UNEXPECTED_RESPONSE", retryable: false });
  });
});

describe("P10 splice", () => {
  it("puts the raw event in the body byte for byte, after the six other members", () => {
    const raw = '{ "id" : "WH-1",\n  "event_type":"INVOICING.INVOICE.PAID", "resource": {"x": "\\u00e9"} }';
    const body = spliceVerification({ auth_algo: "SHA256withRSA", cert_url: "https://c/x", transmission_id: "t-1", transmission_sig: "s==", transmission_time: "2026-10-21T12:00:00Z", webhook_id: "WH123" }, raw);
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body)).toMatchObject({ webhook_id: "WH123", webhook_event: { id: "WH-1" } });
  });

  it("refuses an event that is not one JSON object", () => {
    for (const raw of ["", "[]", "null", "{", '"x"', '{"a":1} {"b":2}']) {
      expect(() => spliceVerification({ auth_algo: "A", cert_url: "https://c/x", transmission_id: "t", transmission_sig: "s", transmission_time: "2026-10-21T12:00:00Z", webhook_id: "W" }, raw), raw).toThrow(/P10/u);
    }
  });
});

describe("logs", () => {
  it("say which operation, status and attempt, and never carry the token, the secret, a body or an id", async () => {
    const { fake, client, log } = fakeAndClient();
    fake.inject({ op: "P5", status: 503 });
    const twin = await sharedTwin(client);
    const text = log.lines.join("\n");
    const token = JSON.parse(fake.requests.find((r) => r.op === "P1")?.response ?? "{}") as { access_token: string };
    expect(text).not.toContain(token.access_token);
    expect(text).not.toContain(fake.credentials.clientSecret);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(twin.id ?? "unreachable");
    expect(text).not.toContain("Sarah");
    const calls = log.events().filter((e) => e["event"] === "paypal.call");
    expect(calls.map((e) => `${String(e["op"])}:${String(e["status"])}:${String(e["attempt"])}`)).toEqual(["P1:200:1", "P3:201:1", "P4:200:1", "P5:503:1", "P5:200:2"]);
    expect(calls.find((e) => e["op"] === "P3")?.["paypalRequestId"]).toMatch(/^pl-/u);
  });
});
