// SPDX-License-Identifier: MIT
/**
 * The device store (read model rank 2): IndexedDB when the browser allows it, memory otherwise, and every record
 * re-validated when read back, because storage is input too.
 */
import "fake-indexeddb/auto";
import { createRegistry, defineLocalChain } from "@paylink/chains";
import { describe, expect, it } from "vitest";
import { DB_NAME, invoiceId, memoryStore, openDeviceStore, parseStoredContact, parseStoredInvoice, parseStoredReceipt, receiptId } from "../src/store/db.ts";
import type { DeviceStore, ReceiptRecord } from "../src/store/db.ts";
import { CHAIN_ID, issue, localChain, payee, payer, registry, TOKEN_ADDRESS } from "./helpers.ts";

const TX = `0x${"ab".repeat(32)}` as const;

function receipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id: receiptId(CHAIN_ID, TX, 3),
    chainId: CHAIN_ID,
    txHash: TX,
    logIndex: 3,
    role: "paid",
    invoiceKey: `0x${"cd".repeat(32)}`,
    payee: payee.address,
    payer: payer.address,
    token: TOKEN_ADDRESS,
    amount: "25500000",
    blockTime: 1_791_417_600,
    fragment: `2.${String(CHAIN_ID)}.${TX}.3`,
    savedAt: 5,
    ...overrides,
  };
}

async function roundTrip(store: DeviceStore): Promise<void> {
  const a = await issue({ createdAt: 2 });
  const b = await issue({ createdAt: 1, memo: null });
  await store.putInvoice(a.record);
  await store.putInvoice(b.record);
  const listed = await store.listInvoices();
  expect(listed).toHaveLength(2);
  expect(listed.map((v) => parseStoredInvoice(v, registry)?.record.createdAt)).toEqual([1, 2]);
  expect(parseStoredInvoice(await store.getInvoice(a.record.id), registry)?.link.key).toBe(a.issued.key);
  await store.deleteInvoice(a.record.id);
  expect(await store.getInvoice(a.record.id)).toBeUndefined();

  await store.putReceipt(receipt());
  expect((await store.listReceipts()).map(parseStoredReceipt)).toEqual([receipt()]);

  await store.putContact({ address: payee.address, label: "Rakoto Design", card: null, updatedAt: 1 });
  expect((await store.listContacts()).map(parseStoredContact)).toEqual([{ address: payee.address, label: "Rakoto Design", card: null, updatedAt: 1 }]);
  await store.deleteContact(payee.address);
  expect(await store.listContacts()).toEqual([]);
}

describe("device store", () => {
  it("persists in IndexedDB", async () => {
    const store = await openDeviceStore();
    expect(store.persistent).toBe(true);
    await roundTrip(store);
    indexedDB.deleteDatabase(DB_NAME);
  });

  it("falls back to memory when IndexedDB is unavailable, and says so", async () => {
    const store = await openDeviceStore(false);
    expect(store.persistent).toBe(false);
    await roundTrip(store);
  });

  it("falls back to memory when opening throws (blocked site data)", async () => {
    const original = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => {
      throw new DOMException("The user denied permission to access the database.", "SecurityError");
    };
    try {
      expect((await openDeviceStore()).persistent).toBe(false);
    } finally {
      indexedDB.open = original;
    }
  });

  it("hands out copies: mutating a listed record does not change the store", async () => {
    const store = memoryStore();
    const { record } = await issue();
    await store.putInvoice(record);
    const [copy] = (await store.listInvoices()) as { createdAt: number }[];
    if (copy !== undefined) {
      copy.createdAt = 99;
    }
    expect(((await store.getInvoice(record.id)) as { createdAt: number }).createdAt).toBe(record.createdAt);
  });
});

describe("stored invoices are re-validated", () => {
  it("accepts a record that matches its signed invoice", async () => {
    const { record, issued } = await issue();
    const parsed = parseStoredInvoice(structuredClone(record), registry);
    expect(parsed?.link.key).toBe(issued.key);
    expect(parsed?.link.memo).toBe("Logo design, invoice 042");
  });

  it("rejects a tampered amount, memo, key, id, signature or role", async () => {
    const { record } = await issue();
    const signed = record.signed as unknown as Record<string, unknown>;
    const invoice = signed["invoice"] as Record<string, unknown>;
    const cases: unknown[] = [
      { ...record, signed: { ...signed, invoice: { ...invoice, amount: "1" } } },
      { ...record, signed: { ...signed, memo: "Something else" } },
      { ...record, key: `0x${"00".repeat(32)}` },
      { ...record, id: invoiceId(CHAIN_ID + 1, record.key) },
      { ...record, signed: { ...signed, signature: `0x${"11".repeat(65)}` } },
      { ...record, role: "stolen" },
      { ...record, createdAt: -1 },
      null,
      "not a record",
    ];
    for (const value of cases) {
      expect(parseStoredInvoice(value, registry), JSON.stringify(value).slice(0, 80)).toBeNull();
    }
  });

  it("rejects an invoice for a chain outside the edition's registry", async () => {
    const { record } = await issue();
    const other = createRegistry([defineLocalChain({ chainId: 1337, rpcUrl: "http://127.0.0.1:8546", tokens: localChain().tokens, deployment: localChain().deployment })]);
    expect(parseStoredInvoice(record, other)).toBeNull();
  });

  it("rejects receipts whose id does not match their fields, and malformed contacts", () => {
    expect(parseStoredReceipt(receipt())).not.toBeNull();
    expect(parseStoredReceipt(receipt({ logIndex: 4 }))).toBeNull();
    expect(parseStoredReceipt(receipt({ amount: "-1" }))).toBeNull();
    // A mixed-case address with a wrong checksum is a corrupted record.
    expect(parseStoredReceipt(receipt({ payee: "0x70997970C51812dc3A010C7d01b50e0d17dc79c8" }))).toBeNull();
    expect(parseStoredContact({ address: payee.address, label: "", card: null, updatedAt: 1 })).toBeNull();
    expect(parseStoredContact({ address: payee.address, label: "x".repeat(65), card: null, updatedAt: 1 })).toBeNull();
    expect(parseStoredContact({ address: "0x1234", label: "x", card: null, updatedAt: 1 })).toBeNull();
  });
});
