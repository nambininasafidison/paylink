// SPDX-License-Identifier: MIT
/**
 * POST /v1/twin, GET /v1/twin/:key and GET /v1/rails/:key (src/routes/twin.ts) over the API's real services (the
 * reconciler's engine and in-memory stores), the PayPal fake, Ethereum Sepolia with PayLinkV2 recorded at its CREATE2
 * address (as it will be once deployed), a chain reader answering "payable", and links signed with an anvil key
 * (./world.ts).
 */
import type { ApiProblem, RailsResponse, TwinView } from "@paylink/api-contract";
import { registry as shippedRegistry } from "@paylink/chains";
import { describe, expect, it } from "vitest";
import { railsView, TWIN_FRESH_MS } from "../../src/routes/twin.ts";
import type { TwinRecord } from "../../src/store/types.ts";
import { T0 } from "../helpers.ts";
import { link, PAGES, PAYEE, PYUSD, world } from "./world.ts";

const harness = world;

const problem = async (response: Response): Promise<ApiProblem> => (await response.json()) as ApiProblem;

describe("POST /v1/twin", () => {
  it("makes the twin once: P2, P3, P4, P5, registered with the reconciler, answered 201", async () => {
    const h = harness();
    const { url, key } = await link();
    const response = await h.post({ link: url, recipient: { givenName: "Sarah", email: "sarah@example.com" }, dueDate: "2026-11-06" });
    expect(response.status).toBe(201);
    const view = (await response.json()) as TwinView;
    expect(view).toMatchObject({ key, number: `PL-11155111-${key.slice(2, 14)}`, status: "SHARED", statusClass: "open", amount: "120.00", currency: "USD", checkedAt: new Date(T0).toISOString() });
    expect(view.recipientViewUrl).toBe(`http://paypal.fake.invalid/invoice/p/${view.paypalId}`);
    expect(h.fake.requests.filter((r) => r.op !== "P1").map((r) => r.op)).toEqual(["P2", "P3", "P4", "P5"]);
    const created = h.fake.invoice(view.paypalId) as { detail: { reference: string; memo: string; note: string; payment_term: unknown }; primary_recipients: unknown; items: unknown };
    expect(created.detail).toMatchObject({ reference: key, memo: `PayLink twin · payee ${PAYEE.address} · eip155:11155111`, payment_term: { due_date: "2026-11-06" } });
    expect(created.detail.note).toBe(`Prefer USDC? Pay this same invoice on Ethereum Sepolia (testnet) with PayLink: ${url}`);
    expect(created.items).toEqual([{ id: "ITEM-1", name: "Logo design", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }]);
    expect(await h.services.stores.global().findTwinByKey(key)).toEqual({ paypalId: view.paypalId, payee: PAYEE.address, key });
    expect(h.rpc).toEqual([]);
  });

  it("answers a retry with the same twin (200), and makes no second invoice", async () => {
    const h = harness();
    const { url } = await link();
    const first = (await (await h.post({ link: url })).json()) as TwinView;
    const again = await h.post({ link: url });
    expect(again.status).toBe(200);
    expect(((await again.json()) as TwinView).paypalId).toBe(first.paypalId);
    expect(h.fake.state.invoices.size).toBe(1);
  });

  it("finds a twin PayPal made although its answer was lost, instead of making a second one", async () => {
    const h = harness();
    const { url } = await link();
    h.fake.inject({ op: "P3", noAnswer: "after" });
    const response = await h.post({ link: url });
    expect(response.status).toBe(200);
    expect(h.fake.state.invoices.size).toBe(1);
  });

  it("refuses a link signed for another payee than the session's (403), before calling PayPal", async () => {
    const h = harness();
    const { url } = await link();
    const response = await h.post({ link: url }, "other");
    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "forbidden", rule: "E_TWIN_NOT_PAYEE" });
    expect(h.fake.requests).toHaveLength(0);
  });

  it("refuses a signature that is not the payee's (ECDSA fails, the payee has no code)", async () => {
    const h = harness();
    const { url } = await link();
    const [head = "", fragment = ""] = url.split("#");
    const parts = fragment.split(".");
    const signature = parts[3] ?? "";
    parts[3] = `${signature.slice(0, 10)}${signature[10] === "A" ? "B" : "A"}${signature.slice(11)}`;
    const response = await h.post({ link: `${head}#${parts.join(".")}` });
    expect(response.status).toBe(400);
    expect((await problem(response)).rule).toBe("E_TWIN_SIGNATURE");
    expect(h.rpc).toEqual(["eth_getCode"]);
    expect(h.fake.requests).toHaveLength(0);
  });

  it("says PayLinkV2 is not deployed yet while the shipped registry has no Sepolia deployment (D-CHAIN)", async () => {
    expect(shippedRegistry.v2Target(11155111)).toBeUndefined();
    const h = harness(shippedRegistry);
    const { url } = await link();
    const response = await h.post({ link: url });
    expect(response.status).toBe(400);
    expect(await problem(response)).toMatchObject({ code: "invalid-request", rule: "E_CHAIN_UNKNOWN", detail: "PayLinkV2 is not deployed on this link's chain yet" });
  });

  it.each<[string, Parameters<typeof link>[0], Record<string, unknown>, string]>([
    ["an open amount", { amount: 0n }, {}, "E_TWIN_OPEN_AMOUNT"],
    ["a multi-payment invoice", { maxPayments: 3 }, {}, "E_TWIN_MULTI_PAYMENT"],
    ["a fraction of a cent", { amount: 120_000_001n }, {}, "E_TWIN_PRECISION"],
    ["an expired invoice", { validUntil: BigInt(Math.floor(T0 / 1000) - 1) }, {}, "E_TWIN_EXPIRED"],
    ["a past due date", {}, { dueDate: "2026-10-20" }, "E_TWIN_DUE_DATE"],
    ["an email PayPal refuses", {}, { recipient: { email: "sarah@" } }, "E_TWIN_INPUT"],
  ])("refuses %s (400 %s), before calling PayPal", async (_label, linkOverrides, body, rule) => {
    const h = harness();
    const { url } = await link(linkOverrides);
    const response = await h.post({ link: url, ...body });
    expect(response.status).toBe(400);
    expect((await problem(response)).rule).toBe(rule);
    expect(h.fake.requests.filter((r) => r.op !== "P1" && r.op !== "P2")).toHaveLength(0);
  });

  it("refuses what is not a link, and unknown members", async () => {
    const h = harness();
    expect((await problem(await h.post({ link: "not a url" }))).rule).toBe("E_TWIN_LINK");
    expect((await problem(await h.post({ link: PAGES }))).rule).toBe("E_TWIN_LINK");
    expect((await problem(await h.post({ link: `${PAGES}#2.11155111.x.y` }))).code).toBe("invalid-request");
    expect((await h.post({ link: PAGES, amount: "1" })).status).toBe(400);
  });

  it("twins a PayPal USD invoice too, and omits the note for a link that is not https", async () => {
    const h = harness();
    const { url } = await link({ token: PYUSD, amount: 5_000_000n });
    const response = await h.post({ link: url.replace("https://paypal.paylink-mg.pages.dev", "http://127.0.0.1:4173") });
    expect(response.status).toBe(201);
    const view = (await response.json()) as TwinView;
    expect(view.amount).toBe("5.00");
    expect((h.fake.invoice(view.paypalId) as { detail: Record<string, unknown> }).detail).not.toHaveProperty("note");
  });

  it("answers 503 when PayPal does not answer, and registers nothing", async () => {
    const h = harness();
    const { url, key } = await link();
    h.fake.inject({ op: "P2", status: 503, times: 3 });
    const response = await h.post({ link: url });
    expect(response.status).toBe(503);
    expect(await problem(response)).toMatchObject({ code: "paypal-unavailable", rule: "SERVICE_UNAVAILABLE" });
    expect(await h.services.stores.global().findTwinByKey(key)).toBeNull();
  });

  it("needs a session", async () => {
    const h = harness();
    expect((await h.post({ link: PAGES }, "nobody")).status).toBe(401);
  });
});

describe("GET /v1/twin/:key", () => {
  it("answers the payee's twin from the store, and reads PayPal again only after 10 seconds", async () => {
    const h = harness();
    const { url, key } = await link();
    const created = (await (await h.post({ link: url })).json()) as TwinView;
    const reads = (): number => h.fake.requests.filter((r) => r.op === "P5").length;
    const before = reads();
    const cached = await h.get(`/v1/twin/${key}`, "payee");
    expect(cached.status).toBe(200);
    expect(((await cached.json()) as TwinView).paypalId).toBe(created.paypalId);
    expect(reads()).toBe(before);
    h.fake.pay(created.paypalId);
    h.clock.now += TWIN_FRESH_MS;
    const fresh = (await (await h.get(`/v1/twin/${key}`, "payee")).json()) as TwinView;
    expect(reads()).toBe(before + 1);
    expect(fresh).toMatchObject({ status: "PAID", statusClass: "paid", checkedAt: new Date(h.clock.now).toISOString() });
  });

  it("answers 404 for another payee's twin or an unknown key, 400 for a malformed key, 401 without a session", async () => {
    const h = harness();
    const { url, key } = await link();
    await h.post({ link: url });
    expect((await h.get(`/v1/twin/${key}`, "other")).status).toBe(404);
    expect((await h.get(`/v1/twin/0x${"0".repeat(64)}`, "payee")).status).toBe(404);
    expect((await h.get(`/v1/twin/0xABC`, "payee")).status).toBe(400);
    expect((await h.get(`/v1/twin/${key}`)).status).toBe(401);
  });
});

describe("GET /v1/rails/:key", () => {
  it("is public, short-cached, and says only status, amount, currency, URL and time", async () => {
    const h = harness();
    const { url, key } = await link();
    const created = (await (await h.post({ link: url })).json()) as TwinView;
    const response = await h.get(`/v1/rails/${key}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=2");
    expect(await response.json()).toEqual({ status: "open", amount: "120.00", currency: "USD", url: created.recipientViewUrl, checkedAt: new Date(T0).toISOString() });
    expect(await (await h.get(`/v1/rails/0x${"0".repeat(64)}`)).json()).toEqual({ status: "none", amount: null, currency: null, url: null, checkedAt: null });
    expect((await h.get("/v1/rails/nope")).status).toBe(400);
  });

  it("maps every status class and situation to what the pay page may offer", () => {
    const twin = (lastStatus: TwinRecord["lastStatus"], situation: TwinRecord["situation"] = "S1"): TwinRecord => ({ lastStatus, situation, amountBase: "120000000", checkedAt: T0, recipientViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-1" }) as TwinRecord;
    const status = (record: TwinRecord): RailsResponse["status"] => railsView(record).status;
    expect(status(twin("SHARED"))).toBe("open");
    expect(railsView(twin("SHARED")).url).toBe("https://www.sandbox.paypal.com/invoice/p/#INV2-1");
    expect(status(twin("SENT", "S3"))).toBe("closed");
    expect(status(twin("SENT", "S7"))).toBe("closed");
    expect(status(twin("SENT", "S0"))).toBe("none");
    expect(status(twin("PAYMENT_PENDING", "S5"))).toBe("pending");
    expect(status(twin("PARTIALLY_PAID", "S5"))).toBe("pending");
    expect(status(twin("PAID", "S2"))).toBe("paid");
    expect(status(twin("MARKED_AS_PAID", "S8"))).toBe("paid");
    expect(status(twin("CANCELLED", "S6"))).toBe("closed");
    expect(status(twin("REFUNDED", "S9"))).toBe("closed");
    expect(status(twin("DRAFT"))).toBe("none");
    expect(status(twin("SCHEDULED"))).toBe("none");
    expect(status(twin(null))).toBe("none");
    expect(railsView(twin("PAID", "S2")).url).toBeNull();
  });
});
