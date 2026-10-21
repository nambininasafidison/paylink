// SPDX-License-Identifier: MIT
/**
 * Inputs of the situation table for the reconciler's tests (L1): one twin of $120.00 in Circle USDC on Ethereum Sepolia,
 * PayPal observations by status, chain observations by state, and the four kinds of PayPal transactions the echo filter
 * must tell apart. Every value is made up for tests; the addresses are the registry's USDC and anvil's public accounts.
 */
import type { InvoiceKey } from "@paylink/api-contract";
import { statusClassOf } from "@paylink/api-contract";
import { echoNote } from "../../src/reconciler/echo.ts";
import type { ChainObservation, ChainPayment, PayPalObservation, PayPalTransaction, TwinFacts } from "../../src/reconciler/types.ts";
import { T0 } from "../helpers.ts";

export const CHAIN_ID = 11155111;
export const KEY: InvoiceKey = `0x${"ab".repeat(32)}`;
export const OTHER_KEY: InvoiceKey = `0x${"cd".repeat(32)}`;
/** Circle USDC on Ethereum Sepolia (packages/chains/src/chains/ethereum-sepolia.ts). */
export const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
export const PYUSD = "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9" as const;
/** anvil's public default accounts: payee and payer. */
export const PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
export const PAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
export const TX: `0x${string}` = `0x${"12".repeat(32)}`;
export const OTHER_TX: `0x${string}` = `0x${"34".repeat(32)}`;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const TWIN: TwinFacts = {
  key: KEY,
  payee: PAYEE,
  chainId: CHAIN_ID,
  paypalId: "INV2-TEST-0000-0000-0001",
  invoiceNumber: "PL-11155111-abababababab",
  amountBase: "120000000",
  amountUsd: "120.00",
  token: USDC,
  rail: "USDC",
  recordedPaymentIds: [],
  lastReminderAt: null,
  sentAt: T0 - HOUR,
  dueDate: "2026-11-06",
  autoRecordUndone: false,
};

export const PAYMENT: ChainPayment = {
  txHash: TX,
  logIndex: 7,
  blockNumber: 11_960_000,
  timestamp: Math.floor(T0 / 1000) - 600,
  payer: PAYER,
  amount: "120000000",
  token: USDC,
  rail: "USDC",
};

/** The PayPal transaction PayLink's P6 leaves: its echo of PAYMENT. */
export const ECHO_TX: PayPalTransaction = { paymentId: "ECHO0000000000000001", type: "EXTERNAL", method: "OTHER", note: echoNote(CHAIN_ID, TX, KEY), amount: "120.00", paymentDate: "2026-10-21" };
/** A payment made on PayPal's hosted page. */
export const PAYPAL_TX: PayPalTransaction = { paymentId: "PAYPAL00000000000001", type: "PAYPAL", method: "PAYPAL", note: null, amount: "120.00", paymentDate: "2026-10-21" };
export const PAYPAL_TX_2: PayPalTransaction = { ...PAYPAL_TX, paymentId: "PAYPAL00000000000002" };

export function paypal(status: string, options: { readonly transactions?: readonly PayPalTransaction[]; readonly paidAmount?: string | null; readonly amount?: string; readonly currency?: string; readonly reference?: string; readonly email?: boolean } = {}): PayPalObservation {
  const paid = ["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"].includes(status);
  return {
    read: "ok",
    status,
    statusClass: statusClassOf(status),
    amount: options.amount ?? "120.00",
    currency: options.currency ?? "USD",
    reference: options.reference ?? KEY,
    paidAmount: options.paidAmount === undefined ? (paid ? "120.00" : null) : options.paidAmount,
    transactions: options.transactions ?? [],
    hasRecipientEmail: options.email ?? true,
  };
}

export const PAYPAL_FAILED: PayPalObservation = { read: "failed", retryable: true };

const CHAIN_NOW = Math.floor(T0 / 1000);

/** The chain variants of the exhaustive table. */
export const CHAINS = {
  payable: { state: "payable", payments: [], paidAt: null, chainTime: CHAIN_NOW },
  paid: { state: "paid", payments: [PAYMENT], paidAt: PAYMENT.timestamp, chainTime: CHAIN_NOW },
  /** Paid by `stateOf`, the `Paid` log not verified yet, 2 minutes ago. */
  confirming: { state: "paid", payments: [], paidAt: CHAIN_NOW - 120, chainTime: CHAIN_NOW },
  /** Paid by `stateOf`, no verified `Paid` log after an hour. */
  unverified: { state: "paid", payments: [], paidAt: CHAIN_NOW - 3600, chainTime: CHAIN_NOW },
  cancelled: { state: "cancelled", payments: [], paidAt: null, chainTime: CHAIN_NOW },
  expired: { state: "expired", payments: [], paidAt: null, chainTime: CHAIN_NOW },
  "not-deployed": { state: "not-deployed", payments: [], paidAt: null, chainTime: null },
  unreadable: { state: "unreadable", payments: [], paidAt: null, chainTime: null },
} as const satisfies Readonly<Record<string, ChainObservation>>;

export type ChainVariant = keyof typeof CHAINS;

/** The transaction variants of the exhaustive table. */
export const TXS = {
  none: [],
  echo: [ECHO_TX],
  paypal: [PAYPAL_TX],
  "echo+paypal": [ECHO_TX, PAYPAL_TX],
} as const satisfies Readonly<Record<string, readonly PayPalTransaction[]>>;

export type TxVariant = keyof typeof TXS;
