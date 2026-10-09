// SPDX-License-Identifier: MIT
/**
 * The ledger backup (ADR 0016): one passkey, many keys.
 *
 * - PRF namespaces: the books salt is SHA-256("paylink.books.v1"); the account's namespace can never be evaluated as
 *   work; the layer asks one assertion pinned to the device's credential, and the answer differs from the account's.
 * - The envelope against known answers from an independent implementation (test/vectors/books-vectors.py: RFC 5869
 *   HKDF in plain Python, pyca/cryptography AES-GCM), against node:crypto, and the primitives against their published
 *   vectors (RFC 5869 test case 1, the GCM specification's test case 16).
 * - Wrong key and tampering: another passkey is told apart from an altered file; every header field is authenticated.
 * - Strict parsing, newer files refused before any prompt, the schema 1 → 2 migration.
 * - The books in and out of the device store (scope, validation, idempotent merge) and the panel end to end in the
 *   DOM: back up on one device, restore on another with the same passkey, and every refusal with its support code.
 */
import { createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WebAuthnClient } from "@category-labs/mera";
import { createTranslator, EN, featureTranslator, loadFeature, LOCALES, loadMessages } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";
import { decodeInvoiceFragment, encodeInvoiceFragment, expiresIn, issueInvoice, toSignedInvoiceJson } from "@paylink/sdk";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { getAddress } from "viem";
import type { Address, Hex, LocalAccount } from "viem";
import { mnemonicToAccount, privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKey, EVM_ACCOUNT_PATH, namespaceOutput, signIn, withPasskeySigner } from "../src/accounts/mera.ts";
import { ACCOUNT_NAMESPACE, BOOKS_NAMESPACE, namespaceSalt } from "../src/accounts/namespaces.ts";
import type { MeraModule } from "../src/accounts/passkey.ts";
import { CREATE_ID, passkeyLayer, PasskeyUseError } from "../src/accounts/passkey.ts";
import type { AccountProvider } from "../src/accounts/types.ts";
import type { App } from "../src/app/context.ts";
import type { Session } from "../src/app/session.ts";
import { decodeBase64url, encodeBase64url } from "../src/books/base64url.ts";
import { collectBooks, MAX_RECORDS, mergeBooks, upgradeContent } from "../src/books/content.ts";
import type { BooksContent } from "../src/books/content.ts";
import { BOOKS_SCHEMA, BooksError, headerBytes, MAX_FILE_BYTES, openBooks, PAD_BLOCK, parseBooksFile, sealBooks, serializeBooksFile } from "../src/books/envelope.ts";
import type { BooksFailure, BooksFile } from "../src/books/envelope.ts";
import { ledgerKeyOutput } from "../src/books/key.ts";
import type { LoadNamespaceModule } from "../src/books/key.ts";
import { backupFileName, booksPanel, describeBooksError } from "../src/books/panel.ts";
import { invoiceId, memoryStore, receiptId } from "../src/store/db.ts";
import type { ContactRecord, DeviceStore, InvoiceRecord, ReceiptRecord } from "../src/store/db.ts";
import { CHAIN_ID, NOW, registry, TOKEN_ADDRESS } from "./helpers.ts";

const hex = (h: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(h, "hex"));

interface Vector {
  readonly name: string;
  readonly input: { readonly prfOutput: string; readonly merchant: Address; readonly chainId: number; readonly createdAt: string; readonly salt: string; readonly iv: string; readonly schema: number; readonly content: unknown };
  readonly expected: { readonly prfSalt: string; readonly check: string; readonly key: string; readonly aad: string; readonly plaintextBytes: number; readonly paddedBytes: number; readonly file: string };
}

const VECTORS = (JSON.parse(readFileSync(join(import.meta.dirname, "vectors/books-v1.json"), "utf8")) as { namespace: string; vectors: Vector[] }).vectors;
const [V2, V1] = VECTORS as [Vector, Vector];

/** The salt and IV of a vector, in the order `sealBooks` asks for them. */
const pinned = (v: Vector) => {
  const queue = [hex(v.input.salt), hex(v.input.iv)];
  return (length: number): Uint8Array<ArrayBuffer> => {
    const next = queue.shift();
    if (next?.length !== length) {
      throw new Error("unexpected randomness request");
    }
    return next;
  };
};

const sealVector = async (v: Vector): Promise<BooksFile> =>
  await sealBooks(hex(v.input.prfOutput), { merchant: v.input.merchant, chainId: v.input.chainId, schema: v.input.schema, content: v.input.content, now: new Date(v.input.createdAt), random: pinned(v) });

async function failure(promise: Promise<unknown>): Promise<BooksFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BooksError) {
      return error.failure;
    }
    throw error;
  }
  throw new Error("expected a BooksError");
}

function failureOf(run: () => unknown): BooksFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof BooksError) {
      return error.failure;
    }
    throw error;
  }
  throw new Error("expected a BooksError");
}

// ---------------------------------------------------------------------------------------------------- namespaces

describe("PRF namespaces", () => {
  it("salts the books namespace with SHA-256 of its name, as Mera salts its own default", async () => {
    expect(BOOKS_NAMESPACE).toBe("paylink.books.v1");
    expect(Buffer.from(await namespaceSalt(BOOKS_NAMESPACE)).toString("hex")).toBe(V2.expected.prfSalt);
  });

  it("never evaluates the account's namespace, or any name outside the closed list, as work", async () => {
    await expect(namespaceSalt(ACCOUNT_NAMESPACE as never)).rejects.toThrow(/not a PayLink work namespace/);
    await expect(namespaceSalt("paylink.books.v2" as never)).rejects.toThrow(/not a PayLink work namespace/);
  });
});

// ---------------------------------------------------------------------------------------------------- primitives

describe("WebCrypto primitives against their published vectors", () => {
  it("HKDF-SHA-256: RFC 5869 test case 1", async () => {
    const ikm = await crypto.subtle.importKey("raw", hex("0b".repeat(22)), "HKDF", false, ["deriveBits"]);
    const okm = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: hex("000102030405060708090a0b0c"), info: hex("f0f1f2f3f4f5f6f7f8f9") }, ikm, 42 * 8);
    expect(Buffer.from(okm).toString("hex")).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  });

  it("AES-256-GCM with additional data: the GCM specification's test case 16", async () => {
    const key = await crypto.subtle.importKey("raw", hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308"), "AES-GCM", false, ["encrypt"]);
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: hex("cafebabefacedbaddecaf888"), additionalData: hex("feedfacedeadbeeffeedfacedeadbeefabaddad2"), tagLength: 128 },
      key,
      hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39"),
    );
    expect(Buffer.from(sealed).toString("hex")).toBe(
      "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" + "76fc6ece0f4e1768cddf8853bb2d551b",
    );
  });
});

// ---------------------------------------------------------------------------------------------------- envelope

describe("the backup file against known answers", () => {
  it.each(VECTORS)("$name: written byte for byte as the independent implementation writes it", async (v) => {
    const file = await sealVector(v);
    expect(serializeBooksFile(file)).toBe(v.expected.file);
    expect(file.kdf.check).toBe(v.expected.check);
    expect(new TextDecoder().decode(headerBytes(file))).toBe(v.expected.aad);
    expect(decodeBase64url(file.ciphertext)?.length).toBe(v.expected.paddedBytes + 16);
  });

  it.each(VECTORS)("$name: opened by the app, and by node:crypto with the vector's key", async (v) => {
    const file = parseBooksFile(v.expected.file);
    expect(await openBooks(hex(v.input.prfOutput), file)).toEqual(v.input.content);
    // An independent decryption: HKDF and AES-GCM from node:crypto, the key and additional data from the vector.
    const ikm = hex(v.input.prfOutput);
    const key = Buffer.from(hkdfSync("sha256", ikm, hex(v.input.salt), `paylink.books.v1/aes-256-gcm/eip155:${String(v.input.chainId)}/${v.input.merchant}`, 32));
    expect(key.toString("hex")).toBe(v.expected.key);
    expect(Buffer.from(hkdfSync("sha256", ikm, new Uint8Array(32), "paylink.books.v1/check", 32)).toString("base64url")).toBe(v.expected.check);
    const sealed = Buffer.from(file.ciphertext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, hex(v.input.iv));
    decipher.setAAD(Buffer.from(v.expected.aad, "utf8"));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    expect(plain.length).toBe(v.expected.paddedBytes);
    expect(plain.subarray(v.expected.plaintextBytes).every((b) => b === 0x20)).toBe(true);
    expect(JSON.parse(plain.toString("utf8")) as unknown).toEqual(v.input.content);
  });

  it("pads to whole 4 KiB blocks, so the size says little about the number of records", async () => {
    const small = await sealBooks(new Uint8Array(32).fill(3), { merchant: V2.input.merchant, chainId: 10143, content: { invoices: [], receipts: [], contacts: [] } });
    const larger = await sealBooks(new Uint8Array(32).fill(3), { merchant: V2.input.merchant, chainId: 10143, content: { invoices: [], receipts: [], contacts: Array.from({ length: 20 }, () => ({ address: V2.input.merchant, label: "x", card: null, updatedAt: 1 })) } });
    expect(decodeBase64url(small.ciphertext)?.length).toBe(PAD_BLOCK + 16);
    expect(decodeBase64url(larger.ciphertext)?.length).toBe(PAD_BLOCK + 16);
  });

  it("wipes the PRF output it is given, and keeps every key non-extractable", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const deriveKey = vi.spyOn(crypto.subtle, "deriveKey");
    const output = hex(V2.input.prfOutput);
    const file = await sealBooks(output, { merchant: V2.input.merchant, chainId: 10143, content: V2.input.content });
    expect(output.every((b) => b === 0)).toBe(true);
    const again = hex(V2.input.prfOutput);
    await openBooks(again, file);
    expect(again.every((b) => b === 0)).toBe(true);
    expect(importKey.mock.calls.every((call) => !call[3])).toBe(true);
    expect(deriveKey.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(deriveKey.mock.calls.every((call) => !call[3] && [...call[4]].length === 1)).toBe(true);
  });

  it("uses a fresh salt and IV for every file: the same books never give the same ciphertext", async () => {
    const one = await sealBooks(hex(V2.input.prfOutput), { merchant: V2.input.merchant, chainId: 10143, content: V2.input.content });
    const two = await sealBooks(hex(V2.input.prfOutput), { merchant: V2.input.merchant, chainId: 10143, content: V2.input.content });
    expect(one.kdf.salt).not.toBe(two.kdf.salt);
    expect(one.cipher.iv).not.toBe(two.cipher.iv);
    expect(one.ciphertext).not.toBe(two.ciphertext);
    // The key check belongs to the passkey, not to the file.
    expect(one.kdf.check).toBe(two.kdf.check);
  });
});

describe("wrong passkey, altered file", () => {
  const file = (): BooksFile => parseBooksFile(V2.expected.file);
  const flip = (b64: string, index: number): string => {
    const bytes = decodeBase64url(b64) ?? new Uint8Array();
    bytes[index] = (bytes[index] ?? 0) ^ 0x01;
    return encodeBase64url(bytes);
  };

  it("another passkey's output is refused by the key check, before any decryption", async () => {
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    expect(await failure(openBooks(randomBytes(32), file()))).toBe("wrong-key");
    // The account namespace's output of the right passkey is another key too.
    expect(await failure(openBooks(hex(V1.input.prfOutput), file()))).toBe("wrong-key");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("a changed byte anywhere in the ciphertext or the tag fails authentication", async () => {
    const sealed = decodeBase64url(file().ciphertext)?.length ?? 0;
    for (const index of [0, 1, 200, PAD_BLOCK - 1, sealed - 16, sealed - 1]) {
      expect(await failure(openBooks(hex(V2.input.prfOutput), { ...file(), ciphertext: flip(file().ciphertext, index) })), String(index)).toBe("tampered");
    }
  });

  it("every header field is authenticated: merchant, chain, schema, time, salt and IV", async () => {
    const other = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    const edits: Partial<BooksFile>[] = [
      { merchant: other },
      { chain: "eip155:84532" },
      { schema: 1 },
      { createdAt: "2026-10-09T01:00:00.001Z" },
      { kdf: { ...file().kdf, salt: flip(file().kdf.salt, 0) } },
      { cipher: { ...file().cipher, iv: flip(file().cipher.iv, 11) } },
    ];
    for (const edit of edits) {
      expect(await failure(openBooks(hex(V2.input.prfOutput), { ...file(), ...edit })), JSON.stringify(edit)).toBe("tampered");
    }
  });

  it("a ciphertext moved from another file of the same passkey fails authentication", async () => {
    const mine = await sealBooks(hex(V2.input.prfOutput), { merchant: V2.input.merchant, chainId: 10143, content: { invoices: [], receipts: [], contacts: [] } });
    expect(await failure(openBooks(hex(V2.input.prfOutput), { ...file(), ciphertext: mine.ciphertext }))).toBe("tampered");
  });

  it("an edited key check reads as another passkey: the file stays locked either way", async () => {
    expect(await failure(openBooks(hex(V2.input.prfOutput), { ...file(), kdf: { ...file().kdf, check: flip(file().kdf.check, 5) } }))).toBe("wrong-key");
  });

  it("authenticated content that is not JSON is unreadable, not trusted", async () => {
    const sealed = await sealBooks(hex(V2.input.prfOutput), { merchant: V2.input.merchant, chainId: 10143, content: "x" });
    expect(await openBooks(hex(V2.input.prfOutput), sealed)).toBe("x");
    expect(() => upgradeContent(2, "x")).toThrow(BooksError);
  });
});

describe("parsing a file: strict, and newer files refused before any prompt", () => {
  const base = (): Record<string, unknown> => JSON.parse(V2.expected.file) as Record<string, unknown>;
  const text = (value: unknown): string => JSON.stringify(value);

  it("accepts the canonical file, in any key order and spacing", () => {
    const shuffled = Object.fromEntries(Object.entries(base()).reverse());
    expect(parseBooksFile(JSON.stringify(shuffled))).toEqual(parseBooksFile(V2.expected.file));
  });

  it.each([
    ["not JSON", "{", "unreadable"],
    ["not a books file", text({ hello: 1 }), "unreadable"],
    ["an extra field", text({ ...base(), note: "call me" }), "unreadable"],
    ["a missing field", text({ ...base(), createdAt: undefined }), "unreadable"],
    ["envelope 0", text({ ...base(), version: 0 }), "unreadable"],
    ["envelope 2", text({ ...base(), version: 2 }), "newer"],
    ["schema 3", text({ ...base(), schema: 3 }), "newer"],
    ["schema 0", text({ ...base(), schema: 0 }), "unreadable"],
    ["a lower-case merchant", text({ ...base(), merchant: V2.input.merchant.toLowerCase() }), "unreadable"],
    ["a chain that is not CAIP-2", text({ ...base(), chain: "10143" }), "unreadable"],
    ["a time that is not ISO 8601 UTC", text({ ...base(), createdAt: "2026-10-09 01:00" }), "unreadable"],
    ["another namespace", text({ ...base(), kdf: { ...(base()["kdf"] as object), namespace: "mera.prf.salt.v1" } }), "unreadable"],
    ["a padded salt", text({ ...base(), kdf: { ...(base()["kdf"] as object), salt: `${(base()["kdf"] as { salt: string }).salt}=` } }), "unreadable"],
    ["a short IV", text({ ...base(), cipher: { name: "AES-256-GCM", iv: "AAAA" } }), "unreadable"],
    ["another cipher", text({ ...base(), cipher: { name: "AES-128-GCM", iv: (base()["cipher"] as { iv: string }).iv } }), "unreadable"],
    ["a ciphertext cut short", text({ ...base(), ciphertext: (base()["ciphertext"] as string).slice(0, -8) }), "unreadable"],
  ] as const)("refuses %s", (_name, input, expected) => {
    expect(failureOf(() => parseBooksFile(input))).toBe(expected);
  });

  it("refuses a file larger than a backup can be", () => {
    expect(failureOf(() => parseBooksFile(" ".repeat(MAX_FILE_BYTES + 1)))).toBe("too-large");
  });
});

describe("base64url", () => {
  it("round-trips every length and agrees with Node's encoder", () => {
    for (let n = 0; n <= 64; n += 1) {
      const bytes = randomBytes(n);
      const encoded = encodeBase64url(bytes);
      expect(encoded).toBe(bytes.toString("base64url"));
      expect(Buffer.from(decodeBase64url(encoded) ?? []).equals(bytes)).toBe(true);
    }
  });

  it("refuses padding, other alphabets, impossible lengths and non-zero trailing bits", () => {
    for (const bad of ["AA==", "A+/A", "A", "AB", "AAB", "QUJD RA", "QR"]) {
      expect(decodeBase64url(bad), bad).toBeNull();
    }
    expect(decodeBase64url("QQ")).toEqual(Uint8Array.from([0x41]));
  });
});

// ---------------------------------------------------------------------------------------------------- schema

describe("content schemas", () => {
  it("upgrades schema 1 (invoices and receipts) to schema 2 with an empty address book", async () => {
    expect(upgradeContent(1, { invoices: [], receipts: [] })).toEqual({ invoices: [], receipts: [], contacts: [] });
    // The schema-1 file written by the independent implementation opens and upgrades.
    const file = parseBooksFile(V1.expected.file);
    expect(file.schema).toBe(1);
    expect(upgradeContent(file.schema, await openBooks(hex(V1.input.prfOutput), file))).toEqual({ invoices: [], receipts: [], contacts: [] });
  });

  it("holds each schema to exactly its shape", () => {
    expect(failureOf(() => upgradeContent(1, { invoices: [], receipts: [], contacts: [] }))).toBe("unreadable");
    expect(failureOf(() => upgradeContent(2, { invoices: [], receipts: [] }))).toBe("unreadable");
    expect(failureOf(() => upgradeContent(2, { invoices: {}, receipts: [], contacts: [] }))).toBe("unreadable");
    expect(failureOf(() => upgradeContent(2, [[], [], []]))).toBe("unreadable");
    expect(failureOf(() => upgradeContent(2, { invoices: new Array(MAX_RECORDS + 1).fill(null), receipts: [], contacts: [] }))).toBe("unreadable");
    expect(failureOf(() => upgradeContent(BOOKS_SCHEMA + 1, { invoices: [], receipts: [], contacts: [] }))).toBe("newer");
    expect(failureOf(() => upgradeContent(0, { invoices: [], receipts: [] }))).toBe("unreadable");
  });
});

// ---------------------------------------------------------------------------------------------------- store

/** Signs an invoice on the local chain for `signer` (as the create terminal does) and returns its device record. */
async function issueFor(signer: LocalAccount, memo: string, createdAt: number): Promise<InvoiceRecord> {
  const issued = await issueInvoice({
    registry,
    chainId: CHAIN_ID,
    signer,
    draft: { payee: signer.address, token: TOKEN_ADDRESS, amount: 25_500_000n, maxPayments: 1, expiry: expiresIn(NOW, 7n * 86_400n), memo },
  });
  decodeInvoiceFragment(encodeInvoiceFragment(issued.signed), registry);
  return { id: invoiceId(CHAIN_ID, issued.key), chainId: CHAIN_ID, key: issued.key, signed: toSignedInvoiceJson(issued.signed, issued.key), role: "issued", createdAt };
}

const receipt = (payer: Address, payee: Address, n: number, chainId = CHAIN_ID): ReceiptRecord => {
  const txHash: Hex = `0x${n.toString(16).padStart(64, "0")}`;
  return {
    id: receiptId(chainId, txHash, 0),
    chainId,
    txHash,
    logIndex: 0,
    role: "paid",
    invoiceKey: `0x${"ab".repeat(32)}`,
    payee,
    payer,
    token: TOKEN_ADDRESS,
    amount: "25500000",
    blockTime: 1_791_417_600,
    fragment: `2.${String(chainId)}.${txHash}.0`,
    savedAt: 1_000 + n,
  };
};

const contact = (address: Address, label: string, card: string | null, updatedAt: number): ContactRecord => ({ address, label, card, updatedAt });

describe("the books in and out of the device store", () => {
  const merchant = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());

  async function seeded(): Promise<{ store: DeviceStore; mine: InvoiceRecord[] }> {
    const store = memoryStore();
    const mine = [await issueFor(merchant, "Logo design, invoice 042", 1), await issueFor(merchant, "Kitenge × 2 — épicerie Rasoa", 2)];
    for (const record of mine) {
      await store.putInvoice(record);
    }
    // Another account's invoice on this device, a receive card saved from Send, a broken record.
    await store.putInvoice(await issueFor(stranger, "not the merchant's", 3));
    await store.putInvoice({ ...(await issueFor(stranger, "Rasoa's card", 4)), role: "card" });
    await store.putInvoice({ ...mine[0], id: "31337:0xnope" } as InvoiceRecord);
    await store.putReceipt(receipt(merchant.address, stranger.address, 1));
    await store.putReceipt(receipt(stranger.address, merchant.address, 2));
    await store.putReceipt(receipt(stranger.address, stranger.address, 3));
    await store.putReceipt(receipt(merchant.address, stranger.address, 4, 84532));
    await store.putContact(contact(stranger.address, "Rasoa", `2.${String(CHAIN_ID)}.AAAA`, 10));
    await store.putContact(contact(getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8"), "Base friend", "2.84532.AAAA", 10));
    await store.putContact(contact(getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"), "No card", null, 10));
    return { store, mine };
  }

  it("collects the merchant's books on one chain: its invoices, saved cards, its receipts and its address book", async () => {
    const { store } = await seeded();
    const { content, records } = await collectBooks(store, registry, { merchant: merchant.address, chainId: CHAIN_ID });
    expect(content.invoices.map((r) => (r as InvoiceRecord).signed.memo).sort()).toEqual(["Kitenge × 2 — épicerie Rasoa", "Logo design, invoice 042", "Rasoa's card"]);
    expect(content.receipts.map((r) => (r as ReceiptRecord).txHash.slice(-1)).sort()).toEqual(["1", "2"]);
    expect(content.contacts.map((c) => (c as ContactRecord).label).sort()).toEqual(["No card", "Rasoa"]);
    expect(records).toBe(7);
    expect(await collectBooks(memoryStore(), registry, { merchant: merchant.address, chainId: CHAIN_ID })).toEqual({ content: { invoices: [], receipts: [], contacts: [] }, records: 0 });
  });

  it("round-trips through a file into another device's store, idempotently", async () => {
    const { store } = await seeded();
    const { content } = await collectBooks(store, registry, { merchant: merchant.address, chainId: CHAIN_ID });
    const prf = randomBytes(32);
    const file = await sealBooks(Uint8Array.from(prf), { merchant: merchant.address, chainId: CHAIN_ID, content });
    const opened = upgradeContent(file.schema, await openBooks(Uint8Array.from(prf), parseBooksFile(serializeBooksFile(file))));
    const other = memoryStore();
    expect(await mergeBooks(other, registry, { merchant: merchant.address, chainId: CHAIN_ID }, opened)).toEqual({ added: 7, present: 0, skipped: 0 });
    expect(await mergeBooks(other, registry, { merchant: merchant.address, chainId: CHAIN_ID }, opened)).toEqual({ added: 0, present: 7, skipped: 0 });
    expect(await collectBooks(other, registry, { merchant: merchant.address, chainId: CHAIN_ID })).toEqual(await collectBooks(store, registry, { merchant: merchant.address, chainId: CHAIN_ID }));
  });

  it("skips records that fail the device store's checks or belong to another merchant or chain", async () => {
    const { mine } = await seeded();
    const forged = { ...mine[0], signed: { ...mine[0]?.signed, memo: "Paid in full" } };
    // A well-formed record whose signature is not the merchant's over its key (another invoice's signature).
    const resigned = { ...mine[1], signed: { ...mine[1]?.signed, payeeSig: mine[0]?.signed.payeeSig } };
    const content: BooksContent = {
      invoices: [mine[0], forged, resigned, await issueFor(stranger, "someone else's", 5), { nonsense: true }],
      receipts: [receipt(merchant.address, stranger.address, 9), receipt(stranger.address, stranger.address, 10), receipt(merchant.address, stranger.address, 11, 84532), { ...receipt(merchant.address, stranger.address, 12), id: "x" }],
      contacts: [contact(stranger.address, "Rasoa", null, 1), contact(stranger.address, "", null, 1), contact(stranger.address, "Elsewhere", "2.84532.AAAA", 1)],
    };
    expect(await mergeBooks(memoryStore(), registry, { merchant: merchant.address, chainId: CHAIN_ID }, content)).toEqual({ added: 3, present: 0, skipped: 9 });
  });

  it("keeps the newer address-book entry", async () => {
    const store = memoryStore();
    await store.putContact(contact(stranger.address, "Rasoa (new number)", null, 20));
    const scope = { merchant: merchant.address, chainId: CHAIN_ID };
    expect(await mergeBooks(store, registry, scope, { invoices: [], receipts: [], contacts: [contact(stranger.address, "Rasoa", null, 10)] })).toEqual({ added: 0, present: 1, skipped: 0 });
    expect(await mergeBooks(store, registry, scope, { invoices: [], receipts: [], contacts: [contact(stranger.address, "Rasoa Store", null, 30)] })).toEqual({ added: 1, present: 0, skipped: 0 });
    expect((await store.listContacts()).map((c) => (c as ContactRecord).label)).toEqual(["Rasoa Store"]);
  });
});

// ---------------------------------------------------------------------------------------------------- the passkey

/**
 * An authenticator with PRF as CTAP `hmac-secret` computes it: a secret per credential, HMAC over the salt. One
 * instance is "the passkey manager": credentials it holds sync to every device that uses it.
 */
function authenticator(): WebAuthnClient & { readonly salts: string[]; readonly pinned: (string | null)[]; answerWith: Uint8Array | null } {
  const secrets = new Map<string, Buffer>();
  const prf = (id: Uint8Array, salt: Uint8Array): Uint8Array => Uint8Array.from(createHmac("sha256", secrets.get(Buffer.from(id).toString("hex")) ?? Buffer.alloc(32)).update(salt).digest());
  const client = {
    salts: [] as string[],
    pinned: [] as (string | null)[],
    answerWith: null as Uint8Array | null,
    createCredential(request: Parameters<WebAuthnClient["createCredential"]>[0]) {
      const id = randomBytes(16);
      secrets.set(id.toString("hex"), randomBytes(32));
      client.salts.push(Buffer.from(request.prfSalt).toString("hex"));
      return Promise.resolve({ credentialId: Uint8Array.from(id), prfEnabled: true, prfOutput: prf(id, request.prfSalt) });
    },
    getCredential(request: Parameters<WebAuthnClient["getCredential"]>[0]) {
      client.salts.push(Buffer.from(request.prfSalt).toString("hex"));
      client.pinned.push(request.allowCredential === undefined ? null : Buffer.from(request.allowCredential.credentialId).toString("base64url"));
      const id = client.answerWith ?? request.allowCredential?.credentialId ?? Buffer.from([...secrets.keys()][0] ?? "", "hex");
      return Promise.resolve({ credentialId: Uint8Array.from(id), prfOutput: prf(id, request.prfSalt) });
    },
  };
  return client;
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
  };
}

/** The Mera chunk as the ledger key loads it, over the fake authenticator. */
const meraFor = (client: WebAuthnClient): LoadNamespaceModule => () => Promise.resolve({ namespaceOutput: (o) => namespaceOutput({ ...o, webAuthnClient: client }) });

/** One device: its own storage and IndexedDB, the shared passkey manager. */
function device(client: WebAuthnClient, options: { readonly webAuthn?: boolean } = {}) {
  const storage = memoryStorage();
  const load = (): Promise<MeraModule> =>
    Promise.resolve({
      createKey: (o) => createKey({ ...o, webAuthnClient: client }),
      signIn: (o) => signIn({ ...o, webAuthnClient: client }),
      withPasskeySigner: (o, use) => withPasskeySigner({ ...o, webAuthnClient: client }, use as never),
    });
  const layer = passkeyLayer({ rpId: null, defaultChainId: CHAIN_ID, storage, location: { hostname: "localhost", protocol: "http:" }, load, webAuthnAvailable: () => options.webAuthn ?? true });
  return { layer, storage, store: memoryStore(), load: meraFor(client) };
}

/** Connects with a prompt, as the KeyCard does; a passkey layer always shares an account or throws. */
async function connect(layer: ReturnType<typeof device>["layer"], connectorId: string, label?: string): Promise<AccountProvider> {
  const account = await layer.connect(connectorId, { silent: false, ...(label === undefined ? {} : { label }) });
  if (account === null) {
    throw new Error("no account");
  }
  return account;
}

/** The account a fake PRF output for Mera's salt derives (viem's own BIP-39/BIP-32: an independent path). */
async function accountFor(client: ReturnType<typeof authenticator>, credentialId: string): Promise<LocalAccount> {
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ACCOUNT_NAMESPACE)));
  const answer = await client.getCredential({ rpId: "localhost", challenge: new Uint8Array(32), prfSalt: salt, userVerification: "required", allowCredential: { credentialId: Uint8Array.from(Buffer.from(credentialId, "base64url")) } });
  client.salts.pop();
  client.pinned.pop();
  return mnemonicToAccount(entropyToMnemonic(answer.prfOutput ?? new Uint8Array(32), wordlist), { path: EVM_ACCOUNT_PATH });
}

describe("the ledger key: the passkey's books namespace", () => {
  it("asks one assertion pinned to the device's credential, with the books salt, and gets another output than the account's", async () => {
    const client = authenticator();
    const { layer, storage, load } = device(client);
    const account = await layer.connect(CREATE_ID, { silent: false, label: "Rakoto Design" });
    const record = JSON.parse(storage.items.get("paylink.passkey") ?? "{}") as { credentialId: string };
    client.salts.length = 0;
    client.pinned.length = 0;
    const output = await ledgerKeyOutput(layer, account?.address ?? "0x", load);
    expect(client.salts).toEqual([V2.expected.prfSalt]);
    expect(client.pinned).toEqual([record.credentialId]);
    expect(output).toHaveLength(32);
    const accountSalt = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ACCOUNT_NAMESPACE))).toString("hex");
    expect(V2.expected.prfSalt).not.toBe(accountSalt);
    // The passkey layer stored public facts only, before and after.
    expect([...storage.items.keys()]).toEqual(["paylink.passkey"]);
    expect(Object.keys(JSON.parse(storage.items.get("paylink.passkey") ?? "{}") as object).sort()).toEqual(["address", "createdAt", "credentialId", "label", "rpId", "version"]);
  });

  it("refuses without passkeys, with no key on the device, for another account, or when another credential answers", async () => {
    const client = authenticator();
    const elsewhere = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    const none = device(client, { webAuthn: false });
    await expect(ledgerKeyOutput(none.layer, elsewhere, none.load)).rejects.toMatchObject({ failure: "unsupported" });
    const { layer, load } = device(client);
    await expect(ledgerKeyOutput(layer, elsewhere, load)).rejects.toBeInstanceOf(PasskeyUseError);
    const account = await layer.connect(CREATE_ID, { silent: false, label: "A" });
    await expect(ledgerKeyOutput(layer, elsewhere, load)).rejects.toMatchObject({ failure: "other-key" });
    const asked = client.salts.length;
    client.answerWith = Uint8Array.from(randomBytes(16));
    await expect(ledgerKeyOutput(layer, account?.address ?? "0x", load)).rejects.toMatchObject({ failure: "other-key" });
    // Mera's refusals keep their meaning; a chunk that fails to load is a plain failure.
    expect(client.salts.slice(asked)).toEqual([V2.expected.prfSalt]);
    client.answerWith = null;
    const cancelled = (): Promise<never> => Promise.reject(Object.assign(new Error("cancelled"), { failure: "cancelled" }));
    await expect(ledgerKeyOutput(layer, account?.address ?? "0x", () => Promise.resolve({ namespaceOutput: cancelled }))).rejects.toMatchObject({ failure: "cancelled" });
    await expect(ledgerKeyOutput(layer, account?.address ?? "0x", () => Promise.reject(new Error("offline")))).rejects.toMatchObject({ failure: "failed" });
  });
});

// ---------------------------------------------------------------------------------------------------- the panel

function sessionOf(account: AccountProvider | null): Session {
  return {
    account: () => account,
    connectors: () => [],
    subscribe: () => () => undefined,
    connect: () => Promise.reject(new Error("not in this test")),
    disconnect: () => undefined,
    ready: Promise.resolve(),
  };
}

async function appFor(store: DeviceStore, account: AccountProvider | null, locale: Locale = "en"): Promise<App> {
  return {
    edition: { accountLayers: [] },
    registry,
    store,
    session: sessionOf(account),
    locale,
    i18n: createTranslator(locale, locale === "en" ? EN : await loadMessages(locale), { fallback: EN }),
  } as unknown as App;
}

/** The panel has loaded its strings and drawn itself. */
async function rendered(panel: HTMLElement): Promise<void> {
  await until(() => panel.querySelector(".view-head") !== null);
}

const tick = async (ms = 0): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) {
    await tick(5);
  }
  expect(check()).toBe(true);
}

/** Captures what the page saves (the download helper's blob). */
function captureDownloads(): { files: { name: string; text: Promise<string> }[] } {
  const files: { name: string; text: Promise<string> }[] = [];
  let pending = new Blob([]);
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (blob instanceof Blob) {
      pending = blob;
    }
    return `blob:${location.origin}/books`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    files.push({ name: this.getAttribute("download") ?? "", text: pending.text() });
  });
  return { files };
}

function chooseFile(panel: HTMLElement, name: string, text: string): void {
  const input = panel.querySelector<HTMLInputElement>("input[type=file]");
  if (input === null) {
    throw new Error("no file input");
  }
  Object.defineProperty(input, "files", { configurable: true, value: [new File([text], name, { type: "application/json" })] });
  input.dispatchEvent(new Event("change"));
}

const statusText = (panel: HTMLElement): string => panel.querySelector(".status")?.textContent ?? "";
/** The books feature catalogue in English (a chunk of its own: the core catalogue never carries it). */
const BOOKS = await loadFeature("books", "en");
const en = (key: keyof typeof BOOKS): string => BOOKS[key] ?? "";
/** An i18n key showing through untranslated (`books.error.tampered`), not the namespace name `paylink.books.v1`. */
const RAW_KEY = /(^|[^.\w])(books|common|error)\.[a-z]/;

describe("the ledger backup panel", () => {
  let restored = 0;
  const hooks = (load: LoadNamespaceModule) => ({ restored: (): void => void (restored += 1), load });

  beforeEach(() => {
    restored = 0;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  /** A merchant whose passkey made two invoices on device A. */
  async function merchantOnDeviceA() {
    const client = authenticator();
    const a = device(client);
    const account = await connect(a.layer, CREATE_ID, "Rakoto Design");
    const record = JSON.parse(a.storage.items.get("paylink.passkey") ?? "{}") as { credentialId: string };
    const signer = await accountFor(client, record.credentialId);
    expect(signer.address).toBe(account.address);
    await a.store.putInvoice(await issueFor(signer, "Logo design, invoice 042", 1));
    await a.store.putInvoice(await issueFor(signer, "Kitenge × 2 — épicerie Rasoa", 2));
    return { client, a, account };
  }

  it("signed out, explains what the ledger key does and offers no key", async () => {
    const panel = booksPanel(await appFor(memoryStore(), null), device(authenticator()).layer, hooks(device(authenticator()).load));
    document.body.append(panel);
    await rendered(panel);
    expect(panel.querySelector(".screen-top")?.textContent).toContain("PRF namespace paylink.books.v1");
    expect(panel.querySelector(".books-hint")?.textContent).toBe(en("books.signIn"));
    expect(panel.querySelector("button")).toBeNull();
  });

  it("backs up on device A and restores on device B with the same passkey; the key is never stored", async () => {
    const { client, a, account } = await merchantOnDeviceA();
    const saved = captureDownloads();
    const panelA = booksPanel(await appFor(a.store, account), a.layer, hooks(a.load));
    document.body.append(panelA);
    await rendered(panelA);
    expect(panelA.querySelector(".readings")?.textContent).toContain(account.address.slice(2, 6));
    const before = client.salts.length;
    panelA.querySelector<HTMLButtonElement>("[data-books=backup]")?.click();
    await until(() => saved.files.length === 1);
    await until(() => statusText(panelA).startsWith("Backup saved"));
    expect(statusText(panelA)).toBe(en("books.saved.other").replace("{count}", "2"));
    // One fingerprint, for the books namespace only.
    expect(client.salts.slice(before)).toEqual([V2.expected.prfSalt]);
    const file = saved.files[0];
    expect(file?.name).toBe(`paylink-ledger-backup-${String(CHAIN_ID)}-${account.address.slice(0, 8).toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`);
    const text = (await file?.text) ?? "";
    expect(text).not.toContain("Logo design");
    expect(text).not.toContain("Kitenge");
    expect(parseBooksFile(text).merchant).toBe(account.address);
    // Nothing but the public record was written to storage on device A, and no store record holds key material.
    expect([...a.storage.items.keys()]).toEqual(["paylink.passkey"]);
    expect(await a.store.listInvoices()).toHaveLength(2);

    // Device B: empty books, the same passkey (synced), signed in.
    const b = device(client);
    const accountB = await connect(b.layer, "passkey.signin");
    expect(accountB.address).toBe(account.address);
    const panelB = booksPanel(await appFor(b.store, accountB), b.layer, hooks(b.load));
    document.body.append(panelB);
    await rendered(panelB);
    chooseFile(panelB, file?.name ?? "", text);
    await until(() => panelB.querySelector("[data-books=unlock]") !== null);
    expect(panelB.querySelector(".books-file-screen")?.textContent).toContain(en("books.file.kicker"));
    panelB.querySelector<HTMLButtonElement>("[data-books=unlock]")?.click();
    await until(() => statusText(panelB).startsWith("Restored"));
    expect(statusText(panelB)).toBe("Restored: 2 new, 0 already here.");
    expect(restored).toBe(1);
    expect((await b.store.listInvoices()).map((r) => (r as InvoiceRecord).signed.memo).sort()).toEqual(["Kitenge × 2 — épicerie Rasoa", "Logo design, invoice 042"]);
    expect([...b.storage.items.keys()]).toEqual(["paylink.passkey"]);

    // The same file again: nothing new.
    chooseFile(panelB, file?.name ?? "", text);
    await until(() => panelB.querySelector("[data-books=unlock]") !== null);
    panelB.querySelector<HTMLButtonElement>("[data-books=unlock]")?.click();
    await until(() => statusText(panelB).includes("2 already"));
    expect(restored).toBe(1);
  });

  it("refuses another account's file before any prompt, a tampered file after one, and says why", async () => {
    const { client, a, account } = await merchantOnDeviceA();
    const { content } = await collectBooks(a.store, registry, { merchant: account.address, chainId: CHAIN_ID });
    const output = await ledgerKeyOutput(a.layer, account.address, a.load);
    const genuine = serializeBooksFile(await sealBooks(output, { merchant: account.address, chainId: CHAIN_ID, content }));

    // A second passkey on device C: another account.
    const c = device(client);
    const other = await connect(c.layer, CREATE_ID, "Someone else");
    const panelC = booksPanel(await appFor(c.store, other), c.layer, hooks(c.load));
    document.body.append(panelC);
    await rendered(panelC);
    const prompts = client.salts.length;
    chooseFile(panelC, "x.json", genuine);
    await until(() => panelC.querySelector(".status.err") !== null);
    expect(statusText(panelC)).toContain(en("books.error.otherAccount").replace("{address}", account.address));
    expect(statusText(panelC)).toContain("Error code BooksOtherAccount");
    expect(client.salts.length).toBe(prompts);
    // The same file with its merchant edited to this account: its own passkey cannot open it.
    chooseFile(panelC, "x.json", genuine.replace(account.address, other.address));
    await until(() => panelC.querySelector("[data-books=unlock]") !== null);
    panelC.querySelector<HTMLButtonElement>("[data-books=unlock]")?.click();
    await until(() => panelC.querySelector(".status.err") !== null);
    expect(statusText(panelC)).toContain(en("books.error.wrongKey"));
    expect(statusText(panelC)).toContain("Error code BooksWrongKey");
    expect(await c.store.listInvoices()).toHaveLength(0);

    // Device A, the right passkey, an altered ciphertext.
    const panelA = booksPanel(await appFor(memoryStore(), account), a.layer, hooks(a.load));
    document.body.append(panelA);
    await rendered(panelA);
    const parsed = JSON.parse(genuine) as { ciphertext: string };
    const bytes = decodeBase64url(parsed.ciphertext) ?? new Uint8Array();
    bytes[10] = (bytes[10] ?? 0) ^ 0x80;
    chooseFile(panelA, "x.json", JSON.stringify({ ...parsed, ciphertext: encodeBase64url(bytes) }));
    await until(() => panelA.querySelector("[data-books=unlock]") !== null);
    panelA.querySelector<HTMLButtonElement>("[data-books=unlock]")?.click();
    await until(() => panelA.querySelector(".status.err") !== null);
    expect(statusText(panelA)).toContain(en("books.error.tampered"));
    expect(statusText(panelA)).toContain("Error code BooksTampered");
    expect(restored).toBe(0);

    // Not a backup at all, and a backup from a newer PayLink.
    chooseFile(panelA, "notes.json", "{\"hello\":1}");
    await until(() => statusText(panelA).includes("BooksFileInvalid"));
    chooseFile(panelA, "new.json", JSON.stringify({ ...parsed, version: 2 }));
    await until(() => statusText(panelA).includes("BooksFileNewer"));
  });

  it("says there is nothing to back up yet, without asking for a fingerprint", async () => {
    const client = authenticator();
    const a = device(client);
    const account = await connect(a.layer, CREATE_ID, "New shop");
    const panel = booksPanel(await appFor(a.store, account), a.layer, hooks(a.load));
    document.body.append(panel);
    await rendered(panel);
    const prompts = client.salts.length;
    panel.querySelector<HTMLButtonElement>("[data-books=backup]")?.click();
    await until(() => panel.querySelector(".status.err") !== null);
    expect(statusText(panel)).toContain(en("books.error.empty"));
    expect(client.salts.length).toBe(prompts);
  });

  it.each(LOCALES)("speaks %s, with every failure translated and its support code", async (locale) => {
    const app = await appFor(memoryStore(), null, locale);
    const panel = booksPanel(app, device(authenticator()).layer, hooks(device(authenticator()).load));
    document.body.append(panel);
    await until(() => panel.querySelector(".books-hint") !== null);
    expect(panel.textContent).not.toMatch(RAW_KEY);
    expect(panel.querySelector(".books-hint")?.textContent).toBe((await loadFeature("books", locale))["books.signIn"]);
    const books = { i18n: await featureTranslator(locale, "books") };
    const failures: BooksFailure[] = ["unreadable", "too-large", "newer", "wrong-key", "tampered", "other-account", "other-network", "empty"];
    for (const f of failures) {
      const said = describeBooksError(books, new BooksError(f, "x", { detail: "0xAbC" }));
      expect(said.message).not.toMatch(RAW_KEY);
      expect(said.code).toMatch(/Books[A-Z]/);
    }
    // The catalogue every page carries never holds the books strings; the panel loads them.
    expect(Object.keys(await loadMessages(locale)).some((key) => key.startsWith("books."))).toBe(false);
  });

  it("names a backup by network, account and day", () => {
    expect(backupFileName({ chain: "eip155:10143", merchant: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", createdAt: "2026-10-09T01:00:00.000Z" })).toBe("paylink-ledger-backup-10143-0xf39fd6-2026-10-09.json");
  });
});
