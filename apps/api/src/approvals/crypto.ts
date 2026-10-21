// SPDX-License-Identifier: MIT
/**
 * The few cryptographic operations approvals and sessions need, on WebCrypto (`crypto.subtle`, present in workerd and in
 * Node 22): SHA-256, HMAC-SHA256 keys from a hex secret, constant-time MAC verification (`subtle.verify`), canonical JSON
 * and base64url. No key material is ever logged or returned.
 *
 * Owner: reconciler workstream.
 */
import type { Hex } from "@paylink/api-contract";
import type { ApiRuntime } from "../core/runtime.ts";

const encoder = new TextEncoder();

/** `0x` + the SHA-256 of a UTF-8 string, lowercase. */
export async function sha256Hex(text: string): Promise<Hex> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return `0x${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Canonical JSON (docs/paypal/SPEC.md §10.5): object keys sorted by code unit, no whitespace, strings, finite numbers,
 * booleans, null and arrays only. Anything else (undefined, a function, NaN, a bigint) is refused, so two encodings of
 * the same proposal can never hash differently.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON has no non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot encode a ${typeof value}`);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) {
    return null;
  }
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Where a MAC key came from: the configured secret, a per-process key (Node only), or nothing usable. */
export type MacKey = { readonly state: "configured" | "ephemeral"; readonly key: CryptoKey } | { readonly state: "missing" | "invalid" };

/**
 * The HMAC-SHA256 key of a hex secret of at least 32 bytes (`APPROVAL_HMAC_KEY`, `SESSION_HMAC_KEY`: 32 random bytes,
 * hex, docs/paypal/SPEC.md §12.1). Without a secret, the Node entry (tests, e2e, the offline demo) draws a key that lives
 * as long as the process; the Worker has none, and the routes that need it answer 500 with a rule naming the secret.
 */
export async function macKey(secret: string | undefined, runtime: Pick<ApiRuntime, "kind" | "random" | "logger">, name: string): Promise<MacKey> {
  let raw: Uint8Array;
  let state: "configured" | "ephemeral";
  if (secret === undefined) {
    if (runtime.kind !== "node") {
      return { state: "missing" };
    }
    raw = runtime.random(32);
    state = "ephemeral";
    runtime.logger.log("warn", "secret.ephemeral", { area: name });
  } else {
    const hex = secret.trim().replace(/^0x/iu, "");
    if (!/^(?:[0-9a-fA-F]{2}){32,}$/u.test(hex)) {
      return { state: "invalid" };
    }
    raw = Uint8Array.from(hex.match(/../gu) ?? [], (h) => Number.parseInt(h, 16));
    state = "configured";
  }
  const key = await crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return { state, key };
}

export async function hmac(key: CryptoKey, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Constant-time check of a MAC (WebCrypto's `verify`). */
export async function hmacVerify(key: CryptoKey, mac: Uint8Array, message: string): Promise<boolean> {
  return await crypto.subtle.verify("HMAC", key, mac as Uint8Array<ArrayBuffer>, encoder.encode(message));
}
