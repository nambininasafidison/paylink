// SPDX-License-Identifier: MIT
/**
 * Approval tokens (docs/paypal/SPEC.md §10.5, invariant AI-3): HMAC over sha256(canonical proposal), payee and expiry.
 * A token approves exactly one proposal, for one payee, for 15 minutes; everything else is refused with its reason.
 * Single use (replay) is the store's compare-and-set, tested with the desk (test/reconciler/desk.test.ts).
 */
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/approvals/crypto.ts";
import { canonicalProposal, createApprovals } from "../../src/approvals/factory.ts";
import { APPROVAL_TTL_MS } from "../../src/approvals/types.ts";
import type { CanonicalProposal } from "../../src/approvals/types.ts";
import { createMemoryStores } from "../../src/store/memory.ts";
import { T0, testRuntime } from "../helpers.ts";
import { KEY, PAYEE, PAYER, TWIN } from "../reconciler/fixtures.ts";

const SECRET = "11".repeat(32);
/** `null`: no APPROVAL_HMAC_KEY at all. */
const approvals = (secret: string | null = SECRET, kind: "node" | "worker" = "node") => {
  const runtime = testRuntime({ secrets: secret === null ? {} : { approvalHmacKey: secret } });
  return createApprovals({ runtime: { ...runtime, kind }, stores: createMemoryStores() });
};

const PROPOSAL: CanonicalProposal = {
  id: "p_0123456789abcdef0123",
  kind: "cancel_paypal",
  key: KEY,
  payee: PAYEE,
  chainId: 11155111,
  args: { invoice: TWIN.invoiceNumber, paypalId: TWIN.paypalId, amount: "120.00", currency: "USD" },
};

describe("canonical proposal and hash", () => {
  it("is canonical JSON: sorted keys, no whitespace, lowercased key and payee", () => {
    expect(canonicalProposal(PROPOSAL)).toBe(
      `{"args":{"amount":"120.00","currency":"USD","invoice":"PL-11155111-abababababab","paypalId":"INV2-TEST-0000-0000-0001"},"chainId":11155111,"id":"p_0123456789abcdef0123","key":"${KEY}","kind":"cancel_paypal","payee":"${PAYEE.toLowerCase()}"}`,
    );
    expect(canonicalJson({ b: [1, "x", null, true], a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":[1,"x",null,true]}');
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(1n)).toThrow(TypeError);
  });

  it("hashes equal proposals equally whatever their key order or case, and any changed value differently", async () => {
    const a = approvals();
    const h = await a.hash(PROPOSAL);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/u);
    const reordered = { ...PROPOSAL, payee: PAYEE.toLowerCase() as `0x${string}`, args: Object.fromEntries(Object.entries(PROPOSAL.args).reverse()) };
    expect(await a.hash(reordered)).toBe(h);
    for (const changed of [{ ...PROPOSAL, args: { ...PROPOSAL.args, amount: "12.00" } }, { ...PROPOSAL, kind: "send_reminder" as const }, { ...PROPOSAL, id: "p_other" }, { ...PROPOSAL, chainId: 1 }]) {
      expect(await a.hash(changed)).not.toBe(h);
    }
  });
});

describe("tokens", () => {
  it("approve exactly the proposal, for its payee, until it expires", async () => {
    const a = approvals();
    const issued = await a.issue(PROPOSAL, T0);
    expect(issued).toMatchObject({ hash: await a.hash(PROPOSAL), payee: PAYEE, expiresAt: T0 + APPROVAL_TTL_MS });
    expect(issued.token).toMatch(/^pa1\.[0-9a-f]{64}\.[0-9a-f]{40}\.\d+\.[A-Za-z0-9_-]{43}$/u);
    expect(await a.verify(issued.token, PROPOSAL, PAYEE, T0)).toEqual({ ok: true });
    expect(await a.verify(issued.token, PROPOSAL, PAYEE, T0 + APPROVAL_TTL_MS)).toEqual({ ok: true });
  });

  it("refuse a wrong hash: a token for another proposal, or the proposal with a changed value", async () => {
    const a = approvals();
    const other = await a.issue({ ...PROPOSAL, id: "p_other" }, T0);
    expect(await a.verify(other.token, PROPOSAL, PAYEE, T0)).toEqual({ ok: false, reason: "hash-mismatch" });
    const issued = await a.issue(PROPOSAL, T0);
    expect(await a.verify(issued.token, { ...PROPOSAL, args: { ...PROPOSAL.args, amount: "1200.00" } }, PAYEE, T0)).toEqual({ ok: false, reason: "hash-mismatch" });
  });

  it("refuse an expired token", async () => {
    const a = approvals();
    const issued = await a.issue(PROPOSAL, T0);
    expect(await a.verify(issued.token, PROPOSAL, PAYEE, T0 + APPROVAL_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
    const short = await a.issue(PROPOSAL, T0, T0 + 1000);
    expect(short.expiresAt).toBe(T0 + 1000);
    expect(await a.verify(short.token, PROPOSAL, PAYEE, T0 + 1001)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuse another account: a session of another payee, or a proposal of another payee", async () => {
    const a = approvals();
    const issued = await a.issue(PROPOSAL, T0);
    expect(await a.verify(issued.token, PROPOSAL, PAYER, T0)).toEqual({ ok: false, reason: "other-payee" });
    const theirs = await a.issue({ ...PROPOSAL, payee: PAYER }, T0);
    expect(await a.verify(theirs.token, { ...PROPOSAL, payee: PAYER }, PAYEE, T0)).toEqual({ ok: false, reason: "other-payee" });
  });

  it("refuse a forged, edited or truncated token, and one from another key", async () => {
    const a = approvals();
    const issued = await a.issue(PROPOSAL, T0);
    const [prefix, hash, payee, exp, mac] = issued.token.split(".") as [string, string, string, string, string];
    // Extending the expiry, or moving the token to another payee, breaks the MAC.
    expect(await a.verify([prefix, hash, payee, String(Number(exp) + 3_600_000), mac].join("."), PROPOSAL, PAYEE, T0)).toEqual({ ok: false, reason: "bad-mac" });
    expect(await a.verify([prefix, hash, PAYER.toLowerCase().slice(2), exp, mac].join("."), PROPOSAL, PAYER, T0)).toEqual({ ok: false, reason: "bad-mac" });
    expect(await a.verify(issued.token.slice(0, -1), PROPOSAL, PAYEE, T0)).toEqual({ ok: false, reason: "malformed" });
    expect(await a.verify("", PROPOSAL, PAYEE, T0)).toEqual({ ok: false, reason: "malformed" });
    expect(await a.verify(issued.token.replace("pa1.", "pa2."), PROPOSAL, PAYEE, T0)).toEqual({ ok: false, reason: "malformed" });
    const rotated = approvals("22".repeat(32));
    expect(await rotated.verify(issued.token, PROPOSAL, PAYEE, T0)).toEqual({ ok: false, reason: "bad-mac" });
  });

  it("need the secret in the Worker; the Node entry draws a per-process key", async () => {
    await expect(approvals(null, "worker").issue(PROPOSAL, T0)).rejects.toMatchObject({ problem: { code: "internal", rule: "E_APPROVAL_KEY_MISSING" } });
    await expect(approvals("not-hex", "worker").issue(PROPOSAL, T0)).rejects.toMatchObject({ problem: { rule: "E_APPROVAL_KEY_INVALID" } });
    await expect(approvals("ab".repeat(16), "worker").issue(PROPOSAL, T0)).rejects.toMatchObject({ problem: { rule: "E_APPROVAL_KEY_INVALID" } });
    const node = approvals(null, "node");
    const issued = await node.issue(PROPOSAL, T0);
    expect(await node.verify(issued.token, PROPOSAL, PAYEE, T0)).toEqual({ ok: true });
  });
});
