// SPDX-License-Identifier: MIT
/**
 * The payer's verification strip: each lamp from the chain, and "unknown" (never valid, never invalid) when the
 * network cannot be read. Any red or unknown lamp keeps the Pay key from paying.
 */
import { decodeInvoiceFragment, encodeInvoiceFragment } from "@paylink/sdk";
import { describe, expect, it } from "vitest";
import { checkContract, checkLink, checkPayable, checkSignature, checksAllow } from "../src/read/checks.ts";
import type { LinkChecks } from "../src/read/checks.ts";
import { fakeChain, issue, NOW, registry } from "./helpers.ts";

describe("signature lamp", () => {
  it("is green for the payee's own ECDSA signature", async () => {
    const { link } = await issue();
    expect(await checkSignature(link, fakeChain().client)).toEqual({ state: "ok", delegated: false });
  });

  it("is red when the signature was altered", async () => {
    const { issued } = await issue();
    // One nibble of r changed: the signature recovers to some other address.
    const original = issued.signed.signature;
    const signature = `${original.slice(0, 10)}${original[10] === "0" ? "1" : "0"}${original.slice(11)}` as typeof original;
    const forged = decodeInvoiceFragment(encodeInvoiceFragment({ ...issued.signed, signature }), registry);
    expect((await checkSignature(forged, fakeChain().client)).state).toBe("err");
  });

  it("is unknown when the payee's code cannot be read", async () => {
    const { link } = await issue();
    const fake = fakeChain();
    fake.down = true;
    expect(await checkSignature(link, fake.client)).toEqual({ state: "unknown" });
  });
});

describe("payable lamp", () => {
  it("is green inside the window, unpaid, not cancelled", async () => {
    const { link } = await issue();
    const result = await checkPayable(link, fakeChain().client);
    expect(result).toMatchObject({ state: "ok", status: "payable", now: NOW });
  });

  it("is red once paid, cancelled or expired, by chain time", async () => {
    const { link } = await issue();
    const fake = fakeChain();
    fake.states.set(link.key, { payments: 1, cancelled: false, lastPaidAt: NOW, total: link.invoice.amount });
    expect(await checkPayable(link, fake.client)).toMatchObject({ state: "err", status: "paid" });
    fake.states.set(link.key, { payments: 0, cancelled: true, lastPaidAt: 0n, total: 0n });
    expect(await checkPayable(link, fake.client)).toMatchObject({ state: "err", status: "cancelled" });
    fake.states.delete(link.key);
    fake.now = link.invoice.validUntil + 1n;
    expect(await checkPayable(link, fake.client)).toMatchObject({ state: "err", status: "expired" });
  });

  it("is unknown when the state cannot be read", async () => {
    const { link } = await issue();
    const fake = fakeChain();
    fake.down = true;
    expect(await checkPayable(link, fake.client)).toEqual({ state: "unknown" });
  });
});

describe("contract lamp", () => {
  it("is red when the registry address holds no code, unknown when it cannot be read", async () => {
    const { link } = await issue();
    const fake = fakeChain();
    expect((await checkContract(link, fake.client)).state).toBe("err");
    fake.down = true;
    expect(await checkContract(link, fake.client)).toEqual({ state: "unknown" });
  });
});

describe("the Pay key", () => {
  it("pays only when every lamp the chain lights is green", async () => {
    const { link } = await issue();
    const checks = await checkLink(link, fakeChain().client);
    expect(checks.signature.state).toBe("ok");
    expect(checks.payable.state).toBe("ok");
    expect(checksAllow(checks)).toBe(false);
    const green: LinkChecks = { ...checks, contract: { state: "ok" } };
    expect(checksAllow(green)).toBe(true);
    expect(checksAllow({ ...green, signature: { state: "unknown" } })).toBe(false);
    expect(checksAllow({ ...green, payable: { state: "unknown" } })).toBe(false);
  });
});
