// SPDX-License-Identifier: MIT
/**
 * The till's PayPal source (docs/paypal/SPEC.md §14.2 F4, §3.2 "PayPal payment"): an armed till lights for PayPal only
 * when PayPal's own GET says `PAID`, the reconciler puts the twin in S2 or S4 (at least one payment that is not PayLink's
 * echo of a chain payment), the key is the armed invoice's and the amount is the signed one exactly. It reads the twin
 * with the payee's desk session and never asks for a signature on its own.
 */
import type { TwinView } from "@paylink/api-contract";
import type { DecodedInvoiceLink } from "@paylink/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountProvider } from "../../src/accounts/types.ts";
import type { App } from "../../src/app/context.ts";
import { forgetSession, storedSession } from "../../src/editions/paypal/session.ts";
import { paidOnPaypal, paypalTill, TWIN_POLL_MS } from "../../src/editions/paypal/till.ts";
import { cachedTwin } from "../../src/editions/paypal/twins.ts";
import { API, KEY, paypalApp } from "./fixtures.ts";

const PAYEE = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

/** The parts of an armed invoice the till's PayPal source reads: 120.00 USDC to PAYEE. */
const link = { key: KEY, invoice: { payee: PAYEE, amount: 120_000_000n }, token: { symbol: "USDC", decimals: 6 } } as unknown as DecodedInvoiceLink;

const twin = (over: Partial<TwinView> = {}): TwinView => ({
  key: KEY,
  paypalId: "INV2-AAAA-BBBB-CCCC-DDDD",
  number: "PL-11155111-abababababab",
  // The sandbox's open status after a share link (the owner's capture of 2026-10-29).
  status: "UNPAID",
  statusClass: "open",
  recipientViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2AAAABBBBCCCCDDDD",
  amount: "120.00",
  currency: "USD",
  situation: "S1",
  checkedAt: "2026-10-22T11:02:31.000Z",
  ...over,
});

type Answer = { status: number; body: unknown } | "network";

/** Stubs `fetch` with the API's answers to `GET /v1/twin/:key`, in order (the last one repeats). */
function stubTwin(answers: readonly Answer[]): { path: string; auth: string | null }[] {
  const seen: { path: string; auth: string | null }[] = [];
  let next = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      seen.push({ path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      if (answer === undefined || answer === "network") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    }),
  );
  return seen;
}

/** An app whose connected wallet is `address`, with a desk session for it when `session` is true. */
function till(address: string = PAYEE, session = true, api: string | null = API): App {
  const account = { address, kind: "injected" } as unknown as AccountProvider;
  if (session) {
    sessionStorage.setItem("paylink.paypal.session", JSON.stringify({ payee: address.toLowerCase(), token: "ps1.till", expiresAt: Date.now() + 3_600_000 }));
  }
  return { ...paypalApp("en", { api }), session: { account: () => account, ready: Promise.resolve(), subscribe: () => () => undefined } } as unknown as App;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  forgetSession();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("paidOnPaypal: the till's only PayPal rule", () => {
  it("holds for PAID in S2 or S4, on the armed key, at the signed amount exactly", () => {
    expect(paidOnPaypal(link, twin({ status: "PAID", statusClass: "paid", situation: "S2" }))).toBe(true);
    expect(paidOnPaypal(link, twin({ status: "PAID", statusClass: "paid", situation: "S4" }))).toBe(true);
    expect(paidOnPaypal(link, twin({ status: "PAID", statusClass: "paid", situation: "S2", amount: "120" }))).toBe(true);
  });

  it("never holds for an echo of a chain payment, a mark, a payment in flight, another amount or another invoice", () => {
    // S8: PayPal's PAID comes only from PayLink's own record of a chain payment (the chain lights that itself).
    expect(paidOnPaypal(link, twin({ status: "PAID", statusClass: "paid", situation: "S8" }))).toBe(false);
    expect(paidOnPaypal(link, twin({ status: "MARKED_AS_PAID", statusClass: "paid-outside", situation: "S2" }))).toBe(false);
    expect(paidOnPaypal(link, twin({ status: "PARTIALLY_PAID", statusClass: "in-flight", situation: "S5" }))).toBe(false);
    expect(paidOnPaypal(link, twin({ status: "PAID", statusClass: "paid", situation: "S0" }))).toBe(false);
    expect(paidOnPaypal(link, twin({ status: "PAID", statusClass: "paid", situation: "S2", amount: "119.99" }))).toBe(false);
    expect(paidOnPaypal(link, twin({ status: "PAID", statusClass: "paid", situation: "S2", amount: "120.001" }))).toBe(false);
    expect(paidOnPaypal(link, twin({ status: "PAID", statusClass: "paid", situation: "S2", key: `0x${"cd".repeat(32)}` }))).toBe(false);
    const open = { ...link, invoice: { ...link.invoice, amount: 0n } } as DecodedInvoiceLink;
    expect(paidOnPaypal(open, twin({ status: "PAID", statusClass: "paid", situation: "S2", amount: "0.00" }))).toBe(false);
  });
});

describe("the till's PayPal line", () => {
  it("asks for nothing and reads nothing without the payee's desk session: it offers a key that opens one", async () => {
    const seen = stubTwin([{ status: 200, body: twin() }]);
    const source = paypalTill(till(PAYEE, false), link, () => undefined);
    expect(source.element.getAttribute("data-paypal")).toBe("no-session");
    expect(source.element.querySelector("[data-action=watch-paypal]")?.textContent).toBe("Also watch PayPal");
    source.start();
    await flush();
    expect(seen).toEqual([]);
    source.stop();
  });

  it("says PayPal is not watched when the edition's API is not configured", () => {
    const source = paypalTill(till(PAYEE, true, null), link, () => undefined);
    expect(source.element.getAttribute("data-paypal")).toBe("off");
    expect(source.element.textContent).toContain("not configured");
  });

  it("reads the twin every 3 seconds with the session, and lights once on PayPal's own PAID at the exact amount", async () => {
    const paid = twin({ status: "PAID", statusClass: "paid", situation: "S2", checkedAt: "2026-10-22T11:05:00.000Z" });
    const seen = stubTwin([{ status: 200, body: twin() }, { status: 200, body: twin({ status: "PAID", statusClass: "paid", situation: "S8" }) }, { status: 200, body: paid }]);
    const lit: TwinView[] = [];
    const source = paypalTill(till(), link, (value) => lit.push(value));
    expect(source.element.getAttribute("data-paypal")).toBe("watching");
    source.start();
    await flush();
    expect(seen).toEqual([{ path: `/v1/twin/${KEY}`, auth: "Bearer ps1.till" }]);
    expect(source.element.textContent).toContain("Watching PayPal too");
    await vi.advanceTimersByTimeAsync(TWIN_POLL_MS);
    await flush();
    // An echo of a chain payment (S8) is not a PayPal payment: still watching.
    expect(lit).toEqual([]);
    await vi.advanceTimersByTimeAsync(TWIN_POLL_MS);
    await flush();
    expect(lit).toEqual([paid]);
    expect(source.element.getAttribute("data-paypal")).toBe("paid");
    expect(cachedTwin(KEY)?.status).toBe("PAID");
    await vi.advanceTimersByTimeAsync(TWIN_POLL_MS * 3);
    expect(seen).toHaveLength(3);
    source.stop();
  });

  it("stops at once when the till stops", async () => {
    const seen = stubTwin([{ status: 200, body: twin() }]);
    const source = paypalTill(till(), link, () => undefined);
    source.start();
    await flush();
    source.stop();
    await vi.advanceTimersByTimeAsync(TWIN_POLL_MS * 3);
    expect(seen).toHaveLength(1);
  });

  it("says there is no twin (404) and stops reading; keeps trying when PayPal or the API does not answer", async () => {
    stubTwin([{ status: 404, body: { code: "not-found", status: 404 } }]);
    const none = paypalTill(till(), link, () => undefined);
    none.start();
    await flush();
    expect(none.element.getAttribute("data-paypal")).toBe("no-twin");
    none.stop();

    const seen = stubTwin(["network", { status: 503, body: { code: "paypal-unavailable", status: 503 } }, { status: 200, body: twin() }]);
    const down = paypalTill(till(), link, () => undefined);
    down.start();
    await flush();
    expect(down.element.getAttribute("data-paypal")).toBe("unreachable");
    await vi.advanceTimersByTimeAsync(TWIN_POLL_MS);
    await flush();
    expect(down.element.getAttribute("data-paypal")).toBe("unreachable");
    await vi.advanceTimersByTimeAsync(TWIN_POLL_MS);
    await flush();
    expect(down.element.getAttribute("data-paypal")).toBe("watching");
    expect(seen).toHaveLength(3);
    down.stop();
  });

  it("drops a session the API refuses (401) and offers to open a new one, without signing by itself", async () => {
    stubTwin([{ status: 401, body: { code: "unauthorized", status: 401 } }]);
    const source = paypalTill(till(), link, () => undefined);
    source.start();
    await flush();
    expect(source.element.getAttribute("data-paypal")).toBe("no-session");
    expect(storedSession(PAYEE)).toBeNull();
    source.stop();
  });

  it("watches PayPal only for the invoice's payee: another connected account reads nothing", async () => {
    const seen = stubTwin([{ status: 200, body: twin() }]);
    const source = paypalTill(till(OTHER), link, () => undefined);
    expect(source.element.getAttribute("data-paypal")).toBe("no-session");
    source.start();
    await flush();
    expect(seen).toEqual([]);
    source.stop();
  });
});
