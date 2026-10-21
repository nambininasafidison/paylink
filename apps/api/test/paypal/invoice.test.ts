// SPDX-License-Identifier: MIT
/**
 * The PayPal side of a twin (src/paypal/invoice.ts, docs/paypal/SPEC.md §7.2): the create body member by member, what
 * the builder refuses instead of sending, the invoice number, the memo that names the payee, and the notifications.
 */
import fc from "fast-check";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { CANCEL_SILENTLY, DEFAULT_ITEM_NAME, invoiceNumberFor, parseTwinMemo, payerNote, REMIND_RECIPIENT, SHARE_LINK, TwinInputError, twinCreateBody, twinMemo } from "../../src/paypal/invoice.ts";
import { KEY, PAYEE, SEPOLIA, twinInput } from "./fixtures.ts";

const SHORT_KEY: `0x${string}` = "0x1234";

describe("the create body (P3, §7.2)", () => {
  it("carries K, the number, the memo, the note, the due date, the recipient, one item and no partial payment or tip", () => {
    expect(twinCreateBody(twinInput())).toEqual({
      detail: {
        currency_code: "USD",
        reference: KEY,
        invoice_number: "PL-11155111-3fa9c0e17b2d",
        memo: `PayLink twin · payee ${PAYEE} · eip155:11155111`,
        note: "Prefer USDC? Pay this same invoice on Ethereum Sepolia (testnet) with PayLink: https://paypal.paylink-mg.pages.dev/paypal/pay/#i=example",
        payment_term: { due_date: "2026-11-06" },
      },
      primary_recipients: [{ billing_info: { name: { given_name: "Sarah" }, email_address: "sarah@example.com" } }],
      items: [{ name: "Logo design", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }],
      configuration: { partial_payment: { allow_partial_payment: false }, allow_tip: false },
    });
  });

  it("omits the issue date, so PayPal uses its own current date and send answers 200", () => {
    expect(twinCreateBody(twinInput()).detail).not.toHaveProperty("invoice_date");
  });

  it("omits what the payee did not give: due date, recipient, note; and names the item when there is no memo", () => {
    const body = twinCreateBody(twinInput({ dueDate: null, recipient: null, payLink: null, description: "   " }));
    expect(body.detail).not.toHaveProperty("payment_term");
    expect(body.detail).not.toHaveProperty("note");
    expect(body).not.toHaveProperty("primary_recipients");
    expect(body.items[0]?.name).toBe(DEFAULT_ITEM_NAME);
    expect(twinCreateBody(twinInput({ recipient: { email: "  sarah@example.com " } })).primary_recipients).toEqual([{ billing_info: { email_address: "sarah@example.com" } }]);
    expect(twinCreateBody(twinInput({ description: "Logo\n  design\tv2" })).items[0]?.name).toBe("Logo design v2");
  });

  it.each([
    ["amount", { amountUsd: "120" }],
    ["amount", { amountUsd: "120.001" }],
    ["amount", { amountUsd: "0.00" }],
    ["amount", { amountUsd: "-1.00" }],
    ["due_date", { dueDate: "6 Nov 2026" }],
    ["item.name", { description: "x".repeat(201) }],
    ["recipient.givenName", { recipient: { givenName: "x".repeat(141) } }],
    ["recipient.email", { recipient: { email: "sarah@" } }],
    ["recipient.email", { recipient: { email: "a..b@example.com" } }],
    ["note", { payLink: { url: "http://insecure.example/pay", symbol: "USDC" as const } }],
    ["note", { payLink: { url: `https://x.example/${"a".repeat(4000)}`, symbol: "USDC" as const } }],
    ["key", { key: SHORT_KEY }],
    ["key", { chainId: 0 }],
  ])("refuses %s instead of sending PayPal what it would reject (%o)", (field, overrides) => {
    expect(() => twinCreateBody(twinInput(overrides))).toThrow(TwinInputError);
    try {
      twinCreateBody(twinInput(overrides));
    } catch (error) {
      expect((error as TwinInputError).field).toBe(field);
    }
  });

  it("names the token the link is signed in", () => {
    expect(payerNote({ url: "https://x.example/p", symbol: "PYUSD" })).toBe("Prefer PYUSD? Pay this same invoice on Ethereum Sepolia (testnet) with PayLink: https://x.example/p");
  });
});

describe("invoice number", () => {
  it("is PL-<chainId>-<first 12 hex of K>, at most 25 characters (fast-check)", () => {
    expect(invoiceNumberFor(SEPOLIA, KEY)).toBe("PL-11155111-3fa9c0e17b2d");
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{64}$/u), fc.integer({ min: 1, max: 999_999_999 }), (hex, chainId) => {
        const number = invoiceNumberFor(chainId, `0x${hex}`);
        expect(number).toBe(`PL-${String(chainId)}-${hex.slice(0, 12)}`);
        expect(number.length).toBeLessThanOrEqual(25);
      }),
    );
    expect(() => invoiceNumberFor(99_999_999_999, KEY)).toThrow(/25 characters/u);
  });
});

describe("the memo naming the payee", () => {
  it("round-trips any address and chain, checksummed (fast-check)", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{40}$/u), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (hex, chainId) => {
        const payee = getAddress(`0x${hex}`);
        const memo = twinMemo(`0x${hex}`, chainId);
        expect(memo.length).toBeLessThanOrEqual(500);
        expect(parseTwinMemo(memo)).toEqual({ payee, chainId });
      }),
    );
  });

  it("reads nothing from a memo PayLink did not write", () => {
    for (const memo of [undefined, null, "", "PayLink twin", `PayLink twin · payee ${PAYEE}`, `PayLink twin · payee ${PAYEE} · eip155:0`, `Note: PayLink twin · payee ${PAYEE} · eip155:1`, `PayLink twin · payee 0x123 · eip155:1`]) {
      expect(parseTwinMemo(memo), String(memo)).toBeNull();
    }
  });
});

describe("notifications", () => {
  it("never carry a subject or a note (PayPal ignores them, V)", () => {
    expect(SHARE_LINK).toEqual({ send_to_recipient: false, send_to_invoicer: false });
    expect(REMIND_RECIPIENT).toEqual({ send_to_recipient: true, send_to_invoicer: false });
    expect(CANCEL_SILENTLY).toEqual({ send_to_recipient: false, send_to_invoicer: false });
  });
});
