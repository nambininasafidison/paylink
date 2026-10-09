<!--
  The repository's landing page. GitHub shows .github/README.md ahead of the root README.md, which is PayLink v1's
  and stays byte-identical (ADR 0010). Checked by docs/tools/check-docs.py (links, paths, addresses, the landing rules).
-->

<p align="center"><img src="../docs/submissions/assets/logo-512.png" alt="PayLink mark" width="96" height="96"></p>

# PayLink

**Signed dollar invoices you share as a link. The client pays with a fingerprint or a wallet and holds no gas token; both sides keep a receipt anyone can verify.**

> **Testnets only, not audited.** PayLinkV2 runs on Monad testnet and Base Sepolia. It has had our own review (tests, coverage, mutation testing, static analysis), not a third-party audit ([evidence](../protocol/audit/README.md)). Do not use it with real funds.

| | |
|---|---|
| **Monad edition** | <https://paylink-mg.pages.dev/monad/>: Mera passkeys as the only account layer, gasless AUSD, Monad testnet (10143) |
| **Base edition** | <https://paylink-mg.pages.dev/base/>: browser wallets, gasless USDC, "Pay with Base" batches, Base Sepolia (84532) |
| **All networks** | <https://paylink-mg.pages.dev/>: every enabled network in the registry, browser wallets |
| **Contract** | `0x448eCce9711860502806A3d5B021a4f9Ba715082`, the same address on both testnets ([below](#the-contract)) |
| **Open standard** | [PayLink invoice format v2](../docs/spec/paylink-invoice-v2.md), with a [JSON Schema](../docs/spec/paylink-invoice-v2.schema.json) and test vectors |
| **Licence** | MIT ([LICENSE](../LICENSE)) |

Each edition's **Status** page (footer, under "System") shows the build it serves, checks the contract on chain, and says whether the relayer and the history service answer right now.

## Contents

1. [The problem and who it is for](#the-problem-and-who-it-is-for)
2. [What a user does](#what-a-user-does)
3. [The contract](#the-contract)
4. [Architecture](#architecture)
5. [Repository layout](#repository-layout)
6. [Run it yourself](#run-it-yourself)
7. [What existed before, and what was built for these events](#what-existed-before-and-what-was-built-for-these-events)
8. [Status and limits](#status-and-limits)
9. [AI use, attributions, licence, security](#ai-use-attributions-licence-security)

## The problem and who it is for

PayLink is built in Antananarivo for people in Madagascar who are paid from abroad: freelancers, small merchants, and the clients and relatives who pay them.

Our working hypothesis is that being paid from abroad is slow, costly or uncertain for them, and that the person asking for the money does most of the chasing. We think a link that the payer opens on a phone, with nothing to install and no gas token to buy, removes most of the friction on the paying side. We are testing this in structured, consented interviews ([protocol](../docs/research/interview-script.md)). **We claim no results yet: PayLink has no users, revenue or partners today.**

The flow every edition is built around:

> A Malagasy freelancer sends a dollar invoice on WhatsApp. The client abroad opens it and pays with a fingerprint, holding no gas token. The freelancer's till lights up when the payment lands. Both sides keep a receipt anyone can verify.

## What a user does

1. **Sign an invoice.** The payee types an amount and a memo. A signing display shows exactly what will be signed (amount, address grouped by four, network, expiry), then one EIP-712 signature makes the invoice: no transaction, no gas, and it works offline. A link, a QR card that prints on A6, WhatsApp and the share sheet are ready at once.
2. **Pay.** The payer opens the link. Four lamps are read from the chain before the Pay key unlocks: the signature is valid, the network is right, the contract is the genuine release (registry address, masked code hash, EIP-712 immutables), and the invoice is still payable. The payer signs one EIP-3009 authorisation and the relayer submits it; the token nonce is derived on chain from the invoice, so the relayer can delay a payment but never redirect it. A smart-account payer on Base approves one EIP-5792 batch instead.
3. **Get paid.** The receipt is verified on chain before the screen says "Approved". The payee's till lights and chimes only for a verified payment of the armed invoice at its exact amount. The ledger reads every invoice's state from the contract, lists payments received, exports CSV and cancels an invoice with one signature and no gas (through the relayer; or one `cancel` transaction).
4. **Send and receive.** Every account has a receive card (an open-amount link with a QR code); saved contacts are paid in two taps.
5. **Keep the books** (Monad edition). A second PRF namespace of the same passkey encrypts the payee's books into a backup file only that passkey can open ([ADR 0016](../docs/adr/0016-ledger-backup-second-prf-namespace.md)).

The app is in English, French and Malagasy (the founder reviews the Malagasy), is an installable PWA, and is tested at phone widths from 320 px.

| Edition | Accounts | Default token and rail | Judge's tour |
|---|---|---|---|
| Monad (`/monad/`) | Mera passkeys only: no wallet extension, no seed phrase, no MON | AUSD, gasless through the relayer; test AUSD from Agora's faucet through the relayer | [Monad pack §4](../docs/submissions/monad.md#4-judge-access-instructions) |
| Base (`/base/`) | Browser wallets (EIP-6963) | USDC: gasless for EOA payers, one batch for smart accounts ("Pay with Base" in the Base app or Coinbase Wallet) | [Colosseum pack §8](../docs/submissions/colosseum.md#8-how-a-judge-can-try-it) |
| All networks (`/`) | Browser wallets | Every route the registry allows, including paying with your own gas | — |

## The contract

`PayLinkV2` 2.0.0 ([source](../protocol/src/PayLinkV2.sol)): Solidity 0.8.30, OpenZeppelin Contracts 5.3.0, `paris` bytecode. Immutable, ownerless and fee-less ([ADR 0004](../docs/adr/0004-immutable-ownerless-feeless.md)); it never keeps funds. Deployed through the CREATE2 factory with the salt preimage `paylink.v2.0.0`, so the address is the same on every network.

| Network | Address | Deployment transaction | Block | Record |
|---|---|---|---|---|
| Monad testnet (10143) | [`0x448eCce9711860502806A3d5B021a4f9Ba715082`](https://testnet.monadvision.com/address/0x448eCce9711860502806A3d5B021a4f9Ba715082) | [`0xb86e7536…cb4d6a`](https://testnet.monadvision.com/tx/0xb86e75367a73e933f3c99a6092357f4b785bf7fdd2c4b299c193e4f903cb4d6a) (CREATE2, sent directly) | 69331735 | [`10143.json`](../protocol/deployments/10143.json) |
| Base Sepolia (84532) | [`0x448eCce9711860502806A3d5B021a4f9Ba715082`](https://sepolia.basescan.org/address/0x448eCce9711860502806A3d5B021a4f9Ba715082) | [`0x2969321d…86b5ed`](https://sepolia.basescan.org/tx/0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed) (CREATE2 reached in a relayed EIP-7702 transaction) | 47859253 | [`84532.json`](../protocol/deployments/84532.json) |

Full hashes: Monad testnet `0xb86e75367a73e933f3c99a6092357f4b785bf7fdd2c4b299c193e4f903cb4d6a`; Base Sepolia `0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed`. Anyone can re-check a deployment against the release (code, masked hash, immutables, EIP-712 domain) with `tools/verify-deployment` ([deployments README](../protocol/deployments/README.md)). The contract source is not yet verified on the block explorers.

## Architecture

```text
 payee (PWA)  ── signed invoice as a link or QR (WhatsApp) ──▶  payer (PWA)
     │  till, ledger: statesOf, Paid logs                         │ EIP-3009 authorisation (passkey or wallet)
     ▼                                                            ▼
 PayLinkV2 (immutable, no owner) ◀── payWithAuthorization ── relayer (Cloudflare Worker,
 Monad testnet · Base Sepolia                                  one Durable Object per chain)
     │  Paid, InvoiceCancelled
     ▼
 history indexer (Envio HyperIndex): a cache for the ledger's history; never trusted for a payment state
```

| Component | Where | What it does | Trusted for |
|---|---|---|---|
| Contract | `protocol/` | Verifies payee signatures, enforces invoice rules, settles without custody | Correctness and settlement |
| SDK | `packages/sdk` | Invoice codec and signing, strict URL format, payment binding, payment router, receipt verification | Reproducing the contract's rules off chain |
| Chain registry | `packages/chains` | Every address, token, RPC and gas bound per network, EIP-55 checked | The app's root of trust for addresses |
| Web app | `apps/web` | Vite and strict TypeScript without a UI framework, PWA, three editions from one codebase, served by Cloudflare Pages with a strict CSP and Trusted Types | Showing exactly what is signed |
| Relayer | `apps/relayer` | Submits only `payWithAuthorization` and `cancelBySig`, simulates first, rate-limits, never sends value | Availability only: it can delay a payment, never redirect it |
| Indexer | `apps/indexer` | Payment history, payee totals and statistics from `Paid` and `InvoiceCancelled` | Nothing authoritative: a cache |
| Design, translations | `packages/design`, `packages/i18n` | v1's "Precision Terminal" design; EN, FR, MG | Presentation |
| End-to-end tests | `e2e/` | Playwright on the production build against anvil chains, the relayer process and a WebAuthn virtual authenticator with PRF | Evidence |

More: [architecture](../docs/ARCHITECTURE.md) (data flows, trust boundaries, failure modes), [decision records](../docs/adr/README.md), [threat model](../docs/security/THREAT_MODEL.md), [documentation index](../docs/README.md).

## Repository layout

| Path | What it holds |
|---|---|
| `protocol/` | PayLinkV2, its Foundry tests (unit, fuzz, invariants, regressions from our own reviews), deployment scripts and records, and the review evidence (`protocol/audit/`) |
| `packages/` | `sdk`, `chains`, `design`, `i18n`, `eslint-config` |
| `apps/` | `web` (the site), `relayer` (gasless submission), `indexer` (history) |
| `e2e/` | Playwright suites and fixtures |
| `tools/` | `deploy-page` (the browser deploy kit served at `/deploy/`), `verify-deployment` |
| `docs/` | Architecture, ADRs, the invoice specification, security, runbooks, research protocol, submission packs |
| `contracts/`, `web/` (except `web/v2/`, the deploy kit), `scripts/compile.js`, `scripts/deploy.js`, `test/`, `verify/`, the root `package.json` and `README.md` | **PayLink v1**, kept byte for byte as it was ([ADR 0010](../docs/adr/0010-arc-stays-on-v1.md)); `npm test` runs its 7 tests |

## Run it yourself

Prerequisites: Node 22.22.0 (`.nvmrc`), pnpm 10.28.0, and Foundry 1.8.5 for the contract ([CONTRIBUTING §2](../CONTRIBUTING.md#2-setting-up)).

```bash
git clone https://github.com/nambininasafidison/paylink && cd paylink
pnpm install --frozen-lockfile

# Contract: build and test (OpenZeppelin comes from pnpm, forge-std is vendored)
(cd protocol && forge build --sizes && forge test)

# TypeScript packages and apps: lint, types, unit tests
pnpm -r --filter '!@paylink/protocol' run lint
pnpm -r --filter '!@paylink/protocol' run typecheck
pnpm -r --filter '!@paylink/protocol' run test

# The web app
pnpm --filter @paylink/web dev        # Vite dev server
pnpm --filter @paylink/web build      # the whole site into apps/web/dist, as Cloudflare Pages builds it

# End to end: anvil from Foundry, and Playwright's Chromium (installed once)
pnpm --filter @paylink/e2e exec playwright install chromium
pnpm --filter @paylink/e2e test

# Documentation checks, and v1's own tests
python3 docs/tools/check-docs.py
npm test
```

Putting the services online: [Cloudflare Pages](../docs/runbooks/cloudflare-pages.md), [relayer](../docs/runbooks/relayer.md), [indexer](../docs/runbooks/envio.md), [contract deployment](../docs/runbooks/deploy.md). No key or secret is in this repository; the relayer's key exists only as a Cloudflare secret.

## What existed before, and what was built for these events

| | Commits | What |
|---|---|---|
| **Pre-existing: PayLink v1** | `31a4fdd` (2026-10-04) and `93ed4e3` (2026-10-05) | A simpler payment-link contract and web app for Arc (`contracts/PayLink.sol`, `web/`). Frozen and not part of the v2 editions ([ADR 0010](../docs/adr/0010-arc-stays-on-v1.md)). Its own README, at the repository root, describes the Arc Microgrants plan: as of 2026-10-09 v1 is **not** deployed on Arc mainnet (`web/config.js` has no address) |
| **Built for Monad Metropolis and Colosseum: PayLink v2** | from `88ac2d9` (2026-10-07, the first v2 commit; the design work started on Oct 5) | The PayLinkV2 contract and its tests, the SDK and chain registry, the web app and its Monad and Base editions (Mera passkeys, gasless rails, till, receive card and Send, ledger backup), the relayer, the indexer, the deploy kit, the end-to-end suites, the open invoice specification and the documentation |

The submission texts, with their disclosures, are in [docs/submissions/](../docs/submissions/README.md).

## Status and limits

- **Testnets only.** Monad mainnet (143) is in the registry but disabled; there is no mainnet deployment.
- **Not audited.** Our own review only: 100 % line and branch coverage of the contract, 63 of 63 hand-written mutants killed, Slither with no untriaged result, invariants I1 to I11 ([evidence](../protocol/audit/README.md), [self-review](../docs/security/self-review.md)).
- **Services.** Gasless payments, test AUSD and gasless cancel need the relayer online; the ledger's full history needs the indexer. Without the indexer, the ledger reads the chain's latest blocks and says so. Each edition's Status page shows whether they answer.
- **No users yet.** PayLink has no users, revenue or partners; demand is a hypothesis under test.
- **Cash-out and regulation.** PayLink does not convert dollars to ariary, and payment and foreign-exchange rules in Madagascar need a legal review before any mainnet launch.

## AI use, attributions, licence, security

- **AI use.** Claude Code (Anthropic) did much of the engineering and documentation under the founder's direction; the founder decides, reviews, holds every key and makes every submission. Commits made with it carry a `Co-Authored-By: Claude` trailer. Details and limits: [AI_DISCLOSURE.md](../AI_DISCLOSURE.md).
- **Third-party components.** OpenZeppelin Contracts, viem, `@category-labs/mera`, Hono, zod, idb, qrcode-generator, Envio HyperIndex (not open source; used for the indexer only), the Archivo and Martian Mono fonts (OFL), each under its own licence: [NOTICE.md](../NOTICE.md).
- **Licence.** MIT, © 2026 nambininasafidison ([LICENSE](../LICENSE)).
- **Security.** Report vulnerabilities privately as [SECURITY.md](../SECURITY.md) explains, never in a public issue.
- **Contributing.** [CONTRIBUTING.md](../CONTRIBUTING.md); changes are listed in [CHANGELOG.md](../CHANGELOG.md).
