// SPDX-License-Identifier: MIT
/**
 * Fixed values of the PayPal spine's tests: a key, a payee, the twin of §7.2 for them, and a helper that creates and
 * shares it on a PayPal (the fake, in tests). Owner: PayPal spine workstream.
 */
import type { Address, InvoiceKey } from "@paylink/api-contract";
import type { PayPalClient } from "../../src/paypal/client.ts";
import type { TwinInvoiceInput } from "../../src/paypal/invoice.ts";
import { SHARE_LINK, twinCreateBody } from "../../src/paypal/invoice.ts";
import type { Invoice } from "../../src/paypal/types.ts";

export const KEY: InvoiceKey = `0x${"3fa9c0e17b2d".padEnd(64, "a")}`;
export const OTHER_KEY: InvoiceKey = `0x${"7e57c0de0b0b".padEnd(64, "b")}`;
/** Anvil's second account (a well-known test address). */
export const PAYEE: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const SEPOLIA = 11155111;
export const TX_HASH: `0x${string}` = `0x${"cd".repeat(32)}`;

export function twinInput(overrides: Partial<TwinInvoiceInput> = {}): TwinInvoiceInput {
  return {
    key: KEY,
    chainId: SEPOLIA,
    payee: PAYEE,
    amountUsd: "120.00",
    description: "Logo design",
    dueDate: "2026-11-06",
    recipient: { givenName: "Sarah", email: "sarah@example.com" },
    payLink: { url: "https://paypal.paylink-mg.pages.dev/paypal/pay/#i=example", symbol: "USDC" },
    ...overrides,
  };
}

/** P3 then P4 (share link) then P5: a twin as PayPal holds it once shared. */
export async function sharedTwin(paypal: PayPalClient, overrides: Partial<TwinInvoiceInput> = {}): Promise<Invoice> {
  const created = await paypal.createInvoice(twinCreateBody(twinInput(overrides)));
  await paypal.sendInvoice(created.id ?? "", SHARE_LINK);
  return await paypal.getInvoice(created.id ?? "");
}

/** The §7.3 note PayLink writes on a recorded payment (the reconciler's `echoNote` builds the same string). */
export function echoNoteFor(key: InvoiceKey, txHash: `0x${string}` = TX_HASH, chainId = SEPOLIA): string {
  return `PayLink · eip155:${String(chainId)} · tx ${txHash} · key ${key}`;
}
