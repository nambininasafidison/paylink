// SPDX-License-Identifier: MIT
/**
 * The device store (read model rank 2, ADR 0009): IndexedDB through `idb`, wrapped so the app keeps working when the
 * browser refuses storage (private windows, blocked site data): it then falls back to memory and says so.
 *
 * Holds what only the device knows: signed invoices with their memos (the chain sees only `memoHash`), saved receive
 * cards, the address book and receipts. Every record is validated when it is read back, because storage is input too:
 * wrappers with zod, signed invoices with the SDK's strict parser against the registry (`parseStoredInvoice`).
 * Nothing here is ever shown as "paid" without a chain check.
 */
import type { Registry } from "@paylink/chains";
import { parseSignedInvoiceJson } from "@paylink/sdk";
import type { DecodedInvoiceLink, SignedInvoiceJson } from "@paylink/sdk";
import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import { getAddress, isAddress } from "viem";
import type { Address, Hex } from "viem";
import * as z from "zod/mini";

export const DB_NAME = "paylink";
export const DB_VERSION = 1;

export type InvoiceRole = "issued" | "card";
export type ReceiptRole = "paid" | "received";

export interface InvoiceRecord {
  /** `<chainId>:<key>`. */
  readonly id: string;
  readonly chainId: number;
  readonly key: Hex;
  /** The canonical JSON form (invoice spec §11), memo included. */
  readonly signed: SignedInvoiceJson;
  /** `issued`: signed on this device by its payee. `card`: someone else's receive card, saved from Send. */
  readonly role: InvoiceRole;
  /** Milliseconds since the epoch, device clock (display and ordering only). */
  readonly createdAt: number;
}

export interface ReceiptRecord {
  /** `<chainId>:<txHash>:<logIndex>`. */
  readonly id: string;
  readonly chainId: number;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly role: ReceiptRole;
  readonly invoiceKey: Hex;
  readonly payee: Address;
  readonly payer: Address;
  readonly token: Address;
  /** Base units, decimal string. */
  readonly amount: string;
  /** Unix seconds of the block. */
  readonly blockTime: number;
  /** The receipt fragment (`2.<chainId>.<txHash>.<logIndex>[…]`), for the receipt link. */
  readonly fragment: string;
  readonly savedAt: number;
}

export interface ContactRecord {
  /** EIP-55. */
  readonly address: Address;
  readonly label: string;
  /** A receive-card fragment (`2.<chainId>.…`) to pay this contact, or `null`. */
  readonly card: string | null;
  readonly updatedAt: number;
}

interface Schema extends DBSchema {
  invoices: { key: string; value: InvoiceRecord; indexes: { byCreated: number } };
  receipts: { key: string; value: ReceiptRecord; indexes: { bySaved: number } };
  contacts: { key: string; value: ContactRecord };
}

// ---------------------------------------------------------------------------------------------------- validation

const hex32 = z.string().check(z.regex(/^0x[0-9a-f]{64}$/));
const address = z.pipe(
  z.string().check(z.refine((v) => isAddress(v, { strict: true }))),
  z.transform((v) => getAddress(v)),
);
const millis = z.number().check(z.minimum(0), z.maximum(8.64e15));

const InvoiceRecordSchema = z.object({
  id: z.string().check(z.maxLength(100)),
  chainId: z.int().check(z.minimum(1)),
  key: hex32,
  signed: z.unknown(),
  role: z.enum(["issued", "card"]),
  createdAt: millis,
});
const ReceiptRecordSchema = z.object({
  id: z.string().check(z.maxLength(160)),
  chainId: z.int().check(z.minimum(1)),
  txHash: hex32,
  logIndex: z.int().check(z.minimum(0)),
  role: z.enum(["paid", "received"]),
  invoiceKey: hex32,
  payee: address,
  payer: address,
  token: address,
  amount: z.string().check(z.regex(/^(0|[1-9][0-9]{0,38})$/)),
  blockTime: z.int().check(z.minimum(0)),
  fragment: z.string().check(z.maxLength(1200)),
  savedAt: millis,
});
const ContactRecordSchema = z.object({
  address,
  label: z.string().check(z.minLength(1), z.maxLength(64)),
  card: z.nullable(z.string().check(z.maxLength(1200))),
  updatedAt: millis,
});

export const invoiceId = (chainId: number, key: Hex): string => `${String(chainId)}:${key.toLowerCase()}`;
export const receiptId = (chainId: number, txHash: Hex, logIndex: number): string => `${String(chainId)}:${txHash.toLowerCase()}:${String(logIndex)}`;

/** A stored invoice, re-validated: structure, then the SDK's registry checks (canonical deployment, memo, shape). */
export function parseStoredInvoice(value: unknown, registry: Registry): { readonly record: InvoiceRecord; readonly link: DecodedInvoiceLink } | null {
  const result = InvoiceRecordSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  try {
    const link = parseSignedInvoiceJson(result.data.signed, registry);
    if (link.key !== result.data.key || link.chainId !== result.data.chainId || result.data.id !== invoiceId(link.chainId, link.key)) {
      return null;
    }
    return { record: { ...result.data, key: link.key, signed: result.data.signed as SignedInvoiceJson }, link };
  } catch {
    return null;
  }
}

export function parseStoredReceipt(value: unknown): ReceiptRecord | null {
  const result = ReceiptRecordSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const r = result.data;
  return r.id === receiptId(r.chainId, r.txHash as Hex, r.logIndex) ? { ...r, txHash: r.txHash as Hex, invoiceKey: r.invoiceKey as Hex } : null;
}

export function parseStoredContact(value: unknown): ContactRecord | null {
  const result = ContactRecordSchema.safeParse(value);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------------------------------- the store

export interface DeviceStore {
  /** False when the browser refused IndexedDB: records live in memory until the page closes. */
  readonly persistent: boolean;
  putInvoice(record: InvoiceRecord): Promise<void>;
  listInvoices(): Promise<readonly unknown[]>;
  getInvoice(id: string): Promise<unknown>;
  deleteInvoice(id: string): Promise<void>;
  putReceipt(record: ReceiptRecord): Promise<void>;
  listReceipts(): Promise<readonly unknown[]>;
  putContact(record: ContactRecord): Promise<void>;
  listContacts(): Promise<readonly unknown[]>;
  deleteContact(address: Address): Promise<void>;
}

/** In-memory store: the fallback, and the test double. */
export function memoryStore(): DeviceStore {
  const invoices = new Map<string, InvoiceRecord>();
  const receipts = new Map<string, ReceiptRecord>();
  const contacts = new Map<string, ContactRecord>();
  return {
    persistent: false,
    putInvoice: (r) => Promise.resolve(void invoices.set(r.id, structuredClone(r))),
    // Same order as the IndexedDB indexes: oldest first, by creation or saving time.
    listInvoices: () => Promise.resolve([...invoices.values()].sort((a, b) => a.createdAt - b.createdAt).map((r) => structuredClone(r))),
    getInvoice: (id) => Promise.resolve(invoices.has(id) ? structuredClone(invoices.get(id)) : undefined),
    deleteInvoice: (id) => Promise.resolve(void invoices.delete(id)),
    putReceipt: (r) => Promise.resolve(void receipts.set(r.id, structuredClone(r))),
    listReceipts: () => Promise.resolve([...receipts.values()].sort((a, b) => a.savedAt - b.savedAt).map((r) => structuredClone(r))),
    putContact: (r) => Promise.resolve(void contacts.set(r.address, structuredClone(r))),
    listContacts: () => Promise.resolve([...contacts.values()].map((r) => structuredClone(r))),
    deleteContact: (a) => Promise.resolve(void contacts.delete(a)),
  };
}

function indexedStore(db: IDBPDatabase<Schema>): DeviceStore {
  return {
    persistent: true,
    putInvoice: async (r) => {
      await db.put("invoices", r);
    },
    listInvoices: async () => await db.getAllFromIndex("invoices", "byCreated"),
    getInvoice: async (id) => await db.get("invoices", id),
    deleteInvoice: async (id) => {
      await db.delete("invoices", id);
    },
    putReceipt: async (r) => {
      await db.put("receipts", r);
    },
    listReceipts: async () => await db.getAllFromIndex("receipts", "bySaved"),
    putContact: async (r) => {
      await db.put("contacts", r);
    },
    listContacts: async () => await db.getAll("contacts"),
    deleteContact: async (a) => {
      await db.delete("contacts", a);
    },
  };
}

/** Opens the device store, or an in-memory one when IndexedDB is unavailable. */
export async function openDeviceStore(available: boolean = "indexedDB" in globalThis): Promise<DeviceStore> {
  if (!available) {
    return memoryStore();
  }
  try {
    const db = await openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const invoices = database.createObjectStore("invoices", { keyPath: "id" });
        invoices.createIndex("byCreated", "createdAt");
        const receipts = database.createObjectStore("receipts", { keyPath: "id" });
        receipts.createIndex("bySaved", "savedAt");
        database.createObjectStore("contacts", { keyPath: "address" });
      },
      blocked() {
        // Another tab holds an older version open; the upgrade proceeds when it closes.
      },
    });
    return indexedStore(db);
  } catch {
    return memoryStore();
  }
}
