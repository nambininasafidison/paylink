// SPDX-License-Identifier: MIT
/**
 * What a books backup holds (ADR 0016), and how it goes in and out of the device store. The content is the device's
 * own records, exactly as `store/db.ts` keeps them, for one merchant on one chain:
 *
 * - invoices: those the merchant signed on this device (`issued`, with their memos, which the chain never sees) and the
 *   receive cards of other people saved from Send (`card`), on the chain;
 * - receipts: payments on the chain that the merchant made or received;
 * - contacts (from schema 2): the address book, without the entries whose card is for another chain.
 *
 * Outstanding EIP-3009 authorisations are not books: they are a payer's in-flight state, tied to the device that
 * signed them (invoice spec §8.6), and are never exported.
 *
 * Schemas. 1: invoices and receipts, the books as PAYLINK-V2-SPEC §2.1 T2 first listed them. 2 (current): adds the
 * address book, which a merchant loses with the phone too. The writer writes the current schema only; the reader
 * accepts every schema from 1 and upgrades it step by step (`MIGRATIONS`), so the upgrade path is exercised from the
 * first release. Decrypted content is input like any other: it must have exactly its schema's shape, every record
 * passes the same checks as a record read back from IndexedDB (`parseStoredInvoice` against the registry,
 * `parseStoredReceipt`, `parseStoredContact`) and must belong to the file's merchant and chain, and the merchant's own
 * invoices must carry the merchant's signature; anything else is skipped.
 */
import type { Registry } from "@paylink/chains";
import { recoverEcdsaSigner } from "@paylink/sdk";
import type { DecodedInvoiceLink } from "@paylink/sdk";
import { getAddress } from "viem";
import type { Address } from "viem";
import { parseStoredContact, parseStoredInvoice, parseStoredReceipt } from "../store/db.ts";
import type { ContactRecord, DeviceStore, InvoiceRecord, ReceiptRecord } from "../store/db.ts";
import { BOOKS_SCHEMA, BooksError } from "./envelope.ts";

/** At most this many records per list (a file is also capped at 8 MiB). */
export const MAX_RECORDS = 50_000;

/** The current schema's content (2). Records are raw JSON values until validated on restore. */
export interface BooksContent {
  readonly invoices: readonly unknown[];
  readonly receipts: readonly unknown[];
  readonly contacts: readonly unknown[];
}

export interface BooksScope {
  readonly merchant: Address;
  readonly chainId: number;
}

const LISTS: Readonly<Record<number, readonly string[]>> = { 1: ["invoices", "receipts"], 2: ["invoices", "receipts", "contacts"] };

/** The content of `schema` with exactly its lists, each an array within bounds, or a `BooksError`. */
function shaped(schema: number, value: unknown): Record<string, unknown[]> {
  const lists = LISTS[schema];
  if (lists === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BooksError("unreadable", `content is not schema ${String(schema)}`);
  }
  const own = Object.keys(value);
  if (own.length !== lists.length || !lists.every((k) => Object.hasOwn(value, k))) {
    throw new BooksError("unreadable", `content is not schema ${String(schema)}`);
  }
  const out: Record<string, unknown[]> = {};
  for (const name of lists) {
    const list = (value as Record<string, unknown>)[name];
    if (!Array.isArray(list) || list.length > MAX_RECORDS) {
      throw new BooksError("unreadable", `${name} is not a list of records`);
    }
    out[name] = list as unknown[];
  }
  return out;
}

/** One step per schema: `MIGRATIONS[n]` turns schema-n content into schema n + 1. */
const MIGRATIONS: Readonly<Record<number, (content: Record<string, unknown[]>) => Record<string, unknown[]>>> = {
  // Schema 2 adds the address book: a schema-1 file had none.
  1: (content) => ({ invoices: content["invoices"] ?? [], receipts: content["receipts"] ?? [], contacts: [] }),
};

/** Validates content of `schema` and upgrades it to the current schema. */
export function upgradeContent(schema: number, value: unknown): BooksContent {
  if (!Number.isSafeInteger(schema) || schema > BOOKS_SCHEMA) {
    throw new BooksError("newer", `schema ${String(schema)} is newer than this PayLink`);
  }
  let current = shaped(schema, value);
  for (let from = schema; from < BOOKS_SCHEMA; from += 1) {
    const step = MIGRATIONS[from];
    if (step === undefined) {
      throw new BooksError("unreadable", `no upgrade from schema ${String(from)}`);
    }
    current = shaped(from + 1, step(current));
  }
  return { invoices: current["invoices"] ?? [], receipts: current["receipts"] ?? [], contacts: current["contacts"] ?? [] };
}

const same = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase();

/** The chain ID a receive-card fragment names (`2.<chainId>.…`), or `null`. */
function cardChain(card: string): number | null {
  const match = /^2\.([1-9][0-9]{0,15})\./.exec(card);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function invoiceInScope(record: InvoiceRecord, payee: Address, scope: BooksScope): boolean {
  return record.chainId === scope.chainId && (record.role === "card" || same(payee, scope.merchant));
}

/**
 * The merchant's own invoices must carry the merchant's signature over their key. The ledger backup exists in the
 * Monad edition only, where the merchant is a passkey account: an EOA, so ECDSA is the whole check. Saved cards are
 * someone else's (possibly a contract account's) and are checked by the pay view's lamps when used, like any card.
 */
async function signedByMerchant(parsed: { readonly record: InvoiceRecord; readonly link: DecodedInvoiceLink }, merchant: Address): Promise<boolean> {
  if (parsed.record.role !== "issued") {
    return true;
  }
  const recovered = await recoverEcdsaSigner(parsed.link.key, parsed.link.signature);
  return "signer" in recovered && same(recovered.signer, merchant);
}

function receiptInScope(record: ReceiptRecord, scope: BooksScope): boolean {
  return record.chainId === scope.chainId && (same(record.payer, scope.merchant) || same(record.payee, scope.merchant));
}

function contactInScope(record: ContactRecord, scope: BooksScope): boolean {
  return record.card === null || cardChain(record.card) === scope.chainId;
}

export interface CollectedBooks {
  readonly content: BooksContent;
  readonly records: number;
}

/** The merchant's books on this device for one chain, validated (records that no longer validate are left out). */
export async function collectBooks(store: DeviceStore, registry: Registry, scope: BooksScope): Promise<CollectedBooks> {
  const merchant = getAddress(scope.merchant);
  const invoices = (await store.listInvoices()).flatMap((value) => {
    const parsed = parseStoredInvoice(value, registry);
    return parsed !== null && invoiceInScope(parsed.record, parsed.link.invoice.payee, { ...scope, merchant }) ? [parsed.record] : [];
  });
  const receipts = (await store.listReceipts()).flatMap((value) => {
    const record = parseStoredReceipt(value);
    return record !== null && receiptInScope(record, { ...scope, merchant }) ? [record] : [];
  });
  const contacts = (await store.listContacts()).flatMap((value) => {
    const record = parseStoredContact(value);
    return record !== null && contactInScope(record, scope) ? [record] : [];
  });
  return { content: { invoices, receipts, contacts }, records: invoices.length + receipts.length + contacts.length };
}

export interface MergeResult {
  /** Records written to this device (new, or a newer contact entry). */
  readonly added: number;
  /** Records this device already had. */
  readonly present: number;
  /** Records that failed validation or belong to another merchant or chain. */
  readonly skipped: number;
}

/**
 * Restores validated content into the device store. Idempotent: an invoice or receipt already here is kept as it is
 * (its ID is its content's identity: the invoice key is its EIP-712 digest, a receipt is a chain log); a contact is
 * replaced only by a newer entry for the same address.
 */
export async function mergeBooks(store: DeviceStore, registry: Registry, scope: BooksScope, content: BooksContent): Promise<MergeResult> {
  const merchant = getAddress(scope.merchant);
  let added = 0;
  let present = 0;
  let skipped = 0;
  for (const value of content.invoices) {
    const parsed = parseStoredInvoice(value, registry);
    if (parsed === null || !invoiceInScope(parsed.record, parsed.link.invoice.payee, { ...scope, merchant }) || !(await signedByMerchant(parsed, merchant))) {
      skipped += 1;
      continue;
    }
    if (parseStoredInvoice(await store.getInvoice(parsed.record.id), registry) !== null) {
      present += 1;
      continue;
    }
    await store.putInvoice(parsed.record);
    added += 1;
  }
  const receipts = new Set((await store.listReceipts()).map(parseStoredReceipt).flatMap((r) => (r === null ? [] : [r.id])));
  for (const value of content.receipts) {
    const record = parseStoredReceipt(value);
    if (record === null || !receiptInScope(record, { ...scope, merchant })) {
      skipped += 1;
      continue;
    }
    if (receipts.has(record.id)) {
      present += 1;
      continue;
    }
    await store.putReceipt(record);
    receipts.add(record.id);
    added += 1;
  }
  const contacts = new Map((await store.listContacts()).map(parseStoredContact).flatMap((c) => (c === null ? [] : [[c.address, c] as const])));
  for (const value of content.contacts) {
    const record = parseStoredContact(value);
    if (record === null || !contactInScope(record, scope)) {
      skipped += 1;
      continue;
    }
    const here = contacts.get(record.address);
    if (here !== undefined && here.updatedAt >= record.updatedAt) {
      present += 1;
      continue;
    }
    await store.putContact(record);
    contacts.set(record.address, record);
    added += 1;
  }
  return { added, present, skipped };
}
