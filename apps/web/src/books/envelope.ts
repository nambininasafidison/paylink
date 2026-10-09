// SPDX-License-Identifier: MIT
/**
 * The books backup file (ADR 0016): the device's books, encrypted end to end for the passkey that holds the account,
 * with WebCrypto only. Nothing here is stored: keys are non-extractable `CryptoKey` objects that live for one call.
 *
 * Keys. `P` is the passkey's PRF output for the books namespace (`paylink.books.v1`, `accounts/namespaces.ts`), never
 * the account's. From it, HKDF-SHA-256 (RFC 5869) derives two independent values:
 *
 *   check = HKDF(IKM = P, salt = 32 zero bytes, info = "paylink.books.v1/check", L = 32)            public key check
 *   K     = HKDF(IKM = P, salt = file salt (32 random bytes),
 *                info = "paylink.books.v1/aes-256-gcm/" ‖ chain (CAIP-2) ‖ "/" ‖ merchant (EIP-55), L = 32)  AES-256-GCM
 *
 * The key check is the same for every file of one passkey; it lets a reader tell "another passkey" from "an altered
 * file" before decrypting, and reveals nothing about K (other HKDF info, and P is a uniform 256-bit secret). K is new
 * for every file (fresh salt), bound to the chain and the merchant through its info.
 *
 * File. A JSON object whose header is in clear and authenticated: every field but `ciphertext`, re-serialised in a
 * fixed order (`headerBytes`), is the AES-GCM additional data, so changing the merchant, the chain, the schema, the
 * time, a salt or the IV makes decryption fail. The plaintext is the books content as UTF-8 JSON, padded with spaces
 * to a multiple of 4 KiB so the file's size says little about how many records it holds. The IV is 12 random bytes,
 * the tag 128 bits.
 *
 *   { "format": "paylink.books", "version": 1, "schema": 2, "chain": "eip155:10143", "merchant": "0x…",
 *     "createdAt": "2026-10-09T01:00:00.000Z",
 *     "kdf": { "namespace": "paylink.books.v1", "hash": "SHA-256", "salt": "<32 bytes>", "check": "<32 bytes>" },
 *     "cipher": { "name": "AES-256-GCM", "iv": "<12 bytes>" }, "ciphertext": "<padded plaintext ‖ tag>" }
 *
 * Binary fields are canonical unpadded base64url. `version` is the envelope (this layout and these algorithms);
 * `schema` is the content inside (`content.ts`, with its migrations).
 */
import { getAddress, isAddress } from "viem";
import type { Address } from "viem";
import { BOOKS_NAMESPACE } from "../accounts/namespaces.ts";
import { decodeBase64url, encodeBase64url } from "./base64url.ts";

export const BOOKS_FORMAT = "paylink.books";
/** The envelope this code writes and reads. */
export const ENVELOPE_VERSION = 1;
/** Content schema this code writes; it reads every schema from `MIN_SCHEMA` (`content.ts` upgrades older ones). */
export const BOOKS_SCHEMA = 2;
export const MIN_SCHEMA = 1;
/** Plaintext padding block (bytes). */
export const PAD_BLOCK = 4096;
/** The largest file a restore reads (bytes). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

const CHECK_INFO = `${BOOKS_NAMESPACE}/check`;
const KEY_INFO = `${BOOKS_NAMESPACE}/aes-256-gcm`;
const ZERO_SALT = new Uint8Array(32);
const TAG_BYTES = 16;

/** Why a books file could not be made or opened. */
export type BooksFailure =
  /** Not a PayLink books file, damaged, or its content is not what its schema says. */
  | "unreadable"
  /** Larger than `MAX_FILE_BYTES`. */
  | "too-large"
  /** Made by a newer PayLink (a later envelope version or content schema). */
  | "newer"
  /** The key check differs: the file was made with another passkey. */
  | "wrong-key"
  /** AES-GCM authentication failed: the file was changed after it was made. */
  | "tampered"
  /** The file holds another account's books. */
  | "other-account"
  /** The file is for a network this edition does not serve. */
  | "other-network"
  /** Nothing to back up. */
  | "empty";

export class BooksError extends Error {
  readonly failure: BooksFailure;
  /** What the sentence names: the other account (`other-account`) or the CAIP-2 chain (`other-network`). */
  readonly detail: string | null;

  constructor(failure: BooksFailure, message: string, options?: { readonly cause?: unknown; readonly detail?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BooksError";
    this.failure = failure;
    this.detail = options?.detail ?? null;
  }
}

export interface BooksHeader {
  readonly format: typeof BOOKS_FORMAT;
  readonly version: typeof ENVELOPE_VERSION;
  readonly schema: number;
  /** CAIP-2. */
  readonly chain: `eip155:${string}`;
  /** EIP-55. */
  readonly merchant: Address;
  /** ISO 8601, UTC, milliseconds (device clock, display only). */
  readonly createdAt: string;
  readonly kdf: { readonly namespace: typeof BOOKS_NAMESPACE; readonly hash: "SHA-256"; readonly salt: string; readonly check: string };
  readonly cipher: { readonly name: "AES-256-GCM"; readonly iv: string };
}

export interface BooksFile extends BooksHeader {
  readonly ciphertext: string;
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const caip2 = (chainId: number): `eip155:${string}` => `eip155:${String(chainId)}`;

/** The chain ID a header names. */
export function chainIdOf(header: Pick<BooksHeader, "chain">): number {
  return Number(header.chain.slice("eip155:".length));
}

/** The header's fields in their fixed order (whatever order the file had). */
function headerObject(h: BooksHeader): BooksHeader {
  return {
    format: h.format,
    version: h.version,
    schema: h.schema,
    chain: h.chain,
    merchant: h.merchant,
    createdAt: h.createdAt,
    kdf: { namespace: h.kdf.namespace, hash: h.kdf.hash, salt: h.kdf.salt, check: h.kdf.check },
    cipher: { name: h.cipher.name, iv: h.cipher.iv },
  };
}

/** The additional data: the header's fields, in their fixed order, as compact JSON (UTF-8). */
export function headerBytes(h: BooksHeader): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(headerObject(h)));
}

/** The HKDF base key of a PRF output. The output (and the copy handed to WebCrypto) is wiped once WebCrypto holds it. */
async function baseKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  const copy = Uint8Array.from(prfOutput);
  try {
    if (copy.length !== 32) {
      throw new BooksError("unreadable", "a PRF output is 32 bytes");
    }
    return await crypto.subtle.importKey("raw", copy, "HKDF", false, ["deriveBits", "deriveKey"]);
  } finally {
    copy.fill(0);
    prfOutput.fill(0);
  }
}

async function keyCheck(base: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: ZERO_SALT, info: utf8(CHECK_INFO) }, base, 256));
}

async function contentKey(base: CryptoKey, salt: Uint8Array<ArrayBuffer>, chain: string, merchant: Address, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8(`${KEY_INFO}/${chain}/${merchant}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** Pads `bytes` with spaces (JSON whitespace) to a whole number of `PAD_BLOCK`s, at least one. */
export function pad(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = Math.max(1, Math.ceil(bytes.length / PAD_BLOCK)) * PAD_BLOCK;
  const out = new Uint8Array(length).fill(0x20);
  out.set(bytes);
  return out;
}

export interface SealInput {
  readonly merchant: Address;
  readonly chainId: number;
  readonly schema?: number;
  /** The content, a JSON value (`content.ts`). */
  readonly content: unknown;
  readonly now?: Date;
  /** Randomness for the salt and the IV (tests pin it); `crypto.getRandomValues` otherwise. */
  readonly random?: (length: number) => Uint8Array<ArrayBuffer>;
}

/** Encrypts the books for the passkey whose books-namespace PRF output is `prfOutput` (wiped here). */
export async function sealBooks(prfOutput: Uint8Array, input: SealInput): Promise<BooksFile> {
  const random = input.random ?? ((length: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(length)));
  const base = await baseKey(prfOutput);
  const salt = random(32);
  const iv = random(12);
  if (salt.length !== 32 || iv.length !== 12) {
    throw new Error("salt and IV are 32 and 12 bytes");
  }
  const merchant = getAddress(input.merchant);
  const header: BooksHeader = {
    format: BOOKS_FORMAT,
    version: ENVELOPE_VERSION,
    schema: input.schema ?? BOOKS_SCHEMA,
    chain: caip2(input.chainId),
    merchant,
    createdAt: (input.now ?? new Date()).toISOString(),
    kdf: { namespace: BOOKS_NAMESPACE, hash: "SHA-256", salt: encodeBase64url(salt), check: encodeBase64url(await keyCheck(base)) },
    cipher: { name: "AES-256-GCM", iv: encodeBase64url(iv) },
  };
  const key = await contentKey(base, salt, header.chain, merchant, "encrypt");
  const plaintext = pad(utf8(JSON.stringify(input.content)));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: headerBytes(header), tagLength: 128 }, key, plaintext));
  plaintext.fill(0);
  return { ...header, ciphertext: encodeBase64url(sealed) };
}

/** The file as written: the header fields in order, then the ciphertext; two-space indentation, final newline. */
export function serializeBooksFile(file: BooksFile): string {
  return `${JSON.stringify({ ...headerObject(file), ciphertext: file.ciphertext }, null, 2)}\n`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Decrypts a parsed file with the books-namespace PRF output of the passkey at hand (wiped here). Resolves the content
 * as the JSON value its `schema` describes (`content.ts` upgrades and validates it).
 * @throws BooksError `wrong-key` (another passkey), `tampered` (authentication failed), `unreadable`.
 */
export async function openBooks(prfOutput: Uint8Array, file: BooksFile): Promise<unknown> {
  const base = await baseKey(prfOutput);
  const check = decodeBase64url(file.kdf.check);
  const salt = decodeBase64url(file.kdf.salt);
  const iv = decodeBase64url(file.cipher.iv);
  const sealed = decodeBase64url(file.ciphertext);
  if (check === null || salt === null || iv === null || sealed === null) {
    throw new BooksError("unreadable", "the file's binary fields are not base64url");
  }
  if (!sameBytes(await keyCheck(base), check)) {
    throw new BooksError("wrong-key", "the file was made with another passkey");
  }
  const key = await contentKey(base, salt, file.chain, file.merchant, "decrypt");
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: headerBytes(file), tagLength: 128 }, key, sealed));
  } catch (error) {
    throw new BooksError("tampered", "the file failed its integrity check", { cause: error });
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
  } catch (error) {
    throw new BooksError("unreadable", "the decrypted content is not JSON", { cause: error });
  } finally {
    plaintext.fill(0);
  }
}

// ---------------------------------------------------------------------------------------------------- parsing

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CHAIN = /^eip155:[1-9][0-9]{0,15}$/;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

function bytesField(value: unknown, length: number): value is string {
  return typeof value === "string" && decodeBase64url(value)?.length === length;
}

const unreadable = (why: string): BooksError => new BooksError("unreadable", why);

/**
 * Parses a books file strictly (it is input: any other key, type, length or spelling is refused). Refuses a later
 * envelope or content schema as `newer`, before any passkey prompt.
 */
export function parseBooksFile(text: string): BooksFile {
  if (text.length > MAX_FILE_BYTES) {
    throw new BooksError("too-large", "the file is larger than a books backup can be");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadable("not JSON");
  }
  if (typeof value !== "object" || value === null || (value as { format?: unknown }).format !== BOOKS_FORMAT) {
    throw unreadable("not a PayLink books file");
  }
  const v = value as Record<string, unknown>;
  const version = v["version"];
  const schema = v["schema"];
  if (Number.isSafeInteger(version) && (version as number) > ENVELOPE_VERSION) {
    throw new BooksError("newer", "the file was made by a newer PayLink (envelope)");
  }
  if (Number.isSafeInteger(schema) && (schema as number) > BOOKS_SCHEMA) {
    throw new BooksError("newer", "the file was made by a newer PayLink (content)");
  }
  if (!exactKeys(v, ["format", "version", "schema", "chain", "merchant", "createdAt", "kdf", "cipher", "ciphertext"])) {
    throw unreadable("unexpected fields");
  }
  if (version !== ENVELOPE_VERSION || !Number.isSafeInteger(schema) || (schema as number) < MIN_SCHEMA) {
    throw unreadable("unknown version or schema");
  }
  const { chain, merchant, createdAt, kdf, cipher, ciphertext } = v;
  if (typeof chain !== "string" || !CHAIN.test(chain) || !Number.isSafeInteger(Number(chain.slice(7)))) {
    throw unreadable("chain");
  }
  if (typeof merchant !== "string" || !isAddress(merchant, { strict: false }) || getAddress(merchant) !== merchant) {
    throw unreadable("merchant");
  }
  if (typeof createdAt !== "string" || !ISO_UTC.test(createdAt) || Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    throw unreadable("createdAt");
  }
  if (!exactKeys(kdf, ["namespace", "hash", "salt", "check"]) || kdf["namespace"] !== BOOKS_NAMESPACE || kdf["hash"] !== "SHA-256" || !bytesField(kdf["salt"], 32) || !bytesField(kdf["check"], 32)) {
    throw unreadable("kdf");
  }
  if (!exactKeys(cipher, ["name", "iv"]) || cipher["name"] !== "AES-256-GCM" || !bytesField(cipher["iv"], 12)) {
    throw unreadable("cipher");
  }
  const sealedLength = typeof ciphertext === "string" ? decodeBase64url(ciphertext)?.length : undefined;
  if (sealedLength === undefined || sealedLength < PAD_BLOCK + TAG_BYTES || (sealedLength - TAG_BYTES) % PAD_BLOCK !== 0) {
    throw unreadable("ciphertext");
  }
  return {
    format: BOOKS_FORMAT,
    version: ENVELOPE_VERSION,
    schema: schema as number,
    chain: chain as `eip155:${string}`,
    merchant,
    createdAt,
    kdf: { namespace: BOOKS_NAMESPACE, hash: "SHA-256", salt: kdf["salt"], check: kdf["check"] },
    cipher: { name: "AES-256-GCM", iv: cipher["iv"] },
    ciphertext: ciphertext as string,
  };
}
