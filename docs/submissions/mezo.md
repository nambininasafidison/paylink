# Mezo Buildathon (AKINDO), wave 1: submission pack

| | |
|---|---|
| **Event** | "Build with MUSD and MEZO: Bitcoin's Economic Layer", the Mezo Buildathon on AKINDO (Mezo / Supernormal Foundation). Track 2 "Access & Distribution". An MUSD or MEZO integration is mandatory: PayLink's is MUSD ([§4](#4-the-musd-integration-explained)) |
| **Deadline** | Wave 1 closes **2026-10-26** (time of day unknown: plan to submit by **Oct 24**). Build Oct 16–26, judging Oct 27–Nov 1; wave 2 builds Nov 2–15 (**UNVERIFIED**: third-party pages only, [research §10](../research/mezo.md#10-mezo-buildathon-on-akindo)) |
| **Status** | Paste-ready, with `[TO FILL: …]` placeholders only where a fact does not exist yet: the video, the interviews. PayLinkV2 is deployed on Mezo testnet (2026-10-16, block 16183660) and the preview serves the edition; the first real MUSD payment went through it on 2026-10-16 (12.50 MUSD, transaction `0xf44cf47b2b6290ae1014dedbe1b0bf8adf590974a619808b47560b4eed6d22cd`, block 16184418). Next: [§10](#10-liste-de-contrôle-en-français) steps 5 bis, 10 and 11 |
| **Written** | 2026-10-13, from the local branch `mezo` at `119a7d6` (23 commits on top of `main` at `0c3bfed`), and checked against Mezo testnet the same day. Revised 2026-10-14 after a review: Mezo's RPC answers, the borrow estimate, the Mezo-only policy, the business fields, the wording of fees and gas |
| **Who submits** | The owner, from the owner's AKINDO account. Claude Code drafts only ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)) |
| **Checklist** | [§10](#10-liste-de-contrôle-en-français), in French; [README.md §5](README.md#5-mezo-buildathon-akindo-wave-1) says what is done |

Every text in a `text` block is the exact text to paste. The line under it is its length in characters, checked by `python3 docs/tools/submission_fields.py` (run it with `--update` after you edit a field). AKINDO's field names and length limits could not be read from here (**UNVERIFIED**, [research §10](../research/mezo.md#10-mezo-buildathon-on-akindo)): each text is complete on its own, so map it to the closest field and trim from the end of a paragraph if a limit bites. Replace every `[TO FILL: …]` or delete the sentence that holds it; never paste a placeholder.

Tags as in the research: **C** confirmed (on chain, or a primary source read), **L** likely, **UNVERIFIED** (third-party only, or not reachable from the build machine).

## Contents

1. [Facts this pack relies on](#1-facts-this-pack-relies-on)
2. [Where judges see it: the preview of branch mezo](#2-where-judges-see-it-the-preview-of-branch-mezo)
3. [Project page and form fields](#3-project-page-and-form-fields)
4. [The MUSD integration, explained](#4-the-musd-integration-explained)
5. [What is new in wave 1, what comes in wave 2](#5-what-is-new-in-wave-1-what-comes-in-wave-2)
6. [Judge access instructions](#6-judge-access-instructions)
7. [Honest limitations](#7-honest-limitations)
8. [Demo video script (at most 2:00, captions, no narration)](#8-demo-video-script-at-most-200-captions-no-narration)
9. [Disclosures and commit range](#9-disclosures-and-commit-range)
10. [Liste de contrôle (en français)](#10-liste-de-contrôle-en-français)

## 1. Facts this pack relies on

Checked from the sandbox on 2026-10-13 unless stated otherwise. If one of them changes, change the texts that use it.

| Fact | Value | Evidence |
|---|---|---|
| Contract on Mezo testnet (31611) | **Not deployed yet.** At `0x448eCce9711860502806A3d5B021a4f9Ba715082`, `eth_getCode` returns `0x` at block 16,145,564 (2026-10-14 00:44 UTC). The deploy kit targets Mezo testnet; you deploy from your wallet ([§10](#10-liste-de-contrôle-en-français) step 4) | live RPC `https://rpc.test.mezo.org`; [deploy runbook §8](../runbooks/deploy.md#8-mezo-testnet) |
| Release identity | PayLinkV2 2.0.0, init code hash `0x289dcd64…7ac5`, salt `keccak256("paylink.v2.0.0")`, through the canonical CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C`, which is on Mezo testnet with its canonical runtime. A dry-run call through it returns `0x448e…5082`; Mezo testnet estimates the deployment at 2,717,457 gas (**C**) | [research §3](../research/mezo.md#3-create2-factory-and-paylinkv2-on-mezo-testnet); `web/v2/deploy/data/release.json` |
| Same contract elsewhere | Live at the same address on Monad testnet (block 69331735) and Base Sepolia (block 47859253), entered at Monad Metropolis and Colosseum | `protocol/deployments/10143.json`, `protocol/deployments/84532.json` |
| Mezo testnet | Chain 31611 (`0x7b7b`); gas coin BTC, 18 decimals; blocks every 4.85 s on average over 10,000 blocks; charges **at least 50 % of the gas limit**; `eth_getLogs` spans at most 10,000 blocks (**C**) | [research §2](../research/mezo.md#2-network); `packages/chains/src/chains/mezo-testnet.ts` |
| Mezo's RPC | Its only public RPC answers `null` to about half of the lookups of a **mined** transaction by hash (`eth_getTransactionReceipt`, `eth_getTransactionByHash`); a moment later the same request answers. PayLink, its SDK and the deploy kit ask again before they conclude anything, and say "not returned yet", never "invalid" (**C**) | [research §2](../research/mezo.md#2-network); [ADR 0017](../adr/0017-mezo-edition-chain-layer.md) decision 7 |
| MUSD lending | BorrowerOperations `0xCdF7028ceAB81fA0C6971208e83fa7872994beE5`: `minNetDebt` 1,800 MUSD, gas compensation 200 MUSD, borrowing fee 0.1 %, MCR 110 %, CCR 150 %, interest 1 % a year (`interestRate` 100 bps); 83,339 USD per BTC on MUSD's PriceFeed, no recovery mode (2026-10-14). The smallest loan books 2,001.80 MUSD of debt and locks at least 0.02643 BTC at 110 % (**C**) | [research §4](../research/mezo.md#4-musd-on-mezo-testnet) |
| MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`: "Mezo USD", 18 decimals, EIP-712 domain `Mezo USD` / `1`. **EIP-2612 permit: yes** (ECDSA only, so smart accounts cannot sign one). **EIP-3009: no.** No fee, hook, pause or blocklist; not upgradeable. Its owner, an EOA on testnet, can let any address burn MUSD from any account (**C**) | [research §4](../research/mezo.md#4-musd-on-mezo-testnet) |
| Payment routes | Plain wallet: `payWithPermit` (one permit + one transaction). Smart account: exact `approve` + `pay`, or one EIP-5792 batch. `payWithAuthorization`: impossible (MUSD has no EIP-3009) | [ADR 0017](../adr/0017-mezo-edition-chain-layer.md); `e2e/specs/mezo.spec.ts` |
| Fork evidence | On an anvil fork of Mezo testnet (block 16,140,641) with the real MUSD and factory: the deployment lands at the release address (2,678,851 gas used); `payWithPermit` uses 135,733 gas, `pay` 101,996; each moves exactly the invoice amount, PayLinkV2 keeps nothing, no allowance is left | `packages/chains/data/fork-gas-measurements.json`; [research §5](../research/mezo.md#5-paylinkv2-with-musd-on-a-fork-smoke-test) |
| Network fee per payment | About **0.002 sat** (2 × 10⁻¹¹ BTC) charged for a `payWithPermit` at today's base fee and tip: 135,733 gas used × (130 + 16) wei, 2026-10-14. The pay page and Status show an **upper bound under 0.005 sat**: the 177,100-gas limit PayLink sets × (2 × base fee + tip), 276 wei. Paid by the payer | [research §5](../research/mezo.md#5-paylinkv2-with-musd-on-a-fork-smoke-test); `apps/web/src/editions/mezo/ui.ts` (`feeUpperBound`) |
| Test funds | Test BTC from `https://faucet.test.mezo.org` (captcha; drip size **UNVERIFIED**) or the Mezo Discord `#testnet`. Test MUSD has **no faucet**: it is borrowed against test BTC, at least 2,000 MUSD of debt (1,800 + a 200 reserve), so at least about 0.0265 test BTC of collateral; plan on 0.04 | [research §8](../research/mezo.md#8-how-a-tester-gets-test-btc-and-musd); [faucets runbook §3](../runbooks/faucets.md#3-musd-on-mezo-testnet-no-faucet) |
| Mezo edition | `/mezo/` on branch `mezo`: create, pay, receipt, ledger, send, till, status; EIP-6963 wallets; MUSD only; the smallest MUSD loan read live from MUSD's contracts; its own Content-Security-Policy (Mezo's RPC only: not even PayLink's relayer, which serves no Mezo chain); EN, FR, MG | `apps/web/src/editions/mezo/`; `apps/web/public/_headers`; [web app README](../../apps/web/README.md) |
| Tests | On branch `mezo`, 2026-10-14: 335 Foundry tests passing; 1,547 TypeScript tests passing (SDK 569, web 406, chains 226, relayer 131, deploy page 82, design 29, i18n 29, indexer 28, ESLint config 25, verify-deployment 22; 9 opt-in fork tests skipped); 41 Playwright end-to-end tests passing and 1 skipped by design, 10 of them for Mezo on a fork of Mezo testnet or an anvil chain with its id (9 for the edition, 1 for its deploy kit) | `forge test`; `pnpm -r test`; `e2e/specs/mezo.spec.ts`, `e2e/specs/deploy-mezo.spec.ts` |
| Where it is served | `https://mezo.paylink-mg.pages.dev/mezo/`, the Cloudflare Pages preview of branch `mezo`, **not online yet**: the branch is pushed, and since 2026-10-14 the project's preview branch setting is "Custom branches" with `mezo` only (it was "All non-Production branches" before, which the owner closed) ([§2](#2-where-judges-see-it-the-preview-of-branch-mezo)). The host is blocked from the sandbox, so check it yourself | [Cloudflare Pages runbook §2](../runbooks/cloudflare-pages.md#2-build-settings) |
| Production | `https://paylink-mg.pages.dev/monad/` answers 200; `https://paylink-mg.pages.dev/mezo/` answers 404. Production stays on `main`, unchanged, while Monad Metropolis and Colosseum are judged | `curl`, 2026-10-13 |
| Relayer, indexer | Neither serves Mezo: the relayer cannot carry an MUSD payment with PayLinkV2, and there is no history indexer for Mezo | [ADR 0017](../adr/0017-mezo-edition-chain-layer.md) |
| Real payments on Mezo testnet | **None yet** (no contract there). Your rehearsal and video make the first ones | — |
| Users, revenue, partners, interviews | None to report as of 2026-10-14. Plan: 3 to 6 sessions before Oct 24, reported as "n of N" ([demand validation](#demand-validation)) | [interview protocol](../research/interview-script.md) ready; no session recorded |
| Buildathon rules | Tracks, rubric (Mezo Integration 30, Product & Business Viability 30, Technical Implementation 20, User Experience 10, Submission Materials 10), wave dates and form fields come from third-party pages; AKINDO cannot be reached from here (**UNVERIFIED**) | [research §10](../research/mezo.md#10-mezo-buildathon-on-akindo) |

## 2. Where judges see it: the preview of branch mezo

Production (`main`, `https://paylink-mg.pages.dev`) is under judging for Monad Metropolis (`/monad/`) and Colosseum (`/base/`) and must not change. So the Mezo edition is served by Cloudflare Pages from the branch `mezo`, at **`https://mezo.paylink-mg.pages.dev/mezo/`**. For that you must, once:

1. In the Pages project `paylink-mg`, Settings → Build → Branch control, set "Preview branch" to **Custom branches** and include **`mezo`** only. Today it is "None" on purpose ([ADR 0005](../adr/0005-dedicated-origin-and-rpid.md)): a preview host is a subdomain of the passkey rpId. The Mezo edition has no passkeys, and the code refuses passkey ceremonies anywhere but `paylink-mg.pages.dev` itself; allowing this one branch is your decision.
2. Give the **Preview** environment the same three variables as Production: `NODE_VERSION` = `22.22.0`, `PNPM_VERSION` = `10.28.0`, `SKIP_DEPENDENCY_INSTALL` = `1` ([Cloudflare Pages runbook §2](../runbooks/cloudflare-pages.md#2-build-settings)). Without them the build runs on the image's older Node, which the build script refuses, or installs the wrong dependencies.
3. Push the branch `mezo` (never `main`). Set 1 and 2 first: Pages builds a branch when it receives a push.
4. Check `https://mezo.paylink-mg.pages.dev/mezo/status/`: "Build" names your pushed commit and edition `mezo`. The contract lamp turns green only once the deployment is recorded and pushed ([§10](#10-liste-de-contrôle-en-français) steps 4 to 6); every other Mezo lamp is green at once.

The relayer Worker must keep "Builds for non-production branches" off ([relayer runbook §3](../runbooks/relayer.md#3-check-the-build-settings)), so pushing `mezo` changes nothing in production.

## 3. Project page and form fields

Participants report these fields: an AKINDO project page (pitch, repository, deployed address, demo video) and a form with name, category, TL;DR, how it works, target group, tech stack, track, chain, new or existing, readiness, future milestones and team (**UNVERIFIED**). Map each text below to whatever the form shows.

### Project name

<!-- field: mezo.name max=0 -->
```text
PayLink
```
Characters: 7 (no stated limit)

### Track, chain, category

- **Track:** 2, "Access & Distribution" (tools and interfaces for MUSD users). PayLink is a payment interface, not a DeFi protocol.
- **Chain:** Mezo (testnet, chain 31611).
- **Category:** Payments (or the closest option: consumer payments, invoicing).

### Logo

`docs/submissions/assets/logo-1024.png` (1024 × 1024 PNG), the app's own mark ([README §3](README.md#3-assets)). Do not use `social-card.png`: it shows the Monad edition.

**Screenshots.** Five Mezo screens (`screens/screen-6-mezo-create.png` to `screen-10-mezo-borrow.png`: the signed card, the permit route with the BTC fee, the receipt, Status with MUSD and the smallest loan, a payer who borrows MUSD) come from the production build on a fork of Mezo testnet, with `capture-mezo.json` saying when and from which commit. They need the recorded deployment, so Claude makes them right after [§10](#10-liste-de-contrôle-en-français) step 5 (`pnpm --filter @paylink/e2e capture 03-mezo`); label them "fork capture" wherever they appear, or take your own from the live preview once it pays.

### TL;DR

<!-- field: mezo.tldr max=0 -->
```text
Dollar invoices you share as a link, paid in MUSD on Mezo. A freelancer or small shop in Madagascar signs an invoice for free; the client pays it from their own wallet, straight to the seller (from a plain wallet: one permit signature, one transaction), and both keep a receipt anyone can verify on chain.
```
Characters: 305 (no stated limit)

### Pitch and how it works

The project page's main text. The deployment sentence needs the transaction hash from [§10](#10-liste-de-contrôle-en-français) step 5.

<!-- field: mezo.description max=0 -->
```text
PayLink turns a dollar invoice into a link, and on Mezo that dollar is MUSD, the Bitcoin-backed dollar. A freelancer or a small shop signs the invoice once, for free, shares it on WhatsApp or as a printed QR code, and the client pays it from their own wallet, straight to the seller, through an immutable contract that never holds the money. Both sides keep a receipt that anyone can re-verify on chain.

WHO IT IS FOR
PayLink is built in Antananarivo for people in Madagascar who are paid from abroad: freelancers, small merchants, and the clients and relatives who pay them. Our working hypothesis, which we are testing in structured interviews (the protocol is in the repository; we claim no results yet), is that being paid from abroad is slow, costly or uncertain for them. MUSD gives them a dollar backed by bitcoin that moves wallet to wallet; PayLink gives that dollar an invoice, a till and a ledger.

WHAT A USER DOES (mezo.paylink-mg.pages.dev/mezo/, Mezo testnet)
1. Sign an invoice. The seller connects any EVM wallet (MetaMask, Rabby or another EIP-6963 wallet), types an amount in MUSD and what it is for, reads a signing display (amount, address grouped by four, network, expiry) and signs one EIP-712 invoice. No transaction, no gas, no sign-up; the wallet adds Mezo testnet from our registry if it does not know it. The link, a QR card that prints on A6, WhatsApp and a till are ready at once. An invoice is paid once, by a set number of payers, or without limit as an open-amount receive card.
2. Pay. The client opens the link. Four lamps are read from Mezo before the Pay key unlocks: the signature, the network, the contract (the genuine PayLink release: registry address, code hash, EIP-712 immutables) and whether the invoice is still payable. A plain wallet signs one EIP-2612 permit for exactly the amount, under MUSD's own domain ("Mezo USD", version 1), then sends one payWithPermit transaction. A smart account approves exactly the amount, then pays; a wallet that batches (EIP-5792) does both in one approval. The page shows the network fee in sats, paid in BTC by the payer's wallet.
3. Get paid. The payment transaction moves exactly the invoice amount from payer to payee; PayLink keeps nothing and no allowance is left. The receipt is verified on chain before the screen says Approved. The seller's till lights green only for a verified Paid event of that invoice at its exact amount. The ledger reads each invoice's state from the contract, totals it, exports CSV, and cancels an open invoice with one transaction.
4. Pay without selling bitcoin. A payer who lacks MUSD sees the smallest Mezo loan that covers the invoice and the test BTC it locks, read live from MUSD's own contracts, next to Mezo's testnet borrow page (MUSD has no faucet). A payer who lacks BTC for the fee is sent to Mezo's faucet or Discord.
5. Check everything. The Status page reads Mezo live: the network, the genuine contract, MUSD (name, decimals, permit yes, EIP-3009 no, exactly as our registry says), the fee per payment and the smallest MUSD loan.
The app is in English, French and Malagasy (Malagasy under review by the founder), with an ariary estimate that is labelled as an estimate and never used in a payment.

HOW WE USE MUSD AND MEZO
- Beyond the token: a payer short of MUSD is shown the smallest Mezo loan that covers the invoice and the test BTC it locks, computed with MUSD's own rule from values read live from MUSD's BorrowerOperations, PriceFeed and TroveManager (minimum debt, borrowing fee, gas compensation, collateral ratio, recovery mode). For a bitcoin holder that reads: pay this invoice without selling your bitcoin.
- MUSD is the edition's only invoice currency, and its properties were read on Mezo testnet, not assumed: 18 decimals, EIP-2612 permits with ECDSA signatures only, no EIP-3009, no fee or transfer hook, not upgradeable.
- MUSD has permits but not signed transfers, so the payer's own wallet sends the payment and pays the BTC fee: about 0.002 sat at today's prices, under the 0.005-sat upper bound the pay page shows. The app says so instead of promising a gasless flow that PayLink cannot deliver with MUSD.
- Mezo charges at least 50% of a transaction's gas limit, so every PayLink call (pay, payWithPermit, cancel) sends a limit from gas bounds measured on a fork of Mezo testnet with the real MUSD, which keeps that minimum below the gas actually used. The exact approve before a pay sends its own estimate plus 10%, and an EIP-5792 batch's limit is the wallet's.
- Mezo's public RPC sometimes answers "not found" for a transaction that is mined. PayLink asks again, and says "not returned yet" instead of calling a real payment invalid.
- The app discloses MUSD's issuer powers: on testnet, the owner of the MUSD contract can let chosen addresses mint MUSD or burn it from any account.

UNDER THE HOOD
- PayLinkV2 (Solidity 0.8.30, OpenZeppelin 5.3.0) is immutable, ownerless and fee-less, with exact-delta settlement. It is deployed with the canonical CREATE2 factory at 0x448eCce9711860502806A3d5B021a4f9Ba715082 on Mezo testnet (transaction 0x1662fb5126d7582947cc77ba2f96266c4f1a561c0e1761f7e4c6249e19e1165e), the same bytecode at the same address as on Monad testnet and Base Sepolia.
- 335 Foundry tests (unit, fuzz, invariants), 100% line and branch coverage of the contract, 63 of 63 hand-written mutants killed. This is our own review, not a third-party audit.
- More than 1,500 TypeScript unit and integration tests (SDK, web app, chain registry, deploy tools) and 42 Playwright end-to-end tests, 9 of them for the Mezo edition against an anvil fork of Mezo testnet with the real MUSD, its lending contracts and the CREATE2 factory: the full invoice-to-receipt flow, an RPC that answers "not found" for mined transactions as Mezo's does, smart accounts and batches, a payer without BTC or MUSD (with the live borrow estimate), cancellation, status, security headers, and axe-core WCAG 2.2 AA checks in three languages, two themes and three screen widths.
- A strict Content-Security-Policy that lets the Mezo edition talk to Mezo's RPC only, with Trusted Types and no third-party script.
- An open invoice specification (EIP-712 types, URL encodings, receipt verification) with a JSON Schema and test vectors, so any wallet can issue or pay a PayLink invoice.

HONEST STATUS
Testnet only, not audited, no users or revenue yet. PayLink v2 (contract, SDK, web app) was built from Oct 5, 2026 and is also entered at Monad Metropolis and Colosseum; the Mezo edition was built for this buildathon from Oct 13. Claude Code (AI) did much of the engineering under the founder's direction; the founder owns every decision, key and submission.
```
Characters: 6,702 (no stated limit)

### Target group

<!-- field: mezo.target max=0 -->
```text
1. Malagasy freelancers with clients abroad (design, development, translation, remote assistance). They already send invoices and chase payments; PayLink gives them a signed MUSD invoice they share on WhatsApp in seconds, with no fee and no sign-up.
2. Small merchants in Madagascar who serve visitors and the diaspora: a printed QR card at the counter, and a till that lights up only when the payment is verified on chain.
3. Payers abroad: clients, employers and members of the diaspora who hold MUSD or can mint it against their bitcoin. They never sign up; they pay from the wallet they already use. Every invoice puts PayLink in front of a payer at the moment of paying, so payers are also our main acquisition channel.
These are hypotheses we are testing in structured, consented interviews, not a validated market.
```
Characters: 821 (no stated limit)

### Business model and go-to-market

"Product & Business Viability" weighs 30 of 100 in the rubric (**UNVERIFIED**). Adapted from the Colosseum pack's business plan ([colosseum.md §4](colosseum.md#4-business-plan-and-go-to-market)), rewritten for MUSD. Every figure about MUSD was read on Mezo testnet on 2026-10-14 ([research §4](../research/mezo.md#4-musd-on-mezo-testnet)); everything else is a hypothesis or a plan.

<!-- field: mezo.business max=0 -->
```text
Everything below is a plan or a hypothesis to test, not a result. As of October 14, 2026, PayLink has no users, no revenue and no partners, and we claim none.

WHO PAYS IN MUSD, AND WHY (hypotheses)
- Payers abroad who hold bitcoin and do not want to sell it. On Mezo they can borrow MUSD against it (1% a year on testnet today, plus a 0.1% fee and a 200 MUSD reserve on the debt, all read on chain) and pay a dollar invoice with it. PayLink shows them the smallest loan that covers the invoice before they pay.
- Malagasy freelancers and small merchants who invoice those payers: a signed MUSD invoice on WhatsApp, a printed QR card, a till that lights only for a verified payment, and books read from the contract.
- Every invoice puts PayLink in front of a payer at the moment of paying, so payers are also our main acquisition channel.

BUSINESS MODEL (hypotheses)
- The core stays free. The contract takes no fee and cannot be changed to take one, and on Mezo the payer's own wallet pays the network fee, so a payment costs us nothing.
- PayLink Business, later: a subscription for accounting export, webhooks, team access and branded cards. The price is to be tested; interviews count only past spending on invoicing or bookkeeping tools as evidence.
- Later, referral revenue from licensed cash-out partners. None exists today.

GO-TO-MARKET (plan)
- Founder-led onboarding in Antananarivo, in Malagasy and French (the app speaks both, plus English), starting with the founder's own circles of freelancers and developers.
- Mezo's own community: bitcoin holders who already borrow MUSD are the payers we need. We will show the edition in Mezo's Discord and ask testers to pay a real testnet invoice.
- WhatsApp first: the share sheet, the wa.me link and the printed card are built in.
- The payer loop: we measure how many payers later issue their own invoice.

RISKS WE NAME
- Cash-out: PayLink does not convert MUSD to ariary; users need a licensed local path, and we have no partner today.
- Regulation: payment and foreign-exchange rules in Madagascar must be reviewed with counsel before any mainnet launch; we make no compliance claim.
- The issuer and the loan: MUSD's owner can let chosen addresses mint MUSD or burn it from any account (read on testnet), and a borrower's loan is liquidated if bitcoin falls far enough.
- Payers need an EVM wallet and a little BTC for the fee; Bitcoin wallets through Mezo Passport come in wave 2.

METRICS
Activation (first paid invoice within 7 days), median time to get paid (computed by the app), repeat payers per merchant, payer-to-merchant conversion, share of payers who borrowed MUSD to pay, and cash-out completion once a path exists.

NEXT 90 DAYS (plan)
October: PayLinkV2 deployed on Mezo testnet, its source verified, the first real MUSD payments; 3 to 6 interviews reported as "n of N". November (wave 2): Bitcoin wallets as payers through Mezo Passport, and a testnet pilot with freelancers in Antananarivo. December: an external review of the contract if funding allows; Mezo mainnet only after a cash-out path and a legal review exist.

WHY NOW
MUSD lets a bitcoin holder spend dollars without selling bitcoin, at a fixed rate, and a payment on Mezo costs a fraction of a satoshi, so a small invoice is worth paying on chain. PayLink adds what a freelancer needs around that dollar: an invoice, a till, a receipt anyone can verify, and books.
```
Characters: 3,410 (no stated limit)

### Demand validation

<!-- field: mezo.validation max=0 -->
```text
We have not validated demand yet, and we say so. What exists: a written interview protocol with six hypotheses (H1 to H6) and their falsifiers, a consent form, and reporting rules that count only what participants describe from their own past ("n of N", never "would you use it"). Planned: 3 to 6 sessions before October 24, 2026, with freelancers in Antananarivo and with payers who hold bitcoin. Sessions held as of [TO FILL: date]: [TO FILL: N]. Findings: [TO FILL: "n of N" lines with their limitations, or "none yet"].
```
Characters: 523 (no stated limit)

### Tech stack

<!-- field: mezo.stack max=0 -->
```text
Contract: Solidity 0.8.30 and OpenZeppelin 5.3.0, tested with Foundry (unit, fuzz and invariant tests, hand-written mutants, Slither), deployed through the canonical CREATE2 factory so it has one address on every chain.
Standards: EIP-712 invoices, EIP-2612 permits (MUSD), ERC-5267, EIP-6963 wallet discovery, EIP-3085 to add Mezo testnet to the wallet, EIP-5792 batches for smart accounts.
App: TypeScript with no UI framework, Vite and viem, on a typed chain registry and SDK shared with the browser deploy kit and the verification CLI. Static hosting on Cloudflare Pages with a strict Content-Security-Policy and Trusted Types.
Tests: Vitest, Playwright with axe-core, and anvil forks of Mezo testnet with the real MUSD.
Languages: English, French, Malagasy.
```
Characters: 762 (no stated limit)

### New or existing

Answer **existing**, with this text if the form asks for details.

<!-- field: mezo.existing max=0 -->
```text
Existing project, new Mezo edition. PayLink v2 (the PayLinkV2 contract, SDK, web app, till, ledger and receipts) was built from Oct 5, 2026 and is entered at Monad Metropolis (Monad edition, AUSD) and Colosseum (Base edition, USDC). The contract is immutable and unchanged. Built for this buildathon, from Oct 13, 2026: MUSD support, Mezo testnet in our chain registry and deploy tools, the Mezo edition of the app, and its end-to-end tests on a fork of Mezo testnet.
```
Characters: 467 (no stated limit)

### Readiness

Pick the option closest to "working prototype on testnet".

<!-- field: mezo.readiness max=0 -->
```text
Working prototype on Mezo testnet: invoices, MUSD payments, receipts, the till, the ledger and the status page run end to end in the browser. Not audited, no mainnet deployment, no users yet.
```
Characters: 191 (no stated limit)

### Mezo integration (if the form asks how you use MUSD or MEZO)

<!-- field: mezo.integration max=0 -->
```text
PayLink uses MUSD as the invoice and payment currency of its Mezo edition, and reads Mezo's own MUSD system, not only the token.
- Borrow to pay, without selling bitcoin: a payer who lacks MUSD is shown the smallest Mezo loan that covers the invoice and the test BTC it locks, computed with BorrowerOperations' own rule from values read live: the minimum debt, the borrowing fee, the 200 MUSD gas compensation and the collateral ratio from BorrowerOperations, the BTC price from MUSD's PriceFeed, recovery mode from TroveManager. The Status page shows the smallest loan too. Read only: PayLink never touches the loan.
- Invoices name MUSD (0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 on Mezo testnet) and an amount in its 18 decimals, signed by the seller with EIP-712: no gas.
- Payment: a plain wallet signs one EIP-2612 permit for exactly the amount under MUSD's own EIP-712 domain ("Mezo USD", version 1), with PayLinkV2 as spender, then sends PayLinkV2.payWithPermit. The contract uses the permit and moves exactly the amount from payer to payee in the same transaction, and emits Paid. A smart account (which cannot sign an MUSD permit, since MUSD checks ECDSA only) approves exactly the amount, then calls pay, or sends both as one EIP-5792 batch.
- Every MUSD property we rely on was read on Mezo testnet: decimals, the permit functions and domain separator, the absence of EIP-3009, no fee or hook, no proxy. The Status page re-reads them live and turns red if MUSD stops matching our registry.
- Mezo's gas rules: the fee is paid in BTC by the payer and at least 50% of the gas limit is charged, so every PayLink call (pay, payWithPermit, cancel) sends a limit from gas bounds measured on a fork of Mezo testnet with the real MUSD; the exact approve before a pay sends its own estimate plus 10%, and a batch's limit is the wallet's. The pay page shows the fee in sats.
- Mezo's RPC: it sometimes answers "not found" for a mined transaction, so PayLink asks again and never calls a real payment invalid.
- Onboarding: the app links Mezo's faucet and Discord for test BTC and Mezo's testnet borrow page for MUSD, and tells a payer whether BTC or MUSD is missing.
Not used yet: Mezo Passport (it needs React; Bitcoin wallets as payers are our wave 2 headline), the MEZO token, and gasless payment (MUSD has no EIP-3009, and PayLinkV2 charges whoever sends a permit payment).
```
Characters: 2,380 (no stated limit)

### Future milestones

<!-- field: mezo.milestones max=0 -->
```text
Wave 1: PayLinkV2's source verified on Mezo's explorer on 2026-10-20 (Exact Match, from the release's standard JSON input, checked against the release before upload).
Wave 2 (Nov 2-15), each item decided and tested on Mezo testnet before it ships:
1. Bitcoin wallets as payers: Mezo Passport (Unisat, OKX, Xverse through Safe smart accounts) on the pay page, paying with approve and pay.
2. Lighter payments for the payer: test whether Mezo includes EIP-7702 transactions, so a sponsor can carry a payment the payer still signs, and find whether an ERC-4337 paymaster exists on Mezo.
3. MEZO as a second currency, once a payment in MEZO through PayLinkV2 is proven on Mezo testnet itself.
4. A testnet pilot with freelancers in Antananarivo, reported as interview counts with their limits, and the Malagasy text reviewed.
5. A full payment history for the merchant's ledger.
Later, only after a third-party audit and a legal review of payments and foreign exchange in Madagascar: Mezo mainnet, and a cash-out path through licensed partners (none exists today).
```
Characters: 1,060 (no stated limit)

### Team

<!-- field: mezo.team max=0 -->
```text
Solo founder: nambininasafidison, a software developer based in Antananarivo, Madagascar. The founder decides scope and design, reviews every change and owns every key, account and submission. Much of the engineering and documentation was done with Claude Code, Anthropic's AI coding tool, under the founder's direction; commits made with it carry a Co-Authored-By trailer, and the repository's AI_DISCLOSURE.md states what it did and was not allowed to do (no keys, no deployments, no submissions).
```
Characters: 499 (no stated limit)

### Repository, deployed address, demo video

| Field | Value |
|---|---|
| Repository | `https://github.com/nambininasafidison/paylink/tree/mezo` once you have pushed the branch (public, MIT). The home page of the repository shows `main`, which has no Mezo edition while Monad and Colosseum are judged: link the branch |
| Live demo | `https://mezo.paylink-mg.pages.dev/mezo/` ([§2](#2-where-judges-see-it-the-preview-of-branch-mezo)) |
| Deployed address | `0x448eCce9711860502806A3d5B021a4f9Ba715082` on Mezo testnet (31611), deployment transaction [`0x1662fb5126d7582947cc77ba2f96266c4f1a561c0e1761f7e4c6249e19e1165e`](https://explorer.test.mezo.org/tx/0x1662fb5126d7582947cc77ba2f96266c4f1a561c0e1761f7e4c6249e19e1165e), block 16183660, 2026-10-16 |
| Demo video | The public (or unlisted) YouTube video titled "PayLink on Mezo: MUSD invoices paid by link (testnet demo)", script [§8](#8-demo-video-script-at-most-200-captions-no-narration) |

### Disclosure (if the form asks for prior work or other events)

<!-- field: mezo.disclosure max=0 -->
```text
Prior work: PayLink v1, a simple payment-link app on Arc, was created on Oct 4-5, 2026; it is frozen and not part of this entry. PayLink v2 (the PayLinkV2 contract, SDK, chain registry, web app with its editions, deploy kit, relayer, indexer, tests and the open invoice specification) was built from Oct 5, 2026 and is entered at Monad Metropolis (Monad edition) and at Colosseum (Base edition). The Mezo edition and everything Mezo-specific were built from Oct 13, 2026, on the branch mezo.
AI: Claude Code (Anthropic) wrote much of the code and documentation under the founder's direction (AI_DISCLOSURE.md).
Third-party code: OpenZeppelin Contracts, viem, qrcode-generator, and the Archivo and Martian Mono fonts (OFL), each under its own licence (NOTICE.md).
```
Characters: 762 (no stated limit)

## 4. The MUSD integration, explained

"Mezo Integration" weighs 30 of 100 in the rubric (**UNVERIFIED**). This is what PayLink actually does with MUSD, step by step; every fact is **C** unless tagged.

| Step | What happens | Where |
|---|---|---|
| The token | The registry names MUSD on Mezo testnet with what was read on chain: 18 decimals, domain `Mezo USD` / `1`, `eip2612: true`, `eip3009: false` | `packages/chains/src/chains/mezo-testnet.ts` |
| The invoice | The seller signs an EIP-712 invoice (PayLink's own domain) naming MUSD and an amount in base units. No transaction. The wallet adds Mezo testnet from the registry (EIP-3085) | `e2e/specs/mezo.spec.ts` (hero flow) |
| The route | The SDK picks the route from the token's flags and the payer's account: a code-less payer gets `payWithPermit`, a smart account gets exact `approve` + `pay`, or one EIP-5792 batch if the wallet offers it. An EIP-3009 route is refused for MUSD (`E_TOKEN_NOT_EIP3009`) | `packages/sdk/src/router.ts`; [ADR 0017](../adr/0017-mezo-edition-chain-layer.md) |
| The permit | One `Permit` signature under MUSD's own domain: owner the payer, spender PayLinkV2, value exactly the amount | `e2e/specs/mezo.spec.ts` checks every field |
| Settlement | `payWithPermit` uses the permit for `msg.sender` and moves exactly the amount from payer to payee in the same transaction; the contract never holds MUSD and leaves no allowance. A second payment of a one-off invoice reverts `SoldOut` | `protocol/src/PayLinkV2.sol`; fork rehearsal in `tools/deploy-page/test/mezo-fork.test.ts` |
| Gas | Each PayLink call (`pay`, `payWithPermit`, `cancel`) sends `clamp(estimate × 1.10, floor, ceiling)` from bounds measured on a fork of Mezo testnet (for `payWithPermit` 161,000 to 242,000), so Mezo's 50 % minimum charge stays below the gas used. The exact `approve` before a `pay` sends its own estimate × 1.10 (approve is not a PayLink call, so it has no registry bounds); an EIP-5792 batch carries no limit, the wallet sets it, and Mezo charges at least half of it. The pay page shows the fee in sats as an upper bound | `packages/chains/data/fork-gas-measurements.json`; `apps/web/src/rails/wallet.ts` |
| The receipt and the till | The receipt is verified against the chain before "Approved"; the till lights only for a verified `Paid` event of its invoice at the exact amount | `e2e/specs/mezo.spec.ts` |
| Status | MUSD is re-read live: symbol, decimals, ERC-5267 domain, `nonces` and `DOMAIN_SEPARATOR` answer, `authorizationState` does not. Red if the chain and the registry disagree | `apps/web/src/editions/mezo/status.ts` |
| Funds | No BTC: the payer is sent to Mezo's faucet and Discord, and the Pay key reads "Check my BTC again". No MUSD: "MUSD has no faucet", with Mezo's testnet borrow page | `apps/web/src/editions/mezo/ui.ts`, `apps/web/src/editions/mezo/links.ts` |
| Borrowing, read live | No MUSD: the smallest Mezo loan that covers the shortfall (at least `minNetDebt`, whole MUSD), the debt it books (+ 0.1 % fee + 200 MUSD gas compensation) and the BTC it locks at MCR (CCR in recovery mode), from BorrowerOperations (in the registry), its PriceFeed and its TroveManager, by `eth_call` only. The Status page shows the smallest loan | `apps/web/src/editions/mezo/borrow.ts`; [ADR 0017](../adr/0017-mezo-edition-chain-layer.md) decision 8 |
| Mezo's RPC | Lookups by hash that answer `null` for a mined transaction are asked again (8 lookups over about 11 s) before anything is concluded; a payment whose receipt is not returned yet reads "sent, not returned yet" with "Check the payment again" | `packages/sdk/src/receipt.ts`, `apps/web/src/pages/pay.ts`; ADR 0017 decision 7 |

**Why no payment is gasless on Mezo.** PayLink's gasless route elsewhere is `payWithAuthorization`, which needs EIP-3009; MUSD has none. `payWithPermit` and `pay` take the payer from `msg.sender`, so a relayer that sent them would pay with its own money. The payer therefore pays a fee of about 0.002 sat (2 × 10⁻¹¹ BTC) at today's prices and must hold a little test BTC ([research §11](../research/mezo.md#11-payment-routes-and-gasless-relaying)).

**Not integrated, and why.** Mezo Passport needs React, wagmi and RainbowKit, and its Bitcoin-wallet accounts are Safe smart accounts that cannot sign an MUSD permit; Mezo's docs call it optional (**C**, [research §9](../research/mezo.md#9-mezo-passport)). MEZO is permit-capable on chain, but a payment in MEZO through PayLinkV2 is untested, because anvil cannot run Mezo's built-in token contracts (**UNVERIFIED**). Both are wave 2 candidates ([§5](#5-what-is-new-in-wave-1-what-comes-in-wave-2)).

## 5. What is new in wave 1, what comes in wave 2

Waves are judged on progress (**UNVERIFIED**, participants' notes). The Mezo work started on Oct 13, 2026, three days before the build window that third-party pages give for wave 1 (Oct 16): the texts say "from Oct 13" and claim nothing about the window. Add what you do during the window (the deployment, the first real payments, the video) to the field below.

<!-- field: mezo.wave1 max=0 -->
```text
New in wave 1 (built from Oct 13, 2026, on top of PayLink v2):
- Mezo testnet in PayLink's chain registry, with every fact read on chain: MUSD's domain and permit support, the absence of EIP-3009, the 50% minimum gas charge, the 10,000-block log window.
- A gas table measured on a fork of Mezo testnet with the real MUSD and CREATE2 factory.
- The browser deploy kit and the verification CLI target Mezo testnet; the deployment was rehearsed on a fork, where it lands at the release address and passes all ten checks.
- The Mezo edition of the app: MUSD invoices, payment by permit, by exact approval, or by one batch for smart accounts, the BTC fee shown in sats, guidance to Mezo's faucet and testnet borrow page, MUSD checked live on the Status page, and its own Content-Security-Policy (Mezo's RPC only). English, French and Malagasy.
- Pay without selling bitcoin: the smallest Mezo loan that covers an invoice, and the test BTC it locks, read live from MUSD's BorrowerOperations, PriceFeed and TroveManager, on the pay page and the Status page.
- Reads that hold on Mezo's public RPC, which sometimes answers "not found" for a mined transaction: the app, the SDK and the deploy tools ask again instead of calling a payment invalid.
- 9 end-to-end tests of the edition on a fork of Mezo testnet with the real MUSD and lending contracts, including Mezo's "not found" answers for mined transactions and accessibility checks in three languages, and 1 of the deploy kit on Mezo testnet's chain id.
- PayLinkV2 deployed on Mezo testnet at 0x448eCce9711860502806A3d5B021a4f9Ba715082 on 2026-10-16, its source verified on Mezo's explorer on 2026-10-20 (Exact Match), and the first real MUSD payment through it on 2026-10-16 (12.50 MUSD, invoice signed by the payee, paid with one permit signature and one transaction).
```
Characters: 1,817 (no stated limit)

**Wave 2 (Nov 2–15, UNVERIFIED dates).** The milestones field above lists them. Each needs its own decision before it is built: Passport brings React and GPL-3.0 code into an MIT app; EIP-7702 sponsorship needs Mezo to include type-4 transactions (**L**) and wallets to support them; ERC-4337 needs a bundler and paymaster on Mezo, and none is known (**UNVERIFIED**); MEZO needs a payment proven on testnet itself ([research §11](../research/mezo.md#11-payment-routes-and-gasless-relaying)).

## 6. Judge access instructions

Paste into the project page or wherever AKINDO asks for test instructions. Fill its four placeholders after the deployment and your rehearsal ([§10](#10-liste-de-contrôle-en-français) steps 4 to 9). The sentence that offers test MUSD is a promise only you can make: keep it or delete it.

<!-- field: mezo.judges max=0 -->
```text
Everything runs on Mezo testnet (chain 31611). You need an EVM browser wallet (MetaMask, Rabby or any EIP-6963 wallet); on a phone, open the links in your wallet's own browser. Bitcoin wallets that need Mezo Passport cannot connect yet.

QUICK LOOK, NO FUNDS (2 minutes)
- Status: https://mezo.paylink-mg.pages.dev/mezo/status/ reads Mezo testnet live: the network, the genuine PayLink contract, MUSD (permit yes, EIP-3009 no), the BTC fee per payment, and the smallest MUSD loan with the BTC it locks, read from MUSD's own contracts.
- A real paid receipt: https://mezo.paylink-mg.pages.dev/mezo/r/#2.31611.0xf44cf47b2b6290ae1014dedbe1b0bf8adf590974a619808b47560b4eed6d22cd.0.P-X5aLYVI8zOWZuZvUwM_DnGZsoRiRekD68c16E9sO9WyG3nlzrFAwAAAAAAAAAArXjrxaxiAAAAAAAAAAAAAAAAAABq2udWAAAAAW2ofx2FnhG7frretwGDNfw5gOiHGNLEjbfrFTjdrsTFPxfZe_U6Zy8jLFAs7MsnW3KlLzXd6EOvICR9BN2RRPU.3fV7lNn-GeYkPjpbe-lhlJ4M6q3Q2jpmeTAvYnOi4bB-RZe2CBAFkWlkRYH-PY92buzmDjyCEtZw8g0kgnbSqhw.TG9nbyBkZXNpZ24g4oCUIHRlc3Q. It re-verifies the payment on chain each time it opens; "View the transaction" opens Mezo's explorer.
- An open invoice: https://mezo.paylink-mg.pages.dev/mezo/pay/#2.31611.P-X5aLYVI8zOWZuZvUwM_DnGZsoRiRekD68c16E9sO9WyG3nlzrFAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABq-T6zAAAAAGXfCaulgtP9E7uvdyQqFi7jkhLhhDXhtcp6dBaul6AyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.XYsebJEGwdYH3Bfcjdnzr0bWbLsieYWhFG0lY-n_4o8wjyGSifD6_cIE3gOd4N_8DzFlw-EhSi5dh3L8cbjAkRw. Its four lamps (signature, network, contract, payable) are read from the chain before anything can be paid.

1. SELLER: SIGN AN INVOICE (1 minute, no funds needed)
- Open https://mezo.paylink-mg.pages.dev/mezo/. Type an amount (for example 1.50) and a memo.
- Press "Connect a wallet to sign" and pick your wallet; the key then reads "Review and sign". Press it: the signing display shows what you are about to sign.
- Press "Sign in wallet". Your wallet adds Mezo testnet if it does not know it, then asks for a signature, not a transaction. No gas.
- The card appears with its QR code: "Copy", "WhatsApp", "Print card", "Show on the till".

2. TILL (optional, 20 seconds)
- "Show on the till", then "Start the till". It lights green only for a verified payment of this invoice at its exact amount.

3. PAYER: PAY IN MUSD (needs MUSD and a little test BTC)
- Open the link with another account (a second browser profile or device).
- Press "Connect a wallet to pay", then "Switch to Mezo testnet" if asked, then "Pay 1.50 MUSD". A plain account signs one permit for exactly the amount, then confirms one transaction. A smart account approves exactly the amount, then pays. The line under the key gives the network fee in sats, paid in BTC by your wallet.
- "Approved" appears once the receipt is verified on chain. "Open the receipt", then "View the transaction".
- No BTC or no MUSD: the page says which is missing and links Mezo's faucet and testnet borrow page. Without MUSD it also shows the smallest Mezo loan that covers the invoice and the test BTC it locks, read live. Test MUSD has no faucet; it is borrowed against test BTC (smallest loan 1,800 MUSD plus a 200 MUSD reserve).
- If you would rather not borrow, send your address to @safidisonraherizo (Telegram or Discord) and we will send you 20 test MUSD and a little test BTC.

4. SELLER: THE BOOKS
- "Ledger" (top menu): each invoice's state read from the contract, the totals and CSV export. "Cancel" then "Confirm cancel" sends one cancel transaction from your wallet (a little BTC).

CHECK IT YOURSELF
- Contract: 0x448eCce9711860502806A3d5B021a4f9Ba715082 on Mezo testnet, deployed in transaction 0x1662fb5126d7582947cc77ba2f96266c4f1a561c0e1761f7e4c6249e19e1165e (block 16183660, 2026-10-16); the same address and bytecode as on Monad testnet and Base Sepolia.
- MUSD: 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503.
- Source and tests: https://github.com/nambininasafidison/paylink/tree/mezo. The Mezo parts: apps/web/src/editions/mezo, e2e/specs/mezo.spec.ts, docs/adr/0017-mezo-edition-chain-layer.md, docs/research/mezo.md.
- Language: EN, FR or MG at the top of every page.
```
Characters: 4,075 (no stated limit)

## 7. Honest limitations

For the reviewers and for you. The texts above already say the ones that matter to a judge.

| Limitation | Effect | What we say |
|---|---|---|
| Testnet only, not audited | No real money; Mezo's own dApp listing needs a third-party audit and mainnet (**C**, Mezo docs) | "Testnet only, not audited"; the contract review is our own (335 Foundry tests, 100 % line and branch coverage, 63 of 63 mutants killed) |
| No gasless payment | Every payer needs a little test BTC, about 0.002 sat per payment (the app shows an upper bound under 0.005 sat); a merchant's cancellation is a transaction too | Said in the app (lead notes, pay page, Status) and in the texts |
| Mezo's RPC answers `null` for some mined transactions | "Approved" can take a few seconds more; rarely the pay page says "not returned yet" and offers "Check the payment again", and a receipt link may need "Try again" | ADR 0017 decision 7; not in the texts beyond "asks again" |
| The borrow estimate is a floor | It is the minimum collateral at Mezo's ratio at the price read now; a loan that close to it is liquidated by a small fall of bitcoin | The app says "Lock more to stay clear of liquidation"; PayLink never opens or touches a loan |
| Test MUSD is borrowed, not dispensed | A tester needs at least about 0.0265 test BTC of collateral to mint the smallest loan; judges may hold no MUSD | The app explains it; the judge instructions offer to send MUSD (your call) |
| Faucet unverified from here | The faucet's drip and cooldown are **UNVERIFIED** (the page cannot be reached from the sandbox). The borrow page is Mezo's testnet one, `testnet.mezo.org/feature/borrow` (**C**, Mezo's user guide); `mezo.org/feature/borrow` is the Mainnet app | The app links the testnet borrow page only |
| No Mezo Passport, no Bitcoin wallets | Unisat, OKX or Xverse users cannot pay yet | Said on the wallet picker; wave 2 candidate |
| No MEZO token | Only MUSD (and native BTC in the registry) | Wave 2 candidate, once proven on testnet |
| Served from a preview, not production | The URL is `mezo.paylink-mg.pages.dev`; production stays on `main` during the other events' judging | [§2](#2-where-judges-see-it-the-preview-of-branch-mezo) |
| Ledger history | No indexer for Mezo: "Payments received" lists recent blocks only, and says over what period | — |
| Gas bounds from a fork | Measured with anvil's Ethereum gas schedule; only the deployment estimate is confirmed equal on Mezo itself (**L** for the rest). The table is provisional until re-measured on chain | [ADR 0017](../adr/0017-mezo-edition-chain-layer.md) |
| Explorer links | `explorer.test.mezo.org/tx/…` follows Blockscout's layout (**L**); the explorer could not be reached from here | Check "View the transaction" in the rehearsal |
| Malagasy | The 51 Mezo strings in Malagasy, and the 2 core strings added for an unconfirmed payment, are machine drafts pending the founder's review (`packages/i18n/src/locales/mg.review.json`) | "Malagasy under review by the founder" |
| Issuer risk | The MUSD owner can authorise addresses that burn MUSD from any account | Disclosed on the create page |
| Market | No users, revenue, partners or interviews yet; no cash-out to ariary | Hypotheses only, in every text |
| Rules | Rubric, tracks, dates and fields are from third-party pages (**UNVERIFIED**) | Check them on AKINDO before submitting |

## 8. Demo video script (at most 2:00, captions, no narration)

**Goal:** one real MUSD invoice on Mezo testnet, from signature to verified receipt, in under two minutes. No voice: every message is a caption. Sound: none, or only the till's chime; music only if it is royalty-free.

**Rules** ([demo recording runbook §1](../runbooks/demo-recording.md#1-honesty-rules)): real testnet transactions only; measured numbers only (the "settled in" figure is measured on the device; never edit it); mark every cut ("cut: waiting for the block"); say "testnet" on screen; never "audited"; nothing private on screen.

**Preconditions**

- [ ] PayLinkV2 deployed on Mezo testnet and recorded; `https://mezo.paylink-mg.pages.dev/mezo/status/` all green with your pushed commit.
- [ ] A laptop with Chrome, two profiles, each with MetaMask: profile **Payee** with a plain account named "Rakoto Design" (a little test BTC; no MUSD needed), profile **Payer** with a plain account named "Client" holding at least 20 MUSD and some test BTC. MetaMask's smart-account mode off on both (the payer then takes the permit route). Both wallets already know Mezo testnet (add it off camera, once).
- [ ] Dark theme (moon key at the top), English, Do Not Disturb, bookmarks bar hidden, no other extension, window at 1280 × 800.
- [ ] Rehearse the whole take once the day before ([§10](#10-liste-de-contrôle-en-français) step 9). That rehearsal is also your first real MUSD payment.

| # | Time | Screen and exact clicks | Caption (bottom third, white on dark band) |
|---|---|---|---|
| 1 | 0:00–0:07 | Payee: `https://mezo.paylink-mg.pages.dev/mezo/`, the hero "Sign a link. Get paid in MUSD." and the MEZO network band | "PayLink · Mezo testnet · invoices in MUSD, the Bitcoin-backed dollar" |
| 2 | 0:07–0:20 | Type amount `12.50`, memo `Logo design, invoice 042`. Press **Review and sign**; hold on the signing display "You are about to sign this invoice" | "A freelancer in Antananarivo bills a client abroad" then "What you sign, before you sign it" |
| 3 | 0:20–0:32 | Press **Sign in wallet**; MetaMask shows a signature request (typed data, no fee); approve it. The card with its QR code appears | "One EIP-712 signature. No transaction, no gas, no sign-up" |
| 4 | 0:32–0:40 | Payee: **Show on the till** (opens the till), **Start the till**; it waits | "Till armed for this exact invoice" |
| 5 | 0:40–0:50 | Payee: **Copy**. Payer profile: paste the link in the address bar. Hold on the four lamps | "Checked on Mezo before you can pay: signature, network, contract, payable" |
| 6 | 0:50–1:02 | Payer: **Connect a wallet to pay**, pick MetaMask, connect. The key reads **Pay 12.50 MUSD**; hold on "One signature, then one transaction from your wallet." and the "Network fee: about … sat" line | "MUSD supports permits (EIP-2612): one signature, one transaction. Fee in BTC, a fraction of a sat" |
| 7 | 1:02–1:17 | Press **Pay 12.50 MUSD**. MetaMask: the permit signature request (spender `0x448e…5082`, 12.5 MUSD); approve it. Then the transaction request (fee in BTC); approve it | "Permit for exactly 12.50 MUSD, under MUSD's own domain" then "payWithPermit: straight from the client's wallet to the seller's" |
| 8 | 1:17–1:27 | Payer: "Approved", "Paid in full", "settled in N.N s". If you trim the wait for the block, show the cut label | "Receipt verified on chain · time measured on this device" (and "cut: waiting for the block" if trimmed) |
| 9 | 1:27–1:34 | Payee: the till turns green, **Paid** | "The till lights only for a verified Paid event at the exact amount" |
| 10 | 1:34–1:46 | Payer: **Open the receipt** (Payment found · Genuine contract · Matches the invoice), then **View the transaction**: the transaction on `explorer.test.mezo.org` | "Real testnet transaction · Mezo testnet" |
| 11 | 1:46–1:55 | Payee: **Ledger**: the invoice reads Paid, the total 12.50 MUSD. Then the footer's **Status**: "MUSD on the network" green | "Every state read from the contract · MUSD checked live" |
| 12 | 1:55–2:00 | Hold on the ledger or a title card | "PayLink · github.com/nambininasafidison/paylink · testnet · not audited" |

**If something fails while recording**

| Problem | Do this |
|---|---|
| The pay key reads "Check my BTC again" | The Payer account has no BTC for the fee: fund it off camera, press the key, retake from shot 6 |
| "This account holds 0.00 MUSD." | Wrong account, or MUSD not sent yet: fix off camera, retake from shot 5 |
| The key reads "Switch to Mezo testnet", or MetaMask asks to add or switch to Mezo testnet | Press it, approve in MetaMask; keep it in the take or retake |
| The route note says "Two transactions: approve exactly this amount, then pay." | The Payer account is a smart account (MetaMask smart-account mode on): use a plain account, or keep it and change caption 6 to "A smart account approves exactly the amount, then pays" |
| The status page says "Not deployed yet" or a red lamp | Stop: the deployment record is not in the preview yet. Tell Claude |
| "View the transaction" does not open the transaction | Open `https://explorer.test.mezo.org` and search the hash by hand, on camera; tell Claude the right URL form |
| A notification, a personal detail, the wrong theme | Retake the shot |

**Upload:** YouTube, public or unlisted, title "PayLink on Mezo: MUSD invoices paid by link (testnet demo)". Description: "Testnet demo on Mezo testnet (chain 31611). Contract 0x448eCce9711860502806A3d5B021a4f9Ba715082. Source: https://github.com/nambininasafidison/paylink/tree/mezo. Not audited." Captions burned into the picture, so the video works muted.

## 9. Disclosures and commit range

| Item | Disclosure |
|---|---|
| Pre-existing work | PayLink v1 (Arc), commits `31a4fdd` (2026-10-04) and `93ed4e3` (2026-10-05), frozen ([ADR 0010](../adr/0010-arc-stays-on-v1.md)). PayLink v2 from `88ac2d9` (2026-10-07; the work started on Oct 5) to `0c3bfed` (2026-10-12): the contract, SDK, registry, web app, deploy kit, relayer, indexer, tests and specification, entered at Monad Metropolis and Colosseum |
| Built for this buildathon | The branch `mezo`, from `f0fb1ce` (2026-10-13, the research notes) to the submitted commit: Mezo testnet in `packages/chains`, the deploy kit and `tools/verify-deployment`; the Mezo edition (`apps/web/src/editions/mezo/`, the `mezo` catalogues in `packages/i18n`); `e2e/specs/mezo.spec.ts`, `e2e/specs/deploy-mezo.spec.ts`; [ADR 0017](../adr/0017-mezo-edition-chain-layer.md), [research](../research/mezo.md), this pack |
| Unchanged | `protocol/src` (PayLinkV2 is immutable and already released); production (`main`), `/monad/` and `/base/` |
| Other events | Monad Metropolis (Monad edition) and Colosseum (Base edition), same repository and contract; v1 is the Arc Microgrants entry. Their texts, written before Oct 13, call a Mezo edition "planned, not built": true when written |
| AI tools | Claude Code (Anthropic), under the owner's direction; commits carry a `Co-Authored-By: Claude` trailer ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)) |
| Third-party components | OpenZeppelin Contracts 5.3.0, viem, qrcode-generator, the Archivo and Martian Mono fonts (OFL) ([NOTICE.md](../../NOTICE.md)). No Mezo package is shipped |
| Tag | `submission/mezo-wave1-<date>` on the submitted commit, created and pushed by you |

## 10. Liste de contrôle (en français)

Dans l'ordre. Ne pousse jamais `main` : seulement la branche `mezo`. Les étapes « Claude » se font dans une session Claude Code.

**Avant tout le reste : les étapes 3 à 9, au plus tôt, bien avant le 24 octobre.** Tant que PayLinkV2 n'est pas déployé et enregistré, rien ne peut être signé ni payé dans l'édition Mezo : ni le parcours des juges, ni le lien de reçu, ni la vidéo ne peuvent être vérifiés en direct, et les vagues sont jugées sur les progrès (non vérifié). Fais le déploiement et les premiers paiements pendant la fenêtre du 16 au 26 octobre, note leurs dates et donne-les à Claude pour le champ « vague 1 » ([§5](#5-what-is-new-in-wave-1-what-comes-in-wave-2)).

1. **Discord et AKINDO.** Rejoins le Discord de Mezo (`https://discord.com/invite/mezo`) avec le compte que tu déclares sur AKINDO. Vérifie ton inscription au Mezo Buildathon, puis lis sur AKINDO l'heure exacte de clôture de la vague 1 (le 26 octobre), les champs du formulaire et leurs limites : ce dossier n'a pas pu les lire.
2. **BTC de test.** Crée deux comptes MetaMask simples et neufs, « Rakoto Design » (vendeur, il déploie aussi) et « Client » (payeur). Demande du BTC de test sur `https://faucet.test.mezo.org` (captcha) pour les deux. Pour emprunter du MUSD il faut au moins environ 0,0265 BTC de test de garantie (prévois 0,04) : si le robinet donne moins, demande dans `#testnet` sur le Discord.
3. **Prévisualisation, puis la branche.** D'abord, dans Cloudflare Pages, projet `paylink-mg` : Settings → Build → Branch control → Preview branch « Custom branches », inclure seulement `mezo` ; ajoute à l'environnement **Preview** `NODE_VERSION` = `22.22.0`, `PNPM_VERSION` = `10.28.0`, `SKIP_DEPENDENCY_INSTALL` = `1` ([§2](#2-where-judges-see-it-the-preview-of-branch-mezo)). Ensuite `git push origin mezo` (jamais `main` ; ou demande-le explicitement à Claude). Vérifie que `https://mezo.paylink-mg.pages.dev/mezo/status/` répond (« Build » donne ton commit, édition `mezo`) et que `https://paylink-mg.pages.dev/monad/` n'a pas changé.
4. **Déployer PayLinkV2 sur Mezo testnet** ([deploy runbook §8](../runbooks/deploy.md#8-mezo-testnet)). Ouvre `https://mezo.paylink-mg.pages.dev/v2/deploy/?chain=mezo`. Vérifie l'`initCodeHash` `0x289dcd64…7ac5` et l'adresse `0x448eCce9711860502806A3d5B021a4f9Ba715082` (sinon, arrête). MetaMask en compte standard (mode smart account désactivé), MEZO, « Switch wallet to Mezo testnet », accepte le réseau (31611, BTC). Tous les voyants verts, **Deploy**, confirme sans toucher la limite de gas.
5. **Enregistrer.** Quand les 10 vérifications passent, télécharge `31611.json` et donne-le à Claude avec le hash de la transaction et la date. Claude revérifie, committe l'enregistrement, régénère registre, kit et relais, ajoute le déploiement au README du dépôt, remplit adresse et hash dans ce dossier, puis fait les cinq captures d'écran Mezo (`pnpm --filter @paylink/e2e capture 03-mezo`, sur un fork) et prépare le fichier de vérification du code source (`python3 script/standard-input.py`, [deploy runbook §8](../runbooks/deploy.md#8-mezo-testnet) étape 9).
5 bis. **Vérifier le code source sur l'explorateur, le même jour.** Sur `https://explorer.test.mezo.org/address/0x448eCce9711860502806A3d5B021a4f9Ba715082`, « Verify & publish » avec « Solidity (Standard JSON input) », compilateur `v0.8.30+commit.73712a01`, le fichier que Claude t'a préparé, contrat `src/PayLinkV2.sol:PayLinkV2`, sans arguments de constructeur (noms de menus non vérifiés : l'explorateur est injoignable depuis le bac à sable). Donne le lien à Claude, qui l'ajoute à ce dossier et au README.
6. **Repousser.** `git push origin mezo`. Sur `https://mezo.paylink-mg.pages.dev/mezo/status/` : le contrat Mezo est vert (« Genuine contract »), MUSD vert, « Build » donne ton commit.
7. **MUSD de test.** Avec « Rakoto Design », connecte-toi sur `https://testnet.mezo.org`, puis emprunte au moins 2 000 MUSD sur `https://testnet.mezo.org/feature/borrow`. N'utilise jamais `https://mezo.org/feature/borrow` : le guide de Mezo dit que c'est l'application **Mainnet**, avec de vrais BTC. Envoie 50 à 100 MUSD et un peu de BTC à « Client ».
8. **Lien pour les juges.** Sur `/mezo/`, crée un lien à montant libre (montant vide, « Unlimited », 30 jours).
9. **Répétition = premier vrai paiement.** Facture de 12,50 MUSD signée par « Rakoto Design », payée par « Client » (une signature permit, une transaction). Ouvre le reçu, puis « View the transaction » sur l'explorateur. Garde le lien du reçu et note la date. Avec un compte qui a du MUSD mais pas de BTC, regarde aussi si l'application testnet de Mezo propose « Get Gas » (un échange sans frais de MUSD contre un peu de BTC) et dis-le à Claude : s'il existe, la ligne « pas de BTC » pourra le citer.
10. **Vidéo.** Tourne la démo ([§8](#8-demo-video-script-at-most-200-captions-no-narration)) : au plus 2 min, sous-titres, sans voix. Mets-la sur YouTube.
11. **Remplir et soumettre.** Donne à Claude le lien du reçu, le lien à montant libre, la vidéo, ton pseudo Discord ou Telegram et les dates (ou remplace toi-même chaque `[TO FILL: …]`, puis `python3 docs/tools/submission_fields.py --update`). Sur AKINDO : piste 2, chaîne Mezo, les textes du [§3](#3-project-page-and-form-fields) et du [§6](#6-judge-access-instructions), le dépôt `…/tree/mezo`, l'adresse, la vidéo. Soumets avant le 26 octobre (vise le 24), puis pose le tag `submission/mezo-wave1-<date>` et pousse-le.
12. **Pendant le jugement (27 oct.–1er nov.).** Laisse la prévisualisation en ligne, ne pousse rien de cassant sur `mezo`, garde du MUSD et du BTC de test pour les juges, et surveille le Discord.
