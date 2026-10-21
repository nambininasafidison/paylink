// SPDX-License-Identifier: MIT
/**
 * One PayPal twin per key (src/paypal/twin.ts, docs/paypal/SPEC.md §3.2 "Twin"): found before it is made, never made
 * twice when PayPal's answer is lost, sent once, read back; partial reference matches ignored; a scheduled send
 * reported.
 */
import { describe, expect, it } from "vitest";
import { isPayPalError } from "../../src/paypal/client.ts";
import { twinCreateBody } from "../../src/paypal/invoice.ts";
import { ensureTwin, findTwins } from "../../src/paypal/twin.ts";
import { KEY, OTHER_KEY, twinInput } from "./fixtures.ts";
import { fakeAndClient } from "./support.ts";

const body = twinCreateBody(twinInput());

describe("ensureTwin", () => {
  it("creates, shares and reads back a new twin: P2, P3, P4, P5 with deterministic request ids", async () => {
    const { fake, client } = fakeAndClient();
    const twin = await ensureTwin(client, KEY, body);
    expect(twin).toMatchObject({ origin: "created", send: 200, duplicates: [], invoice: { status: "SHARED", detail: { reference: KEY } } });
    expect(fake.requests.filter((r) => r.op !== "P1").map((r) => r.op)).toEqual(["P2", "P3", "P4", "P5"]);
    expect(fake.requests.find((r) => r.op === "P3")?.requestId).toBe(`pl-create-${KEY.slice(2, 26)}`);
    expect(fake.requests.find((r) => r.op === "P4")?.requestId).toBe(`pl-send-${KEY.slice(2, 26)}`);
  });

  it("is idempotent: a retried call finds the twin and writes nothing", async () => {
    const { fake, client } = fakeAndClient();
    const first = await ensureTwin(client, KEY, body);
    const before = fake.requests.length;
    const again = await ensureTwin(client, KEY, body);
    expect(again).toMatchObject({ origin: "found", send: null, invoice: { id: first.invoice.id } });
    expect(fake.requests.slice(before).map((r) => r.op)).toEqual(["P2", "P5"]);
    expect(fake.state.invoices.size).toBe(1);
  });

  it("never makes a second invoice when P3's answer is lost after PayPal made it", async () => {
    const { fake, client } = fakeAndClient();
    fake.inject({ op: "P3", noAnswer: "after" });
    const twin = await ensureTwin(client, KEY, body);
    expect(twin).toMatchObject({ origin: "found", send: 200, invoice: { status: "SHARED" } });
    expect(fake.state.invoices.size).toBe(1);
    expect(fake.requests.filter((r) => r.op !== "P1").map((r) => r.op)).toEqual(["P2", "P3", "P2", "P4", "P5"]);
  });

  it("reports the failure when P3 got no answer and made nothing (the caller tries again later)", async () => {
    const { fake, client } = fakeAndClient();
    fake.inject({ op: "P3", noAnswer: "before" });
    await expect(ensureTwin(client, KEY, body)).rejects.toSatisfy((e: unknown) => isPayPalError(e) && e.ambiguous);
    expect(fake.state.invoices.size).toBe(0);
    const twin = await ensureTwin(client, KEY, body);
    expect(twin.origin).toBe("created");
  });

  it("sends a twin left in DRAFT by an earlier run", async () => {
    const { fake, client } = fakeAndClient();
    await client.createInvoice(body);
    const twin = await ensureTwin(client, KEY, body);
    expect(twin).toMatchObject({ origin: "found", send: 200, invoice: { status: "SHARED" } });
    expect(fake.state.invoices.size).toBe(1);
  });

  it("settles a P4 whose answer was lost by reading the invoice", async () => {
    const { fake, client } = fakeAndClient();
    fake.inject({ op: "P4", noAnswer: "after" });
    const twin = await ensureTwin(client, KEY, body);
    expect(twin).toMatchObject({ send: "settled-by-read", invoice: { status: "SHARED" } });
  });

  it("keeps the failure when P4's answer was lost before PayPal sent anything", async () => {
    const { fake, client } = fakeAndClient();
    fake.inject({ op: "P4", noAnswer: "before" });
    await expect(ensureTwin(client, KEY, body)).rejects.toSatisfy((e: unknown) => isPayPalError(e) && e.operation === "P4");
    expect([...fake.state.invoices.values()].map((i) => i.status)).toEqual(["DRAFT"]);
  });

  it("reports a scheduled send (202)", async () => {
    const { client } = fakeAndClient();
    const twin = await ensureTwin(client, KEY, { ...body, detail: { ...body.detail, invoice_date: "2026-12-01" } });
    expect(twin).toMatchObject({ send: 202, invoice: { status: "SCHEDULED" } });
  });

  it("ignores invoices whose reference only contains the key, and picks the oldest of exact duplicates", async () => {
    const { fake, client } = fakeAndClient();
    const longer = twinCreateBody(twinInput({ key: OTHER_KEY }));
    await client.createInvoice({ ...longer, detail: { ...longer.detail, reference: `${KEY}-copy`, invoice_number: "OTHER-1" } });
    expect(await findTwins(client, KEY)).toEqual([]);
    const first = await client.createInvoice(body);
    const second = await client.createInvoice({ ...body, detail: { ...body.detail, invoice_number: "PL-dup" } });
    const twin = await ensureTwin(client, KEY, body);
    expect(twin.invoice.id).toBe(first.id);
    expect(twin.duplicates).toEqual([second.id]);
    expect(fake.state.invoices.size).toBe(3);
  });

  it("refuses a body whose reference is not the key", async () => {
    const { client } = fakeAndClient();
    await expect(ensureTwin(client, OTHER_KEY, body)).rejects.toThrow(RangeError);
  });
});
