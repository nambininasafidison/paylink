// SPDX-License-Identifier: MIT
/**
 * The relayer client and the display-only exchange rate: answers are parsed strictly (an unexpected body is a failure,
 * never a success), problems keep their code, fallback and retry delay, health is cached and a failure reads as "down",
 * requests carry no credentials and go only to the configured endpoint; the ariary estimate is integer arithmetic,
 * rounded half up, for dollar tokens only, and a malformed snapshot hides it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ariaryLabel, ariaryOf, loadFx, parseFx } from "../src/core/fx.ts";
import { parseAccepted, parseChainHealth, parseProblem, RELAYER_TIMEOUT_MS, relayerClient, RelayerProblem } from "../src/core/relayer.ts";

const URL_ = "https://paylink-relayer.example.workers.dev";
const config = { relayer: { url: URL_, chains: [10143, 84532] } };
const TX = `0x${"ab".repeat(32)}`;

function health(chains: unknown[]): Response {
  return new Response(JSON.stringify({ status: "ok", chains }), { status: 200, headers: { "content-type": "application/json" } });
}

const ready = { chainId: 10143, state: "ready", operations: { pay: true, cancel: true, onboard: true }, relayer: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" };

describe("relayer client", () => {
  it("reads health per chain, caches it, and treats a failure or an unknown chain as down", async () => {
    let now = 0;
    const fetcher = vi.fn((...args: [RequestInfo | URL, RequestInit?]) => Promise.resolve(args.length > 0 ? health([ready, { chainId: 84532, state: "awaiting-deployment", operations: { pay: false } }]) : new Response(null)));
    const client = relayerClient(config, fetcher, () => now);
    expect(await client.availability(10143)).toMatchObject({ kind: "up", health: { chainId: 10143, operations: { pay: true, onboard: true } } });
    expect(await client.availability(84532)).toEqual({ kind: "down", state: "awaiting-deployment" });
    expect(await client.availability(421614)).toEqual({ kind: "none" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${URL_}/v1/health`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    now = 25_000;
    fetcher.mockImplementationOnce(() => Promise.reject(new TypeError("offline")));
    expect(await client.availability(10143)).toEqual({ kind: "down", state: "offline" });
    client.invalidate();
    fetcher.mockImplementationOnce(() => Promise.resolve(health([])));
    expect(await client.availability(10143)).toEqual({ kind: "down", state: "unreachable" });
  });

  it("posts the relay bodies to the chain's path and accepts only the documented answer", async () => {
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { chainId: number };
      return Promise.resolve(new Response(JSON.stringify({ status: "submitted", kind: "pay", chainId: body.chainId, txHash: TX, duplicate: false, subject: "0x" }), { status: 202 }));
    });
    const client = relayerClient(config, fetcher);
    const accepted = await client.pay({ chainId: 10143 } as never);
    expect(accepted).toEqual({ status: "submitted", kind: "pay", chainId: 10143, txHash: TX, duplicate: false });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${URL_}/v1/10143/pay`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "omit", headers: { "content-type": "application/json" } });
    // The same answer for another operation is not a success.
    await expect(client.cancel({ chainId: 10143 } as never)).rejects.toMatchObject({ code: "invalid-response", fallback: "self-submit" });
    await expect(client.pay({ chainId: 421614 } as never)).rejects.toMatchObject({ code: "unknown-chain" });
  });

  it("onboards an address and turns problems and transport failures into RelayerProblem", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "submitted", kind: "onboard", chainId: 10143, txHash: TX, duplicate: false }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "faucet-unavailable", detail: "cooldown", fallback: "retry", retryAfter: 42 }), { status: 503, headers: { "retry-after": "42" } }))
      .mockResolvedValueOnce(new Response("not json", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("network"));
    const client = relayerClient(config, fetcher);
    expect(await client.onboard(10143, "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc")).toMatchObject({ kind: "onboard", txHash: TX });
    const sent = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body;
    expect(JSON.parse(typeof sent === "string" ? sent : "{}")).toEqual({ chainId: 10143, address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" });
    await expect(client.onboard(10143, "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc")).rejects.toMatchObject({ code: "faucet-unavailable", retryAfter: 42, fallback: "retry" });
    await expect(client.onboard(10143, "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc")).rejects.toMatchObject({ code: "http-502" });
    await expect(client.onboard(10143, "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc")).rejects.toMatchObject({ code: "offline", fallback: "retry" });
    expect(relayerClient({ relayer: null }).endpoint(10143)).toBeNull();
  });

  it("parses problems with bounded fields, and health entries defensively", () => {
    const problem = parseProblem({ code: "rejected", rule: "WrongAmount", reason: "x".repeat(81), fallback: "self-submit", error: { name: "SoldOut", i18nKey: "error.contract.soldOut" } }, 422, null);
    expect(problem).toBeInstanceOf(RelayerProblem);
    expect(problem).toMatchObject({ code: "rejected", status: 422, rule: "WrongAmount", reason: null, fallback: "self-submit", revert: { name: "SoldOut", i18nKey: "error.contract.soldOut" } });
    expect(parseProblem(null, 429, "7")).toMatchObject({ code: "http-429", retryAfter: 7, fallback: "none" });
    expect(parseChainHealth({ chainId: 1, state: "weird" })).toMatchObject({ state: "unreachable", operations: { pay: false }, relayer: null });
    expect(parseChainHealth({ chainId: "1" })).toBeNull();
    expect(parseAccepted({ status: "settled", kind: "pay", chainId: 1, txHash: "0x12", duplicate: true }, { kind: "pay", chainId: 1 })).toBeNull();
    expect(parseAccepted([], { kind: "pay", chainId: 1 })).toBeNull();
  });
});

const fx = { version: 1, base: "USD", date: "2026-10-08", rates: { MGA: "4453.66921254", EUR: "0.89246269" }, source: { name: "fawazahmed0/exchange-api", url: "https://github.com/fawazahmed0/exchange-api", package: "@fawazahmed0/currency-api@2026.10.8", license: "CC0-1.0" } };
const ausd = { symbol: "AUSD", decimals: 6 } as const;

/** Headers at once, then a body that starts and never ends; `honoursAbort` makes it error when the request aborts. */
function stalling(honoursAbort: boolean): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"submitted","kind":"pay",'));
        if (honoursAbort) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        }
      },
    });
    return Promise.resolve(new Response(body, { status: 202, headers: { "content-type": "application/json" } }));
  });
}

describe("relayer client: one deadline for the whole answer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["errors when the request aborts", true],
    ["ignores the abort", false],
  ])("turns headers followed by a stalled body into 'offline, retry' at the deadline (a body that %s)", async (_name, honoursAbort) => {
    vi.useFakeTimers();
    const client = relayerClient(config, stalling(honoursAbort));
    let outcome: unknown = "pending";
    const paying = client.pay({ chainId: 10143 } as never).then(
      () => (outcome = "accepted"),
      (error: unknown) => (outcome = error),
    );
    await vi.advanceTimersByTimeAsync(RELAYER_TIMEOUT_MS - 1);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await paying;
    expect(outcome).toBeInstanceOf(RelayerProblem);
    expect(outcome).toMatchObject({ code: "offline", fallback: "retry" });
  });

  it("reads a health answer whose body stalls as down, not as a page that waits forever", async () => {
    vi.useFakeTimers();
    const client = relayerClient(config, stalling(false));
    const availability = client.availability(10143);
    await vi.advanceTimersByTimeAsync(RELAYER_TIMEOUT_MS);
    expect(await availability).toEqual({ kind: "down", state: "offline" });
  });
});

describe("ariary estimate", () => {
  it("multiplies in integers and rounds half up, for dollar tokens only", () => {
    const snapshot = parseFx(fx);
    expect(snapshot).toEqual({ date: "2026-10-08", mga: "4453.66921254", source: "fawazahmed0/exchange-api" });
    if (snapshot === null) {
      throw new Error("no snapshot");
    }
    // 25.50 × 4453.66921254 = 113,568.56… → 113,569 Ar.
    expect(ariaryOf(25_500_000n, ausd, snapshot)).toBe(113_569n);
    expect(ariaryOf(1n, ausd, snapshot)).toBe(0n);
    expect(ariaryOf(1_000_000n, { symbol: "MON", decimals: 18 }, snapshot)).toBeNull();
    const label = ariaryLabel(25_500_000n, ausd, snapshot, "fr", (p) => `≈ ${p.amount} · ${p.date}`);
    expect(label).toBe("≈ 113 569 Ar · 8 oct. 2026");
    expect(ariaryLabel(0n, ausd, snapshot, "en", () => "x")).toBeNull();
    expect(ariaryLabel(1n, ausd, null, "en", () => "x")).toBeNull();
  });

  it("hides the label for a malformed or unlicensed snapshot, or when the file is missing", async () => {
    for (const bad of [null, { ...fx, version: 2 }, { ...fx, rates: { MGA: "1e3" } }, { ...fx, rates: { MGA: "0" } }, { ...fx, date: "08/10/2026" }, { ...fx, source: { ...fx.source, license: "proprietary" } }]) {
      expect(parseFx(bad)).toBeNull();
    }
    expect(await loadFx(() => Promise.resolve(new Response(JSON.stringify(fx))))).toMatchObject({ mga: "4453.66921254" });
    expect(await loadFx(() => Promise.resolve(new Response("", { status: 404 })))).toBeNull();
    expect(await loadFx(() => Promise.reject(new TypeError("offline")))).toBeNull();
  });
});
