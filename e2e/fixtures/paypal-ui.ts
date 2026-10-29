// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's screens end to end (e2e/specs/paypal-ui.spec.ts, docs/paypal/SPEC.md §14.3): the production build
 * of the `all` and `paypal` editions under their real `_headers`, with Ethereum Sepolia's deployment and tokens taken from
 * a local chain (`PAYLINK_E2E_CHAINS`, as every e2e build does), and the edition's API answered by the test itself.
 *
 * - The chain: anvil with Ethereum Sepolia's chain id (11155111), PayLinkV2 2.0.0 put at its release address through
 *   the CREATE2 factory with the release init code (as the deploy kit does; `web/v2/deploy/data/release.json`), and two
 *   6-decimal EIP-3009 + EIP-2612 tokens standing in for Circle's USDC (EIP-712 domain "USDC"/"2", as read on Sepolia)
 *   and PayPal USD ("PayPal USD"/"1"), from protocol/test/mocks/Mock3009.sol. The registry's RPC URL,
 *   https://ethereum-sepolia-rpc.publicnode.com, is routed to it; nothing reaches the real Sepolia.
 * - The API: every request to the production API origin (`/config.json`'s `api`) is answered by `MockApi`, which plays
 *   the contract of `@paylink/api-contract` (routes, bodies, RFC 9457 problems, CORS for the site's origin only), verifies
 *   the payee's `PayLinkSession` signature like the API does, refuses session routes without its token, and lets each
 *   test choose the answer, the delay or the failure of each route. That is what makes every screen state reachable.
 * - The wallet: e2e/fixtures/wallet.ts (EIP-6963, anvil's unlocked accounts sign).
 *
 * Accounts are anvil's public defaults; no real key is used anywhere.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Route } from "@playwright/test";
import { concat, decodeFunctionResult, encodeDeployData, encodeFunctionData, getCreateAddress, parseUnits, verifyTypedData } from "viem";
import type { Abi, Address, Hex } from "viem";
import { API_ROUTES, PAYPAL_EDITION_CHAIN_ID, SESSION_DOMAIN, SESSION_TYPES } from "../../packages/api-contract/src/index.ts";
import type {
  AlertView,
  ApiProblemCode,
  ApiRouteId,
  AutoRecordView,
  CheckResponse,
  DeskResponse,
  DraftResponse,
  HealthResponse,
  InvoiceKey,
  ProposalView,
  RailsResponse,
  SessionRequest,
  TwinView,
} from "../../packages/api-contract/src/index.ts";
import { startAnvil } from "./anvil.ts";
import type { Anvil } from "./anvil.ts";
import { ACCOUNTS, artifact, send } from "./app.ts";
import { API_ORIGIN, SEPOLIA_RPC } from "./paypal.ts";
import { REPO } from "./server.ts";

export { ACCOUNTS, API_ORIGIN, SEPOLIA_RPC };
export const SEPOLIA = PAYPAL_EDITION_CHAIN_ID;

interface ReleaseData {
  readonly initCode: Hex;
  readonly release: { readonly create2: { readonly factory: Address; readonly salt: Hex; readonly address: Address } };
}
const release = JSON.parse(readFileSync(join(REPO, "web/v2/deploy/data/release.json"), "utf8")) as ReleaseData;
/** PayLinkV2's release address, the same on every chain (CREATE2). */
export const PAYLINK = release.release.create2.address;

/** anvil's default account #5 deploys the PayPal USD stand-in (nonce 0, so its address is known in advance). */
const PYUSD_OWNER: Address = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
export const USDC = { symbol: "USDC", name: "USDC (local)", domain: { name: "USDC", version: "2" }, decimals: 6, address: getCreateAddress({ from: ACCOUNTS.tokenOwner, nonce: 0n }) } as const;
export const PYUSD = { symbol: "PYUSD", name: "PayPal USD (local)", domain: { name: "PayPal USD", version: "1" }, decimals: 6, address: getCreateAddress({ from: PYUSD_OWNER, nonce: 0n }) } as const;
/** What the payer holds in each token. */
export const PAYER_FUNDS = parseUnits("500", 6);

/** `PAYLINK_E2E_CHAINS`: Ethereum Sepolia's identity and RPC URL, the local tokens and the local deployment. */
export function sepoliaE2eChains(): string {
  const token = (t: typeof USDC | typeof PYUSD): object => ({ symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals, eip3009: true, eip2612: true, domain: t.domain });
  return JSON.stringify([
    {
      base: SEPOLIA,
      rpcUrl: SEPOLIA_RPC,
      tokens: [token(USDC), token(PYUSD)],
      deployment: { address: PAYLINK, txHash: `0x${"0".repeat(63)}1`, blockNumber: "1", deployer: ACCOUNTS.deployer },
    },
  ]);
}

/** Builds `all` and `paypal` with the local Sepolia into apps/web/dist-e2e-paypalui. */
export async function buildPaypalUiSite(): Promise<string> {
  const app = join(REPO, "apps/web");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=@paylink/source", "scripts/build.ts", "--e2e"], {
      cwd: app,
      env: { ...process.env, PAYLINK_EDITIONS: "all,paypal", PAYLINK_E2E_OUT: "dist-e2e-paypalui", PAYLINK_E2E_CHAINS: sepoliaE2eChains() },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`the PayPal edition's e2e build exited with ${String(code)}`));
      }
    });
  });
  return join(app, "dist-e2e-paypalui");
}

export interface SepoliaChain {
  readonly anvil: Anvil;
  balanceOf(token: Address, owner: Address): Promise<bigint>;
  /** PayLinkV2's `cancelled` flag for `key` (statesOf), read on the chain. */
  cancelled(key: Hex): Promise<boolean>;
}

/** `stateOf(bytes32) returns (LinkState)`: payments, cancelled, lastPaidAt, total (protocol/src/interfaces/IPayLinkV2.sol). */
const STATE_OF = [
  {
    type: "function",
    name: "stateOf",
    stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ name: "state", type: "tuple", components: [{ name: "payments", type: "uint32" }, { name: "cancelled", type: "bool" }, { name: "lastPaidAt", type: "uint64" }, { name: "total", type: "uint128" }] }],
  },
] as const satisfies Abi;

/** anvil as Ethereum Sepolia: PayLinkV2 at its release address, the USDC and PayPal USD stand-ins, the payer funded. */
export async function startSepolia(): Promise<SepoliaChain> {
  const anvil = await startAnvil({ chainId: SEPOLIA, factory: "default" });
  const { create2 } = release.release;
  await send(anvil, ACCOUNTS.deployer, create2.factory, concat([create2.salt, release.initCode]));
  if ((await anvil.rpc<Hex>("eth_getCode", [PAYLINK, "latest"])) === "0x") {
    throw new Error("PayLinkV2 is not at the release address");
  }
  const mock = artifact("Mock3009.sol/Mock3009.json");
  for (const [owner, token] of [[ACCOUNTS.tokenOwner, USDC], [PYUSD_OWNER, PYUSD]] as const) {
    const deployed = await send(anvil, owner, null, encodeDeployData({ abi: mock.abi, bytecode: mock.bytecode, args: [token.domain.name, token.symbol, token.domain.version, token.decimals] }));
    if (deployed.contractAddress?.toLowerCase() !== token.address.toLowerCase()) {
      throw new Error(`${token.symbol} landed at ${String(deployed.contractAddress)}, not ${token.address}`);
    }
    await send(anvil, owner, token.address, encodeFunctionData({ abi: mock.abi, functionName: "mint", args: [ACCOUNTS.payer, PAYER_FUNDS] }));
  }
  return {
    anvil,
    balanceOf: async (token, owner) => BigInt(await anvil.rpc<Hex>("eth_call", [{ to: token, data: encodeFunctionData({ abi: mock.abi, functionName: "balanceOf", args: [owner] }) }, "latest"])),
    cancelled: async (key) => {
      const data = await anvil.rpc<Hex>("eth_call", [{ to: PAYLINK, data: encodeFunctionData({ abi: STATE_OF, functionName: "stateOf", args: [key] }) }, "latest"]);
      return decodeFunctionResult({ abi: STATE_OF, functionName: "stateOf", data }).cancelled;
    },
  };
}

/** A JSON-RPC call the page makes, and the answer to give instead of the chain's (`undefined`: ask the chain). */
export type RpcOverride = (call: { readonly method: string; readonly params: readonly unknown[] }) => unknown;

/**
 * Sends the page's requests for Sepolia's registry RPC to `anvil`, with the CORS answers a public RPC gives. `override`
 * answers chosen calls itself (a token's `paused()`, for instance). Returns the methods seen.
 */
export async function routeSepolia(context: BrowserContext, anvil: Anvil, override: { current: RpcOverride | null } = { current: null }): Promise<string[]> {
  const log: string[] = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
  await context.route(`${SEPOLIA_RPC}/**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const body = JSON.parse(request.postData() ?? "{}") as { id: unknown; method: string; params?: unknown[] } | { id: unknown; method: string; params?: unknown[] }[];
    const one = async (call: { id: unknown; method: string; params?: unknown[] }): Promise<unknown> => {
      log.push(call.method);
      const forced = override.current?.({ method: call.method, params: call.params ?? [] });
      if (forced !== undefined) {
        return { jsonrpc: "2.0", id: call.id, result: forced };
      }
      const response = await fetch(anvil.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call) });
      return await response.json();
    };
    const answer = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
    await route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(answer) });
  });
  return log;
}

// ------------------------------------------------------------------------------------------- the API

/** One request the page made to the API. */
export interface ApiCall {
  readonly route: ApiRouteId;
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** The bearer token the request carried, if any. */
  readonly token: string | null;
}

/** An answer: a status and a body, or a problem; `delayMs` holds it back; `abort` drops the connection. */
export type ApiAnswer = { readonly status: number; readonly body: unknown; readonly delayMs?: number } | { readonly abort: true; readonly delayMs?: number };
export type ApiHandler = (call: ApiCall) => ApiAnswer | Promise<ApiAnswer>;

/** An RFC 9457 problem as the API writes it. */
export function problem(code: ApiProblemCode, status: number, rule?: string): ApiAnswer {
  return { status, body: { type: `https://paylink.example/problems/${code}`, code, status, title: code, detail: "e2e", ...(rule === undefined ? {} : { rule }) } };
}

export const ok = (body: unknown, status = 200, delayMs?: number): ApiAnswer => ({ status, body, ...(delayMs === undefined ? {} : { delayMs }) });

const ROUTES = API_ROUTES.map((spec) => ({
  ...spec,
  names: [...spec.path.matchAll(/:([a-z]+)/g)].map((m) => m[1] ?? ""),
  pattern: new RegExp(`^${spec.path.replace(/:([a-z]+)/g, "([^/]+)")}$`),
}));

/**
 * The edition's API as the test plays it. Session routes need the token `session.create` issued (else 401, as the API);
 * `session.create` verifies the payee's EIP-712 signature (else 401). Every other route answers what the test set with
 * `on`, else its default: health OK, no rails, and 501 for the rest (the API's answer for a route not implemented).
 */
export class MockApi {
  readonly calls: ApiCall[] = [];
  private readonly handlers = new Map<ApiRouteId, ApiHandler>();
  private readonly tokens = new Set<string>();
  private issued = 0;

  private readonly siteOrigin: string;

  constructor(siteOrigin: string) {
    this.siteOrigin = siteOrigin;
  }

  /** Sets the answer of `route` (replacing the previous one). */
  on(route: ApiRouteId, handler: ApiHandler | ApiAnswer): this {
    this.handlers.set(route, typeof handler === "function" ? handler : () => handler);
    return this;
  }

  /** Answers `route` with each of `answers` in turn, then the last one again. */
  sequence(route: ApiRouteId, answers: readonly ApiAnswer[]): this {
    let next = 0;
    return this.on(route, () => {
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      if (answer === undefined) {
        throw new Error(`no answer for ${route}`);
      }
      return answer;
    });
  }

  /** Forgets every token issued (the API's sessions lapse: the next session route answers 401). */
  expireSessions(): void {
    this.tokens.clear();
  }

  /** The calls to `route`. */
  to(route: ApiRouteId): ApiCall[] {
    return this.calls.filter((c) => c.route === route);
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route(`${API_ORIGIN}/**`, async (route: Route) => {
      await this.serve(route);
    });
  }

  private cors(): Record<string, string> {
    return { "access-control-allow-origin": this.siteOrigin, vary: "Origin", "access-control-expose-headers": "Retry-After, X-Request-Id" };
  }

  private async serve(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (request.headers()["origin"] !== this.siteOrigin) {
      await route.fulfill({ status: 403, body: "origin-not-allowed" });
      return;
    }
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { ...this.cors(), "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "access-control-max-age": "600" } });
      return;
    }
    const spec = ROUTES.find((r) => r.method === request.method() && r.pattern.test(url.pathname));
    if (spec === undefined) {
      await this.fulfill(route, problem("not-found", 404));
      return;
    }
    const values = spec.pattern.exec(url.pathname)?.slice(1) ?? [];
    const params = Object.fromEntries(spec.names.map((name, i) => [name, decodeURIComponent(values[i] ?? "")]));
    const auth = /^Bearer (.+)$/.exec(request.headers()["authorization"] ?? "")?.[1] ?? null;
    const raw = request.postData();
    const call: ApiCall = { route: spec.id, method: request.method(), path: url.pathname, params, body: raw === null || raw === "" ? undefined : (JSON.parse(raw) as unknown), token: auth };
    this.calls.push(call);
    if (spec.auth === "session" && (auth === null || !this.tokens.has(auth))) {
      await this.fulfill(route, problem("unauthorized", 401));
      return;
    }
    const handler = this.handlers.get(spec.id);
    if (handler !== undefined) {
      await this.fulfill(route, await handler(call));
      return;
    }
    switch (spec.id) {
      case "session.create":
        await this.fulfill(route, await this.session(call));
        return;
      case "health":
        await this.fulfill(route, ok(health()));
        return;
      case "rails.get":
        await this.fulfill(route, ok(rails({ status: "none" })));
        return;
      default:
        await this.fulfill(route, problem("not-implemented", 501));
    }
  }

  /** `POST /v1/session`: the payee's EIP-712 signature over the session, checked as the API checks it. */
  private async session(call: ApiCall): Promise<ApiAnswer> {
    const request = call.body as SessionRequest;
    const { session } = request;
    const valid =
      request.chainId === SEPOLIA &&
      session.origin === this.siteOrigin &&
      BigInt(session.expiresAt) - BigInt(session.issuedAt) <= 12n * 3600n &&
      (await verifyTypedData({
        address: session.payee,
        domain: { ...SESSION_DOMAIN, chainId: SEPOLIA },
        types: SESSION_TYPES,
        primaryType: "PayLinkSession",
        message: { payee: session.payee, origin: session.origin, issuedAt: BigInt(session.issuedAt), expiresAt: BigInt(session.expiresAt), nonce: session.nonce },
        signature: request.signature,
      }).catch(() => false));
    if (!valid) {
      return problem("unauthorized", 401);
    }
    this.issued += 1;
    const token = `ps1.e2e-${String(this.issued)}`;
    this.tokens.add(token);
    return ok({ token, payee: session.payee, expiresAt: new Date(Number(session.expiresAt) * 1000).toISOString() });
  }

  private async fulfill(route: Route, answer: ApiAnswer): Promise<void> {
    if (answer.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    }
    if ("abort" in answer) {
      await route.abort("connectionrefused");
      return;
    }
    const isProblem = typeof answer.body === "object" && answer.body !== null && "code" in answer.body && answer.status >= 400;
    await route.fulfill({
      status: answer.status,
      headers: { ...this.cors(), "content-type": isProblem ? "application/problem+json" : "application/json", "cache-control": "no-store" },
      body: JSON.stringify(answer.body),
    });
  }
}

// ------------------------------------------------------------------------------------------- answers

export const NOW = (): string => new Date().toISOString();

export function health(over: Partial<HealthResponse> = {}): HealthResponse {
  const at = NOW();
  return {
    status: "degraded",
    service: "paylink-api",
    version: "0.1.0",
    contract: 1,
    time: at,
    paypalEnvironment: "sandbox",
    rows: [
      { id: "paypal", state: "ok", code: "last-get", checkedAt: at },
      { id: "webhook", state: "ok", code: "last-verified", checkedAt: at, values: { ageSeconds: 95 } },
      { id: "assistant", state: "unknown", code: "model:@cf/google/gemma-4-26b-a4b-it", checkedAt: null, values: { dailyNeuronBudget: 9000, neuronsLeft: 7450 } },
      { id: "chain", state: "ok", code: "deployed", checkedAt: null, values: { chainId: SEPOLIA } },
      { id: "store", state: "ok", code: "readable", checkedAt: at },
    ],
    ...over,
  };
}

export function rails(over: Partial<RailsResponse>): RailsResponse {
  return { status: "none", amount: null, currency: null, url: null, checkedAt: null, ...over };
}

/** PayPal's invoice number for `key` (`PL-<chainId>-<first 12 hex of K>`, docs/paypal/SPEC.md §7.2). */
export const numberOf = (key: string): string => `PL-${String(SEPOLIA)}-${key.slice(2, 14)}`;

export function twin(key: InvoiceKey, over: Partial<TwinView> = {}): TwinView {
  return {
    key,
    paypalId: "INV2-E2E0-AAAA-BBBB-CCCC",
    number: numberOf(key),
    // The sandbox's open status after a share link (the owner's capture of 2026-10-29).
    status: "UNPAID",
    statusClass: "open",
    recipientViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2E2E0AAAABBBBCCCC",
    amount: "120.00",
    currency: "USD",
    situation: "S1",
    checkedAt: NOW(),
    ...over,
  };
}

export function draftAnswer(over: Partial<Extract<DraftResponse, { outcome: "draft" }>> = {}, draft: Partial<Extract<DraftResponse, { outcome: "draft" }>["draft"]> = {}): DraftResponse {
  return {
    outcome: "draft",
    draft: { amountBase: "120000000", amountText: "$120", currency: "USD", description: "Logo design", clientName: "Sarah", clientEmail: null, dueDate: inDays(14), clientLanguage: "en", ...draft },
    clarifications: [],
    confidence: "high",
    model: "@cf/google/gemma-4-26b-a4b-it",
    ...over,
  };
}

/** `YYYY-MM-DD`, `days` from today (UTC). */
export function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const HASH = (n: number): Hex => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;

export function proposal(key: InvoiceKey, over: Partial<ProposalView> = {}): ProposalView {
  const n = Number.parseInt(key.slice(2, 4), 16);
  return {
    id: `p_${key.slice(2, 10)}_${over.kind ?? "cancel_paypal"}`,
    kind: "cancel_paypal",
    key,
    invoiceNumber: numberOf(key),
    amount: "120.00",
    rail: "PAYPAL",
    situation: "S7",
    exact: [
      { label: "invoice", value: numberOf(key) },
      { label: "amount", value: "120.00 USD" },
      { label: "action", value: over.kind ?? "cancel_paypal" },
      { label: "effect", value: "closes-the-paypal-rail" },
      { label: "rail", value: "PAYPAL" },
    ],
    reasonCode: "chain-cancelled",
    origin: "reconciler",
    message: null,
    args: { invoice: numberOf(key), amount: "120.00", currency: "USD" },
    hash: HASH(n),
    token: `approval-${key.slice(2, 10)}`,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    state: "open",
    createdAt: NOW(),
    ...over,
  };
}

export function autoRecord(key: InvoiceKey, over: Partial<AutoRecordView> = {}): AutoRecordView {
  return {
    id: "r_EXTR-86F38350LX4353815",
    key,
    invoiceNumber: numberOf(key),
    paymentId: "EXTR-86F38350LX4353815",
    rail: "USDC",
    txHash: `0x${"ef".repeat(32)}`,
    recordedAt: NOW(),
    undoUntil: new Date(Date.now() + 23 * 3_600_000).toISOString(),
    undone: false,
    ...over,
  };
}

export function alert(key: InvoiceKey, over: Partial<AlertView> = {}): AlertView {
  return { key, invoiceNumber: numberOf(key), situation: "S4", code: "paid-twice", raisedAt: NOW(), ...over };
}

export function desk(over: Partial<DeskResponse> = {}): DeskResponse {
  return { proposals: [], autoRecords: [], alerts: [], checkedAt: NOW(), assistant: { available: true, reason: null }, ...over };
}

export function check(over: Partial<CheckResponse> = {}): CheckResponse {
  return { verdict: "NOT_RECEIVED", sources: { paypal: "checked", chain: "checked" }, matches: [], links: [], checkedAt: NOW(), ...over };
}

/** A key that no invoice of the run has (for desk cards that need no invoice on the device). */
export const keyOf = (n: number): InvoiceKey => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
