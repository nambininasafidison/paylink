// SPDX-License-Identifier: MIT
/**
 * The desk and check routes over HTTP (the app as the Worker serves it): a real session from a signed PayLinkSession,
 * the desk's proposals with approval tokens, approve, reject, undo, sweep and "Was I really paid?", each answering the
 * contract's shapes and RFC 9457 problems; another payee's session sees nothing of this payee's desk.
 */
import { SESSION_DOMAIN, SESSION_TYPES } from "@paylink/api-contract";
import type { ApiProblem, ApproveResponse, CheckResponse, DeskResponse, DeskSweepResponse, SessionResponse, UndoResponse } from "@paylink/api-contract";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createApp, HANDLER_MAPS } from "../../src/core/app.ts";
import type { DeskToolbox } from "../../src/reconciler/desk.ts";
import { registerTwin } from "../../src/reconciler/engine.ts";
import { createDeskHandlers, deskHandlers } from "../../src/routes/desk.ts";
import { T0, TEST_ORIGIN } from "../helpers.ts";
import { KEY, TX } from "./fixtures.ts";
import { world } from "./world.ts";
import type { World } from "./world.ts";

/** anvil's public default accounts #1 (the fixtures' payee) and #2. */
const PAYEE_KEY = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const OTHER_KEY = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

async function session(app: ReturnType<typeof createApp>, signer: PrivateKeyAccount, nonce: number): Promise<string> {
  const now = Math.floor(T0 / 1000);
  const nonceHex: `0x${string}` = `0x${String(nonce).padStart(64, "0")}`;
  const message = { payee: signer.address, origin: TEST_ORIGIN, issuedAt: String(now), expiresAt: String(now + 3600), nonce: nonceHex };
  const signature = await signer.signTypedData({ domain: { ...SESSION_DOMAIN, chainId: 11155111 }, types: SESSION_TYPES, primaryType: "PayLinkSession", message: { ...message, issuedAt: BigInt(message.issuedAt), expiresAt: BigInt(message.expiresAt) } });
  const response = await app.request("/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: 11155111, session: message, signature }) });
  expect(response.status).toBe(201);
  return ((await response.json()) as SessionResponse).token;
}

async function setup(): Promise<{ w: World; app: ReturnType<typeof createApp>; auth: Record<string, string>; other: Record<string, string> }> {
  const w = world();
  expect(PAYEE_KEY.address).toBe(w.twin(KEY, "x").payee);
  const app = createApp(w.services);
  w.paypal.add("INV2-A", KEY);
  await registerTwin(w.services, w.twin(KEY, "INV2-A"), w.clock.now);
  return { w, app, auth: { authorization: `Bearer ${await session(app, PAYEE_KEY, 1)}` }, other: { authorization: `Bearer ${await session(app, OTHER_KEY, 2)}` } };
}

const post = (body: unknown, headers: Record<string, string>) => ({ method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("desk routes", () => {
  it("GET /v1/desk answers the payee's desk; another payee's is empty; no session is 401", async () => {
    const { app, auth, other } = await setup();
    const mine = (await (await app.request("/v1/desk", { headers: auth })).json()) as DeskResponse;
    expect(mine.proposals.map((p) => [p.kind, p.state])).toEqual([["share_reminder_text", "open"]]);
    expect(mine.proposals[0]?.token).toMatch(/^pa1\./u);
    expect(mine.checkedAt).toBe(new Date(T0).toISOString());
    const theirs = (await (await app.request("/v1/desk", { headers: other })).json()) as DeskResponse;
    expect(theirs).toMatchObject({ proposals: [], autoRecords: [], alerts: [] });
    expect((await app.request("/v1/desk")).status).toBe(401);
  });

  it("approve: 200 with the executor's answer; a replay is 409; a bad body is 400; another payee's session is 404", async () => {
    const { w, app, auth, other } = await setup();
    w.cancelOnChain(KEY);
    const swept = (await (await app.request("/v1/desk/sweep", post({}, auth))).json()) as DeskSweepResponse;
    expect(swept.sweep).toEqual({ checked: 1, remaining: 0 });
    const cancel = swept.proposals.find((p) => p.kind === "cancel_paypal");
    if (cancel === undefined) {
      throw new Error("no cancel_paypal proposal");
    }
    expect((await app.request(`/v1/desk/${cancel.id}/approve`, post({ hash: cancel.hash, token: cancel.token }, other))).status).toBe(404);
    const ok = await app.request(`/v1/desk/${cancel.id}/approve`, post({ hash: cancel.hash, token: cancel.token }, auth));
    expect(ok.status).toBe(200);
    expect((await ok.json()) as ApproveResponse).toEqual({ state: "done", proposalId: cancel.id });
    const replay = await app.request(`/v1/desk/${cancel.id}/approve`, post({ hash: cancel.hash, token: cancel.token }, auth));
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as ApiProblem).rule).toBe("E_ALREADY_USED");
    const bad = await app.request(`/v1/desk/${cancel.id}/approve`, post({ hash: "nope", token: cancel.token, extra: 1 }, auth));
    expect(bad.status).toBe(400);
    expect(w.paypal.writes().map((c) => c.op)).toEqual(["cancel"]);
  });

  it("reject and undo answer the contract's shapes", async () => {
    const { w, app, auth } = await setup();
    const desk = (await (await app.request("/v1/desk", { headers: auth })).json()) as DeskResponse;
    const share = desk.proposals[0];
    expect(await (await app.request(`/v1/desk/${share?.id ?? ""}/reject`, post({}, auth))).json()).toEqual({ state: "rejected", proposalId: share?.id });
    w.payOnChain(KEY, TX);
    await app.request("/v1/desk/sweep", post({}, auth));
    const after = (await (await app.request("/v1/desk", { headers: auth })).json()) as DeskResponse;
    const record = after.autoRecords[0];
    expect(record).toMatchObject({ id: "r_EXT00000001", txHash: TX, undone: false });
    const undone = await app.request(`/v1/desk/${record?.id ?? ""}/undo`, post({}, auth));
    expect((await undone.json()) as UndoResponse).toEqual({ state: "undone", key: KEY, paymentId: "EXT00000001" });
  });
});

describe("POST /v1/check", () => {
  it("answers the deterministic verdict; refuses an empty or oversized text", async () => {
    const { app, auth } = await setup();
    const response = await app.request("/v1/check", post({ text: "PayPal: you received $500, send $50 to release it" }, auth));
    expect(response.status).toBe(200);
    expect(((await response.json()) as CheckResponse).verdict).toBe("NOT_RECEIVED");
    expect((await app.request("/v1/check", post({ text: "" }, auth))).status).toBe(400);
    expect((await app.request("/v1/check", post({ text: "x".repeat(4001) }, auth))).status).toBe(400);
    expect((await app.request("/v1/check", post({ text: "x" }, {}))).status).toBe(401);
  });
});

describe("POST /v1/desk/sweep: the payee's language", () => {
  it("reaches the assistant from the body; an empty body means English; any other value is 400", async () => {
    const { w, auth } = await setup();
    const seen: (DeskToolbox["locale"] | "none")[] = [];
    const spy = createDeskHandlers((_services, toolbox) => {
      seen.push(toolbox.locale ?? "none");
      return Promise.resolve({ available: true, reason: null });
    });
    const app = createApp(w.services, HANDLER_MAPS.map((map) => (map === deskHandlers ? spy : map)));
    expect((await app.request("/v1/desk/sweep", post({ locale: "fr" }, auth))).status).toBe(200);
    expect((await app.request("/v1/desk/sweep", { method: "POST", headers: auth })).status).toBe(200);
    expect((await app.request("/v1/desk/sweep", post({}, auth))).status).toBe(200);
    expect(seen).toEqual(["fr", "none", "none"]);
    const bad = await app.request("/v1/desk/sweep", post({ locale: "de" }, auth));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiProblem).code).toBe("invalid-request");
    expect((await app.request("/v1/desk/sweep", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "fr" })).status).toBe(415);
  });
});
