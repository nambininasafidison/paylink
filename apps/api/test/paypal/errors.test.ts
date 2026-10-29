// SPDX-License-Identifier: MIT
/**
 * How PayPal failures reach the API's callers (src/paypal/errors.ts), the token's lifetime and cache
 * (src/paypal/token.ts), and the request ids of writes (src/paypal/idempotency.ts).
 */
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { ProblemError } from "../../src/core/problem.ts";
import { PayPalError } from "../../src/paypal/client.ts";
import { paypalProblem, withPayPalProblems } from "../../src/paypal/errors.ts";
import { randomRequestId, REQUEST_ID_PATTERN, requestIdFor } from "../../src/paypal/idempotency.ts";
import { TOKEN_MARGIN_MS, TokenCache, tokenExpiry } from "../../src/paypal/token.ts";
import { KEY, TX_HASH } from "./fixtures.ts";
import { recordingGlobal, T0 } from "./support.ts";

describe("PayPal failures as the API's problems", () => {
  it.each([
    [new PayPalError("P5", 0, { name: "E_PAYPAL_NOT_CONFIGURED", retryable: false }), { code: "paypal-unavailable", status: 503, rule: "E_PAYPAL_NOT_CONFIGURED" }],
    [new PayPalError("P1", 401, { name: "invalid_client", retryable: false }), { code: "paypal-unavailable", status: 503, rule: "invalid_client" }],
    [new PayPalError("P5", 403, { name: "NOT_AUTHORIZED" }), { code: "paypal-unavailable", rule: "NOT_AUTHORIZED" }],
    [new PayPalError("P5", 0, { name: "E_PAYPAL_NO_ANSWER" }), { code: "paypal-unavailable", rule: "E_PAYPAL_NO_ANSWER", retryAfter: 30 }],
    [new PayPalError("P5", 429, { name: "RATE_LIMIT_REACHED", retryAfterMs: 4_500 }), { code: "paypal-unavailable", retryAfter: 5 }],
    [new PayPalError("P5", 503, { name: "SERVICE_UNAVAILABLE" }), { code: "paypal-unavailable", status: 503 }],
    [new PayPalError("P5", 404, { name: "RESOURCE_NOT_FOUND" }), { code: "paypal-rejected", status: 502, rule: "RESOURCE_NOT_FOUND" }],
    [new PayPalError("P9", 422, { name: "UNPROCESSABLE_ENTITY", issue: "CANNOT_REMIND_INVOICE" }), { code: "paypal-rejected", rule: "UNPROCESSABLE_ENTITY:CANNOT_REMIND_INVOICE" }],
    [new PayPalError("P5", 200, { name: "E_PAYPAL_UNEXPECTED_RESPONSE", retryable: false }), { code: "paypal-rejected", rule: "E_PAYPAL_UNEXPECTED_RESPONSE" }],
    [new PayPalError("P5", 0, { name: "E_PAYPAL_INVALID_INPUT", retryable: false }), { code: "invalid-request", status: 400 }],
    [new PayPalError("P8", 422), { code: "paypal-rejected", rule: "HTTP_422" }],
  ])("%s → %o", (error, expected) => {
    expect(paypalProblem(error).problem).toMatchObject(expected);
  });

  it("never carries PayPal's own message, and rethrows anything that is not a PayPal failure", async () => {
    const problem = paypalProblem(new PayPalError("P9", 422, { name: "UNPROCESSABLE_ENTITY", issue: "CANNOT_REMIND_INVOICE", debugId: "abc123" }));
    expect(problem.problem.detail).toBe("PayPal refused the request (CANNOT_REMIND_INVOICE)");
    const bug = new TypeError("a bug");
    expect(() => paypalProblem(bug)).toThrow(bug);
    await expect(withPayPalProblems(() => Promise.reject(new PayPalError("P5", 503)))).rejects.toBeInstanceOf(ProblemError);
    expect(await withPayPalProblems(() => Promise.resolve(7))).toBe(7);
  });
});

describe("the token's lifetime", () => {
  it("honours the lifetime PayPal gives: the sandbox's 32,326 s (capture of 2026-10-29) is used for 8 h 48 min 46 s", () => {
    expect(tokenExpiry(T0, 32_326) - T0).toBe((8 * 3600 + 48 * 60 + 46) * 1000);
    // No ceiling of PayLink's own: a longer or shorter lifetime is honoured the same way.
    expect(tokenExpiry(T0, 86_400)).toBe(T0 + 86_400_000 - TOKEN_MARGIN_MS);
    expect(tokenExpiry(T0, 3_600)).toBe(T0 + 3_600_000 - TOKEN_MARGIN_MS);
  });

  it("is expires_in − 10 min, or half of a short one", () => {
    expect(tokenExpiry(T0, 32_400)).toBe(T0 + 32_400_000 - TOKEN_MARGIN_MS);
    expect(tokenExpiry(T0, 1_201)).toBe(T0 + 1_201_000 - TOKEN_MARGIN_MS);
    expect(tokenExpiry(T0, 1_200)).toBe(T0 + 600_000);
    expect(tokenExpiry(T0, 60)).toBe(T0 + 30_000);
  });

  it("is never handed out once refused, even if the shared store still holds it", async () => {
    const global = recordingGlobal();
    let n = 0;
    const cache = new TokenCache(
      () => {
        n += 1;
        return Promise.resolve({ access_token: `token-${String(n)}`, token_type: "Bearer", expires_in: 32_400 });
      },
      () => T0,
      global.store,
      silentLogger,
    );
    expect(await cache.get()).toBe("token-1");
    cache.invalidate("token-1");
    expect(await cache.get()).toBe("token-2");
    expect(global.tokens.map((t) => t.token)).toEqual(["token-1", "token-2"]);
  });

  it("propagates a failed fetch to every waiting caller, then tries again", async () => {
    let calls = 0;
    const cache = new TokenCache(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new PayPalError("P1", 503)) : Promise.resolve({ access_token: "t", token_type: "Bearer", expires_in: 32_400 });
      },
      () => T0,
      null,
      silentLogger,
    );
    const results = await Promise.allSettled([cache.get(), cache.get()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(await cache.get()).toBe("t");
    expect(calls).toBe(2);
  });
});

describe("request ids of writes", () => {
  it("are deterministic per kind and parts, and valid PayPal-Request-Id values", () => {
    const id = requestIdFor("record", KEY, TX_HASH);
    expect(id).toBe(`pl-record-${KEY.slice(2, 26)}-${TX_HASH.slice(2, 26)}`);
    expect(id).toMatch(REQUEST_ID_PATTERN);
    expect(requestIdFor("undo", KEY, "EXTR-86F38350LX4353815")).toBe(`pl-undo-${KEY.slice(2, 26)}-EXTR-86F38350LX4353815`);
    expect(requestIdFor("cancel", KEY)).not.toBe(requestIdFor("remind", KEY));
    expect(() => requestIdFor("undo", KEY, "has space")).toThrow(RangeError);
    expect(() => requestIdFor("record", KEY, TX_HASH, KEY, TX_HASH)).toThrow(RangeError);
  });

  it("are random and well formed for one-off writes", () => {
    const id = randomRequestId((n) => new Uint8Array(n).fill(171));
    expect(id).toBe(`pl-${"ab".repeat(16)}`);
    expect(id).toMatch(REQUEST_ID_PATTERN);
  });
});
