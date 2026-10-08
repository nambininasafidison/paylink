// SPDX-License-Identifier: MIT
/**
 * The gasless relayer's client (apps/relayer, PAYLINK-V2-SPEC §3.7). The endpoint comes from the same-origin
 * `/config.json` only (spec §3.6 "No URL-configurable endpoints"), and only for the chains it lists.
 *
 * The relayer is trusted for availability only: whatever it answers, the payment is proven by the chain (the receipt is
 * verified on the registry RPC), and its refusals carry a `fallback` the payer view acts on (`self-submit` the same
 * authorisation, `retry` later). Answers are parsed strictly: an unexpected body is a failure, never a success.
 *
 * Requests carry no credentials and no referrer; bodies are the invoice spec's relay bodies (§11.2), which contain no
 * memo and nothing personal beyond the payer's address.
 */
import type { CancelAuthorizationJson, RelayPayRequestJson } from "@paylink/sdk";
import type { Address, Hex } from "viem";
import { endpointFor } from "./config.ts";
import type { RuntimeConfig } from "./config.ts";

/** Per-chain state in `GET /v1/health` (apps/relayer `ChainState`, plus `unreachable`). */
export type RelayerChainState = "ready" | "not-configured" | "awaiting-deployment" | "unfunded" | "rpc-error" | "unreachable";

export interface RelayerChainHealth {
  readonly chainId: number;
  readonly state: RelayerChainState;
  readonly operations: { readonly pay: boolean; readonly cancel: boolean; readonly onboard: boolean };
  /** The relayer's own address on the chain (public), for the status page. */
  readonly relayer: Address | null;
}

/** What the payer view needs to know, per chain. */
export type RelayerAvailability =
  | { readonly kind: "none" }
  | { readonly kind: "down"; readonly state: RelayerChainState | "offline" }
  | { readonly kind: "up"; readonly health: RelayerChainHealth };

/** `202 Accepted` or a duplicate's `200` (apps/relayer README "Endpoints"). */
export interface RelayAccepted {
  readonly status: "submitted" | "pending" | "settled";
  readonly kind: "pay" | "cancel" | "onboard";
  readonly chainId: number;
  readonly txHash: Hex;
  readonly duplicate: boolean;
}

/** An RFC 9457 problem the relayer answered, or a transport failure (`code: "offline"`). */
export class RelayerProblem extends Error {
  readonly code: string;
  readonly status: number;
  readonly fallback: "self-submit" | "retry" | "none";
  readonly retryAfter: number | null;
  readonly rule: string | null;
  readonly reason: string | null;
  /** The decoded revert of a failed simulation (`simulation-failed`), with the SDK's i18n key. */
  readonly revert: { readonly name: string; readonly i18nKey: string } | null;

  constructor(parts: {
    readonly code: string;
    readonly status: number;
    readonly detail: string;
    readonly fallback?: "self-submit" | "retry" | "none";
    readonly retryAfter?: number | null;
    readonly rule?: string | null;
    readonly reason?: string | null;
    readonly revert?: { readonly name: string; readonly i18nKey: string } | null;
  }) {
    super(`relayer ${parts.code}: ${parts.detail}`);
    this.name = "RelayerProblem";
    this.code = parts.code;
    this.status = parts.status;
    this.fallback = parts.fallback ?? "none";
    this.retryAfter = parts.retryAfter ?? null;
    this.rule = parts.rule ?? null;
    this.reason = parts.reason ?? null;
    this.revert = parts.revert ?? null;
  }
}

const TIMEOUT_MS = 12_000;
const HEALTH_TTL_MS = 20_000;
const STATES: readonly RelayerChainState[] = ["ready", "not-configured", "awaiting-deployment", "unfunded", "rpc-error", "unreachable"];
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200): string | null => (typeof value === "string" && value.length <= max ? value : null);

/** Parses one chain of a health document; anything malformed reads as unreachable. */
export function parseChainHealth(value: unknown): RelayerChainHealth | null {
  if (!isRecord(value) || typeof value["chainId"] !== "number" || !Number.isSafeInteger(value["chainId"])) {
    return null;
  }
  const state = STATES.find((s) => s === value["state"]) ?? "unreachable";
  const ops = isRecord(value["operations"]) ? value["operations"] : {};
  const relayer = typeof value["relayer"] === "string" && ADDRESS.test(value["relayer"]) ? (value["relayer"] as Address) : null;
  return {
    chainId: value["chainId"],
    state,
    operations: { pay: ops["pay"] === true, cancel: ops["cancel"] === true, onboard: ops["onboard"] === true },
    relayer,
  };
}

/** Parses a success body; `null` when it is not exactly what the relayer documents. */
export function parseAccepted(value: unknown, expected: { readonly kind: RelayAccepted["kind"]; readonly chainId: number }): RelayAccepted | null {
  if (!isRecord(value)) {
    return null;
  }
  const { status, kind, chainId, txHash, duplicate } = value;
  if ((status !== "submitted" && status !== "pending" && status !== "settled") || kind !== expected.kind || chainId !== expected.chainId) {
    return null;
  }
  if (typeof txHash !== "string" || !HEX32.test(txHash) || typeof duplicate !== "boolean") {
    return null;
  }
  return { status, kind: expected.kind, chainId: expected.chainId, txHash: txHash as Hex, duplicate };
}

/** Parses an `application/problem+json` body into a `RelayerProblem` (unknown members are ignored). */
export function parseProblem(value: unknown, httpStatus: number, retryAfterHeader: string | null): RelayerProblem {
  const body = isRecord(value) ? value : {};
  const fallback = body["fallback"] === "self-submit" || body["fallback"] === "retry" || body["fallback"] === "none" ? body["fallback"] : undefined;
  const headerSeconds = retryAfterHeader !== null && /^\d{1,6}$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
  const retryAfter = typeof body["retryAfter"] === "number" && Number.isFinite(body["retryAfter"]) && body["retryAfter"] >= 0 ? body["retryAfter"] : headerSeconds;
  const error = isRecord(body["error"]) ? body["error"] : null;
  const revertName = text(error?.["name"], 80);
  const revertKey = text(error?.["i18nKey"], 120);
  return new RelayerProblem({
    code: text(body["code"], 60) ?? `http-${String(httpStatus)}`,
    status: httpStatus,
    detail: text(body["detail"], 400) ?? text(body["title"], 200) ?? "",
    ...(fallback === undefined ? {} : { fallback }),
    retryAfter,
    rule: text(body["rule"], 80),
    reason: text(body["reason"], 80),
    revert: revertName !== null && revertKey !== null ? { name: revertName, i18nKey: revertKey } : null,
  });
}

export interface RelayerClient {
  /** The relayer's URL for this chain, or `null` when `/config.json` names none. */
  endpoint(chainId: number): string | null;
  /** The relayer's state for a chain (`GET /v1/health`, cached for 20 s; a failure reads as `down`). */
  availability(chainId: number): Promise<RelayerAvailability>;
  pay(body: RelayPayRequestJson): Promise<RelayAccepted>;
  cancel(body: CancelAuthorizationJson): Promise<RelayAccepted>;
  /** Monad testnet only: the relayer asks the AUSD faucet to fund `address` (10,000 test AUSD). */
  onboard(chainId: number, address: Address): Promise<RelayAccepted>;
  /** Forgets the cached health, so the next `availability` asks again. */
  invalidate(): void;
}

type Fetch = typeof fetch;

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function relayerClient(config: Pick<RuntimeConfig, "relayer">, fetcher: Fetch = (...args) => fetch(...args), now: () => number = Date.now): RelayerClient {
  let cached: { readonly at: number; readonly chains: ReadonlyMap<number, RelayerChainHealth> | null } | null = null;
  let inflight: Promise<ReadonlyMap<number, RelayerChainHealth> | null> | null = null;
  const base = config.relayer?.url.replace(/\/+$/, "") ?? null;

  const health = async (): Promise<ReadonlyMap<number, RelayerChainHealth> | null> => {
    if (cached !== null && now() - cached.at < HEALTH_TTL_MS) {
      return cached.chains;
    }
    inflight ??= (async () => {
      try {
        const response = await withTimeout(
          async (signal) => await fetcher(`${base ?? ""}/v1/health`, { method: "GET", signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: { accept: "application/json" } }),
          TIMEOUT_MS,
        );
        const body: unknown = await response.json();
        const list = isRecord(body) && Array.isArray(body["chains"]) ? body["chains"] : [];
        const chains = new Map<number, RelayerChainHealth>();
        for (const entry of list) {
          const parsed = parseChainHealth(entry);
          if (parsed !== null) {
            chains.set(parsed.chainId, parsed);
          }
        }
        cached = { at: now(), chains };
        return chains;
      } catch {
        cached = { at: now(), chains: null };
        return null;
      } finally {
        inflight = null;
      }
    })();
    return await inflight;
  };

  const post = async (path: string, body: unknown, expected: { readonly kind: RelayAccepted["kind"]; readonly chainId: number }): Promise<RelayAccepted> => {
    if (base === null || endpointFor(config.relayer, expected.chainId) === null) {
      throw new RelayerProblem({ code: "unknown-chain", status: 0, detail: "no relayer for this chain", fallback: "self-submit" });
    }
    let response: Response;
    try {
      response = await withTimeout(
        async (signal) =>
          await fetcher(`${base}${path}`, {
            method: "POST",
            signal,
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            headers: { "content-type": "application/json", accept: "application/json, application/problem+json" },
            body: JSON.stringify(body),
          }),
        TIMEOUT_MS,
      );
    } catch {
      cached = null;
      throw new RelayerProblem({ code: "offline", status: 0, detail: "the relayer did not answer", fallback: "retry" });
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) {
      const accepted = parseAccepted(parsed, expected);
      if (accepted === null) {
        throw new RelayerProblem({ code: "invalid-response", status: response.status, detail: "unexpected answer", fallback: "self-submit" });
      }
      return accepted;
    }
    throw parseProblem(parsed, response.status, response.headers.get("retry-after"));
  };

  return {
    endpoint: (chainId) => endpointFor(config.relayer, chainId),
    async availability(chainId) {
      if (endpointFor(config.relayer, chainId) === null) {
        return { kind: "none" };
      }
      const chains = await health();
      if (chains === null) {
        return { kind: "down", state: "offline" };
      }
      const chain = chains.get(chainId);
      if (chain === undefined) {
        return { kind: "down", state: "unreachable" };
      }
      return chain.state === "ready" ? { kind: "up", health: chain } : { kind: "down", state: chain.state };
    },
    pay: async (body) => await post(`/v1/${String(body.chainId)}/pay`, body, { kind: "pay", chainId: body.chainId }),
    cancel: async (body) => await post(`/v1/${String(body.chainId)}/cancel`, body, { kind: "cancel", chainId: body.chainId }),
    onboard: async (chainId, address) => await post(`/v1/${String(chainId)}/onboard`, { chainId, address }, { kind: "onboard", chainId }),
    invalidate() {
      cached = null;
    },
  };
}
