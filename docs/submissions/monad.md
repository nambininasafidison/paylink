# Monad Metropolis: submission pack

| | |
|---|---|
| **Event** | Monad Metropolis, Track 02 "Consumer Products & Payments", with four bounties: Agora (Best Cross-Border Payments App), Envio (Best Use of Envio), Best Mera-Powered UX on Monad, Mera "One Passkey, Many Keys" |
| **Deadline** | Final submission **2026-10-14 03:59 UTC** (Oct 14, 06:59 EAT) (**UV**, FACTS 2026-10-06); our target **Oct 12, 20:00 UTC** |
| **Status** | Paste-ready, with `[TO FILL: …]` placeholders only where a fact does not exist yet (a URL, a video, an interview count). The project is a **draft** on the Metropolis dashboard with its track and four bounties selected (**UV**, FACTS 2026-10-08) |
| **Written** | 2026-10-09, from the repository at `d9662c3` plus this pack, and checked against the chain the same day (below) |
| **Who submits** | The owner, from the owner's account. Claude Code drafts only ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)) |
| **Checklist** | [README.md](README.md#1-monad-metropolis) says what is done and what you must still do, in order |

Every text in a `text` block is the exact text to paste. The line under it is its length in characters, checked by `python3 docs/tools/submission_fields.py` (run it with `--update` after you edit a field). Replace every `[TO FILL: …]` or delete the sentence that holds it; never paste a placeholder.

## Contents

1. [Facts this pack relies on](#1-facts-this-pack-relies-on)
2. [Form fields](#2-form-fields)
3. [Go-to-market and user acquisition](#3-go-to-market-and-user-acquisition)
4. [Judge access instructions](#4-judge-access-instructions)
5. [Bounty answers](#5-bounty-answers)
6. [Disclosures and commit range](#6-disclosures-and-commit-range)

## 1. Facts this pack relies on

Checked from the sandbox on 2026-10-09 unless stated otherwise. If one of them changes, change the texts that use it.

| Fact | Value | Evidence |
|---|---|---|
| Contract | PayLinkV2 2.0.0 at `0x448eCce9711860502806A3d5B021a4f9Ba715082` on Monad testnet (10143) | `protocol/deployments/10143.json`; `eth_getCode` at that address returns the runtime code (checked 2026-10-09) |
| Deployment transaction | `0xb86e75367a73e933f3c99a6092357f4b785bf7fdd2c4b299c193e4f903cb4d6a`, block 69331735, CREATE2 | the record above; [MonadVision](https://testnet.monadvision.com/tx/0xb86e75367a73e933f3c99a6092357f4b785bf7fdd2c4b299c193e4f903cb4d6a) |
| Same contract on Base Sepolia (84532) | same address, block 47859253 | `protocol/deployments/84532.json`, `eth_getCode` checked 2026-10-09 |
| Contract tests | 335 Foundry tests in 32 suites, all passing; 100 % lines and branches of `src/`; 63 of 63 mutants killed; Slither 0 untriaged | `forge test` run on 2026-10-09 (again after the review fixes); `protocol/audit/README.md` |
| TypeScript tests | 1,452 passing (SDK 564, web 351, chains 204, relayer 131 plus 3 opt-in fork tests skipped, deploy page 74, design 29 with this pack's 8 brand tests, indexer 28, i18n 27, ESLint config 25, verify-deployment 19) | `pnpm -r test` on 2026-10-09, after the review fixes |
| End-to-end tests | 31 Playwright tests on the production build, all passing | same run |
| Live product | `https://paylink-mg.pages.dev/monad/` | Cloudflare Pages project `paylink-mg` (FACTS 2026-10-07). **Not checked from the sandbox today** (the proxy refused the host); check it yourself ([README §1](README.md#1-monad-metropolis)) |
| Relayer (gasless payments, test AUSD, gasless cancel) | built and tested; **not deployed yet** | [relayer runbook](../runbooks/relayer.md) |
| History indexer (Envio) | built and tested; **not deployed yet**; `/config.json` has `"indexer": null` | [Envio runbook](../runbooks/envio.md) |
| Payments on the real testnets | **none yet**: no `Paid` or `InvoiceCancelled` event from the contract between its deployment and Monad block 69424550, nor on Base Sepolia up to block 47872756 | `eth_getLogs` over every block since each deployment, in the RPCs' 100- and 200-block windows, 2026-10-09 ~03:00 UTC. Your demo recordings will make the first ones |
| Users, revenue, partners, interviews | none to report as of 2026-10-09 | the research protocol is ready ([interview script](../research/interview-script.md)); no session is recorded in the repository |

## 2. Form fields

### Primary track

`Consumer Products & Payments` (Track 02), already selected on the draft.

### Project logo

`docs/submissions/assets/logo-1024.png` (1024 × 1024 PNG, 135 kB; the form wants PNG, JPG or WEBP, at least 500 px, at most 2 MB and 4 MP). `logo-512.png` is the same mark at 512 px. Both are rendered from `packages/design/brand/mark.svg`, the app's own mark ([assets](README.md#3-assets)).

### Project name

<!-- field: monad.name max=120 -->
```text
PayLink
```
Characters: 7 / 120

### One-line description

<!-- field: monad.one-line max=200 -->
```text
Dollar invoices you share as a link: your client pays in AUSD on Monad with a fingerprint (Mera passkey), holds no gas token, and both sides keep a receipt anyone can verify.
```
Characters: 174 / 200

### Description

<!-- field: monad.description max=8000 -->
```text
PayLink turns a dollar invoice into a link. A freelancer or a small shop signs the invoice once, shares it on WhatsApp or as a printed QR code, and the client, anywhere, pays it in AUSD with a fingerprint. The money goes straight from the payer to the payee through an immutable contract, and both sides keep a receipt that anyone can re-verify on chain.

WHO IT IS FOR
PayLink is built in Antananarivo for people in Madagascar who are paid from abroad: freelancers, small merchants, and the clients and relatives who pay them. Our working hypothesis, which we are testing in structured interviews (the protocol is in the repository; we claim no results yet), is that being paid from abroad is slow, costly or uncertain for them, and that a link the payer opens on a phone, with no app to install and no gas token to buy, removes most of the friction on the paying side.

WHAT A USER DOES ON MONAD (paylink-mg.pages.dev/monad/)
1. Create a PayLink key. A Mera passkey is the whole account layer, for the merchant and for the payer: no wallet extension, no seed phrase, no MON. One fingerprint creates the passkey, and its PRF output derives the account.
2. Sign an invoice. The merchant types an amount and what it is for. A signing display shows exactly what the fingerprint will sign (amount, address grouped by four, network, expiry), then one fingerprint signs an EIP-712 invoice. Creating it costs no gas and works offline. The link, a QR card that prints on A6, WhatsApp and the system share sheet are ready at once.
3. Pay. The payer opens the link. Four lamps are read from the chain before the Pay key unlocks: the signature is valid, the network is right, the contract is the genuine PayLink release (registry address, masked code hash, EIP-712 immutables), and the invoice is still payable. The payer creates their own PayLink key; on testnet, "Get 10,000 test AUSD" asks Agora's AUSD faucet through our relayer, so the payer never needs MON. The signing display says "Pay exactly this, once", one fingerprint signs an EIP-3009 authorization, and the relayer submits payWithAuthorization. The token nonce is derived on chain from the invoice, the payer, the amount and a reference, so the relayer can delay a payment but cannot redirect it, and the payer can send the same signed authorization themselves.
4. Get paid. The receipt is verified on chain before the screen says Approved, with "settled in N.N s" measured on the payer's device. The merchant's till (a phone or tablet on the counter) lights green and chimes only for a verified Paid event of the armed invoice, at its exact amount. The ledger merges the device's invoices with the contract's statesOf, lists the payments received from the chain's latest blocks (an Envio HyperIndex indexer for the full history is built and tested in apps/indexer; until it is online, the ledger says it reads only the latest blocks), exports CSV, and cancels an invoice with one fingerprint and no gas (cancelBySig).
5. Send and receive. Every account has a receive card: an open-amount link printed with its QR code. Contacts saved in the address book are paid in two taps, and the pay view shows "Saved as ..." or an amber "first payment to this address" warning.
6. Keep the books. A second PRF namespace of the same passkey (paylink.books.v1) derives an AES-256-GCM key that encrypts the merchant's books into a file only that passkey can open, on any device it syncs to.
The app is in English, French and Malagasy (the founder is reviewing the Malagasy), with an ariary estimate that is labelled as an estimate and never used in a payment.

WHY MONAD, IN WHAT WE ACTUALLY USE
- Monad charges the gas limit, not the gas used, so every transaction sends clamp(estimate x 1.10, floor, ceiling) from per-function gas bounds measured on anvil's Monad emulation, not a padded guess.
- The public RPC caps eth_getLogs at 100 blocks, so the till polls from head - 10 every second, and a merchant's full history needs an indexer: an Envio HyperIndex indexer over HyperSync is built and tested (apps/indexer); until it is online, the ledger reads the chain's latest blocks and says so.
- The relayer never sends value, which keeps it clear of Monad's reserve-balance rule.
- Blocks are fast enough for a payment to feel like a card tap. We show the time measured on the payer's device instead of quoting a figure.

UNDER THE HOOD
- PayLinkV2 (Solidity 0.8.30, OpenZeppelin 5.3.0, paris bytecode) is immutable, ownerless and fee-less. Settlement is exact-delta: the contract never keeps funds. It is deployed on Monad testnet at 0x448eCce9711860502806A3d5B021a4f9Ba715082 (CREATE2), the same address as on Base Sepolia.
- 335 Foundry tests (unit, fuzz and 11 invariants), 100% line and branch coverage of the contract, 63 of 63 hand-written mutants killed, Slither with no untriaged result. This is our own review, not a third-party audit.
- More than 1,400 TypeScript unit and integration tests (SDK, web app, relayer, indexer, chain registry) and 31 Playwright end-to-end tests on the production build, with Chromium's WebAuthn virtual authenticator and PRF, the relayer process and axe-core WCAG 2.2 AA checks.
- A strict Content-Security-Policy with Trusted Types, no third-party script, a frame lock, and passkeys pinned to one origin.
- An open invoice specification (EIP-712 types, key derivation, payment binding, URL encodings, receipt verification) with a JSON Schema and test vectors, so any wallet can issue or pay a PayLink invoice.

HONEST STATUS
Testnet only, not audited. PayLink v1, a simpler payment-link contract on Arc, was written on Oct 4-5, 2026; everything in this entry (the v2 contract, the Monad edition, Mera, the relayer, the indexer, the ledger backup) was built from Oct 5 on, with Claude Code (AI) doing much of the engineering under the founder's direction. The founder owns every decision, key and submission.
```
Characters: 5,894 / 8,000

<a id="description-with-the-indexer"></a>**Only once the indexer answers** ([README §1](README.md#1-monad-metropolis) step 9 done, and on `/monad/status/` the "History service" lamp is green and reads "Monad testnet: indexed to block …"), replace the two sentences above that say "until it is online" with these, word for word; otherwise paste the Description as it is, which is true either way. Each replacement is shorter than the sentence it replaces, so the text stays within the limit.

Step 4 ("Get paid"), replace the sentence that starts "The ledger merges":

```text
The ledger merges the device's invoices with the contract's statesOf, lists the payments received from an Envio HyperIndex indexer (falling back to the chain's latest blocks), exports CSV, and cancels an invoice with one fingerprint and no gas (cancelBySig).
```

"Why Monad", replace the second item:

```text
- The public RPC caps eth_getLogs at 100 blocks, so the till polls from head - 10 every second, and history comes from an Envio HyperIndex indexer over HyperSync instead of the browser.
```

### GitHub repository

`https://github.com/nambininasafidison/paylink` (public, MIT). Push `main` first: the ledger backup, the history indexer, this pack and the fixes after its review are local commits ([README §1](README.md#1-monad-metropolis)). The repository's home page then shows [`.github/README.md`](../../.github/README.md), the v2 README the T&C ask for (problem and user, both editions, the contract and its transactions, architecture, setup, the pre-existing v1, what was built, AI use, attributions); the root `README.md` is v1's, frozen. Check after the push that the home page opens on "PayLink" with the Monad and Base editions, not on v1's "shareable USDC payment links on Arc".

### Live product

`https://paylink-mg.pages.dev/monad/` (Monad testnet). Check before pasting that it serves the v2 app, not v1 ([README §1](README.md#1-monad-metropolis)).

### Technical demo video, pitch video, Agora demo video

Scripts: [video-scripts.md](video-scripts.md) (a), (b) and (c). Links: `[TO FILL: YouTube URL, public]` for each.

### Product advertisement (optional, at most 30 s)

Optional. [video-scripts.md §5](video-scripts.md#5-optional-30-second-advertisement) cuts one from the demo footage.

### X profile (optional)

`[TO FILL: your X handle, or leave empty]`

## 3. Go-to-market and user acquisition

<!-- field: monad.gtm max=8000 -->
```text
Everything below is a plan or a hypothesis to test, not a result. As of October 9, 2026, PayLink has no users, no revenue and no partners, and we do not claim any.

THE PROBLEM WE ARE TESTING
Our hypothesis is that freelancers and small merchants in Madagascar who are paid from abroad find it slow, costly or uncertain today, and that the person asking for the money does most of the chasing. We test this in structured, consented interviews with freelancers, merchants and payers abroad (protocol and consent text in the repository). Results so far: [TO FILL: "n of N" counts from the interviews actually held, or "none yet"].

WHO WE START WITH (hypotheses)
1. Beachhead: Malagasy freelancers with clients abroad (design, development, translation, remote assistance). They already send invoices and chase payments, and their clients already pay online. PayLink gives them a signed dollar invoice they share on WhatsApp in seconds, with no fee and no sign-up.
2. Small merchants who serve visitors and the diaspora: a printed receive card with a QR code at the counter, and a till that lights up only when the payment is verified on chain. This tests whether a verifiable receipt and an instant "paid" signal matter at a counter.
3. Payers abroad: clients, employers, and members of the Malagasy diaspora who pay people and small businesses at home. They never sign up; their only step is a passkey on the phone they already use. Because every invoice puts PayLink in front of a payer at the moment of paying, payers are also our main acquisition channel.

HOW WE REACH THEM (planned channels)
- Founder-led outreach in Antananarivo, where the founder lives and works: [TO FILL: the freelancer, developer and student communities you actually belong to]. Each first user is onboarded in person or on a call, in Malagasy or French; the app already speaks both.
- The product loop: each invoice reaches a payer, and some payers are paid by others too. We measure how many payers later create their own invoice.
- WhatsApp first: the share sheet, the wa.me link and a printed A6 card are built in, because that is where invoices already travel.
- Monad and Agora communities, for testers and for AUSD liquidity once on mainnet.
- Content in Malagasy and French showing one real (testnet) payment end to end, with the receipt anyone can check.

PRICING (hypotheses)
- The core stays free. The contract takes no fee and cannot be changed to take one: it is immutable and ownerless. Our cost per gasless payment is the relayer's gas, which we will measure on testnet before any price is set.
- "PayLink Business": a subscription for accounting export, webhooks, team access and branded cards. Price to be tested; interviews only count past spending on invoicing or bookkeeping tools as evidence, never "would you pay".
- Later, referral revenue from licensed cash-out partners. None exists today.

WHAT MUST BE TRUE (our riskiest assumptions)
- Cash-out: PayLink pays in digital dollars and does not convert them to ariary. Users need a local cash-out path; we will only point to licensed providers, and we have no partnership today.
- Acceptance of digital dollars by both sides.
- Regulation: payment and foreign-exchange rules in Madagascar must be reviewed with counsel before any mainnet launch. We make no compliance claim.
- Passkeys with PRF on the phones our users actually have (iCloud Keychain, Google Password Manager or 1Password).

HOW WE MEASURE IT
- Activation: share of new PayLink keys with a first paid invoice within 7 days.
- Time to get paid: median from issuing an invoice to its first payment (the ledger already computes it on the device).
- Repeat payers per merchant, from the indexer's payer-to-payee records.
- Payer-to-merchant conversion: payers who later issue an invoice.
- Share of payments that are gasless, relayer cost per payment, and relayer refusals.
- Cash-out completion, reported by users, once a path exists.

NEXT 90 DAYS (plan)
1. October: at least 6 interviews, reported as "n of N" with their limitations; a testnet pilot with merchants from the founder's network.
2. November: fix what the pilot shows; publish the open invoice specification as a standalone document others can implement.
3. December: an external review of the contract if funding allows; Monad mainnet (chain 143 is already in our registry, disabled) only after a cash-out path and a legal review exist.
```
Characters: 4,415 / 8,000

## 4. Judge access instructions

Optional and private on the form. Paste it once the relayer answers (README §1, P0); until then the gasless steps cannot work, and the text says so in its first paragraph, which you delete once the relayer is up.

<!-- field: monad.judges max=8000 -->
```text
[TO FILL: delete this paragraph once https://paylink-relayer.raherizonambinina.workers.dev/v1/health answers. Until then: the fee service is offline, so "Get 10,000 test AUSD", gasless payments and gasless cancel do not work; the contract checks, the invoice, the receipt and the till do.]

Everything runs on Monad testnet (chain 10143). Nothing to install, no wallet, no MON.

WHAT YOU NEED
- A phone or computer whose passkey manager supports the PRF extension: iCloud Keychain (recent iPhone or Mac, Safari), Google Password Manager (Android, Chrome) or 1Password. If PayLink says "This passkey cannot hold a PayLink key (no PRF)", use one of those.
- Two passkeys to see both sides, the merchant's and the payer's: use a second device or a second browser profile for the payer (one browser profile remembers one PayLink key at a time).
- Open https://paylink-mg.pages.dev/monad/ itself: PayLink keys work only on that exact address.

1. MERCHANT: SIGN AN INVOICE (about 1 minute)
- Open https://paylink-mg.pages.dev/monad/. Type an amount (for example 12.50) and a memo.
- "Use my PayLink key to sign": opens the KeyCard. Type a name for the key and press "Create my PayLink key", then confirm with your fingerprint or screen lock. This creates a passkey; its PRF output derives your Monad account. PayLink never sees or stores the key.
- The signing display shows what you are about to sign. The orange key under it ("Sign in wallet"; with a PayLink key it asks for your fingerprint, there is no wallet) signs. No transaction, no gas: the invoice is an EIP-712 signature.
- The card appears with its QR code. "Copy" copies the link, "WhatsApp" opens a chat with it, "Print card" prints it on A6, "Show on the till" opens the counter display.

2. MERCHANT: ARM THE TILL (optional, 20 seconds)
- "Show on the till", then "Start the till". It waits, and lights green with a chime only for a verified payment of this invoice at its exact amount.

3. PAYER: PAY WITH A FINGERPRINT (about 1 minute)
- Open the link with the payer's device or profile. The display shows the amount and the memo; four lamps (signature, network, contract, payable) are read from the chain before anything can be paid. Any red lamp locks payment.
- "Use my PayLink key to pay": create the payer's key the same way.
- "Get 10,000 test AUSD": our relayer asks Agora's AUSD testnet faucet to fund your new account. The faucet serves one request a minute for everyone; if it says to wait, wait a minute.
- Read the signing display ("Pay exactly this, once": amount, address, network, valid for 10 minutes, fee covered), then press "Pay 12.50 AUSD" and confirm with your fingerprint. You sign an EIP-3009 authorization; the relayer submits it. Your account holds no MON at any point.
- "Approved" appears once the receipt is verified on chain, with the settlement time measured on your device. The till lights up.
- "Open the receipt": the receipt page re-checks the payment against the chain every time it opens. "View the transaction" opens it on MonadVision.

4. MERCHANT: THE BOOKS
- "Ledger" (top menu): every invoice signed on this device, its state read from the contract (statesOf), the totals, and CSV export.
- "Cancel" then "Confirm cancel" on an open invoice: one fingerprint, no gas (cancelBySig through the relayer).
- "Payments received": [TO FILL: "from the Envio indexer" once it is deployed, else "from the chain's latest blocks only; the history service is not deployed"]. Each row has "Verify receipt".
- "Ledger backup": "Back up my ledger" encrypts the books with a second key from the same passkey and downloads a file; "Restore from a file" opens it again, on any device the passkey syncs to.

5. SEND AND RECEIVE
- "Send" (top menu): "Create my receive card" makes an open-amount link with a QR code. Paste someone's receive card link under "Save a contact" with a name; "Send" next to that name opens it, you type any amount and press "Send AUSD", then confirm with your fingerprint.

6. CHECK EVERYTHING YOURSELF
- "Status" (footer, under "System"): the contract on Monad testnet checked live (code and immutables match release 2.0.0), the relayer and the history service.
- Contract: 0x448eCce9711860502806A3d5B021a4f9Ba715082 on Monad testnet, deployed in transaction 0xb86e75367a73e933f3c99a6092357f4b785bf7fdd2c4b299c193e4f903cb4d6a (block 69331735). Same address on Base Sepolia.
- Source, tests and threat model: https://github.com/nambininasafidison/paylink

IF SOMETHING FAILS
- "The service that covers the network fee did not answer": the relayer is down or out of gas. Nothing was charged; the signature is kept, so pressing Pay again later sends the same one.
- "PayLink keys are not available here": open https://paylink-mg.pages.dev/monad/ in Safari or Chrome directly, not inside another app.
- Language: EN, FR or MG at the top of every page.
```
Characters: 4,859 / 8,000

## 5. Bounty answers

The forms ask one question per bounty; none states a length limit (**UV**, FACTS 2026-10-08). Each answer below says what is built and where, and nothing more.

### 5.1 Agora: Best Cross-Border Payments App

Question: the core features that let a user send AUSD to another person or across borders. The bounty also needs a demo video of at most 2 minutes showing passkey onboarding, an AUSD balance and a completed send or receive settled instantly: [video-scripts.md (c)](video-scripts.md#3-c-agora-demo-at-most-200).

The bounty also asks for **"a mobile app"** (**UV**, FACTS 2026-10-08). Whether an installable web app (PWA) counts is not known: the question is [Q5 of the forum page](monad-forum.md#q5-agora-does-an-installable-pwa-count-as-a-mobile-app-post-or-check). The answer below says what PayLink is: a PWA, with no app-store app. Keep its "Mobile:" sentence only if the rehearsal installed PayLink from the browser and paid from its home-screen icon ([video-scripts.md §0.2](video-scripts.md#02-devices-pick-one-setup-and-rehearse-it-once-the-day-before)); [README §1](README.md#1-monad-metropolis) step 7 says what to do with the organisers' answer.

<!-- field: monad.bounty-agora max=0 -->
```text
PayLink makes AUSD the default dollar of its Monad edition and lets anyone send it across borders in two ways, both settled by one contract call on Monad testnet:
1. Pay an invoice. A merchant in Antananarivo signs a dollar invoice (EIP-712, no gas) and shares it as a link or QR code; a client anywhere opens it and pays it in AUSD.
2. Send to a person. Every account has a receive card, an open-amount payment link with a QR code. Save someone's card in the address book once, then press "Send" next to their name, type any amount, and pay.
How AUSD moves: the payer signs an EIP-3009 authorization for Agora's AUSD with a fingerprint (a Mera passkey; no wallet, no MON), and our relayer submits PayLinkV2.payWithAuthorization. The contract calls AUSD's receiveWithAuthorization and forwards exactly the amount to the payee in the same transaction; the authorization's nonce is derived on chain from the invoice, payer, amount and reference, so the relayer cannot redirect the money. The receipt is verified on chain before the payer sees "Approved", with the settlement time measured on their device, and the merchant's till lights up for that payment.
Onboarding: "Get 10,000 test AUSD" has the relayer call Agora's AUSD testnet faucet (requestFunds) for a new account, so neither side ever holds MON. The app shows the account's AUSD balance when it is too low to pay, then offers the faucet.
Mobile: PayLink is a mobile-first installable PWA (web manifest with standalone display, service worker): "Add to Home Screen" in iOS Safari, or "Install app" in Android Chrome, installs it with its own icon. Every page is checked at phone widths from 320 to 390 px in the end-to-end suite, and the Monad payment runs end to end on a phone-sized screen.
Real AUSD: the gasless payment was run against Agora's AUSD and its faucet on an anvil fork of Monad testnet (relayer fork test, and the screenshots in docs/submissions/assets).
Where: protocol/src/PayLinkV2.sol (payWithAuthorization), apps/web/src/pages/pay.ts and send.ts, apps/web/src/rails/authorization.ts, apps/web/src/app/funds.ts, apps/relayer/ (pay and onboard endpoints). Contract: 0x448eCce9711860502806A3d5B021a4f9Ba715082.
Not built: Agora's Instant Settlement product, and conversion to local currency.
```
Characters: 2,268 (no stated limit)

### 5.2 Envio: Best Use of Envio

Question: a project that meaningfully uses HyperIndex, HyperSync or HyperRPC to power real on-chain data, actually driving a feature. **It qualifies only once the indexer is deployed and `/config.json` names it** ([Envio runbook](../runbooks/envio.md), README §1 P1). Until then, do not tick this bounty with this text. Fill the two placeholders from the runbook's §5 checks on submission day.

<!-- field: monad.bounty-envio max=0 -->
```text
PayLink's history indexer (apps/indexer) is an Envio HyperIndex 3.12.1 project sourced from HyperSync. It indexes our PayLinkV2 contract's Paid and InvoiceCancelled events on Monad testnet from its deployment block (69331735), and on Base Sepolia, into seven entities: Invoice, Payment, Payee, PayeeToken, PayerPayee, DailyVolume and DailyActivity.
It drives the merchant's books in the live app. The ledger's "Payments received" lists every payment to the signed-in merchant, across devices, newest first, each with a "Verify receipt" link that the receipt page re-checks on Monad RPC; it shows the merchant's record ("N payments received since <date> · M payers") and volume per token, and the indexer's first-payment time gives the typical time to get paid for links paid several times. The status page shows how far the index has processed each chain.
Why Envio: Monad's public RPC caps eth_getLogs at 100 blocks, so a browser cannot rebuild a merchant's history. Without the indexer, the app reads only the last 10 log windows and says so.
The indexer is a cache by design: payment states come from the contract (statesOf) and receipts from RPC, so a stale index can never make an unpaid invoice look paid; a test fails if payment or receipt code imports the indexer client. The arithmetic is pure, and the handlers are tested with Envio's createTestIndexer on simulated logs (28 tests, offline).
Endpoint: [TO FILL: the GraphQL URL from the Envio runbook §3]. Indexed to block [TO FILL: from _meta on submission day].
```
Characters: 1,523 (no stated limit)

### 5.3 Mera: Best Mera-Powered UX on Monad

Question: Mera as the entire account layer.

<!-- field: monad.bounty-mera-ux max=0 -->
```text
In PayLink's Monad edition, Mera is the only account layer, for the merchant and for the payer. There is no wallet extension, no WalletConnect, no Dynamic or Privy, and no seed phrase: a "PayLink key" is a Mera passkey.
- Create: the KeyCard explains what the key is ("Your phone is the vault"), says it is a test network, and "Create my PayLink key" calls createPasskeyWithPrfOutput. The account is Mera's documented derivation of the PRF output (BIP-39, then m/44'/60'/0'/0/0, secp256k1), checked against an independent viem implementation.
- Sign: every signature goes through getPasskeyPrfOutput, a Mera secp256k1 signing session and toViemAccount, and the key exists in memory only for that one signature. The device keeps only the credential ID, the address and a label.
- Know what you sign: Mera shows no wallet popup, so PayLink shows a signing display before the fingerprint that signs an invoice or a payment: the amount, the address grouped by four, the network, the expiry or how long the payment signature stays valid, and who pays the fee. A cancellation asks for a second press ("Confirm cancel") before its fingerprint.
- Never need MON: the merchant signs invoices off-chain (EIP-712, no gas); the payer signs an EIP-3009 authorization that our relayer submits; cancellations are signed too (cancelBySig); and test AUSD comes from Agora's faucet through the relayer. A brand-new passkey account can be paid and can pay with zero MON.
- Safe by default: the passkey rpId is pinned to paylink-mg.pages.dev at build time and ceremonies run only on that exact host, so a preview deployment can never use a production key; a passkey that belongs to another account is refused.
- Tested: Chromium's WebAuthn virtual authenticator with PRF drives the whole flow end to end (two PayLink keys, onboarding, a gasless fingerprint payment at 0 MON, the till, a gasless cancel, a receive card), on the production build.
Where: apps/web/src/accounts/mera.ts and passkey.ts, apps/web/src/app/key-ui.ts (KeyCard), e2e/specs/editions.spec.ts. Mera SDK: @category-labs/mera 0.2.0, pinned and loaded lazily.
```
Characters: 2,106 (no stated limit)

### 5.4 Mera: One Passkey, Many Keys

Question: Mera in non-account work (at least one PRF namespace does non-account work).

<!-- field: monad.bounty-mera-keys max=0 -->
```text
PayLink uses one Mera passkey for two independent keys.
- Namespace mera.prf.salt.v1 is the account: Mera's derivation turns its PRF output into the secp256k1 key that signs invoices, payments and cancellations.
- Namespace paylink.books.v1 does non-account work: it encrypts the merchant's books. Its salt is SHA-256("paylink.books.v1"), evaluated through Mera's getPasskeyPrfOutput with one fingerprint, pinned to the credential the device recorded. HKDF-SHA-256 turns the output into an AES-256-GCM key, which encrypts the books on this device (invoices with their memos, receipts, saved receive cards, the address book) into a downloadable file. The file's header (account, network, time, salt, key check, IV) is authenticated, so changing any field breaks decryption.
The two outputs are unrelated, so the books key can never sign, and the code that asks for it cannot ask for the account's namespace: the list of work namespaces is closed and refuses the account's.
"Restore from a file" opens the backup on any device the passkey syncs to. A file made with another passkey is refused ("Not made with your passkey"), an altered file fails its integrity check, another account's file is refused before any prompt, and every restored record passes the device store's checks and the merchant's signature. Nothing is stored: the PRF output is wiped once WebCrypto holds it, and the keys are non-extractable and live for one call.
Tested: crypto vectors from an independent Python implementation, the RFC 5869 and AES-GCM vectors, tampering of every header field; and end to end, one browser profile backs up, a second restores with the same passkey, the test decrypts the file with node:crypto from the books namespace only, and searches both profiles' storage for key material (none).
Where: apps/web/src/accounts/namespaces.ts, apps/web/src/books/, docs/adr/0016-ledger-backup-second-prf-namespace.md, e2e/specs/books.spec.ts.
```
Characters: 1,930 (no stated limit)

## 6. Disclosures and commit range

For the form's description and for any judge who asks. The T&C copies require pre-existing components and AI use to be disclosed (**L**, PAYLINK-V2-SPEC §2.1).

| Item | Disclosure |
|---|---|
| Pre-existing work | PayLink v1 (Arc contract and web app): commits `31a4fdd` (2026-10-04) and `93ed4e3` (2026-10-05), inside the hackathon period. It is frozen and is not part of the Monad edition ([ADR 0010](../adr/0010-arc-stays-on-v1.md)) |
| Built for this event | Everything from `88ac2d9` (2026-10-07, the first v2 commit; the work started on Oct 5) to the submitted commit: `protocol/` (PayLinkV2), `packages/`, `apps/web` (Monad edition), `apps/relayer`, `apps/indexer`, `e2e/`, `docs/` |
| Shared with other events | The same repository and contract also serve the Base edition (Colosseum, [colosseum.md](colosseum.md)); v1 is the Arc Microgrants entry. Mezo and PayPal editions are planned, not built |
| AI tools | Claude Code (Anthropic) wrote much of the code and documentation under the owner's direction; commits carry a `Co-Authored-By: Claude` trailer ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)) |
| Third-party components | OpenZeppelin Contracts 5.3.0, viem, `@category-labs/mera`, Envio, Hono, zod, qrcode-generator, the Archivo and Martian Mono fonts (OFL) ([NOTICE.md](../../NOTICE.md)) |
| Tag | `submission/monad-2026-10-12` on the submitted commit (PAYLINK-V2-SPEC §10), created by you when you submit |
