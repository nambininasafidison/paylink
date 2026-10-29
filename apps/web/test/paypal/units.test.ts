// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's logic without a page: the API client (routes from the contract, RFC 9457 problems, shapes),
 * the payee's session, exact cents, the pay page's PayPal checks (pinned host, exact amount, the API's status), the
 * issuer controls read on chain, the twin cache and the ledger's rail column.
 */
import { API_ROUTES, PAYPAL_EDITION_CHAIN_ID, SESSION_TYPES } from "@paylink/api-contract";
import type { RailsResponse } from "@paylink/api-contract";
import type { DecodedInvoiceLink } from "@paylink/sdk";
import { recoverTypedDataAddress } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountProvider } from "../../src/accounts/types.ts";
import type { App } from "../../src/app/context.ts";
import type { ChainClient } from "../../src/core/clients.ts";
import { ApiError, getDesk, getHealth, getRails, paypalApi, postApprove, postDraft, postTwin, routePath } from "../../src/editions/paypal/api.ts";
import { failureText } from "../../src/editions/paypal/context.ts";
import { paidRail, paypalPaid, railColumns } from "../../src/editions/paypal/ledger.ts";
import { baseFromDecimal, seconds, usdFromBase } from "../../src/editions/paypal/money.ts";
import { PAYPAL_PAYER_HOSTS, payerUrl, railVerdict, tokenControls, twinnable } from "../../src/editions/paypal/rails.ts";
import { forgetSession, openSession, sessionMessage, storedSession, withSession } from "../../src/editions/paypal/session.ts";
import { cachedTwin, rememberTwin } from "../../src/editions/paypal/twins.ts";
import { SCRIPT_URL } from "../helpers.ts";
import { paypalApp } from "./fixtures.ts";

const API = "https://api.example";
const KEY: Hex = `0x${"ab".repeat(32)}`;
const PAYEE: Address = "0x1111111111111111111111111111111111111111";
const PAYLINK: Address = "0x448eCce9711860502806A3d5B021a4f9Ba715082";
const USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

type Answer = { readonly status: number; readonly body: unknown } | "network";

function api(answers: Readonly<Record<string, Answer>>): { calls: { url: string; init: RequestInit }[]; client: ReturnType<typeof paypalApi> } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const answer = answers[`${init?.method ?? "GET"} ${new URL(url).pathname}`];
    if (answer === undefined || answer === "network") {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }));
  });
  return { calls, client: paypalApi(`${API}/`, fetcher) };
}

function link(options: { amount?: bigint; maxPayments?: number; symbol?: string; decimals?: number } = {}): DecodedInvoiceLink {
  return {
    key: KEY,
    chainId: PAYPAL_EDITION_CHAIN_ID,
    invoice: { payee: PAYEE, token: USDC, amount: options.amount ?? 120_000_000n, maxPayments: options.maxPayments ?? 1 },
    token: { symbol: options.symbol ?? "USDC", decimals: options.decimals ?? 6, address: USDC },
    target: { deployment: { address: PAYLINK } },
  } as unknown as DecodedInvoiceLink;
}

const rails = (over: Partial<RailsResponse> = {}): RailsResponse => ({
  status: "open",
  amount: "120.00",
  currency: "USD",
  url: "https://www.sandbox.paypal.com/invoice/p/#INV2-ABCD-1234",
  checkedAt: "2026-10-22T10:00:00.000Z",
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetSession();
  localStorage.clear();
});

describe("routes and problems", () => {
  it("fills route paths from the contract's table, encoded, and refuses a missing parameter", () => {
    expect(API_ROUTES.map((r) => r.id)).toContain("rails.get");
    expect(routePath("rails.get", { key: KEY })).toBe(`/v1/rails/${KEY}`);
    expect(routePath("desk.approve", { id: "p_1/../x" })).toBe("/v1/desk/p_1%2F..%2Fx/approve");
    expect(() => routePath("twin.get")).toThrow(/missing route parameter key/);
  });

  it("sends no cookie, no referrer, the bearer token only on session routes, and JSON bodies", async () => {
    const { client, calls } = api({ [`GET /v1/rails/${KEY}`]: { status: 200, body: rails() }, "POST /v1/desk/p1/approve": { status: 200, body: { state: "done", proposalId: "p1" } } });
    await getRails(client, KEY);
    await postApprove(client, "ps1.token", "p1", { hash: `0x${"cd".repeat(32)}`, token: "t" });
    expect(calls[0]?.url).toBe(`${API}/v1/rails/${KEY}`);
    expect(calls[0]?.init).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer ps1.token");
    expect(new Headers(calls[1]?.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ hash: `0x${"cd".repeat(32)}`, token: "t" });
  });

  it("turns an RFC 9457 problem into its code and rule, and anything else into a code the page knows", async () => {
    const { client } = api({
      "GET /v1/desk": { status: 409, body: { type: "x", code: "stale", status: 409, title: "t", detail: "d", rule: "E_STALE", retryAfter: 5 } },
      "GET /v1/health": { status: 502, body: { code: "made-up", status: 502 } },
      "POST /v1/ai/draft": { status: 501, body: null },
    });
    await expect(getDesk(client, "t")).rejects.toMatchObject({ name: "ApiError", status: 409, code: "stale", rule: "E_STALE", retryAfter: 5 });
    await expect(getHealth(client)).rejects.toMatchObject({ code: "internal", rule: null });
    await expect(postDraft(client, "t", { text: "x", locale: "en" })).rejects.toMatchObject({ code: "not-implemented" });
    await expect(getRails(client, KEY)).rejects.toMatchObject({ code: "network", status: 0 });
  });

  it("refuses an answer of another shape before the page reads it", async () => {
    const bad = { ...rails(), status: "maybe" };
    const { client } = api({
      [`GET /v1/rails/${KEY}`]: { status: 200, body: bad },
      "POST /v1/twin": { status: 201, body: { key: KEY, number: "PL-1" } },
      "GET /v1/desk": { status: 200, body: { proposals: [{ id: "x" }], autoRecords: [], alerts: [], checkedAt: null, assistant: { available: false, reason: null } } },
    });
    await expect(getRails(client, KEY)).rejects.toMatchObject({ code: "invalid-response" });
    await expect(postTwin(client, "t", { link: "https://x/#y" })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(getDesk(client, "t")).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("tells a made twin (201) from one that existed (200)", async () => {
    const twin = { key: KEY, paypalId: "INV2-1", number: "PL-11155111-abababababab", status: "SHARED", statusClass: "open", recipientViewUrl: null, amount: "120.00", currency: "USD", situation: "S1", checkedAt: "2026-10-22T10:00:00.000Z" };
    expect((await postTwin(api({ "POST /v1/twin": { status: 201, body: twin } }).client, "t", { link: "https://x/#y" })).created).toBe(true);
    expect((await postTwin(api({ "POST /v1/twin": { status: 200, body: twin } }).client, "t", { link: "https://x/#y" })).created).toBe(false);
  });

  it("words every failure in the user's language with an engraved code, rule first", () => {
    const app = paypalApp("en");
    expect(failureText(app, new ApiError(409, "stale", "E_STALE"))).toMatchObject({ message: "The situation changed since this was proposed. Read the desk again.", code: "Error code E_STALE" });
    expect(failureText(app, new ApiError(400, "invalid-request", "E_TWIN_PRECISION")).message).toBe("This amount has a fraction of a cent, which PayPal cannot invoice.");
    expect(failureText(app, new ApiError(0, "network")).code).toBe("Error code network");
    expect(failureText(paypalApp("fr"), new ApiError(503, "paypal-unavailable")).message).toBe("PayPal n'a pas répondu. Réessayez dans une minute.");
    // PayPal's refusal of a reminder without the client's email (the capture of 2026-10-29) says why, not just "refused".
    expect(failureText(app, new ApiError(502, "paypal-rejected", "E_PAYPAL_REMINDER_NEEDS_EMAIL"))).toMatchObject({
      message: "PayPal's own reminder is not offered for this invoice: it has no client email on PayPal, and PayPal refuses to send a reminder without one.",
      code: "Error code E_PAYPAL_REMINDER_NEEDS_EMAIL",
    });
  });
});

describe("the payee's session", () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const account = {
    address: signer.address,
    kind: "injected",
    connector: { id: "test", name: "Test", icon: null, layer: "eip6963" },
    switchChain: vi.fn(() => Promise.resolve()),
    signTypedData: vi.fn((typed: Parameters<AccountProvider["signTypedData"]>[0]) => signer.signTypedData(typed as Parameters<typeof signer.signTypedData>[0])),
  } as unknown as AccountProvider;

  it("signs this origin, now, at most 12 hours and a fresh 32-byte nonce", () => {
    const message = sessionMessage(PAYEE, "https://paypal.paylink-mg.pages.dev", 1_790_000_000_500, (b) => b.fill(7));
    expect(message).toEqual({ payee: PAYEE, origin: "https://paypal.paylink-mg.pages.dev", issuedAt: "1790000000", expiresAt: String(1_790_000_000 + 43_200), nonce: `0x${"07".repeat(32)}` });
  });

  it("opens a session with a signature the API can recover, keeps the token for the tab, and only for that payee", async () => {
    let body: { session: Parameters<typeof sessionMessage>[0] extends never ? never : Record<string, string>; signature: Hex; chainId: number } | null = null;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as typeof body;
      return Promise.resolve(new Response(JSON.stringify({ token: "ps1.tok", payee: signer.address, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 }));
    });
    const app = { ...paypalApp("en"), registry: { get: () => undefined } } as unknown as App;
    expect(await openSession(app, paypalApi(API, fetcher), account)).toBe("ps1.tok");
    expect(body).not.toBeNull();
    const sent = body as unknown as { session: { payee: Address; origin: string; issuedAt: string; expiresAt: string; nonce: Hex }; signature: Hex; chainId: number };
    expect(sent.chainId).toBe(11155111);
    const recovered = await recoverTypedDataAddress({
      domain: { name: "PayLink API", version: "1", chainId: 11155111 },
      types: SESSION_TYPES,
      primaryType: "PayLinkSession",
      message: { ...sent.session, issuedAt: BigInt(sent.session.issuedAt), expiresAt: BigInt(sent.session.expiresAt) },
      signature: sent.signature,
    });
    expect(recovered).toBe(signer.address);
    expect(storedSession(signer.address)).toBe("ps1.tok");
    expect(storedSession(PAYEE)).toBeNull();
    expect(storedSession(signer.address, Date.now() + 3_600_000)).toBeNull();
  });

  it("signs again once when a stored token is refused, and never twice in a row", async () => {
    sessionStorage.setItem("paylink.paypal.session", JSON.stringify({ payee: signer.address.toLowerCase(), token: "old", expiresAt: Date.now() + 3_600_000 }));
    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ token: "new", payee: signer.address, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 })));
    const app = { ...paypalApp("en"), registry: { get: () => undefined } } as unknown as App;
    const seen: string[] = [];
    const result = await withSession(app, paypalApi(API, fetcher), account, (token) => {
      seen.push(token);
      return token === "old" ? Promise.reject(new ApiError(401, "unauthorized")) : Promise.resolve("ok");
    });
    expect(result).toBe("ok");
    expect(seen).toEqual(["old", "new"]);
    forgetSession();
    await expect(withSession(app, paypalApi(API, fetcher), account, () => Promise.reject(new ApiError(401, "unauthorized")))).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("exact cents", () => {
  it("converts base units to PayPal's USD only when they hold whole cents", () => {
    expect(usdFromBase(120_000_000n, 6)).toBe("120.00");
    expect(usdFromBase(7_050_000n, 6)).toBe("7.05");
    expect(usdFromBase(10_000n, 6)).toBe("0.01");
    expect(usdFromBase(10_001n, 6)).toBeNull();
    expect(usdFromBase(0n, 6)).toBeNull();
    expect(baseFromDecimal("120.00", 6)).toBe(120_000_000n);
    expect(baseFromDecimal("7.5", 6)).toBe(7_500_000n);
    expect(baseFromDecimal("1.0000001", 6)).toBeNull();
    expect(baseFromDecimal("-1", 6)).toBeNull();
    expect(baseFromDecimal("1e3", 6)).toBeNull();
    expect(seconds("2026-10-22T10:00:00.000Z")).toBe(1_792_663_200);
    expect(seconds("not a date")).toBeNull();
  });
});

describe("the pay page's PayPal checks", () => {
  it("follows only https URLs on a pinned PayPal host, without credentials or port", () => {
    expect(PAYPAL_PAYER_HOSTS).toEqual(["www.sandbox.paypal.com"]);
    expect(payerUrl("https://www.sandbox.paypal.com/invoice/p/#INV2-1")?.href).toBe("https://www.sandbox.paypal.com/invoice/p/#INV2-1");
    for (const url of [
      "http://www.sandbox.paypal.com/invoice/p/#INV2-1",
      "https://www.sandbox.paypal.com.evil.example/invoice",
      "https://evil.example/www.sandbox.paypal.com",
      "https://user:pw@www.sandbox.paypal.com/invoice",
      "https://www.sandbox.paypal.com:8443/invoice",
      "https://www.paypal.com/invoice/p/#INV2-1",
      "https://sandbox.paypal.com/invoice",
      SCRIPT_URL,
      "not a url",
      null,
    ]) {
      expect(payerUrl(url), String(url)).toBeNull();
    }
  });

  it("offers PayPal only for an open twin of exactly the signed amount in USD", () => {
    expect(railVerdict(link(), rails())).toEqual({ kind: "offer", url: "https://www.sandbox.paypal.com/invoice/p/#INV2-ABCD-1234" });
    expect(railVerdict(link(), rails({ amount: "120" })).kind).toBe("offer");
    expect(railVerdict(link(), rails({ amount: "120.01" }))).toEqual({ kind: "hidden", reason: "amount" });
    expect(railVerdict(link(), rails({ amount: null }))).toEqual({ kind: "hidden", reason: "amount" });
    expect(railVerdict(link(), rails({ currency: null }))).toEqual({ kind: "hidden", reason: "amount" });
    expect(railVerdict(link(), rails({ url: "https://www.sandbox-paypal.com/invoice" }))).toEqual({ kind: "hidden", reason: "host" });
    expect(railVerdict(link(), rails({ url: null }))).toEqual({ kind: "hidden", reason: "host" });
    expect(railVerdict(link(), rails({ status: "none", url: null }))).toEqual({ kind: "hidden", reason: "none" });
    expect(railVerdict(link(), rails({ status: "closed", url: null }))).toEqual({ kind: "hidden", reason: "closed" });
    expect(railVerdict(link(), rails({ status: "pending", url: null }))).toEqual({ kind: "pending" });
    expect(railVerdict(link(), rails({ status: "paid", url: null }))).toEqual({ kind: "paid" });
  });

  it("never offers PayPal on a link that cannot have a twin, whatever the API says", () => {
    for (const l of [link({ amount: 0n }), link({ maxPayments: 0 }), link({ maxPayments: 3 }), link({ amount: 120_000_001n }), link({ symbol: "AUSD" })]) {
      expect(twinnable(l)).toBe(false);
      expect(railVerdict(l, rails())).toEqual({ kind: "hidden", reason: "ineligible" });
    }
    expect(twinnable(link({ symbol: "PYUSD" }))).toBe(true);
  });

  it("reads the issuer's pause and freeze on chain, and says nothing when they cannot be read", async () => {
    const answers = new Map<string, Hex>();
    const client = {
      call: vi.fn(({ to, data }: { to: Address; data: Hex }) => {
        const answer = answers.get(`${to.toLowerCase()}:${data.slice(0, 10)}:${data.slice(-40)}`) ?? answers.get(`${to.toLowerCase()}:${data.slice(0, 10)}`);
        return answer === undefined ? Promise.reject(new Error("execution reverted")) : Promise.resolve({ data: answer });
      }),
    } as unknown as ChainClient;
    const word = (v: number): Hex => `0x${v.toString(16).padStart(64, "0")}`;
    answers.set(`${USDC.toLowerCase()}:0x5c975abb`, word(0));
    answers.set(`${USDC.toLowerCase()}:0xfe575a87`, word(0));
    expect(await tokenControls(client, link())).toEqual({ paused: false, frozen: false });
    answers.set(`${USDC.toLowerCase()}:0x5c975abb`, word(1));
    answers.set(`${USDC.toLowerCase()}:0xfe575a87:${PAYEE.slice(2).toLowerCase()}`, word(1));
    expect(await tokenControls(client, link())).toEqual({ paused: true, frozen: true });
    answers.clear();
    expect(await tokenControls(client, link())).toEqual({ paused: null, frozen: null });
    // PayPal USD asks `isFrozen(address)` instead of `isBlacklisted(address)`.
    answers.set(`${USDC.toLowerCase()}:0xe5839836`, word(0));
    expect(await tokenControls(client, link({ symbol: "PYUSD" }))).toEqual({ paused: null, frozen: false });
  });
});

describe("the twin cache and the ledger's rail column", () => {
  it("remembers twins by key, refuses junk, and names the rail that paid", () => {
    expect(cachedTwin(KEY)).toBeNull();
    rememberTwin({ key: KEY, number: "PL-11155111-abababababab", status: "PAID", checkedAt: "2026-10-22T10:00:00.000Z" });
    expect(cachedTwin(KEY)).toEqual({ number: "PL-11155111-abababababab", status: "PAID", statusClass: "paid", checkedAt: "2026-10-22T10:00:00.000Z" });
    const row = { status: "payable" as const, link: link() };
    expect(paidRail(row, cachedTwin(KEY))).toBe("PAYPAL");
    expect(railColumns(row)).toEqual(["PAYPAL", "PL-11155111-abababababab"]);
    expect(paidRail({ status: "paid", link: link() }, null)).toBe("USDC");
    expect(paidRail({ status: "payable", link: link() }, null)).toBeNull();
    // Paid on chain, PayPal showing PayLink's own record of it (MARKED_AS_PAID or PAID): the chain's rail paid it.
    expect(paidRail({ status: "paid", link: link() }, { statusClass: "paid-outside" })).toBe("USDC");
    expect(paidRail({ status: "paid", link: link() }, { statusClass: "paid" })).toBe("USDC");
    expect(paypalPaid({ status: "paid" }, { statusClass: "paid" })).toBeNull();
    expect(paypalPaid({ status: "payable" }, { statusClass: "paid" })).toBe("paid");
    expect(paypalPaid({ status: "payable" }, { statusClass: "paid-outside" })).toBe("marked");
    expect(paypalPaid({ status: "payable" }, { statusClass: "open" })).toBeNull();
    localStorage.setItem("paylink.paypal.twins", JSON.stringify({ [KEY]: { number: 7 }, "0xnot-a-key": { number: "x", status: "PAID", checkedAt: "t" } }));
    expect(cachedTwin(KEY)).toBeNull();
    localStorage.setItem("paylink.paypal.twins", "{not json");
    expect(cachedTwin(KEY)).toBeNull();
  });
});
