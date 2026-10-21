// SPDX-License-Identifier: MIT
/**
 * Webhook signatures of the PayPal fake, made the way PayPal's documentation describes its own (S: developer.paypal.com
 * "Verify webhook signatures" and Hookdeck's guide, docs/research/paypal/paypal-tech.md §8): an RSA-SHA256
 * (`SHA256withRSA`) signature over `<transmission id>|<transmission time>|<webhook id>|<CRC32 of the raw body>`, the
 * CRC32 written in decimal. One PayPal page shows a SHA-256 body hash instead (the documents conflict, UNVERIFIED);
 * PayLink never verifies signatures itself, it asks PayPal (P10), so only the fake depends on this choice.
 *
 * WebCrypto only (RSASSA-PKCS1-v1_5, 2048 bits), so the fake runs wherever the API does. One key pair per process:
 * generating RSA keys is the slow part.
 *
 * Owner: PayPal spine workstream.
 */

/** `PAYPAL-AUTH-ALGO` of the fake's deliveries. */
export const AUTH_ALGO = "SHA256withRSA";

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

let keys: Promise<CryptoKeyPair> | null = null;

/** The process's signing key pair (generated once, on first use). */
export function signingKeys(): Promise<CryptoKeyPair> {
  // The Workers types widen generateKey's answer to CryptoKey | CryptoKeyPair; an RSA algorithm always yields a pair.
  keys ??= crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]).then((generated) => {
    if (!("privateKey" in generated)) {
      throw new TypeError("expected an RSA key pair");
    }
    return generated;
  });
  return keys;
}

let table: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) of the UTF-8 bytes of `text`, as an unsigned integer. */
export function crc32(text: string): number {
  if (table === null) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The signed string of one delivery. */
export function signatureInput(transmissionId: string, transmissionTime: string, webhookId: string, rawBody: string): string {
  return `${transmissionId}|${transmissionTime}|${webhookId}|${String(crc32(rawBody))}`;
}

/** Base64 RSA-SHA256 signature of `input`. */
export async function sign(input: string): Promise<string> {
  const { privateKey } = await signingKeys();
  const signature = new Uint8Array(await crypto.subtle.sign(ALGORITHM.name, privateKey, new TextEncoder().encode(input)));
  return toBase64(signature);
}

/** Whether `signature` (base64) signs `input` with the process's key. Malformed base64 is a failed check, not an error. */
export async function verify(input: string, signature: string): Promise<boolean> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(signature);
  } catch {
    return false;
  }
  const { publicKey } = await signingKeys();
  return await crypto.subtle.verify(ALGORITHM.name, publicKey, bytes, new TextEncoder().encode(input));
}

/** The public key as a PEM `PUBLIC KEY` block (SPKI), served at the fake's certificate URL. */
export async function publicKeyPem(): Promise<string> {
  const { publicKey } = await signingKeys();
  const exported = await crypto.subtle.exportKey("spki", publicKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new TypeError("expected SPKI bytes");
  }
  const spki = new Uint8Array(exported);
  const lines = toBase64(spki).match(/.{1,64}/gu) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
