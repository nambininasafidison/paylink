// SPDX-License-Identifier: MIT
/**
 * The owner's capture run (apps/api/scripts/capture/) against the PayPal fake: it exercises every behaviour the spine
 * tagged UNVERIFIED, records what it saw as findings, and writes a report with no secret and no personal data. Run with
 * the fake switched to each alternative, its findings name the alternative (so a sandbox run will tell them apart).
 */
import { describe, expect, it } from "vitest";
import { paths, redact, urlShape } from "../../scripts/capture/report.ts";
import type { CaptureReport } from "../../scripts/capture/report.ts";
import { runCapture } from "../../scripts/capture/run.ts";
import type { FakeBehaviour } from "../../src/paypal/fake/index.ts";
import { fakeAndClient, manualClock } from "./support.ts";

async function capture(behaviour: Partial<FakeBehaviour> = {}, options: { readonly pay?: boolean } = {}): Promise<{ report: CaptureReport; json: string; secret: string; lines: string[] }> {
  const clock = manualClock();
  const { fake, client } = fakeAndClient({ clock: clock.now, fake: { behaviour } });
  const lines: string[] = [];
  let n = 0;
  const report = await runCapture({
    paypal: client,
    base: "http://paypal.fake.invalid",
    hasWebhookId: false,
    clock: clock.now,
    random: (bytes) => {
      n += 1;
      return new Uint8Array(bytes).fill(n);
    },
    say: (line) => lines.push(line),
    waitForPayment:
      options.pay === false
        ? null
        : (_url, invoiceId) => {
            fake.pay(invoiceId);
            return Promise.resolve();
          },
    listEvents: async () => {
      const token = await client.token();
      const response = await fake.fetch(`${fake.baseUrl}/v1/notifications/webhooks-events?event_type=INVOICING.INVOICE.PAID`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      return (await response.json()) as unknown;
    },
    keep: false,
  });
  return { report, json: JSON.stringify(report), secret: fake.credentials.clientSecret, lines };
}

/** What a flat event's paths contain (an asymmetric matcher, typed as the value it stands for). */
const FLAT_EVENT_PATHS: unknown = expect.arrayContaining(["resource.id", "resource.status"]);

describe("the capture run", () => {
  it("records every UNVERIFIED behaviour as a finding", async () => {
    const { report } = await capture();
    expect(report.findings).toEqual({
      tokenLifetimeSeconds: 32_400,
      tokenScopes: ["https://uri.paypal.com/services/invoicing"],
      createWithDueDateOnly: "accepted",
      createWithTermTypeAndDueDate: "refused:400:INVALID_REQUEST:INVALID_PARAMETER_SYNTAX",
      createWithoutEmail: "accepted",
      sendAnswer: "200",
      statusAfterShare: "SHARED",
      shareWithoutEmail: "accepted",
      recipientViewUrl: "http://paypal.fake.invalid/invoice/p/{id}",
      referenceSearch: "partial",
      remindWithEmail: "accepted",
      remindWithoutEmail: "refused:422:UNPROCESSABLE_ENTITY:CANNOT_REMIND_INVOICE",
      payerPayment: "paid",
      statusAfterPayerPayment: "PAID",
      payerTransaction: { type: "PAYPAL", method: "PAYPAL" },
      webhookEventPaths: expect.arrayContaining(["resource", "resource.invoice", "resource.invoice.id", "resource.invoice.status", "event_type"]) as unknown,
      statusAfterRecord: "MARKED_AS_PAID",
      recordNote: "exact",
      paymentIdShape: { length: 22, pattern: true },
      undoWithPaymentId: "accepted",
      statusAfterUndo: "SHARED",
      cancelAfterUndo: "accepted",
      statusAfterCancel: "CANCELLED",
    });
    expect(report.steps.map((s) => s.id)).toEqual([
      "token",
      "create-a",
      "create-b",
      "create-c",
      "send-a",
      "read-a",
      "send-c",
      "read-c",
      "search-exact",
      "search-partial",
      "remind-a",
      "remind-c",
      "payer-paid-a",
      "events-paid",
      "create-d",
      "send-d",
      "record-d",
      "read-d-recorded",
      "undo-d",
      "read-d-undone",
      "cancel-d",
      "read-d-cancelled",
      "cleanup-c",
    ]);
    // The fake refuses term_type with due_date ("either but not both", V), so there is no draft B to leave behind.
  });

  it.each<[Partial<FakeBehaviour>, Record<string, unknown>]>([
    [{ statusAfterShare: "SENT" }, { statusAfterShare: "SENT", statusAfterUndo: "SENT" }],
    [{ statusAfterRecord: "PAID_EXTERNAL" }, { statusAfterRecord: "PAID_EXTERNAL" }],
    [{ referenceSearch: "exact" }, { referenceSearch: "exact" }],
    [{ remindRequiresEmail: false }, { remindWithoutEmail: "accepted" }],
    [{ eventResource: "flat" }, { webhookEventPaths: FLAT_EVENT_PATHS }],
  ])("tells the alternatives apart (%o)", async (behaviour, expected) => {
    const { report } = await capture(behaviour);
    expect(report.findings).toMatchObject(expected);
  });

  it("skips the payer's step unless asked, and says so", async () => {
    const { report } = await capture({}, { pay: false });
    expect(report.findings).toMatchObject({ payerPayment: "not-run", statusAfterPayerPayment: null, webhookEventPaths: null });
    expect(report.steps.find((s) => s.id === "payer-pays")?.outcome).toEqual({ result: "skipped", reason: "not asked (--wait-payment)" });
  });

  it("keeps no secret and no personal data in the report", async () => {
    const { report, json, secret, lines } = await capture();
    for (const forbidden of [secret, "FAKE-CLIENT-ID", "A21AA", "payer@example.com", "Capture", "PayLink capture run", "PL-11155111-", "INV2-", "EXTR-", "0x01010101", "0x0000000000000000000000000000000000000001"]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
    expect(report.credentials).toEqual({ clientId: "present", clientSecret: "present", webhookId: "absent" });
    expect(lines.join("\n")).not.toContain(secret);
    expect(report.manual).toHaveLength(3);
  });
});

describe("the report's redaction", () => {
  it("keeps codes and amounts, shapes URLs, and replaces every other string", () => {
    expect(
      redact({
        status: "PAID",
        name: "UNPROCESSABLE_ENTITY",
        detail: { reference: "0xabc", memo: "PayLink twin · payee 0x…", invoice_number: "PL-1", metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#INV2-ABCD-1234-EFGH-5678", create_time: "2026-10-21T12:00:00Z" } },
        invoicer: { email_address: "merchant@example.com", name: { given_name: "Rina" } },
        amount: { currency_code: "USD", value: "1.00" },
        payments: { transactions: [{ type: "EXTERNAL", method: "OTHER", payment_date: "2026-10-21", note: "PayLink · …" }] },
        links: [{ href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-ABCD-1234-EFGH-5678?x=1", rel: "self", method: "GET" }],
        count: 3,
        ok: true,
      }),
    ).toEqual({
      status: "PAID",
      name: "UNPROCESSABLE_ENTITY",
      detail: { reference: "<string:5>", memo: "<string:24>", invoice_number: "<string:4>", metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#{id}", create_time: "<date-time>" } },
      invoicer: { email_address: "<string:20>", name: { given_name: "<string:4>" } },
      amount: { currency_code: "USD", value: "1.00" },
      payments: { transactions: [{ type: "EXTERNAL", method: "OTHER", payment_date: "<date>", note: "<string:11>" }] },
      links: [{ href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/{id}?{query}", rel: "self", method: "GET" }],
      count: 3,
      ok: true,
    });
    expect(urlShape("not a url")).toBe("<string:9>");
    expect(redact({ name: "Rina Rakoto" })).toEqual({ name: "<string:11>" });
  });

  it("lists an object's member paths", () => {
    expect(paths({ id: "x", resource: { invoice: { id: "y" } }, links: [{ href: "z" }] })).toEqual(["id", "resource", "resource.invoice", "resource.invoice.id", "links", "links[].href"]);
  });
});
