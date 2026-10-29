<!--
  The repository's landing page. GitHub shows .github/README.md ahead of the root README.md, which is PayLink v1's
  and stays byte-identical (ADR 0010). Checked by docs/tools/check-docs.py (links, paths, addresses, the landing rules).
-->

<p align="center"><img src="../docs/submissions/assets/logo-512.png" alt="PayLink mark" width="96" height="96"></p>

# PayLink Twin

**One signed invoice, two rails: PayPal, and dollars on chain (USDC, or PayPal USD). An AI collections desk keeps both rails in agreement and proposes the next step; it never signs and never moves money.**

This branch, `paypal`, is PayLink's entry to the PayPal AI Hackathon: the PayPal edition of PayLink, served at <https://paypal.paylink-mg.pages.dev/paypal/> once its preview is online ([judges' tour](#judges-tour), [submission pack](../docs/submissions/paypal.md)).

> **Sandbox and testnet only, not audited.** The PayPal edition uses the PayPal sandbox and Ethereum Sepolia (11155111), where PayLinkV2 is deployed since 2026-10-29 ([below](#the-contract)). PayLinkV2 also runs on Monad testnet, Base Sepolia and Mezo testnet (the Mezo edition, on the branch `mezo`). It has had our own review (tests, coverage, mutation testing, static analysis), not a third-party audit ([evidence](../protocol/audit/README.md)). Do not use it with real funds.

## Contents

1. [PayPal edition (PayLink Twin)](#paypal-edition-paylink-twin), with the [judges' tour](#judges-tour)
2. [PayLink, the project](#paylink-the-project)
3. [The problem and who it is for](#the-problem-and-who-it-is-for)
4. [What a user does](#what-a-user-does)
5. [The contract](#the-contract)
6. [Architecture](#architecture)
7. [Repository layout](#repository-layout)
8. [Run it yourself](#run-it-yourself)
9. [What existed before, and what was built for these events](#what-existed-before-and-what-was-built-for-these-events)
10. [Status and limits](#status-and-limits)
11. [AI use, attributions, licence, security](#ai-use-attributions-licence-security)

## PayPal edition (PayLink Twin)

**One invoice, two rails: PayPal (a twin PayPal invoice, sandbox) and dollars on chain (USDC, or PayPal USD, on Ethereum Sepolia); and an AI collections desk that never touches the money.** Built for the PayPal AI Hackathon on this branch, `paypal` ([ADR 0018](../docs/adr/0018-paypal-edition.md), [specification](../docs/paypal/SPEC.md), [submission pack](../docs/submissions/paypal.md)). The demo pays the on-chain rail in Circle's USDC; PayPal USD is supported and paid only on fork rehearsals, since no test PYUSD could be obtained.

> **Sandbox and testnet only; not fully live yet.** It runs on the PayPal sandbox and Ethereum Sepolia, where the owner deployed PayLinkV2 on 2026-10-29 ([runbook §9](../docs/runbooks/paypal.md#9-paylinkv2-on-ethereum-sepolia), [transaction](https://sepolia.etherscan.io/tx/0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3)), so invoices can be signed and paid there; the Pages preview, the API Worker and its PayPal webhook go online with the owner's steps in the same [runbook](../docs/runbooks/paypal.md). PayPal's sandbox could not be reached from the development environment: the PayPal integration is built against PayPal's OpenAPI files and a contract-tested fake, and every sandbox behaviour not yet observed is marked UNVERIFIED ([runbook §5](../docs/runbooks/paypal.md#5-what-the-capture-decides)).

### Judges' tour

The full instructions, with the sandbox buyer logins, are in the hackathon's testing instructions on Devpost (logins are never in this repository).

1. **Status first.** <https://paypal.paylink-mg.pages.dev/paypal/status/>: the PayLink API, the PayPal sandbox, the last verified webhook, the assistant with today's neurons left, the contract.
2. **PayPal only, no wallet.** Open a judge link from the testing instructions, press **Pay with PayPal**, pay on PayPal's sandbox page as your sandbox buyer, open the link again: "PayPal says this invoice is paid."
3. **The whole flow, with a browser wallet on Sepolia.** On `/paypal/`: **Assistant**, paste "Love it! Send me the invoice, $12, I'll pay by Friday", **Draft** (the wallet connects and signs a desk session: one signature, no transaction), check, **Use draft**, **Review and sign** (the invoice: one signature, no transaction); in "PayPal twin", first under the signed invoice, **Make the PayPal twin**; open the link in another profile and pay with PayPal or in USDC; back on **Desk**, **Check my invoices**: approve the proposal on its exact values; try **Undo** on an automatic record and **Was I really paid?** with a made-up payment notice.
4. **No account at all.** The two rails end to end on your machine, against a fork of Ethereum Sepolia and the PayPal fake: `pnpm --filter @paylink/e2e test specs/paypal-rails.spec.ts` (after the setup of [Run it yourself](#run-it-yourself)). Case (c) drives a model that obeys every injected instruction through the real desk: only the fence's own proposals survive.

AI in the product: Cloudflare Workers AI (`@cf/google/gemma-4-26b-a4b-it`, fallback `@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Development assisted by Claude Code (Anthropic); the owner directed, reviewed and is responsible for the work.

### How it works

| What | How |
|---|---|
| **Twin** | After the payee signs a PayLink invoice, one tap creates a PayPal Invoicing v2 invoice for the same amount with the link's key in PayPal's `reference`, shares it, and reads it back from PayPal (`apps/api/src/paypal/twin.ts`) |
| **Two rails** | The pay page offers **Pay with PayPal** (PayPal's hosted invoice page) only when PayPal's amount equals the signed amount and the page is on a host pinned in the code, next to paying in USDC or PayPal USD from the payer's wallet (`apps/web/src/editions/paypal/rails.ts`) |
| **Truth** | A webhook is verified with PayPal (`verify-webhook-signature`) and only triggers PayPal's `GET` of the invoice; a chain payment counts only as a verified `Paid` event at the exact amount. The till lights "via PAYPAL · verified with PayPal" or for the chain |
| **Desk** | A deterministic table of ten situations per invoice decides what may happen next, with exact values: paid on PayPal → cancel the PayLink link (the payee taps, then signs in their wallet); paid on chain → recorded on the PayPal invoice automatically, Undo for 24 hours; overdue → PayPal's reminder or a message to share; paid twice → an alert, never an automatic refund ([reconciler](../apps/api/src/reconciler/README.md)) |
| **Assistant** | Cloudflare Workers AI drafts an invoice from a client's message (code parses every number) and words the desk's proposals; it can only propose inside the fence, never sign, never call a PayPal write, never see a memo or a PayPal note ([invariants AI-1 to AI-7](../apps/api/evals/README.md#the-invariants-and-the-test-of-each)) |
| **API** | `apps/api`: a Cloudflare Worker (Hono, zod, Durable Objects, one cron a minute, the Workers AI binding) with a Node entry for tests and an offline demo ([README](../apps/api/README.md)) |

## PayLink, the project

**Signed dollar invoices you share as a link; both sides keep a receipt anyone can verify.** In the Monad and Base editions the client pays with a fingerprint or a wallet and holds no gas token (a relayer submits the payment); in the PayPal edition the client pays on PayPal, or from their own wallet with their own Sepolia gas (no passkeys, no relayer: decision D-SCOPE of the [specification](../docs/paypal/SPEC.md#d-scope-what-is-kept-and-what-is-cut)).

| | |
|---|---|
| **Monad edition** | <https://paylink-mg.pages.dev/monad/>: Mera passkeys as the only account layer, gasless AUSD, Monad testnet (10143) |
| **Base edition** | <https://paylink-mg.pages.dev/base/>: browser wallets, gasless USDC, "Pay with Base" batches, Base Sepolia (84532) |
| **All networks** | <https://paylink-mg.pages.dev/>: every enabled network in the registry, browser wallets |
| **Mezo edition** | On the branch [`mezo`](https://github.com/nambininasafidison/paylink/tree/mezo), served at <https://mezo.paylink-mg.pages.dev/mezo/>: browser wallets, MUSD (the Bitcoin-backed dollar) on Mezo testnet (31611). PayLinkV2 is deployed there at the same address since 2026-10-16 ([transaction](https://explorer.test.mezo.org/tx/0x1662fb5126d7582947cc77ba2f96266c4f1a561c0e1761f7e4c6249e19e1165e)) |
| **PayPal edition (PayLink Twin)** | On this branch [`paypal`](https://github.com/nambininasafidison/paylink/tree/paypal), to be served at <https://paypal.paylink-mg.pages.dev/paypal/>: one signed invoice payable on PayPal (a twin PayPal invoice, sandbox) or in USDC on Ethereum Sepolia (11155111), and an AI collections desk that proposes and never moves money ([below](#paypal-edition-paylink-twin)). PayLinkV2 is deployed on Ethereum Sepolia at the same address since 2026-10-29 ([transaction](https://sepolia.etherscan.io/tx/0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3)) |
| **Contract** | `0x448eCce9711860502806A3d5B021a4f9Ba715082`, the same address on every testnet where it is deployed ([below](#the-contract)) |
| **Open standard** | [PayLink invoice format v2](../docs/spec/paylink-invoice-v2.md), with a [JSON Schema](../docs/spec/paylink-invoice-v2.schema.json) and test vectors |
| **Licence** | MIT ([LICENSE](../LICENSE)) |

Each edition's **Status** page (footer, under "System") shows the build it serves, checks the contract on chain, and says whether the relayer and the history service answer right now.

## The problem and who it is for

PayLink is built in Antananarivo for people in Madagascar who are paid from abroad: freelancers, small merchants, and the clients and relatives who pay them.

Our working hypothesis is that being paid from abroad is slow, costly or uncertain for them, and that the person asking for the money does most of the chasing. We think a link that the payer opens on a phone, with nothing to install and no gas token to buy, removes most of the friction on the paying side. We are testing this in structured, consented interviews ([protocol](../docs/research/interview-script.md)). **We claim no results yet: PayLink has no users, revenue or partners today.**

The flow every edition is built around:

> A Malagasy freelancer sends a dollar invoice on WhatsApp. The client abroad opens it and pays: with a fingerprint and no gas token in the Monad and Base editions; on PayPal, or from a wallet with its own gas, in the PayPal edition. The freelancer's till lights up when the payment lands. Both sides keep a receipt anyone can verify.

In the PayPal edition, the PayPal rail serves clients who already pay with PayPal, for freelancers wherever PayPal lets them receive. In Madagascar, secondary sources say PayPal accounts may be able to send but not receive (UNVERIFIED): there, the same invoice's on-chain rail is the one that still gets the freelancer paid, which is why one invoice carries both.

## What a user does

1. **Sign an invoice.** The payee types an amount and a memo. A signing display shows exactly what will be signed (amount, address grouped by four, network, expiry), then one EIP-712 signature makes the invoice: no transaction, no gas, and it works offline. A link, a QR card that prints on A6, WhatsApp and the share sheet are ready at once.
2. **Pay.** The payer opens the link. Four lamps are read from the chain before the Pay key unlocks: the signature is valid, the network is right, the contract is the genuine release (registry address, masked code hash, EIP-712 immutables), and the invoice is still payable. The payer signs one EIP-3009 authorisation; in the Monad and Base editions the relayer submits it (the token nonce is derived on chain from the invoice, so the relayer can delay a payment but never redirect it), and in the PayPal edition the payer's own wallet submits it with its own gas, or the payer pays on PayPal instead. A smart-account payer on Base approves one EIP-5792 batch.
3. **Get paid.** The receipt is verified on chain before the screen says "Approved". The payee's till lights and chimes only for a verified payment of the armed invoice at its exact amount. The ledger reads every invoice's state from the contract, lists payments received, exports CSV and cancels an invoice with one signature and no gas (through the relayer; or one `cancel` transaction).
4. **Send and receive.** Every account has a receive card (an open-amount link with a QR code); saved contacts are paid in two taps.
5. **Keep the books** (Monad edition). A second PRF namespace of the same passkey encrypts the payee's books into a backup file only that passkey can open ([ADR 0016](../docs/adr/0016-ledger-backup-second-prf-namespace.md)).

The app is in English, French and Malagasy (the founder reviews the Malagasy), is an installable PWA, and is tested at phone widths from 320 px.

| Edition | Accounts | Default token and rail | Judge's tour |
|---|---|---|---|
| Monad (`/monad/`) | Mera passkeys only: no wallet extension, no seed phrase, no MON | AUSD, gasless through the relayer; test AUSD from Agora's faucet through the relayer | [Monad pack §4](../docs/submissions/monad.md#4-judge-access-instructions) |
| Base (`/base/`) | Browser wallets (EIP-6963) | USDC: gasless for EOA payers, one batch for smart accounts ("Pay with Base" in the Base app or Coinbase Wallet) | [Colosseum pack §8](../docs/submissions/colosseum.md#8-how-a-judge-can-try-it) |
| All networks (`/`) | Browser wallets | Every route the registry allows, including paying with your own gas | — |
| Mezo (`/mezo/`, branch `mezo`) | Browser wallets (EIP-6963); no Mezo Passport yet | MUSD: one EIP-2612 permit then `payWithPermit`, or exact approve + `pay`, or one batch for smart accounts. The payer's wallet pays the fee in BTC: MUSD has no EIP-3009, so no MUSD payment is gasless | [Mezo pack §6](../docs/submissions/mezo.md#6-judge-access-instructions) |
| PayPal (`/paypal/`, branch `paypal`) | Browser wallets (EIP-6963); no passkeys | Two rails for one invoice: PayPal (the twin PayPal invoice's hosted page, sandbox) or USDC (or PayPal USD) on Ethereum Sepolia by the payer's own EIP-3009 authorisation, with the payer's gas | [Judges' tour](#judges-tour) |

## The contract

`PayLinkV2` 2.0.0 ([source](../protocol/src/PayLinkV2.sol)): Solidity 0.8.30, OpenZeppelin Contracts 5.3.0, `paris` bytecode. Immutable, ownerless and fee-less ([ADR 0004](../docs/adr/0004-immutable-ownerless-feeless.md)); it never keeps funds. Deployed through the CREATE2 factory with the salt preimage `paylink.v2.0.0`, so the address is the same on every network.

| Network | Address | Deployment transaction | Block | Record |
|---|---|---|---|---|
| Monad testnet (10143) | [`0x448eCce9711860502806A3d5B021a4f9Ba715082`](https://testnet.monadvision.com/address/0x448eCce9711860502806A3d5B021a4f9Ba715082) | [`0xb86e7536…cb4d6a`](https://testnet.monadvision.com/tx/0xb86e75367a73e933f3c99a6092357f4b785bf7fdd2c4b299c193e4f903cb4d6a) (CREATE2, sent directly) | 69331735 | [`10143.json`](../protocol/deployments/10143.json) |
| Base Sepolia (84532) | [`0x448eCce9711860502806A3d5B021a4f9Ba715082`](https://sepolia.basescan.org/address/0x448eCce9711860502806A3d5B021a4f9Ba715082) | [`0x2969321d…86b5ed`](https://sepolia.basescan.org/tx/0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed) (CREATE2 reached in a relayed EIP-7702 transaction) | 47859253 | [`84532.json`](../protocol/deployments/84532.json) |
| Mezo testnet (31611) | [`0x448eCce9711860502806A3d5B021a4f9Ba715082`](https://explorer.test.mezo.org/address/0x448eCce9711860502806A3d5B021a4f9Ba715082) | [`0x1662fb51…e1165e`](https://explorer.test.mezo.org/tx/0x1662fb5126d7582947cc77ba2f96266c4f1a561c0e1761f7e4c6249e19e1165e) (CREATE2, sent directly) | 16183660 | [`31611.json`](../protocol/deployments/31611.json) |
| Ethereum Sepolia (11155111) | [`0x448eCce9711860502806A3d5B021a4f9Ba715082`](https://sepolia.etherscan.io/address/0x448eCce9711860502806A3d5B021a4f9Ba715082) | [`0x9a5ade11…b0e5b3`](https://sepolia.etherscan.io/tx/0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3) (CREATE2, sent directly) | 12017054 | [`11155111.json`](../protocol/deployments/11155111.json) |

Full hashes: Monad testnet `0xb86e75367a73e933f3c99a6092357f4b785bf7fdd2c4b299c193e4f903cb4d6a`; Base Sepolia `0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed`; Mezo testnet `0x1662fb5126d7582947cc77ba2f96266c4f1a561c0e1761f7e4c6249e19e1165e`; Ethereum Sepolia `0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3`. Anyone can re-check a deployment against the release (code, masked hash, immutables, EIP-712 domain) with `tools/verify-deployment` ([deployments README](../protocol/deployments/README.md)). The contract source is verified on Mezo's explorer ([Exact Match](https://explorer.test.mezo.org/address/0x448eCce9711860502806A3d5B021a4f9Ba715082), 2026-10-20); the Monad, Base and Ethereum Sepolia explorers do not show it yet (the standard JSON input they take, which solc 0.8.30 compiles to the release's exact init code: [`protocol/PayLinkV2-2.0.0.standard-input.json`](../protocol/PayLinkV2-2.0.0.standard-input.json)).

## Architecture

```text
 PayPal edition (this branch)

 payee (PWA /paypal/) ── signed invoice as a link ──▶ payer (PWA)
   │ session, twin, desk taps                           │ Pay with PayPal              │ or pay in USDC / PYUSD
   ▼                                                    ▼                              ▼ (own wallet, own gas)
 apps/api (Cloudflare Worker "paylink-api")       PayPal's hosted invoice page    PayLinkV2 on Ethereum Sepolia
   ├─ PayPal REST (sandbox): Invoicing v2, OAuth ─▶ the twin invoice                 │ Paid, InvoiceCancelled
   ├─ webhook ◀── PayPal, verified by verify-webhook-signature, then GET            │
   ├─ reconciler: situation table S0–S9, fence, approvals, cron ◀── chain reads ────┘
   └─ Workers AI (AI binding): drafts and proposals, inside the fence only

 Monad and Base editions (branch main)

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
| PayPal edition's API | `apps/api` (branch `paypal`) | Twins an invoice on PayPal, verifies webhooks, reconciles both rails, proposes actions the payee approves; holds no chain key and no PayPal money-moving operation | Availability and advice only |
| SDK | `packages/sdk` | Invoice codec and signing, strict URL format, payment binding, payment router, receipt verification | Reproducing the contract's rules off chain |
| Chain registry | `packages/chains` | Every address, token, RPC and gas bound per network, EIP-55 checked | The app's root of trust for addresses |
| Web app | `apps/web` | Vite and strict TypeScript without a UI framework, PWA, three editions from one codebase on `main`, a fourth (Mezo) on the branch `mezo` and a fifth (PayPal) on this branch, served by Cloudflare Pages with a strict CSP and Trusted Types | Showing exactly what is signed |
| Relayer | `apps/relayer` | Submits only `payWithAuthorization` and `cancelBySig`, simulates first, rate-limits, never sends value | Availability only: it can delay a payment, never redirect it |
| Indexer | `apps/indexer` | Payment history, payee totals and statistics from `Paid` and `InvoiceCancelled` | Nothing authoritative: a cache |
| Design, translations | `packages/design`, `packages/i18n` | v1's "Precision Terminal" design; EN, FR, MG | Presentation |
| End-to-end tests | `e2e/` | Playwright on the production build against anvil chains, the relayer process and a WebAuthn virtual authenticator with PRF | Evidence |

More: [architecture](../docs/ARCHITECTURE.md) (data flows, trust boundaries, failure modes), [decision records](../docs/adr/README.md), [threat model](../docs/security/THREAT_MODEL.md), [documentation index](../docs/README.md).

## Repository layout

| Path | What it holds |
|---|---|
| `protocol/` | PayLinkV2, its Foundry tests (unit, fuzz, invariants, regressions from our own reviews), deployment scripts and records, and the review evidence (`protocol/audit/`) |
| `packages/` | `sdk`, `chains`, `design`, `i18n`, `eslint-config`, and on this branch `api-contract` (the PayPal edition's API types) |
| `apps/` | `web` (the site), `relayer` (gasless submission), `indexer` (history), and on this branch `api` (the PayPal edition's API) |
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

# The PayPal edition: its API offline (PayPal fake, no account), and both rails end to end on a fork of Ethereum Sepolia
pnpm --filter @paylink/api run dev:offline
pnpm --filter @paylink/e2e test specs/paypal-rails.spec.ts

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
| **Built for the PayPal AI Hackathon: the PayPal edition (PayLink Twin)** | from `828b9ff` (2026-10-21), on the branch `paypal` only, on top of the Mezo work at `ffd952f` | Ethereum Sepolia with USDC and PayPal USD in the chain registry, the deploy kit and `tools/verify-deployment`; the API (`apps/api`: PayPal Invoicing v2 and Webhooks, the reconciler, approvals, sessions, the Workers AI assistant, Durable Objects, cron) and its contract (`packages/api-contract`); the PayPal edition of the app; its end-to-end tests ([PayPal pack §9](../docs/submissions/paypal.md#9-disclosures-and-commit-range)). The contract is unchanged |
| **Built for the Mezo Buildathon (AKINDO): the Mezo edition** | from `f0fb1ce` (2026-10-13), on the branch `mezo` only | Mezo testnet in the chain registry, the deploy kit and `tools/verify-deployment`; the Mezo edition of the app (MUSD invoices, permit or approval payments, the BTC fee, Mezo's testnet faucet and borrow page); its end-to-end tests on a fork of Mezo testnet; the [research notes](../docs/research/mezo.md) and [ADR 0017](../docs/adr/0017-mezo-edition-chain-layer.md). The contract is unchanged ([Mezo pack §9](../docs/submissions/mezo.md#9-disclosures-and-commit-range)) |

The submission texts, with their disclosures, are in [docs/submissions/](../docs/submissions/README.md).

## Status and limits

- **Testnets only.** Monad mainnet (143) is in the registry but disabled; there is no mainnet deployment. Mezo testnet (31611) is in the registry for the Mezo edition only, where PayLinkV2 is deployed (2026-10-16). Ethereum Sepolia (11155111) is in the registry for the PayPal edition only, where PayLinkV2 is deployed (2026-10-29).
- **PayPal sandbox only.** The PayPal edition uses the PayPal sandbox with one demo merchant; sandbox behaviours not yet observed are UNVERIFIED; its assistant runs on Workers AI's free daily allocation and rests when it is spent ([limitations](../docs/submissions/paypal.md#7-honest-limitations)).
- **Not audited.** Our own review only: 100 % line and branch coverage of the contract, 63 of 63 hand-written mutants killed, Slither with no untriaged result, invariants I1 to I11 ([evidence](../protocol/audit/README.md), [self-review](../docs/security/self-review.md)).
- **Services.** Gasless payments, test AUSD and gasless cancel need the relayer online; the ledger's full history needs the indexer. Without the indexer, the ledger reads the chain's latest blocks and says so. Each edition's Status page shows whether they answer.
- **No users yet.** PayLink has no users, revenue or partners; demand is a hypothesis under test.
- **Cash-out and regulation.** PayLink does not convert dollars to ariary, and payment and foreign-exchange rules in Madagascar need a legal review before any mainnet launch.

## AI use, attributions, licence, security

- **AI use.** AI in the product: Cloudflare Workers AI (`@cf/google/gemma-4-26b-a4b-it`, fallback `@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Development assisted by Claude Code (Anthropic); the owner directed, reviewed and is responsible for the work. The full disclosure, including how commits are attributed: [AI_DISCLOSURE.md](../AI_DISCLOSURE.md).
- **Third-party components.** OpenZeppelin Contracts, viem, `@category-labs/mera`, Hono, zod, idb, qrcode-generator, Envio HyperIndex (not open source; used for the indexer only), the Archivo and Martian Mono fonts (OFL), each under its own licence: [NOTICE.md](../NOTICE.md).
- **Licence.** MIT, © 2026 nambininasafidison ([LICENSE](../LICENSE)).
- **Security.** Report vulnerabilities privately as [SECURITY.md](../SECURITY.md) explains, never in a public issue.
- **Contributing.** [CONTRIBUTING.md](../CONTRIBUTING.md); changes are listed in [CHANGELOG.md](../CHANGELOG.md).
