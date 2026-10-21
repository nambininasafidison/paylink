// SPDX-License-Identifier: MIT
/**
 * The PayPal side of a twin (docs/paypal/SPEC.md §7.2): the create body (P3) built by code from the signed PayLink
 * invoice, the invoice number, the private memo that names the payee, and the three notification bodies (P4, P8, P9).
 *
 * The create body, field by field (names and limits V, `invoicing_v2.json` at 90e8041):
 *
 * | Member | Value | Why |
 * |---|---|---|
 * | `detail.currency_code` | `USD` | PayLink twins dollar invoices only |
 * | `detail.reference` | K (66 characters, ≤ 120) | PayPal itself holds the link; P2 searches by it |
 * | `detail.invoice_number` | `PL-<chainId>-<first 12 hex of K>` (≤ 25: 24 on Ethereum Sepolia) | readable, unique per K |
 * | `detail.memo` | `PayLink twin · payee 0x… · eip155:<chainId>` (≤ 500, private to the merchant) | a verified webhook finds the payee's records from P5 alone (E, decision of the spine) |
 * | `detail.note` | the PayLink link, when given (≤ 4000) | the payer may prefer the token rail |
 * | `detail.payment_term` | `{ due_date }` alone, when there is one | "either but not both `term_type` or `due_date`" (V); accepted form UNVERIFIED until the capture run |
 * | `detail.invoice_date` | omitted | PayPal's own current date: a future date makes `send` answer 202 (§7.2) |
 * | `primary_recipients` | the client's given name and email, only as the payee typed them | sent to PayPal only, never to the model (§9.4); whether PayPal accepts a twin without an email is UNVERIFIED |
 * | `items` | one item: the memo (≤ 200) × 1 at the signed amount | the amount comes from the signed invoice, by code (AI-5) |
 * | `configuration` | no partial payment, no tip | the amount paid must equal the signed amount |
 *
 * Owner: PayPal spine workstream.
 */
import type { Address, InvoiceKey } from "@paylink/api-contract";
import { getAddress } from "viem";
import type { CreateInvoiceRequest, Notification, RecipientInfo } from "./types.ts";

/** "Share link, not through PayPal" (P4, V): PayPal sends no email; the payee shares the PayLink link. */
export const SHARE_LINK: Notification = { send_to_recipient: false, send_to_invoicer: false };
/** PayPal's own reminder to the payer (P9); PayPal ignores any subject or note PayLink would send (V). */
export const REMIND_RECIPIENT: Notification = { send_to_recipient: true, send_to_invoicer: false };
/** Cancel without notifying anyone (P8): the payee closes the PayPal rail; the link already says so. */
export const CANCEL_SILENTLY: Notification = { send_to_recipient: false, send_to_invoicer: false };

/** Limits of the members PayLink writes (V). */
export const LIMITS = { reference: 120, invoiceNumber: 25, note: 4000, memo: 500, itemName: 200, givenName: 140, email: 254 } as const;

/** Item name when the invoice has no memo. */
export const DEFAULT_ITEM_NAME = "Invoice";

/** `restrictive_email_address.pattern` (V), as PayPal validates the recipient's email. */
const RESTRICTIVE_EMAIL = /^(?!\.)(?:[A-Za-z0-9!#$&'*/=?^`{|}~_%+-]|\.(?!\.)){1,64}(?<!\.)@(?:[A-Za-z0-9-]|\.(?!\.))+\.[a-zA-Z]{2,}$/u;
const KEY = /^0x[0-9a-f]{64}$/u;
const USD = /^(?:0|[1-9][0-9]{0,15})\.[0-9]{2}$/u;
const DATE = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u;

/** What a twin is made from: the signed invoice (verified by the caller) and what the payee typed. */
export interface TwinInvoiceInput {
  readonly key: InvoiceKey;
  readonly chainId: number;
  readonly payee: Address;
  /** The signed amount as PayPal's USD string with two decimals (`"120.00"`), converted by code (E_TWIN_PRECISION). */
  readonly amountUsd: string;
  /** The invoice's memo, used as the item name; `null` for none. */
  readonly description: string | null;
  /** `YYYY-MM-DD`, or null for PayPal's default term (UNVERIFIED which). */
  readonly dueDate: string | null;
  readonly recipient: { readonly givenName?: string; readonly email?: string } | null;
  /** The PayLink link offered in PayPal's note, and the token it is signed in. */
  readonly payLink: { readonly url: string; readonly symbol: "USDC" | "PYUSD" } | null;
}

/** A twin input PayPal would refuse or that would break a rule of §7.2. */
export class TwinInputError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "TwinInputError";
    this.field = field;
  }
}

/** `PL-<chainId>-<first 12 hex of K>` (§7.2, E). */
export function invoiceNumberFor(chainId: number, key: InvoiceKey): string {
  if (!KEY.test(key) || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new TwinInputError("key", "the invoice key or chain id is not valid");
  }
  const number = `PL-${String(chainId)}-${key.slice(2, 14)}`;
  if (number.length > LIMITS.invoiceNumber) {
    throw new TwinInputError("invoice_number", `the invoice number would exceed ${String(LIMITS.invoiceNumber)} characters`);
  }
  return number;
}

/** The private memo naming the payee and the chain: `PayLink twin · payee 0x… · eip155:<chainId>`. */
export function twinMemo(payee: Address, chainId: number): string {
  return `PayLink twin · payee ${getAddress(payee)} · eip155:${String(chainId)}`;
}

const MEMO = /^PayLink twin · payee (?<payee>0x[0-9a-fA-F]{40}) · eip155:(?<chain>[1-9][0-9]{0,15})$/u;

/** The payee and chain a twin's memo names, or null when the memo is not PayLink's (an invoice made elsewhere). */
export function parseTwinMemo(memo: string | null | undefined): { readonly payee: Address; readonly chainId: number } | null {
  const groups = typeof memo === "string" ? MEMO.exec(memo)?.groups : undefined;
  const payee = groups?.["payee"];
  const chain = groups?.["chain"];
  if (payee === undefined || chain === undefined || !Number.isSafeInteger(Number(chain))) {
    return null;
  }
  return { payee: getAddress(payee), chainId: Number(chain) };
}

/** The note to the payer: the PayLink link of the same invoice, honest about the rail (the payer pays Sepolia gas). */
export function payerNote(payLink: NonNullable<TwinInvoiceInput["payLink"]>): string {
  return `Prefer ${payLink.symbol}? Pay this same invoice on Ethereum Sepolia (testnet) with PayLink: ${payLink.url}`;
}

/** The P3 body of §7.2 for `input`. Throws `TwinInputError` instead of sending PayPal what it would refuse. */
export function twinCreateBody(input: TwinInvoiceInput): CreateInvoiceRequest {
  const number = invoiceNumberFor(input.chainId, input.key);
  if (!USD.test(input.amountUsd) || input.amountUsd === "0.00") {
    throw new TwinInputError("amount", "the amount must be a positive USD value with two decimals");
  }
  if (input.dueDate !== null && !DATE.test(input.dueDate)) {
    throw new TwinInputError("due_date", "the due date must be YYYY-MM-DD");
  }
  const name = (input.description ?? "").trim().replace(/\s+/gu, " ");
  const itemName = name === "" ? DEFAULT_ITEM_NAME : name;
  if (itemName.length > LIMITS.itemName) {
    throw new TwinInputError("item.name", `the description may not exceed ${String(LIMITS.itemName)} characters`);
  }
  const note = input.payLink === null ? null : payerNote(input.payLink);
  if (note !== null && (note.length > LIMITS.note || !/^https:\/\/[^\s]+$/u.test(input.payLink?.url ?? ""))) {
    throw new TwinInputError("note", "the PayLink link must be one https URL that fits PayPal's note");
  }
  return {
    detail: {
      currency_code: "USD",
      reference: input.key,
      invoice_number: number,
      memo: twinMemo(input.payee, input.chainId),
      ...(note === null ? {} : { note }),
      ...(input.dueDate === null ? {} : { payment_term: { due_date: input.dueDate } }),
    },
    ...recipientsOf(input.recipient),
    items: [{ name: itemName, quantity: "1", unit_amount: { currency_code: "USD", value: input.amountUsd } }],
    configuration: { partial_payment: { allow_partial_payment: false }, allow_tip: false },
  };
}

function recipientsOf(recipient: TwinInvoiceInput["recipient"]): { readonly primary_recipients?: readonly RecipientInfo[] } {
  const givenName = recipient?.givenName?.trim() ?? "";
  const email = recipient?.email?.trim() ?? "";
  if (givenName.length > LIMITS.givenName) {
    throw new TwinInputError("recipient.givenName", `the client's name may not exceed ${String(LIMITS.givenName)} characters`);
  }
  if (email !== "" && (email.length > LIMITS.email || !RESTRICTIVE_EMAIL.test(email))) {
    throw new TwinInputError("recipient.email", "the client's email is not an address PayPal accepts");
  }
  if (givenName === "" && email === "") {
    return {};
  }
  return {
    primary_recipients: [
      {
        billing_info: {
          ...(givenName === "" ? {} : { name: { given_name: givenName } }),
          ...(email === "" ? {} : { email_address: email }),
        },
      },
    ],
  };
}
