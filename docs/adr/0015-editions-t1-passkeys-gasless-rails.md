# ADR 0015: Editions at T1: Mera passkeys, gasless rails and "Pay with Base"

- **Status:** accepted
- **Date:** 2026-10-08
- **Deciders:** nambininasafidison (owner), Claude Code (engineering)
- **Related:** PAYLINK-V2-SPEC §2.1, §2.2, §3.5, §3.6, §3.7, §3.8, §3.11, §5; invoice spec §8.3, §8.6; ADR 0003 (bound nonce); ADR 0005 (dedicated origin and rpId); ADR 0007 (relayer); ADR 0008 (editions); ADR 0014 (web app)

## Context

- Tier T1 of the Monad edition (spec §2.1) asks for Mera passkeys as the **only** account layer for merchant and payer, gasless AUSD through EIP-3009 and the relayer, testnet onboarding through the relayer's faucet call, gasless cancel, the receive card and Send, the till, EN/FR/MG, an MGA estimate (display only) and an installable PWA. Tier T1 of the Base edition (spec §2.2) asks for gasless USDC through the relayer for EOAs, and "Pay with Base" (EIP-5792 `wallet_sendCalls([approve, pay])`) for smart-account payers only.
- ADR 0014 left three extension points for this: `AccountLayer`, `defaultToken` and `PaymentRail`.
- `@category-labs/mera` 0.2.0 (preview, MIT OR Apache-2.0, npm provenance) is reachable and its source was read (**C**): it gives `createPasskeyWithPrfOutput`, `getPasskeyPrfOutput` (user verification required, default PRF salt `sha256("mera.prf.salt.v1")`), signing sessions that zero their key on `end()`, and `toViemAccount`. Account derivation is left to the application; Mera's documentation recipe is BIP-39 from the PRF output, then BIP-32/BIP-44 `m/44'/60'/0'/0/0` (**C**, mera.category.xyz "Create passkey accounts").
- The Mera passkey demo works on the owner's phone (**UV**, FACTS 2026-10-07). The production origin and rpId are `paylink-mg.pages.dev`; `<branch>.paylink-mg.pages.dev` previews exist on Pages (**UV**).
- PayLinkV2 is deployed and recorded on Monad testnet and Base Sepolia (`protocol/deployments/10143.json`, `84532.json`, 2026-10-08); Arbitrum Sepolia is not, and the app says so ("Not deployed yet", with a link to the deploy kit).
- `@base-org/account` 2.5.13 (pinned in the catalogue for this purpose) pulls `@coinbase/cdp-sdk` (with `@solana/kit`, axios, jose and a second zod), `brotli-wasm` and preact; it injects an inline telemetry script unless told not to, opens a popup that needs `Cross-Origin-Opener-Policy: same-origin-allow-popups`, and calls Coinbase endpoints (**C**, package read on 2026-10-08).

## Options

1. **Passkey keys.**
   - **A.** Derive once and keep the key (or the session) in memory for the page's life.
   - **B.** One passkey assertion per signature: assert, derive, check, sign, end the session, wipe.
   - **C.** Encrypt a generated key with the PRF output and store it (a Mera secret vault).
2. **Pay with Base.**
   - **A.** Bundle `@base-org/account` as a lazy chunk in the Base edition.
   - **B.** The standard EIP-5792 calls on the EIP-6963 provider the payer already chose (the Base app's browser, the Coinbase Wallet extension in smart-wallet mode, any wallet that reports `atomic: supported`).
3. **Relayer endpoint.**
   - **A.** Leave `/config.json` without a relayer until the Worker passes its smoke test.
   - **B.** Name the production Worker now; the app asks its health and falls back when it does not answer.

## Decision

Options **1B**, **2B** and **3B**.

1. **Passkey layer (`apps/web/src/accounts/passkey.ts`, `mera.ts`).**
   - Derivation exactly as Mera documents it (BIP-39 → seed → `m/44'/60'/0'/0/0`), with Mera's default PRF salt. A unit test checks the account against viem's own BIP-39/BIP-32 implementation, so two independent code paths agree on what a passkey derives.
   - The device stores public facts only (credential ID and transports, the derived address, a label), validated on every read. Every page knows the account without a prompt; **each signature costs one fingerprint** and the key exists only for that signature (Mera's session is ended, the PRF output, seed and key buffers this code owns are zeroed; the mnemonic string cannot be).
   - A derived address that differs from the one the device expects is refused (`other-key`), so a second passkey on the same phone cannot sign in the first one's name.
   - **The rpId is fixed at build time** (`paylink-mg.pages.dev`) and ceremonies run only on that exact host: a preview deployment, which WebAuthn would let assert the same rpId, never offers or uses a PayLink key from this code. Local and end-to-end builds use the page's own host. Disabling previews in Pages (runbook) remains the control against a malicious preview build.
   - Mera and the BIP-39/BIP-32 code are a separate chunk, loaded only in the Monad edition and only when a ceremony runs (`/monad/pay/` stays within the 110 kB budget). The KeyCard is a lazy chunk too.
   - A passkey account holds no gas in the normal flow. When it does, it signs its own EIP-1559 transactions (explicit gas limit, fees from the registry RPC) and broadcasts them through the registry RPC.
   - Every page that signs shows the **signing display** first (amount, recipient grouped by four with any saved name, network, validity, who pays the fee), because a passkey shows no wallet popup.
2. **Rails (`apps/web/src/rails/`).** The SDK's PaymentRouter decides; rails only execute.
   - `relayed-authorization` and `self-authorization` share one implementation of invoice spec §8.6: the stored authorisation for (chain, invoice, payer) is parsed against the registry and assessed on chain before anything is signed; a live one is resubmitted, never re-signed (and refused if the payer now asks for another amount); a used one is "already paid"; a new one is persisted before it is sent. Settlement is followed on the chain: the relayer's hash, then the token's `authorizationState` and the `Paid(key, payee, payer)` log, because the relayer may replace its transaction.
   - `batched-approve-pay` sends exactly `[approve(amount), pay]` with `atomicRequired: true` and reads the `Paid` log from the registry RPC.
   - The payer's account kind for the router: `passkey`; `smart-account` when the address has code **or** its wallet reports `atomic: supported` (an undeployed smart account has no code, and its EIP-3009 signature could not be checked by the token); `eoa` otherwise.
   - Editions: Monad = relayed, own-gas, wallet; Base = relayed, batch, own-gas, wallet; `all` = relayed, wallet (so with the relayer down the root behaves exactly as at T0).
3. **Gasless cancel.** The payee signs `Cancel(key, deadline = now + 1 h)`; the relayer submits `cancelBySig`; the ledger waits for `stateOf(key).cancelled` on the chain. Without a relayer for the chain, or on a refusal with `self-submit`, a payee holding gas sends `cancel`.
4. **Onboarding.** On Monad testnet the payer view and the KeyCard offer "Get 10,000 test AUSD": `POST /v1/10143/onboard`, then the faucet's transaction is followed to its receipt. Elsewhere the edition links to the issuer's faucet page (Base: Circle's).
5. **MGA estimate.** `apps/web/public/fx.json` is a snapshot of `fawazahmed0/exchange-api` (CC0-1.0, keyless), fetched from the npm registry by `apps/web/scripts/fx.ts` with the tarball's SHA-512 integrity checked. The app reads it same-origin, labels every estimate "≈ … Ar · estimate · rate of <date>" with the source on hover, multiplies in integers, and shows it only for dollar tokens. It never enters an amount, a signature or a comparison.
6. **Pay with Base (2B).** No third-party SDK on the origin that holds the passkey edition: EIP-5792 over EIP-6963 covers the Base app's in-app browser and the Coinbase Wallet extension, needs no CSP, COOP or Trusted Types exception, and adds no package. The Base Account popup (keys.coinbase.com) is therefore **not** offered from a desktop browser without a smart-wallet extension; adding it later is one more `AccountLayer` behind the same interface, and would need `Cross-Origin-Opener-Policy: same-origin-allow-popups` and a `connect-src` entry for the Base edition only, with `telemetry: false`.
7. **Relayer endpoint (3B).** `/config.json` names `https://paylink-relayer.raherizonambinina.workers.dev` for 10143, 84532 and 421614, and the CSP allows it. Until the Worker is live, `GET /v1/health` fails, the router treats the relayer as down, and the payer views say so ("the fee service is not answering"); nothing else changes.

## Consequences

- Good, because the Monad edition meets the bounty wording (Mera only, no injected wallet) and keeps every guarantee of the other editions: the same registry, signing display, retry safety and receipt verification.
- Good, because a passkey key is in memory only for the duration of one signature, and a preview build cannot use the production key.
- Good, because "Pay with Base" adds no dependency and no policy exception on the passkey origin.
- Bad, because every signature asks for a fingerprint (one for an invoice, one for a payment, one for a cancel); there is no session of several signatures.
- Bad, because desktop payers without the Base app or a smart-wallet extension do not get the Base Account popup; they pay with their EOA, gaslessly.
- Bad, because the faucet's single global cooldown (60 s) is shared by every tester through the relayer.
- Neutral: Mera is a 0.2.0 preview; its API is pinned and wrapped in one module.

## Confirmation

- `apps/web/test/passkey.test.ts` (derivation against viem, one assertion per signature, other-key refusal, stored record validation, rpId pin, local transactions), `rails-t1.test.ts` (persist before relay, resubmit without re-signing, consumed, relayer refusals, settlement through logs, own-gas, batch, router inputs), `relayer.test.ts` (strict parsing, problems, health cache, ariary arithmetic).
- `e2e/specs/editions.spec.ts`: on the production build with its headers, two anvil chains, the relayer process and Chromium's WebAuthn virtual authenticator with PRF: two PayLink keys, onboarding, a gasless fingerprint payment with the payer at 0 MON, the till lighting, a gasless cancel, a receive card paid by a contact, Base gasless USDC (one signature, no transaction) and "Pay with Base" (one `wallet_sendCalls`), axe in dark on a phone.
