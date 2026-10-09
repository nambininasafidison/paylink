// SPDX-License-Identifier: MIT
/**
 * One passkey, many keys (PAYLINK-V2-SPEC §2.1 T2, ADR 0016). A WebAuthn PRF evaluation is a keyed function of the
 * credential and a salt: the same passkey gives a different, unrelated 32-byte output for each salt. PayLink names each
 * use of the passkey with a namespace and derives its PRF salt as `SHA-256(UTF-8(namespace))`, the rule Mera uses for
 * its own default salt:
 *
 * | Namespace          | Work                   | What the PRF output becomes                                              |
 * |--------------------|------------------------|---------------------------------------------------------------------------|
 * | `mera.prf.salt.v1` | the account            | BIP-39 entropy → BIP-32 `m/44'/60'/0'/0/0` → secp256k1 key (`mera.ts`)     |
 * | `paylink.books.v1` | the books backup       | HKDF-SHA-256 → an AES-256-GCM key and a key check (`books/envelope.ts`)    |
 *
 * The authenticator computes each output from its own salt (WebAuthn hashes the salt again under the "WebAuthn PRF"
 * context before CTAP `hmac-secret`), so the books output says nothing about the account's, and a books key that leaks
 * cannot sign. The account namespace belongs to the account layer alone: `namespaceSalt` refuses it, so no work
 * namespace can be used to read the account's PRF output.
 */

/** Mera's default namespace: its salt is `sha256("mera.prf.salt.v1")` (`@category-labs/mera` 0.2.0, documented stable). */
export const ACCOUNT_NAMESPACE = "mera.prf.salt.v1";
/** The books backup: encrypts the device's books for the passkey that holds the account. */
export const BOOKS_NAMESPACE = "paylink.books.v1";

/** The namespaces that do non-account work. Closed on purpose: a new one is a reviewed change (ADR 0016). */
export type WorkNamespace = typeof BOOKS_NAMESPACE;

const WORK_NAMESPACES: readonly string[] = [BOOKS_NAMESPACE];

/** The 32-byte PRF salt of a work namespace: `SHA-256(UTF-8(namespace))`. Refuses the account's namespace. */
export async function namespaceSalt(namespace: WorkNamespace): Promise<Uint8Array<ArrayBuffer>> {
  if (!WORK_NAMESPACES.includes(namespace)) {
    throw new Error(`${namespace} is not a PayLink work namespace`);
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(namespace)));
}
