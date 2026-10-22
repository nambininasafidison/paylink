// SPDX-License-Identifier: MIT
/**
 * Sessions (docs/paypal/SPEC.md §12.2): a payee proves an address with one EIP-712 signature and gets a token valid at
 * most 12 hours; the token opens only that payee's routes. Signed with anvil's public test key (never a real key).
 */
import { SESSION_DOMAIN, SESSION_MAX_SECONDS, SESSION_TYPES } from "@paylink/api-contract";
import type { ApiProblem, SessionRequest, SessionResponse } from "@paylink/api-contract";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/core/app.ts";
import { HANDLER_MAPS } from "../../src/core/app.ts";
import type { RouteHandlers } from "../../src/routes/types.ts";
import { createSessions, sessionDigest } from "../../src/session/factory.ts";
import { SESSION_SIGNED_WITHIN_S } from "../../src/session/types.ts";
import { createMemoryStores } from "../../src/store/memory.ts";
import { DEMO_RESERVE, PAYEE_DAILY, SOURCE_DAILY } from "../../src/store/quotas.ts";
import type { StoreFactory } from "../../src/store/types.ts";
import { T0, TEST_ORIGIN, testRuntime, testServices } from "../helpers.ts";
import { deadFetch, rpcFake } from "../chain/rpc.ts";

/** anvil's public default account #1 (mnemonic "test test … junk"): a test key known to everyone. */
const PAYEE = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const OTHER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const NOW_S = Math.floor(T0 / 1000);
const SECRET = "33".repeat(32);

async function signed(overrides: Partial<SessionRequest["session"]> = {}, options: { readonly signer?: typeof PAYEE; readonly chainId?: number; readonly nonce?: number } = {}): Promise<SessionRequest> {
  const session = {
    payee: PAYEE.address,
    origin: TEST_ORIGIN,
    issuedAt: String(NOW_S),
    expiresAt: String(NOW_S + 3600),
    nonce: hex32(options.nonce ?? 1),
    ...overrides,
  };
  const chainId = options.chainId ?? 11155111;
  const signature = await (options.signer ?? PAYEE).signTypedData({
    domain: { ...SESSION_DOMAIN, chainId },
    types: SESSION_TYPES,
    primaryType: "PayLinkSession",
    message: { ...session, issuedAt: BigInt(session.issuedAt), expiresAt: BigInt(session.expiresAt) },
  });
  return { chainId, session, signature };
}

/** Sepolia as the tests see it: every address is code-less (an EOA). */
const NO_CODE = rpcFake((method) => (method === "eth_getCode" ? "0x" : null)).fetch;

const hex32 = (n: number): `0x${string}` => `0x${String(n).padStart(64, "0")}`;

const sessions = (secret: string | null = SECRET, kind: "node" | "worker" = "node", fetchFn: typeof fetch = NO_CODE, options: { readonly stores?: StoreFactory; readonly demoPayees?: readonly string[] } = {}) => {
  const runtime = testRuntime({ secrets: secret === null ? {} : { sessionHmacKey: secret } });
  const config = options.demoPayees === undefined ? runtime.config : { ...runtime.config, demoPayees: options.demoPayees };
  return createSessions({ runtime: { ...runtime, config, kind, fetch: fetchFn }, stores: options.stores ?? createMemoryStores() });
};

const rule = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return (error as { problem?: ApiProblem }).problem?.rule;
  }
};

describe("opening a session", () => {
  it("verifies the payee's EIP-712 signature and answers a token for that payee, until the signed expiry", async () => {
    const s = sessions();
    const request = await signed();
    const opened = await s.open(request, T0);
    expect(opened).toMatchObject({ payee: PAYEE.address, expiresAt: new Date((NOW_S + 3600) * 1000).toISOString() });
    expect(opened.token).toMatch(/^ps1\.[0-9a-f]{40}\.\d+\.[A-Za-z0-9_-]{43}$/u);
    expect(await s.check(opened.token, T0)).toEqual({ ok: true, payee: PAYEE.address, expiresAt: (NOW_S + 3600) * 1000 });
    expect(await s.check(opened.token, (NOW_S + 3600) * 1000)).toEqual({ ok: false, reason: "expired" });
    expect(sessionDigest(request)).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  it("accepts a signature with v in {0, 1} and upper-case hex, as some wallets send it", async () => {
    const request = await signed({}, { nonce: 7 });
    const v = Number.parseInt(request.signature.slice(130, 132), 16) - 27;
    const wallet = `${request.signature.slice(0, 130).toUpperCase().replace("0X", "0x")}${v.toString(16).padStart(2, "0")}` as `0x${string}`;
    await expect(sessions().open({ ...request, signature: wallet }, T0)).resolves.toMatchObject({ payee: PAYEE.address });
  });

  it("refuses a signature by another key, a changed field, another chain or another origin", async () => {
    const s = sessions();
    expect(await rule(s.open(await signed({}, { signer: OTHER }), T0))).toBe("E_SESSION_SIGNATURE");
    const request = await signed({}, { nonce: 2 });
    expect(await rule(s.open({ ...request, session: { ...request.session, expiresAt: String(NOW_S + 7200) } }, T0))).toBe("E_SESSION_SIGNATURE");
    expect(await rule(s.open(await signed({}, { chainId: 1, nonce: 3 }), T0))).toBe("E_SESSION_CHAIN");
    expect(await rule(s.open(await signed({ origin: "https://evil.example" }, { nonce: 4 }), T0))).toBe("E_SESSION_ORIGIN");
  });

  it("refuses times outside the window: stale signature, future signature, expired, longer than 12 hours", async () => {
    const s = sessions();
    expect(await rule(s.open(await signed({ issuedAt: String(NOW_S - SESSION_SIGNED_WITHIN_S - 1) }), T0))).toBe("E_SESSION_TIME");
    expect(await rule(s.open(await signed({ issuedAt: String(NOW_S + 600) }), T0))).toBe("E_SESSION_TIME");
    expect(await rule(s.open(await signed({ expiresAt: String(NOW_S) }), T0))).toBe("E_SESSION_TIME");
    expect(await rule(s.open(await signed({ expiresAt: String(NOW_S + SESSION_MAX_SECONDS + 1) }), T0))).toBe("E_SESSION_TIME");
    await expect(s.open(await signed({ expiresAt: String(NOW_S + SESSION_MAX_SECONDS) }, { nonce: 9 }), T0)).resolves.toMatchObject({ payee: PAYEE.address });
  });

  it("opens one session per signed nonce (replay)", async () => {
    const s = sessions();
    const request = await signed({}, { nonce: 5 });
    await s.open(request, T0);
    expect(await rule(s.open(request, T0 + 1000))).toBe("E_SESSION_REPLAYED");
  });

  it("accepts a smart account's ERC-1271 approval, read through the registry's RPC, and never guesses when it cannot read", async () => {
    const account = "0x000000000000000000000000000000000000c0DE";
    const smart = rpcFake((method) => (method === "eth_getCode" ? "0x6080" : method === "eth_call" ? `0x1626ba7e${"0".repeat(56)}` : null));
    const request = await signed({ payee: account }, { signer: OTHER, nonce: 11 });
    await expect(sessions(SECRET, "node", smart.fetch).open(request, T0)).resolves.toMatchObject({ payee: account });
    expect(smart.calls.map((c) => c.method)).toEqual(["eth_getCode", "eth_call"]);
    const refusing = rpcFake((method) => (method === "eth_getCode" ? "0x6080" : `0xffffffff${"0".repeat(56)}`));
    expect(await rule(sessions(SECRET, "node", refusing.fetch).open(await signed({ payee: account }, { signer: OTHER, nonce: 12 }), T0))).toBe("E_SESSION_SIGNATURE");
    expect(await rule(sessions(SECRET, "node", deadFetch).open(await signed({}, { signer: OTHER, nonce: 13 }), T0))).toBe("E_SESSION_ERC1271_UNREADABLE");
  });

  it("needs the secret in the Worker", async () => {
    expect(await rule(sessions(null, "worker").open(await signed(), T0))).toBe("E_SESSION_KEY_MISSING");
    expect(await sessions(null, "worker").check("ps1.x", T0)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("daily limits (threat T-60)", () => {
  const DAY = "2026-10-21";
  const read = async (stores: StoreFactory) => ({
    // A limit of 0 refuses without counting: it reads the counter.
    sessions: (await stores.global().useQuota(DAY, "sessions", 0)).used,
    source: (await stores.global().useSubjectQuota(DAY, "sessions-source", "203.0.113.7", 0, Number.MAX_SAFE_INTEGER)).used,
    payee: (await stores.global().useSubjectQuota(DAY, "sessions-payee", PAYEE.address, 0, Number.MAX_SAFE_INTEGER)).used,
  });

  it("a replayed signed body is refused before it counts: no counter moves (the review's probe: ten POSTs moved it ten times)", async () => {
    const stores = createMemoryStores();
    const s = sessions(SECRET, "node", NO_CODE, { stores });
    const request = await signed({}, { nonce: 21 });
    await s.open(request, T0, { source: "203.0.113.7" });
    for (let i = 0; i < 9; i += 1) {
      expect(await rule(s.open(request, T0 + i, { source: "203.0.113.7" }))).toBe("E_SESSION_REPLAYED");
    }
    expect(await read(stores)).toEqual({ sessions: 1, source: 1, payee: 1 });
  });

  it("one payee opens at most 20 sessions a day; one source at most 30, whatever the keys; another source still opens", async () => {
    const stores = createMemoryStores();
    const s = sessions(SECRET, "node", NO_CODE, { stores });
    for (let i = 0; i < PAYEE_DAILY.sessions; i += 1) {
      await s.open(await signed({}, { nonce: 100 + i }), T0, { source: "198.51.100.1" });
    }
    expect(await rule(s.open(await signed({}, { nonce: 199 }), T0, { source: "198.51.100.2" }))).toBe("E_QUOTA_PAYEE");
    // An attacker with fresh keys from one source: stopped at the source's limit, long before the deployment's.
    let opened = 0;
    let refusal: string | undefined;
    for (let i = 0; i < SOURCE_DAILY.sessions + 5 && refusal === undefined; i += 1) {
      const key = privateKeyToAccount(generatePrivateKey());
      const outcome = await rule(s.open(await signed({ payee: key.address }, { signer: key, nonce: 300 + i }), T0, { source: "192.0.2.66" }));
      if (outcome === "resolved") {
        opened += 1;
      } else {
        refusal = outcome;
      }
    }
    expect({ opened, refusal }).toEqual({ opened: SOURCE_DAILY.sessions, refusal: "E_QUOTA_SOURCE" });
    // A judge from elsewhere is not affected.
    const judge = await signed({ payee: OTHER.address }, { signer: OTHER, nonce: 401 });
    await expect(s.open(judge, T0, { source: "192.0.2.77" })).resolves.toMatchObject({ payee: OTHER.address });
  });

  it("the deployment's limit holds for the public, and the demo payees keep their own lane when it is spent", async () => {
    const stores = createMemoryStores();
    const s = sessions(SECRET, "node", NO_CODE, { stores, demoPayees: [PAYEE.address.toLowerCase()] });
    const { SESSIONS_PER_DAY } = await import("../../src/session/types.ts");
    for (let i = 0; i < SESSIONS_PER_DAY; i += 1) {
      await stores.global().useQuota(DAY, "sessions", SESSIONS_PER_DAY);
    }
    const judge = await signed({ payee: OTHER.address }, { signer: OTHER, nonce: 500 });
    expect(await rule(s.open(judge, T0, { source: "192.0.2.10" }))).toBe("E_SESSION_QUOTA");
    // The demo payee: no payee or source limit, its own reserved lane.
    for (let i = 0; i < PAYEE_DAILY.sessions + SOURCE_DAILY.sessions + 1; i += 1) {
      await s.open(await signed({}, { nonce: 600 + i }), T0, { source: "192.0.2.10" });
    }
    expect((await stores.global().useQuota(DAY, "sessionsDemo", 0)).used).toBe(PAYEE_DAILY.sessions + SOURCE_DAILY.sessions + 1);
    expect(DEMO_RESERVE.sessions).toBeGreaterThan(PAYEE_DAILY.sessions + SOURCE_DAILY.sessions + 1);
  });
});

describe("checking a token", () => {
  it("refuses a missing, malformed, forged or rotated-key token", async () => {
    const s = sessions();
    const { token } = await s.open(await signed({}, { nonce: 6 }), T0);
    expect(await s.check(null, T0)).toEqual({ ok: false, reason: "missing" });
    expect(await s.check("Bearer x", T0)).toEqual({ ok: false, reason: "malformed" });
    const [prefix, , exp, mac] = token.split(".") as [string, string, string, string];
    expect(await s.check([prefix, OTHER.address.toLowerCase().slice(2), exp, mac].join("."), T0)).toEqual({ ok: false, reason: "bad-mac" });
    expect(await s.check([prefix, PAYEE.address.toLowerCase().slice(2), String(Number(exp) + 1), mac].join("."), T0)).toEqual({ ok: false, reason: "bad-mac" });
    expect(await sessions("44".repeat(32)).check(token, T0)).toEqual({ ok: false, reason: "bad-mac" });
  });
});

describe("POST /v1/session", () => {
  const echo: RouteHandlers = { "desk.get": ({ c, payee }) => Promise.resolve(c.json({ payee })) };

  it("answers 201 with the token, which then opens the payee's session routes", async () => {
    const services = testServices({ runtime: { ...testRuntime({ secrets: { sessionHmacKey: SECRET } }), fetch: NO_CODE } });
    const app = createApp(services, [...HANDLER_MAPS.filter((m) => !("desk.get" in m)), echo]);
    const response = await app.request("/v1/session", { method: "POST", headers: { "content-type": "application/json", origin: TEST_ORIGIN }, body: JSON.stringify(await signed({}, { nonce: 8 })) });
    expect(response.status).toBe(201);
    const body = (await response.json()) as SessionResponse;
    const desk = await app.request("/v1/desk", { headers: { authorization: `Bearer ${body.token}` } });
    expect(await desk.json()).toEqual({ payee: PAYEE.address });
  });

  it("refuses a malformed body before any signature work, and a bad signature with 401", async () => {
    const app = createApp(testServices({ runtime: { ...testRuntime({ secrets: { sessionHmacKey: SECRET } }), fetch: NO_CODE } }));
    const bad = await app.request("/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: 11155111, session: {}, signature: "0x" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiProblem).code).toBe("invalid-request");
    const forged = await signed({}, { signer: OTHER, nonce: 10 });
    const refused = await app.request("/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forged) });
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as ApiProblem).rule).toBe("E_SESSION_SIGNATURE");
  });
});
