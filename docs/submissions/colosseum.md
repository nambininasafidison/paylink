# Colosseum Crypto World's Fair: submission pack

| | |
|---|---|
| **Event** | Colosseum Crypto World's Fair. Registered with Base and Arbitrum as chains (**UV**, FACTS 2026-10-05/06) |
| **Deadline** | Submit by **2026-10-12, 12:00 UTC** (15:00 EAT). The official deadline is Oct 13 at 02:59 or 06:59 UTC depending on the source (**L**, PAYLINK-V2-SPEC §1.2): do not plan on it |
| **Track** | **Base** (PayLinkV2 is deployed on Base Sepolia). **Arbitrum: do not select it** unless the contract is deployed on Arbitrum Sepolia before you submit ([§2](#2-tracks-base-yes-arbitrum-only-if-deployed)) |
| **Status** | Paste-ready, with `[TO FILL: …]` placeholders where a fact does not exist yet. The Colosseum form's exact fields and length limits are not in our notes: each text below is complete on its own, so map it to the closest field and trim from the end of a section if a limit bites |
| **Written** | 2026-10-09, from the repository at `d9662c3` plus this pack |
| **Rules we rely on** | Only work done from Sep 14 to Oct 12 counts; prior work must be disclosed; one submission per builder; an account and registration are needed before submitting (**C**, PAYLINK-V2-SPEC §2.2) |
| **Checklist** | [README.md §2](README.md#2-colosseum) |

Every `text` block is the exact text to paste; the line under it is its length, checked by `python3 docs/tools/submission_fields.py`. Never paste a `[TO FILL: …]`: fill it or delete its sentence.

## Contents

1. [Facts this pack relies on](#1-facts-this-pack-relies-on)
2. [Tracks: Base yes, Arbitrum only if deployed](#2-tracks-base-yes-arbitrum-only-if-deployed)
3. [Project texts](#3-project-texts)
4. [Business plan and go-to-market](#4-business-plan-and-go-to-market)
5. [Why now](#5-why-now)
6. [The open invoice specification (public good)](#6-the-open-invoice-specification-public-good)
7. [Team, prior work and other events](#7-team-prior-work-and-other-events)
8. [How a judge can try it](#8-how-a-judge-can-try-it)
9. [Links](#9-links)

## 1. Facts this pack relies on

| Fact | Value | Evidence |
|---|---|---|
| Contract on Base Sepolia (84532) | PayLinkV2 2.0.0 at `0x448eCce9711860502806A3d5B021a4f9Ba715082`, block 47859253; CREATE2 reached in a relayed EIP-7702 transaction sent from the owner's MetaMask smart account | `protocol/deployments/84532.json`; `eth_getCode` returns the runtime code (checked 2026-10-09) |
| Same contract on Monad testnet (10143) | same address, block 69331735 | `protocol/deployments/10143.json` |
| Arbitrum Sepolia (421614) | **not deployed**: `eth_getCode` at that address returns `0x` (checked 2026-10-09); the registry, the relayer and the deploy page already support the chain | `packages/chains/src/chains/arbitrum-sepolia.ts` |
| Base edition | `https://paylink-mg.pages.dev/base/`: EIP-6963 browser wallets; gasless USDC for EOA payers (one EIP-3009 signature, the relayer submits); EIP-5792 batches (`wallet_sendCalls([approve(amount), pay])`) for smart-account payers, named "Pay with Base" only in the Base app or Coinbase Wallet; Circle's faucet linked for test USDC | `apps/web/src/editions/index.ts` (`baseProfile`), `apps/web/src/rails/batch.ts`, `e2e/specs/editions.spec.ts` |
| Not used | the `@base-org/account` SDK is **not** shipped: "Pay with Base" is EIP-5792 on the payer's own wallet ([ADR 0015](../adr/0015-editions-t1-passkeys-gasless-rails.md)) | `apps/web/package.json` |
| Tests | 335 Foundry tests (100 % lines and branches of the contract, 63 of 63 mutants killed, Slither 0 untriaged); 1,441 TypeScript tests; 30 Playwright end-to-end tests, all passing on 2026-10-09 | `protocol/audit/README.md`; `pnpm -r test` |
| Payments on the real testnets | none yet (0 contract events on Base Sepolia up to block 47872756, scanned 2026-10-09) | your demo recording will make the first ones |
| Relayer, indexer | built and tested, **not deployed yet** (the Base gasless route needs the relayer) | [relayer runbook](../runbooks/relayer.md), [Envio runbook](../runbooks/envio.md) |
| Users, revenue, partners, interviews | none to report as of 2026-10-09 | [interview protocol](../research/interview-script.md) ready |

## 2. Tracks: Base yes, Arbitrum only if deployed

**Base.** Select it. Everything Base-specific in §3 is built and tested on the production build; the Base Sepolia deployment is real.

**Arbitrum.** PayLinkV2 is not on Arbitrum Sepolia. Claiming an Arbitrum track with a contract that does not exist there would be false, so leave it unselected, unless all of this happens before you submit:

1. Get Arbitrum Sepolia ETH on the deployer wallet (about 0.01 ETH is plenty; [faucets runbook](../runbooks/faucets.md)).
2. Deploy from `https://paylink-mg.pages.dev/deploy/` on Arbitrum Sepolia: same release, same CREATE2 address ([deploy runbook](../runbooks/deploy.md)).
3. Send Claude the transaction hash: it verifies the deployment from the sandbox, commits the deployment record (protocol/deployments/421614.json) and regenerates the registry, and you push. The Base edition then serves Arbitrum Sepolia too (the registry already lists it for that edition).
4. Then, and only then, add one sentence to the description: "The same contract is deployed at the same address on Arbitrum Sepolia, and the Base edition serves it."

## 3. Project texts

### Project name

<!-- field: colosseum.name max=0 -->
```text
PayLink
```
Characters: 7 (no stated limit)

### Tagline

<!-- field: colosseum.tagline max=0 -->
```text
Signed dollar invoices you share as a link and get paid in USDC on Base: no fee, no custody, a receipt anyone can verify.
```
Characters: 121 (no stated limit)

### Short description

<!-- field: colosseum.short max=0 -->
```text
PayLink turns a dollar invoice into a link. The payee signs it once (EIP-712, no gas) and shares it on WhatsApp or as a QR code; the payer opens it anywhere and pays USDC on Base with one wallet signature, gasless, or in one batched approval from a smart account. An immutable, fee-less contract forwards the money in the same transaction, and both sides keep a receipt anyone can re-verify on chain. Built in Antananarivo for people in Madagascar who are paid from abroad.
```
Characters: 473 (no stated limit)

### Description

<!-- field: colosseum.description max=0 -->
```text
PayLink turns a dollar invoice into a link. A freelancer or a small shop signs the invoice once, shares it on WhatsApp or prints it as a QR card, and the client, anywhere in the world, pays it in USDC. The money goes straight from the payer to the payee through an immutable contract, and both sides keep a receipt that anyone can re-verify on chain.

WHO IT IS FOR
PayLink is built in Antananarivo for people in Madagascar who are paid from abroad: freelancers, small merchants, and the clients and relatives who pay them. Our working hypothesis, which we are testing in structured interviews (protocol in the repository; no results are claimed here), is that being paid from abroad is slow, costly or uncertain for them, and that a link the payer opens on a phone, with nothing to install and no gas token to buy, removes most of the friction on the paying side.

HOW IT WORKS ON BASE (paylink-mg.pages.dev/base/)
1. The payee connects any browser wallet (EIP-6963) and signs an EIP-712 invoice after a signing display shows exactly what the wallet will sign. No transaction and no gas: the invoice is a signature, and it can be created offline.
2. The link, a QR card that prints on A6, WhatsApp and the system share sheet are ready at once.
3. The payer opens the link. Four lamps are read from the chain before the Pay key unlocks: the payee's signature is valid, the wallet is on the right network, the contract is the genuine PayLink release (registry address, masked code hash, EIP-712 immutables), and the invoice is still payable. The payee's address is shown in full, grouped by four, with a saved contact name or an amber "first payment to this address" warning.
4. A payment router picks the best way to pay. An EOA payer signs one EIP-3009 authorization for Circle's USDC and sends no transaction: our relayer submits it, and the token nonce is derived on chain from the invoice, the payer, the amount and a reference, so the relayer can delay a payment but never redirect it. A smart-account payer (EIP-5792 atomic batches) approves one wallet_sendCalls with [approve(exact amount), pay]; in the Base app or Coinbase Wallet the key says "Pay with Base". If the relayer is down, the payer sends the same signed authorization with their own gas.
5. The receipt is verified on chain before the screen says Approved. It names both parties in full, prints on an 80 mm roll or A6 with a QR code that re-opens it, and is re-verified every time it is opened. The payee's till lights up only for a verified payment of the armed invoice at its exact amount; the ledger reads every invoice's state from the contract and exports CSV with CAIP identifiers.

ONE CONTRACT, MANY CHAINS
PayLinkV2 (Solidity 0.8.30, OpenZeppelin 5.3.0, paris bytecode) is immutable, ownerless and fee-less. It never keeps funds, and it is deployed through CREATE2 at the same address, 0x448eCce9711860502806A3d5B021a4f9Ba715082, on Base Sepolia and on Monad testnet. Only three things change between our editions: the account layer, the default token and the payment rail. The Base edition uses browser wallets and USDC; the Monad edition, entered separately at Monad Metropolis, uses passkeys and AUSD.

AN OPEN STANDARD
The invoice format is an open specification (EIP-712 types, key derivation, payment binding for EIP-3009, signed cancellation, URL encodings, receipt verification) with a JSON Schema and test vectors that three implementations agree on. Any wallet, marketplace or accounting tool can issue, verify or pay a PayLink invoice without asking us.

QUALITY AND SAFETY
335 Foundry tests (unit, fuzz and 11 invariants), 100% line and branch coverage of the contract, 63 of 63 hand-written mutants killed and Slither with no untriaged result; more than 1,400 TypeScript tests; 30 Playwright end-to-end tests on the production build, with axe-core WCAG 2.2 AA checks in light and dark. A strict Content-Security-Policy with Trusted Types and no third-party script. It is our own review, not a third-party audit, and it runs on testnets only.

STATUS
Testnet only. PayLink v1, a simpler payment-link contract on Arc, was written on Oct 4-5, 2026; PayLink v2, everything above, was built from Oct 5 on, inside this event's window. Claude Code (AI) did much of the engineering under the founder's direction; the founder owns every decision, key and submission.
```
Characters: 4,350 (no stated limit)

### How it is built (technical architecture)

<!-- field: colosseum.architecture max=0 -->
```text
- Contract: protocol/src/PayLinkV2.sol. Four settlement paths (payWithAuthorization for EIP-3009, pay, payWithPermit, payNative), cancel and cancelBySig, and a batched statesOf read. Exact-delta settlement: the contract's balance never changes across a call. Gas limits are clamped to measured per-function bounds.
- SDK: packages/sdk (TypeScript, viem). Invoice codec and EIP-712 signing, the strict URL format, payment binding, receipt verification, deployment code-integrity checks, and the payment router.
- Chain registry: packages/chains. Every address, token, RPC and gas bound per network, validated and EIP-55 checked; the web app trusts nothing else.
- Web app: apps/web. Vite and strict TypeScript with no UI framework, a PWA, EN/FR/MG, and three editions built from one codebase (all chains, Monad, Base). Served by Cloudflare Pages with strict security headers.
- Relayer: apps/relayer. A Cloudflare Worker with one Durable Object per chain. It relays only payWithAuthorization and cancelBySig, checks both signatures and the bound nonce, simulates before sending, rate-limits per requester and payer, and never sends value. It can delay a payment, never redirect it.
- Indexer: apps/indexer. Envio HyperIndex for payment history; a cache only, never trusted for a payment state.
- Tests: Foundry (unit, fuzz, invariants, mutation), Vitest across the TypeScript packages, and Playwright end to end on anvil chains with a mock EIP-1193 wallet that supports EIP-5792 batches, the relayer process, and axe-core.
```
Characters: 1,521 (no stated limit)

## 4. Business plan and go-to-market

<!-- field: colosseum.business max=0 -->
```text
Everything below is a plan or a hypothesis to test, not a result. As of October 9, 2026, PayLink has no users, no revenue and no partners, and we claim none.

PROBLEM (hypothesis under test)
Freelancers and small merchants in Madagascar who are paid from abroad find it slow, costly or uncertain, and the person asking for the money does most of the chasing. We test this in structured, consented interviews with freelancers, merchants and payers abroad; the protocol and consent text are in the repository. Results so far: [TO FILL: "n of N" counts from interviews actually held, or "none yet"].

CUSTOMERS (hypotheses)
1. Malagasy freelancers with clients abroad (design, development, translation, remote assistance): they already invoice and chase payments, and their clients already pay online.
2. Small merchants who serve visitors and the diaspora: a printed receive card and a till that lights up only for a verified payment.
3. Payers abroad never sign up: they open a link and approve once. Every invoice puts PayLink in front of a payer, which makes payers our main acquisition channel.

BUSINESS MODEL (hypotheses)
- The core stays free. The contract takes no fee and cannot be changed to take one. Our only cost per gasless payment is the relayer's gas, which we will measure on testnet before setting any price.
- PayLink Business: a subscription for accounting export, webhooks, team access and branded cards. The price is to be tested; interviews count only past spending on invoicing or bookkeeping tools as evidence.
- Later, referral revenue from licensed cash-out partners. None exists today.

GO-TO-MARKET (plan)
- Founder-led onboarding in Antananarivo, in Malagasy and French (the app speaks both, plus English): [TO FILL: the communities you actually belong to].
- The payer loop: we measure how many payers later issue their own invoice.
- WhatsApp first: the share sheet, the wa.me link and the printed card are built in.
- Base: smart-wallet payers pay in one approval, and EOA payers need no ETH, so a client who already holds USDC on Base can pay in seconds.

RISKS WE NAME
- Cash-out: PayLink does not convert dollars to ariary; users need a licensed local path, and we have no partner today.
- Regulation: payment and foreign-exchange rules in Madagascar must be reviewed with counsel before any mainnet launch; we make no compliance claim.
- Acceptance of digital dollars by both sides; wallet and passkey support on the phones our users have.

METRICS
Activation (first paid invoice within 7 days), median time to get paid (computed by the app), repeat payers per merchant, payer-to-merchant conversion, share of payments that are gasless, relayer cost per payment, and cash-out completion once a path exists.

NEXT 90 DAYS (plan)
October: at least 6 interviews reported as "n of N"; a testnet pilot with merchants from the founder's network. November: fix what the pilot shows; publish the invoice specification as a standalone document. December: an external review of the contract if funding allows; mainnet only after a cash-out path and a legal review exist.
```
Characters: 3,095 (no stated limit)

### Demand validation (if the form asks separately)

<!-- field: colosseum.validation max=0 -->
```text
We have not validated demand yet, and we say so. What exists: a written interview protocol with six hypotheses (H1 to H6) and their falsifiers, a consent form, and reporting rules that count only what participants describe from their own past ("n of N", never "would you use it"). Sessions held as of [TO FILL: date]: [TO FILL: N]. Findings: [TO FILL: "n of N" lines with their limitations, or "none yet"]. Waitlist: [TO FILL: count and how it was collected, or "none yet"].
```
Characters: 474 (no stated limit)

## 5. Why now

<!-- field: colosseum.why-now max=0 -->
```text
Three things that used to block "pay me in dollars with a link" now ship in ordinary phones and wallets. Dollar stablecoins such as USDC support signed transfers (EIP-3009), so a payer can authorise one exact payment without holding gas, and someone else can submit it without being able to redirect it. Smart wallets can approve and pay in one batched step (EIP-5792), and passkeys with the PRF extension now let a phone's fingerprint hold a key. Low-fee networks like Base make a small invoice worth paying on chain. PayLink puts these together for people who are paid from abroad, and keeps the money in the payer's and the payee's own hands.
```
Characters: 645 (no stated limit)

## 6. The open invoice specification (public good)

<!-- field: colosseum.public-good max=0 -->
```text
The PayLink signed invoice format is an open, MIT-licensed specification that anyone may implement without asking: docs/spec/paylink-invoice-v2.md, with a JSON Schema (draft 2020-12) and test vectors. It defines the invoice data model, the EIP-712 domain and types, how the invoice key is derived, the payee signature rules (EOA and ERC-1271), how an EIP-3009 authorization is bound to exactly one payment so a relayer cannot redirect it, signed cancellation, the URL encodings for invoices and receipts, and the algorithm that verifies a receipt from a transaction receipt. Its vectors agree across three independent implementations (ethers, Foundry cast, and the compiled contract). A wallet, a marketplace or an accounting tool can issue, verify or pay a PayLink invoice, or check a receipt, with no dependency on our app or servers; the contract is ownerless and fee-less, so there is no gatekeeper.
```
Characters: 903 (no stated limit)

## 7. Team, prior work and other events

### Team

<!-- field: colosseum.team max=0 -->
```text
Solo founder: nambininasafidison, based in Antananarivo, Madagascar. [TO FILL: one or two sentences on your background, in your own words.] The founder decides scope and design, reviews every change and owns every key, account and submission. Much of the engineering and documentation was done with Claude Code, Anthropic's AI coding tool, under the founder's direction; commits made with it carry a Co-Authored-By trailer, and the repository's AI_DISCLOSURE.md states what it did and was not allowed to do (no keys, no deployments, no submissions).
```
Characters: 549 (no stated limit)

### Prior work and other events

<!-- field: colosseum.disclosure max=0 -->
```text
Prior work: PayLink v1, a simple payment-link contract and web app on Arc, was created on Oct 4-5, 2026 (commits 31a4fdd and 93ed4e3), inside this event's window; it is frozen and is not part of this entry's Base edition. Everything else, PayLink v2 (the PayLinkV2 contract, SDK, chain registry, web app with its editions, relayer, indexer, tests and the open invoice specification), was built from Oct 5, 2026 on, starting at commit 88ac2d9.
Other events: the same repository and contract are also entered at Monad Metropolis with the Monad edition (passkeys and AUSD on Monad testnet), and PayLink v1 is the Arc Microgrants entry. Mezo and PayPal editions are planned for later events and are not built.
Third-party code: OpenZeppelin Contracts, viem, qrcode-generator, Hono, zod, Envio, and the Archivo and Martian Mono fonts (OFL), each under its own licence (NOTICE.md).
```
Characters: 875 (no stated limit)

## 8. How a judge can try it

<!-- field: colosseum.try-it max=0 -->
```text
Base Sepolia, testnet only. You need a browser wallet (MetaMask, Coinbase Wallet or any EIP-6963 wallet) on Base Sepolia, and test USDC from https://faucet.circle.com (the app links to it). A plain account needs no ETH to pay; a smart account pays its own gas.
1. Payee: open https://paylink-mg.pages.dev/base/, type an amount and a memo, press "Review and sign", read the signing display, then "Sign in wallet". Your wallet asks for a signature, not a transaction.
2. Copy the link, or open it on another device by scanning the QR code.
3. Payer: open the link with another account. Four lamps check the signature, network, contract and payability on chain. Press the Pay key to connect, then "Pay <amount> USDC".
- A plain account (EOA) signs one EIP-3009 authorization and sends nothing; our relayer submits it.
- A smart account approves one batch [approve, pay]; in the Base app or Coinbase Wallet the key reads "Pay with Base".
4. "Approved" appears once the receipt is verified on chain. "Open the receipt" re-verifies it on every opening; "View the transaction" opens Basescan.
5. "Ledger" (top menu): the invoice's state read from the contract, CSV export, cancel. "Status" (footer): the contract checked live on Base Sepolia.
Contract: 0x448eCce9711860502806A3d5B021a4f9Ba715082 on Base Sepolia (deployment tx 0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed). Source and tests: https://github.com/nambininasafidison/paylink
```
Characters: 1,452 (no stated limit)

## 9. Links

| What | Value |
|---|---|
| Live (Base edition) | `https://paylink-mg.pages.dev/base/` (check it serves v2 first, [README §2](README.md#2-colosseum)) |
| Repository | `https://github.com/nambininasafidison/paylink` (public, MIT) |
| Contract, Base Sepolia | [Basescan](https://sepolia.basescan.org/address/0x448eCce9711860502806A3d5B021a4f9Ba715082), [Blockscout](https://base-sepolia.blockscout.com/address/0x448eCce9711860502806A3d5B021a4f9Ba715082) |
| Deployment transaction | [Basescan](https://sepolia.basescan.org/tx/0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed) |
| Open invoice specification | [docs/spec/paylink-invoice-v2.md](../spec/paylink-invoice-v2.md) and its [JSON Schema](../spec/paylink-invoice-v2.schema.json) |
| Pitch video (2–3 min) | `[TO FILL: YouTube URL, public]`, script [video-scripts.md (d)](video-scripts.md#4-d-colosseum-pitch-23-min-and-demo-at-most-300) |
| Demo video (at most 3 min) | `[TO FILL: YouTube URL, public]`, same section |
| Logo and thumbnail | `docs/submissions/assets/logo-1024.png`, `docs/submissions/assets/social-card.png` (1200 × 630) |
| Tag | `submission/colosseum-2026-10-12` on the submitted commit, created by you when you submit |
