// SPDX-License-Identifier: MIT
/**
 * Both rails through the whole API in process (./world.ts): a twin made by POST /v1/twin, then
 *
 * - the PayPal rail: the payer pays on PayPal (the fake), PayPal delivers a signed webhook to the API's route, the route
 *   verifies it (P10), reads the invoice (P5) and hands it to the reconciler, which lights the twin as paid via PayPal
 *   (S2) and proposes closing the PayLink link (`cancel_paylink`); the pay page's rail says `paid`; a replayed delivery
 *   changes nothing (docs/paypal/SPEC.md §3.2 "PayPal payment");
 * - the chain rail: the chain shows a verified payment, the reconciler records it on the PayPal twin (P6 with the §7.3
 *   note, S3's automatic record), PayPal reports the record, and the echo filter keeps the twin "closed", never "paid
 *   twice" (§3.2 "Cross-rail close", §10.3).
 */
import type { RailsResponse, TwinView } from "@paylink/api-contract";
import { describe, expect, it } from "vitest";
import { TWIN_FRESH_MS } from "../../src/routes/twin.ts";
import { link, PAYEE, USDC, world } from "./world.ts";

describe("the PayPal rail", () => {
  it("a PayPal payment reaches the twin through a verified webhook, and nothing else lights it", async () => {
    const w = world();
    const { url, key } = await link();
    const twin = (await (await w.post({ link: url, recipient: { givenName: "Sarah", email: "sarah@example.com" } })).json()) as TwinView;
    expect(twin).toMatchObject({ status: "UNPAID", situation: "S1" });

    w.fake.pay(twin.paypalId);
    await w.fake.settled();
    expect(w.fake.state.deliveries.map((d) => [d.state, d.lastStatus])).toEqual([["delivered", 200]]);
    expect(w.fake.requests.filter((r) => r.op === "P10").map((r) => r.status)).toEqual([200]);

    const after = (await (await w.get(`/v1/twin/${key}`, "payee")).json()) as TwinView;
    expect(after).toMatchObject({ status: "PAID", statusClass: "paid", situation: "S2" });
    const proposals = await w.services.stores.payee(PAYEE.address).listProposals();
    // S1's reminder text went stale when the twin was paid; the one open proposal closes the PayLink link.
    expect(proposals.filter((p) => p.state === "open").map((p) => p.kind)).toEqual(["cancel_paylink"]);
    expect((await (await w.get(`/v1/rails/${key}`)).json()) as RailsResponse).toMatchObject({ status: "paid", url: null });

    // The same delivery again: recorded already, nothing read, nothing changed.
    const reads = w.fake.requests.filter((r) => r.op === "P5").length;
    const event = w.fake.state.events.get(w.fake.state.eventOrder.at(-1) ?? "");
    expect(event?.eventType).toBe("INVOICING.INVOICE.PAID");
    w.fake.state.deliveries.push({ eventId: event?.id ?? "", subscriptionId: w.fake.webhookId, attempts: 0, state: "pending", lastStatus: null });
    await w.fake.flush();
    expect(w.fake.requests.filter((r) => r.op === "P5")).toHaveLength(reads);
    expect(await w.services.stores.payee(PAYEE.address).listProposals()).toEqual(proposals);
  });

  it("a forged delivery naming the twin changes nothing", async () => {
    const w = world();
    const { url, key } = await link();
    const twin = (await (await w.post({ link: url })).json()) as TwinView;
    const forged = JSON.stringify({ id: "WH-FORGED-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: twin.paypalId, status: "PAID" } } });
    const response = await w.app.request("/v1/paypal/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1",
        "paypal-transmission-id": "6d2c1a3e-0000-4000-8000-000000000001",
        "paypal-transmission-sig": "Zm9yZ2Vk",
        "paypal-transmission-time": "2026-10-21T12:00:00Z",
      },
      body: forged,
    });
    expect(response.status).toBe(400);
    w.clock.now += TWIN_FRESH_MS - 1;
    expect((await (await w.get(`/v1/twin/${key}`, "payee")).json()) as TwinView).toMatchObject({ status: "UNPAID", situation: "S1" });
  });
});

describe("the chain rail", () => {
  it("a verified chain payment is recorded on the PayPal twin, and PayPal's echo keeps it closed, not paid twice", async () => {
    const w = world();
    const { url, key } = await link();
    const twin = (await (await w.post({ link: url })).json()) as TwinView;
    const txHash: `0x${string}` = `0x${"ab".repeat(32)}`;
    w.chain = (now) => ({
      state: "paid",
      payments: [{ txHash, logIndex: 1, blockNumber: 11_960_000, timestamp: Math.floor(now / 1000) - 120, payer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", amount: "120000000", token: USDC, rail: "USDC" }],
      paidAt: Math.floor(now / 1000) - 120,
      chainTime: Math.floor(now / 1000),
    });
    w.clock.now += TWIN_FRESH_MS;
    const after = (await (await w.get(`/v1/twin/${key}`, "payee")).json()) as TwinView;

    const recorded = w.fake.invoice(twin.paypalId) as { status: string; payments: { transactions: { type: string; method: string; note: string; amount: { value: string } }[] } };
    expect(recorded.payments.transactions).toEqual([expect.objectContaining({ type: "EXTERNAL", method: "OTHER", note: `PayLink · eip155:11155111 · tx ${txHash} · key ${key}`, amount: expect.objectContaining({ value: "120.00" }) as unknown })]);
    expect(recorded.status).toBe("MARKED_AS_PAID");
    expect(after.statusClass).toBe("paid-outside");
    expect(after.situation).toBe("S8");
    expect(await w.services.stores.payee(PAYEE.address).listAlerts()).toEqual([]);
    expect((await (await w.get(`/v1/rails/${key}`)).json()) as RailsResponse).toMatchObject({ status: "paid", url: null });
  });
});
