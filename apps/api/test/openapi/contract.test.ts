// SPDX-License-Identifier: MIT
/**
 * L0 (docs/paypal/SPEC.md §15.2): every request the PayPal client sends and every answer it parses, in success and in
 * refusal, validates against the operation's schema in PayPal's vendored OpenAPI files, for every operation PayLink
 * uses (P2–P11, P13, P14; P1 is in neither file) and under every behaviour the fake can be switched to. The bodies
 * PayLink builds (src/paypal/invoice.ts) validate for any input the builder accepts (fast-check).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PayPalOperationId } from "../../src/paypal/client.ts";
import { isPayPalError, PAYPAL_OPERATIONS } from "../../src/paypal/client.ts";
import type { FakeBehaviour } from "../../src/paypal/fake/index.ts";
import { createPayPalFake } from "../../src/paypal/fake/index.ts";
import { createHttpPayPalClient } from "../../src/paypal/http.ts";
import { CANCEL_SILENTLY, REMIND_RECIPIENT, SHARE_LINK, TwinInputError, twinCreateBody } from "../../src/paypal/invoice.ts";
import { readTransmission, verifyDelivery } from "../../src/paypal/webhook.ts";
import { echoNoteFor, KEY, OTHER_KEY, twinInput } from "../paypal/fixtures.ts";
import { T0 } from "../paypal/support.ts";
import { contractTransport, contractValidator, loadSpec, SANDBOX_REMIND_400_ISSUE, SPEC_FILES } from "./contract.ts";

const silent = { log: () => undefined, child: () => silent };

async function settles(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (isPayPalError(error)) {
      return `${String(error.status)} ${error.issue ?? error.paypalName ?? ""}`;
    }
    throw error;
  }
}

/** Runs every operation, in success and refusal, through the contract transport; returns what it saw. */
async function scenario(behaviour: Partial<FakeBehaviour> = {}): Promise<{ exchanges: ReturnType<typeof contractTransport>["exchanges"]; outcomes: string[] }> {
  const fake = createPayPalFake({ clock: () => T0, behaviour });
  const checked = contractTransport(fake.fetch);
  const client = createHttpPayPalClient({ baseUrl: fake.baseUrl, credentials: fake.credentials, transport: checked.fetch, clock: () => T0, random: (n) => new Uint8Array(n).fill(7), logger: silent, sleep: () => Promise.resolve() });
  const outcomes: string[] = [];
  const note = async (label: string, promise: Promise<unknown>): Promise<void> => {
    outcomes.push(`${label}: ${await settles(promise)}`);
  };

  await note("P2 none", client.searchInvoices({ reference: KEY }, { page: 1, page_size: 20, total_required: true }));
  const draft = await client.createInvoice(twinCreateBody(twinInput()));
  const id = draft.id ?? "";
  await note("P3 same number", client.createInvoice(twinCreateBody(twinInput())));
  await note("P8 draft", client.cancelInvoice(id, CANCEL_SILENTLY));
  await note("P4", client.sendInvoice(id, SHARE_LINK));
  await note("P4 again", client.sendInvoice(id, SHARE_LINK));
  await note("P2 found", client.searchInvoices({ reference: KEY }));
  await note("P13", client.listInvoices({ page: 1, page_size: 10 }));
  await note("P9", client.remindInvoice(id, REMIND_RECIPIENT));
  await note("P6 too much", client.recordPayment(id, { method: "OTHER", amount: { currency_code: "USD", value: "999.00" }, note: echoNoteFor(KEY) }));
  const recorded = await client.recordPayment(id, { method: "OTHER", payment_date: "2026-10-21", amount: { currency_code: "USD", value: "120.00" }, note: echoNoteFor(KEY) });
  await note("P5 recorded", client.getInvoice(id));
  await note("P8 paid", client.cancelInvoice(id, CANCEL_SILENTLY));
  await note("P7", client.deletePayment(id, recorded.payment_id));
  await note("P7 again", client.deletePayment(id, recorded.payment_id));
  await note("P8", client.cancelInvoice(id, CANCEL_SILENTLY));
  await note("P8 again", client.cancelInvoice(id, CANCEL_SILENTLY));
  await note("P5 missing", client.getInvoice("INV2-NONE-NONE-NONE-NONE"));

  // A second twin without an email: PayPal's reminder is refused, as the sandbox refused it (the capture of 2026-10-29).
  const silentTwin = await client.createInvoice(twinCreateBody(twinInput({ key: OTHER_KEY, recipient: { givenName: "Tom" } })));
  await client.sendInvoice(silentTwin.id ?? "", SHARE_LINK);
  await note("P9 no email", client.remindInvoice(silentTwin.id ?? "", REMIND_RECIPIENT));
  fake.pay(silentTwin.id ?? "");
  await note("P5 paid", client.getInvoice(silentTwin.id ?? ""));

  await note("P11", client.createWebhook({ url: "https://paylink-api.example/v1/paypal/other", event_types: [{ name: "INVOICING.INVOICE.PAID" }] }));
  await note("P11 again", client.createWebhook({ url: "https://paylink-api.example/v1/paypal/other", event_types: [{ name: "INVOICING.INVOICE.PAID" }] }));

  const event = fake.state.events.get(fake.state.eventOrder.at(-1) ?? "");
  if (event === undefined) {
    throw new Error("no event");
  }
  await note("P14", client.getWebhookEvent(event.id));
  // P10: sign one delivery on a fake whose deliveries are recorded, then ask the same fake to verify it, as received
  // and tampered.
  const recorder: { headers: Headers; body: string }[] = [];
  const signer = createPayPalFake({
    clock: () => T0,
    behaviour,
    deliver: (_url, init) => {
      recorder.push({ headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : "" });
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  });
  signer.connect({ webhookUrl: "https://paylink-api.example/v1/paypal/webhook" });
  const signerChecked = contractTransport(signer.fetch);
  const signerClient = createHttpPayPalClient({ baseUrl: signer.baseUrl, credentials: signer.credentials, transport: signerChecked.fetch, clock: () => T0, random: (n) => new Uint8Array(n).fill(9), logger: silent, sleep: () => Promise.resolve() });
  const twin = await signerClient.createInvoice(twinCreateBody(twinInput()));
  await signerClient.sendInvoice(twin.id ?? "", SHARE_LINK);
  signer.pay(twin.id ?? "");
  await signer.flush();
  const delivery = recorder.at(-1);
  const transmission = readTransmission((name) => delivery?.headers.get(name));
  if (delivery === undefined || !transmission.ok) {
    throw new Error("no signed delivery");
  }
  outcomes.push(`P10 genuine: ${(await verifyDelivery(signerClient, signer.webhookId, transmission.transmission, delivery.body)).verified ? "SUCCESS" : "FAILURE"}`);
  outcomes.push(`P10 tampered: ${(await verifyDelivery(signerClient, signer.webhookId, transmission.transmission, delivery.body.replace("PAID", "PAYD"))).verified ? "SUCCESS" : "FAILURE"}`);
  signer.revokeTokens();
  await signerClient.listInvoices();
  return { exchanges: [...checked.exchanges, ...signerChecked.exchanges], outcomes };
}

describe("L0: requests and answers against the vendored schemas", () => {
  it("covers every operation PayLink uses, in success and refusal, with no schema violation", async () => {
    const { exchanges, outcomes } = await scenario();
    expect(outcomes).toEqual([
      "P2 none: ok",
      "P3 same number: 422 UNPROCESSABLE_ENTITY",
      "P8 draft: 422 CANNOT_CANCEL_DRAFT_INVOICE",
      "P4: ok",
      "P4 again: 422 INVOICE_ALREADY_SENT",
      "P2 found: ok",
      "P13: ok",
      "P9: ok",
      "P6 too much: 422 PAYMENT_AMOUNT_GREATER_THAN_AMOUNT_DUE",
      "P5 recorded: ok",
      "P8 paid: 422 CANNOT_CANCEL_PAID_INVOICE",
      "P7: ok",
      "P7 again: 404 INVALID_RESOURCE_ID",
      "P8: ok",
      "P8 again: 422 INVOICE_CANCELED_ALREADY",
      "P5 missing: 404 INVALID_RESOURCE_ID",
      "P9 no email: 400 CANNOT_REMIND_AS_BILLING_INFO_ABSENT",
      "P5 paid: ok",
      "P11: ok",
      "P11 again: 400 WEBHOOK_URL_ALREADY_EXISTS",
      "P14: ok",
      "P10 genuine: SUCCESS",
      "P10 tampered: FAILURE",
    ]);
    const violations = exchanges.filter((e) => e.requestProblems.length > 0 || e.responseProblems.length > 0);
    expect(violations).toEqual([]);
    const covered = new Set(exchanges.map((e) => e.op));
    const expected = Object.keys(PAYPAL_OPERATIONS) as PayPalOperationId[];
    expect([...covered].sort()).toEqual([...expected].sort());
    expect(exchanges.some((e) => e.status === 401)).toBe(true);
    expect(exchanges.filter((e) => e.status >= 400).map((e) => e.op)).toEqual(expect.arrayContaining(["P3", "P4", "P5", "P6", "P7", "P8", "P9", "P11", "P13"]));
  });

  it.each<Partial<FakeBehaviour>>([
    { statusAfterRecord: "PAID" },
    { statusAfterRecord: "PAID_EXTERNAL" },
    { statusAfterShare: "SENT" },
    { statusAfterShare: "SHARED" },
    { referenceSearch: "exact" },
    { eventResource: "flat" },
    { remindRequiresEmail: false },
  ])("stays valid with the fake's behaviour %o", async (behaviour) => {
    const { exchanges } = await scenario(behaviour);
    expect(exchanges.filter((e) => e.requestProblems.length > 0 || e.responseProblems.length > 0)).toEqual([]);
  });
});

describe("L0: the one sandbox answer the files do not list", () => {
  const validator = contractValidator();
  const refusal = (issue: string): string => JSON.stringify({ name: "INVALID_REQUEST", message: "Request is not well-formed, syntactically incorrect, or violates schema.", debug_id: "f00", details: [{ issue }] });

  it("accepts P9's 400 CANNOT_REMIND_AS_BILLING_INFO_ABSENT (the capture of 2026-10-29) and still refuses any other new issue", () => {
    expect(SANDBOX_REMIND_400_ISSUE).toBe("CANNOT_REMIND_AS_BILLING_INFO_ABSENT");
    expect(validator.response("P9", 400, refusal(SANDBOX_REMIND_400_ISSUE))).toEqual([]);
    expect(validator.response("P9", 400, refusal("INVALID_STRING_MAX_LENGTH"))).toEqual([]);
    expect(validator.response("P9", 400, refusal("SOMETHING_ELSE")).length).toBeGreaterThan(0);
    expect(validator.response("P8", 400, refusal(SANDBOX_REMIND_400_ISSUE)).length).toBeGreaterThan(0);
  });
});

describe("L0: the bodies PayLink builds", () => {
  const validator = contractValidator();

  it("P3: every twin body the builder accepts validates as an invoice (fast-check)", () => {
    const text = fc.string({ maxLength: 220 });
    fc.assert(
      fc.property(
        fc.record({
          key: fc.stringMatching(/^[0-9a-f]{64}$/u).map((hex) => `0x${hex}` as const),
          chainId: fc.integer({ min: 1, max: 99_999_999_999 }),
          cents: fc.bigInt({ min: 1n, max: 10n ** 15n }),
          description: fc.option(text, { nil: null }),
          dueDate: fc.option(fc.date({ min: new Date("2026-01-01"), max: new Date("2030-12-31"), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10)), { nil: null }),
          givenName: fc.option(fc.string({ maxLength: 150 }), { nil: undefined }),
          email: fc.option(fc.constantFrom("sarah@example.com", "a.b+c@example.co.uk", "bad@", "x@y"), { nil: undefined }),
        }),
        (input) => {
          const amountUsd = `${(input.cents / 100n).toString()}.${(input.cents % 100n).toString().padStart(2, "0")}`;
          let body;
          try {
            body = twinCreateBody(
              twinInput({
                key: input.key,
                chainId: input.chainId,
                amountUsd,
                description: input.description,
                dueDate: input.dueDate,
                recipient: { ...(input.givenName === undefined ? {} : { givenName: input.givenName }), ...(input.email === undefined ? {} : { email: input.email }) },
              }),
            );
          } catch (error) {
            expect(error).toBeInstanceOf(TwinInputError);
            return;
          }
          expect(validator.request("P3", JSON.stringify(body))).toEqual([]);
          expect(body.detail.invoice_number?.length).toBeLessThanOrEqual(25);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("P4, P8, P9: the three notifications; P2: the search; P6: the external payment of §7.3", () => {
    for (const notification of [SHARE_LINK, REMIND_RECIPIENT, CANCEL_SILENTLY]) {
      expect(validator.request("P4", JSON.stringify(notification))).toEqual([]);
    }
    expect(validator.request("P2", JSON.stringify({ reference: KEY }))).toEqual([]);
    expect(validator.request("P6", JSON.stringify({ method: "OTHER", payment_date: "2026-10-21", amount: { currency_code: "USD", value: "120.00" }, note: echoNoteFor(KEY) }))).toEqual([]);
    expect(validator.request("P6", JSON.stringify({ method: "OTHER", note: "x".repeat(2001) })).join()).toMatch(/note/u);
    expect(validator.request("P11", JSON.stringify({ url: "https://paylink-api.raherizonambinina.workers.dev/v1/paypal/webhook", event_types: [{ name: "INVOICING.INVOICE.PAID" }] }))).toEqual([]);
  });

  it("knows the three corrections it makes to the files, and no other", () => {
    const invoicing = loadSpec(SPEC_FILES.invoicing);
    const webhooks = loadSpec(SPEC_FILES.webhooks);
    expect(JSON.stringify((invoicing.components.schemas["payment_reference"] as { properties: unknown }).properties)).toContain('"minLength":"1"');
    expect(JSON.stringify((webhooks.components.schemas["verify_webhook_signature"] as { properties: unknown }).properties)).toContain("transmission_sig");
    // The files list two issues for P9's 400, not the one the sandbox answered on 2026-10-29: correction 3 adds it.
    const remind400 = JSON.stringify(invoicing.components.schemas["invoices.remind-400"]);
    expect([...remind400.matchAll(/"title":"([A-Z_]+)"/gu)].map((m) => m[1])).toEqual(["INVALID_STRING_MAX_LENGTH", "INVALID_ARRAY_MAX_ITEMS"]);
    expect(remind400).not.toContain(SANDBOX_REMIND_400_ISSUE);
    expect(validator.response("P6", 200, JSON.stringify({ payment_id: "EXTR-86F38350LX4353815" }))).toEqual([]);
    expect(validator.response("P6", 200, JSON.stringify({ payment_id: "x".repeat(23) })).join()).toMatch(/payment_id/u);
  });
});
