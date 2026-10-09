# ADR 0016: Ledger backup with the passkey's second key (PRF namespace `paylink.books.v1`)

- **Status:** accepted
- **Date:** 2026-10-09
- **Deciders:** nambininasafidison (owner), Claude Code (engineering)
- **Related:** PAYLINK-V2-SPEC §2.1 (T2), §3.6, §3.9, §4.4, §5 (threat 19); invoice spec §8.6, §15; ADR 0005 (dedicated origin and rpId); ADR 0009 (read model, device store); ADR 0015 (Mera passkeys); [threat model](../security/THREAT_MODEL.md) T-19, T-51 to T-55

## Context

- The merchant's books live only on the device: the IndexedDB device store holds the invoices signed there with their memos (the chain sees only `memoHash`, invoice spec §15), the receive cards saved from Send, the address book and the receipts (ADR 0009). A lost or replaced phone loses them. The ledger's CSV export is plaintext and cannot be read back.
- In the Monad edition the passkey is the whole account layer (ADR 0015). Its account is derived from one WebAuthn PRF evaluation under Mera's default salt `sha256("mera.prf.salt.v1")`. `@category-labs/mera` 0.2.0 lets the caller pass another 32-byte salt to `getPasskeyPrfOutput` (`prfSalt`), and its secret vault (`createSecretVaultWithExistingPasskey`) draws a random salt per vault, derives AES-256-GCM with HKDF info `mera.v1.encrypt.secret` and binds the vault to the PRF output only, without additional data (**C**: package source and type declarations read on 2026-10-09).
- WebAuthn PRF hashes each salt again under the context string "WebAuthn PRF" before CTAP `hmac-secret`, and the outputs for two salts are independent pseudo-random values (**C**: W3C WebAuthn Level 3, PRF extension).
- A synced passkey brings its PRF to the other devices of its passkey manager, so the account and anything derived from the same PRF are reproducible there; Mera documents this for accounts (**L**: Mera's documentation; not yet tried by us on two physical phones).
- Mera's bounty "One Passkey, Many Keys" asks that at least one PRF namespace do non-account work (**UV**: FACTS-UPDATE, Monad submission form, 2026-10-08).
- PAYLINK-V2-SPEC §2.1 T2 fixes the shape: a second PRF evaluation with a separate salt `"paylink.books.v1"`, HKDF-SHA-256 to an AES-256-GCM key, never reusing the output that derives the signing key; the encrypted file is a download, with no server store in v2.0.
- The pay route may load at most 110 kB of gzipped JavaScript (spec §4.4). English messages ship with every page, so every string added to the catalogue is paid for by every payer. On 2026-10-09 the Monad pay route measured 109.1 kB in the production build and 109.8 kB in the end-to-end build (**C**: measured with `apps/web/scripts/build.ts`); some 36 more English strings would have broken the budget.
- Chromium's WebAuthn virtual authenticator exports a credential's private key (`WebAuthn.getCredentials`) but not its PRF secret, and a credential imported with `WebAuthn.addCredential` evaluates no PRF (**C**: checked on Chromium 141.0.7390.37 on 2026-10-09).

## Options

1. **Where the backup key comes from.**
   - **A.** Mera's secret vault: a random PRF salt per backup.
   - **B.** A fixed second namespace, `paylink.books.v1`: its salt evaluated through Mera's `getPasskeyPrfOutput({ prfSalt })`, then HKDF-SHA-256 and AES-256-GCM in WebCrypto, in a file format of our own.
   - **C.** The account's PRF output, with another HKDF info.
   - **D.** A password the merchant chooses (PBKDF2 or Argon2).
2. **Telling a wrong passkey from an altered file.**
   - **A.** The AES-GCM tag only: both read "cannot open".
   - **B.** The tag, plus a public key check derived from the namespace output.
3. **Where the panel's strings live.**
   - **A.** In the catalogue every page carries.
   - **B.** In a feature catalogue that only the ledger page loads.
4. **Restore gesture.**
   - **A.** Choosing the file starts the passkey prompt.
   - **B.** Choosing the file shows it on a display window; "Unlock and restore" starts the prompt.

## Decision

Options **1B**, **2B**, **3B** and **4B**.

1. **Two namespaces of one passkey (`apps/web/src/accounts/namespaces.ts`).** PayLink names each use of the passkey and salts it with `SHA-256(UTF-8(namespace))`, Mera's own rule: `mera.prf.salt.v1` is the account (BIP-39 → `m/44'/60'/0'/0/0` → secp256k1, ADR 0015); `paylink.books.v1` is the ledger key. The list of work namespaces is closed and `namespaceSalt` refuses the account's, so the books code can never ask for the output that derives the signing key. The ledger key is one assertion pinned to the credential the device recorded for the signed-in account (`apps/web/src/books/key.ts`, through `namespaceOutput` in the lazy Mera chunk), and an answer from any other credential is refused. It lives with the books code, not in the passkey layer, so the pay route never carries it.
2. **The file (`apps/web/src/books/envelope.ts`).** From the 32-byte output `P`, HKDF-SHA-256 (RFC 5869) derives:
   - `check = HKDF(P, salt = 32 zero bytes, info = "paylink.books.v1/check")`, 32 bytes, public: the same for every file of the passkey;
   - `K = HKDF(P, salt = 32 random bytes per file, info = "paylink.books.v1/aes-256-gcm/" ‖ CAIP-2 chain ‖ "/" ‖ EIP-55 merchant)`, an AES-256-GCM key, new for every file.

   The file is JSON: `format` `"paylink.books"`, envelope `version` 1, content `schema`, `chain` (CAIP-2), `merchant`, `createdAt`, `kdf` (namespace, hash, salt, check), `cipher` (AES-256-GCM, 12-byte random IV) and `ciphertext` (with its 128-bit tag), binary fields in canonical unpadded base64url. Every field but `ciphertext`, re-serialised in a fixed order, is the additional data, so changing the merchant, the network, the schema, the time, a salt or the IV fails authentication. The plaintext is the content as UTF-8 JSON padded with spaces to a multiple of 4 KiB. A restore checks the key first: a different `check` is "not made with your passkey" (`BooksWrongKey`), a failed tag is "changed after it was made" (`BooksTampered`).
3. **Never stored.** The PRF output is copied into WebCrypto and wiped; every key is a non-extractable `CryptoKey` with one usage that lives for one call; nothing is written to `localStorage`, `sessionStorage` or IndexedDB but the restored records. The JSON text of the books is a JavaScript string and cannot be wiped (the same limit as the mnemonic in ADR 0015).
4. **Content (`apps/web/src/books/content.ts`).** For one merchant on one network: the invoices the merchant signed on the device (memos included) and the receive cards saved from Send, the receipts of payments the merchant made or received, and the address book (entries whose card is for another network excepted). Outstanding EIP-3009 authorisations are a payer's in-flight state tied to the device that signed them (invoice spec §8.6) and are never exported. Content schema 1 (invoices and receipts, as spec §2.1 T2 listed the books) and schema 2 (adds the address book) are both defined; the writer writes 2; the reader upgrades 1 step by step and refuses a newer envelope or schema as "made by a newer PayLink" before any prompt. No schema-1 file was written by a released build: the upgrade path exists so that it is exercised from the first release.
5. **Restore.** Strict parsing (exact fields, canonical encodings, 8 MiB and 50,000 records per list at most) → a network of this edition → the merchant is the signed-in account (`BooksOtherAccount` otherwise, before any prompt) → one fingerprint → key check → authenticated decryption → schema upgrade → every record through the device store's own checks (`parseStoredInvoice` against the registry: canonical deployment, allowlisted token, memo against `memoHash`, key recomputed; `parseStoredReceipt`; `parseStoredContact`) and the file's scope, and the merchant's own invoices through an ECDSA check of the merchant's signature over their key (a passkey account is an EOA; saved cards are checked by the pay view's lamps when used, like any card) → an idempotent merge that never deletes and never replaces an invoice or a receipt (their IDs are their content: the EIP-712 digest, the chain log); an address-book entry is replaced only by a newer one. Restored records are device records like any other: the ledger reads every state from the chain (ADR 0009).
6. **Strings (3B).** `@paylink/i18n` gains feature catalogues (`packages/i18n/src/locales/<feature>.<locale>.json`, a closed list, the first is `books`): generated types and the completeness gate cover them; each is a chunk of its own in every language, loaded by `featureTranslator` on the pages that use it. The Monad pay route stays at 109.1 kB (production); the panel's 36 strings are not in it.
7. **UI (`apps/web/src/books/panel.ts`).** Under the ledger, in the Monad edition only (the build constant drops it from the others): a display window that names the ledger key, its namespace, what it locks and what it is bound to, then "Back up my ledger" and "Restore from a file"; a chosen file is shown on its own window before "Unlock and restore" (4B: Safari wants a fresh gesture for a passkey prompt, and choosing a file is not one, **L**). EN, FR and MG; the Malagasy strings await the founder's review (`mg.review.json`).

## Consequences

- Good, because the same passkey does two unrelated jobs with two unrelated keys: the ledger key cannot sign, and code that unlocks a backup never holds the account's PRF output.
- Good, because the backup is end-to-end encrypted, authenticated with its context, and opens on any device the passkey reaches, with no server and no password.
- Good, because a restored record passes the checks a record read from IndexedDB passes, and more (the merchant's signature on the merchant's invoices), and a backup can add to the books but never remove from them.
- Good, because feature catalogues let payee-only features grow without taxing payers, which other T1 work can reuse.
- Bad, because the clear header tells whoever holds the file the merchant's address (public on chain anyway), the network, when the file was made, its size to within 4 KiB, and a key check that links the files of one passkey.
- Bad, because losing the passkey makes every backup unreadable, by design (threat T-19): the backup protects the books, not the keys.
- Bad, because a new device asks for two fingerprints: one to sign in (account namespace), one to unlock (ledger namespace). WebAuthn could evaluate both salts in one assertion, but Mera's API evaluates one, and Mera stays the only code that talks to WebAuthn.
- Neutral: AES-GCM is not key-committing; that matters when one party knows two keys for one ciphertext, which a single-passkey backup does not involve.
- Neutral: the end-to-end test reaches one authenticator from two browser contexts (`e2e/fixtures/hybrid.ts`, the shape of WebAuthn's cross-device sign-in), because the virtual authenticator cannot copy a PRF secret. Restoring on a second physical phone with a synced passkey is a manual check for the demo runbook.

## Confirmation

- `apps/web/test/books.test.ts`: the namespace salt and the closed list; WebCrypto's HKDF and AES-GCM against RFC 5869 test case 1 and the GCM specification's test case 16; two backup files written byte for byte as an independent implementation writes them (`apps/web/test/vectors/books-vectors.py`, RFC 5869 in plain Python and pyca/cryptography) and opened by the app and by `node:crypto`; padding; wiped PRF outputs and non-extractable keys; another passkey refused before decryption; one changed byte anywhere, and each header field changed, refused; strict parsing and newer files; schema 1 to 2; scope, validation (a forged memo, another signature, another merchant, another network) and the idempotent merge; the ledger key pinned to the device's credential; the panel in the DOM (back up on one device, restore on another with the same passkey, other account, edited merchant, tampering, empty books, EN/FR/MG).
- `packages/i18n/test/completeness.test.ts`: feature catalogues have exactly the English keys in every language, only their own prefix, and are in the generated types.
- `e2e/specs/books.spec.ts`: on the Monad production build, Chromium's virtual authenticator with PRF: device A backs up two invoices; the test asks A's authenticator for both namespaces and decrypts the file with `node:crypto` from the books output only; neither output nor the AES key is in either device's storage; device B (another browser profile, empty) signs in with the same passkey through the cross-device bridge, refuses an altered copy and restores the file, and its ledger shows both memos; device C (another passkey) is refused before any prompt, and an edited copy stays locked after its fingerprint; axe-core zero violations and no sideways scroll at 390 px in dark.
- The pay-route budget gate (`apps/web/scripts/build.ts`): the Monad pay route is unchanged by this feature.
