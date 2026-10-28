# PayPal AI Hackathon (Devpost): submission pack, PayLink Twin

| | |
|---|---|
| **Event** | PayPal AI Hackathon on Devpost ("Build what's next with PayPal and AI"), `https://paypalaihackathon.devpost.com/`. No tracks; the honourable mentions that fit are "Best Use of PayPal + AI" and "Best Use of Agentic Commerce" (one honourable mention at most per project) ([rules §7](../research/paypal/rules.md#7-prizes-usd)) |
| **Deadline** | **2026-11-12 12:00 PST = 20:00 UTC = 23:00 in Antananarivo** (S2: two participant copies of the official rules agree, [rules §2](../research/paypal/rules.md#2-dates)). Plan: feature freeze 2026-10-29, submission about 2026-11-01 ([SPEC, decisions of 2026-10-21](../paypal/SPEC.md#decisions-of-2026-10-21)). Judging Dec 1–15 (S1); the demo stays live and free until 2026-12-15 |
| **Status** | Paste-ready, with `[TO FILL: …]` placeholders only where a fact does not exist yet: the Sepolia deployment, the live URLs once you have checked them, the video, the judge links and logins. **Nothing can be signed or paid on the live edition until PayLinkV2 is deployed on Ethereum Sepolia** ([§10](#10-liste-de-contrôle-en-français) step 5) |
| **Written** | 2026-10-22, on the branch `paypal` (branched from `mezo` at `ffd952f`), by the integration step that applied every workstream's handoff; the commit that adds this file is `git log -1 -- docs/submissions/paypal.md` |
| **Who submits** | The owner, from the owner's Devpost account. Claude Code drafts only ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)) |
| **Checklist** | [§10](#10-liste-de-contrôle-en-français), in French; going live step by step: [PayPal runbook](../runbooks/paypal.md) |

Every text in a `text` block is the exact text to paste. The line under it is its length in characters, checked by `python3 docs/tools/submission_fields.py` (run it with `--update` after you edit a field). Devpost's form for this hackathon could not be read from here (**UNVERIFIED**, [rules §0](../research/paypal/rules.md#0-how-to-read-this-file)): the fields below follow Devpost's usual project page (name, elevator pitch, story, built with, links, video) and what the rules ask the description to say ([rules §9](../research/paypal/rules.md#9-required-deliverables-s2-ah-unless-marked)). Map each text to the closest field. Replace every `[TO FILL: …]` or delete the sentence that holds it; never paste a placeholder.

Tags: **C** confirmed (on chain, in a primary file, or by a test in this repository), **S** a participant copy or snippet of an official page, **UNVERIFIED** not checked.

## Contents

1. [Facts this pack relies on](#1-facts-this-pack-relies-on)
2. [Where judges see it](#2-where-judges-see-it)
3. [Devpost fields](#3-devpost-fields)
4. [The PayPal integration, explained](#4-the-paypal-integration-explained)
5. [The AI, explained](#5-the-ai-explained)
6. [Judge access instructions](#6-judge-access-instructions)
7. [Honest limitations](#7-honest-limitations)
8. [Video storyboard (under 3:00, captions, no invented numbers)](#8-video-storyboard-under-300-captions-no-invented-numbers)
9. [Disclosures and commit range](#9-disclosures-and-commit-range)
10. [Liste de contrôle (en français)](#10-liste-de-contrôle-en-français)

## 1. Facts this pack relies on

Checked on 2026-10-22 unless stated otherwise. If one of them changes, change the texts that use it.

| Fact | Value | Evidence |
|---|---|---|
| The product | The PayPal edition of PayLink, "PayLink Twin", at `/paypal/`: one EIP-712-signed invoice payable on two rails, a PayPal Invoicing v2 "twin" (PayPal's hosted invoice page, sandbox) and USDC or PayPal USD on Ethereum Sepolia through the unchanged PayLinkV2 contract; a collections desk that reconciles both rails and proposes the next step; an assistant on Cloudflare Workers AI that drafts invoices and words proposals, and can only propose | [ADR 0018](../adr/0018-paypal-edition.md); `apps/web/src/editions/paypal/`; `apps/api/` |
| Contract on Ethereum Sepolia (11155111) | **Not deployed yet.** `0x448eCce9711860502806A3d5B021a4f9Ba715082` holds no code; the CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` is there. Every screen says "not deployed" until you deploy with the kit ([runbook §9](../runbooks/paypal.md#9-paylinkv2-on-ethereum-sepolia)) | [sepolia.md](../research/paypal/sepolia.md) (**C**) |
| Deployment gas | Sepolia runs Amsterdam: `eth_estimateGas` of the CREATE2 deployment is 19,249,557 on Sepolia (19,240,803 on a fork); a first USDC payment by EIP-3009 authorisation uses 457,705 gas and a cancellation 146,812, on the fork. The registry and the kit were re-measured under these rules on 2026-10-22, before any real deployment | [sepolia.md §5](../research/paypal/sepolia.md#5-gas-sepolia-runs-amsterdam-read-2026-10-22); `packages/chains/data/fork-gas-measurements.json` (**C**) |
| Tokens | Circle USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (the default and the demo's) and PayPal USD (PYUSD, Paxos) `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9`, both with EIP-3009 and EIP-2612 on Sepolia. No test PYUSD could be obtained (faucet.paxos.com is geo-blocked from Madagascar), so PYUSD is paid only on fork rehearsals | [SPEC D-CHAIN](../paypal/SPEC.md#d-chain-ethereum-sepolia-11155111-not-arbitrum-sepolia) (**C** on chain) |
| PayPal | Sandbox only. REST app "PayLink Twin". Invoicing v2 and Webhooks: twelve operations in `apps/api/src/paypal/client.ts` ([§4](#4-the-paypal-integration-explained)), none that captures, refunds, pays out or disputes money. Built against PayPal's OpenAPI files (`paypal-rest-api-specifications` at `90e8041`, vendored in `apps/api/test/openapi/`) and a fake validated against them; `api-m.sandbox.paypal.com` is not reachable from the build machine, so every live sandbox behaviour is **UNVERIFIED** until your capture run ([runbook §3, §5](../runbooks/paypal.md#5-what-the-capture-decides)) | `apps/api/test/openapi/contract.test.ts` |
| PayPal Agent Toolkit | Not a dependency. The desk's read tools take the toolkit's tool names and parameter schemas (`list_invoices`, `get_invoice`, `search_invoicing`), parity-tested against the vendored sources of `@paypal/agent-toolkit` 1.11.0. Wording rule: "follows the PayPal Agent Toolkit tool contract", never "built with" it ([SPEC §7.6](../paypal/SPEC.md#76-paypal-agent-toolkit-paypalagent-toolkit-1110)) | `apps/api/test/ai/parity.test.ts` |
| AI in the product | Cloudflare Workers AI through the Worker's `AI` binding: `@cf/google/gemma-4-26b-a4b-it`, fallback `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; free allocation 10,000 neurons a day; chosen from Cloudflare's docs repository at `3fe915d`. **No live call has been made yet**: the model's quality (A1 extraction, French and Malagasy) is unmeasured until your live evals; the CI evals replay scripted answers and measure code only | `apps/api/src/ai/models.ts`; [evals](../../apps/api/evals/README.md) |
| The fence | The desk's situation table S0–S9 decides which actions exist for each invoice, with their exact values; an approval is an HMAC token over the proposal's hash, single use; a cancellation of the PayLink link is signed and sent by the payee's own wallet; the API holds no chain key | [reconciler README](../../apps/api/src/reconciler/README.md) |
| Tests | On 2026-10-22, on this branch: 335 Foundry tests (the contract is unchanged); 2,113 TypeScript unit and integration tests (API 448, web app 494, SDK 573, chain registry 238, relayer 131, deploy kit 83, the other packages 146), plus 19 opt-in fork and workerd tests not run by default; 92 Playwright end-to-end tests passing and 1 opt-in skipped, 51 of them for the PayPal edition (its shell 9, every screen state 39, both rails 3); v1's 7 | `forge test`; `pnpm -r test`; `e2e/specs/paypal.spec.ts`, `e2e/specs/paypal-ui.spec.ts`, `e2e/specs/paypal-rails.spec.ts` |
| L3, both rails end to end | On an anvil fork of the real Ethereum Sepolia (PayLinkV2 deployed on the fork at its release address, real Circle USDC) with the PayPal fake: (a) paid on PayPal, verified webhook, the desk's cancel proposal, the payee's own `cancel`; (b) paid in USDC, automatic record on the PayPal twin, Undo; (c) injections in the memo and the PayPal note with a model that obeys them. On 2026-10-22 each case passed 8 times in 8 runs (two single runs and two runs with `--repeat-each=3`; Playwright retries off), about 42 s, 10 s and 8 s each | `e2e/specs/paypal-rails.spec.ts` |
| Where it is served | Web: the Cloudflare Pages preview of the branch `paypal`, `https://paypal.paylink-mg.pages.dev/paypal/` (not online until you add `paypal` to the preview branches). API: the Worker `paylink-api`, expected at `https://paylink-api.raherizonambinina.workers.dev` (not created yet). Production (`main`) is unchanged | [runbook §7, §8](../runbooks/paypal.md#7-the-pages-preview-of-the-branch-paypal) |
| Users, revenue, partners | None to report | — |
| Organisers | Madagascar is eligible; prizes are paid by mail or bank wire (the owner's Discord thread with Devpost, 2026-10-20, **S**). Unanswered: a US sandbox merchant, PYUSD, the AI provider, whether the testing instructions are private | [SPEC, decisions of 2026-10-21](../paypal/SPEC.md#decisions-of-2026-10-21) |

## 2. Where judges see it

| What | Where | Ready when |
|---|---|---|
| The edition | `https://paypal.paylink-mg.pages.dev/paypal/` | [runbook §7](../runbooks/paypal.md#7-the-pages-preview-of-the-branch-paypal) done and a push built |
| Status of every service | `https://paypal.paylink-mg.pages.dev/paypal/status/` (PayLink API, PayPal sandbox, PayPal webhook, assistant with today's neurons left, API store, contract) | same |
| The API | `https://paylink-api.raherizonambinina.workers.dev/v1/health` | [runbook §8](../runbooks/paypal.md#8-the-worker-paylink-api) and the secrets of §2 |
| Paying with PayPal | PayPal's sandbox payer page, reached from the pay page's **Pay with PayPal** key, with a sandbox buyer login | [runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links) |
| The source | `https://github.com/nambininasafidison/paylink/tree/paypal` (MIT); the branch's landing page has a section "PayPal edition (PayLink Twin)" with a judges' tour | the push of `paypal` |
| Running it without any account | `pnpm --filter @paylink/e2e test specs/paypal-rails.spec.ts` (both rails against an anvil fork of Sepolia and the PayPal fake) | now |

Judges may score from the text and the video alone and are not required to run anything ([rules §6](../research/paypal/rules.md#6-judging)): the video carries most of the weight.

## 3. Devpost fields

### Project name

<!-- field: paypal.name max=0 -->
```text
PayLink Twin
```
Characters: 12 (no stated limit)

### Elevator pitch

Devpost's usual limit is 200 characters (**UNVERIFIED** for this form; the specification's outline used 200).

<!-- field: paypal.tagline max=200 -->
```text
One invoice link your client can pay on PayPal or in USDC. An AI desk keeps both rails in agreement and proposes the next step; it never signs and never moves money.
```
Characters: 165 / 200

### About the project

Devpost's story field takes Markdown. Before pasting, fill the two placeholders of "Honest status" or delete their sentences.

<!-- field: paypal.story max=0 -->
```text
## Inspiration

PayLink is built in Antananarivo for freelancers who are paid from abroad. Their clients want to pay the way they already do: many with PayPal, some with dollars on chain. Offering both today means two invoices for one job, two places to watch, and a real chance of being paid twice, or of chasing a client who already paid. Madagascar is where this started, and where it is sharpest: secondary sources say Malagasy PayPal accounts may be able to send but not receive (we could not verify it), so a freelancer there cannot count on the PayPal rail alone, and the same invoice's on-chain rail is the one that still gets them paid. The product is for freelancers anywhere PayPal lets them receive, with Madagascar as the case that shows why one invoice should carry both rails. Our working hypothesis, which we are testing in structured interviews and claim no results for, is that the chasing and the checking are the hard part. PayLink Twin gives one signed invoice two rails, PayPal and dollars on chain (USDC, or PayPal USD), and gives the follow-up to a desk that can propose but cannot touch the money.

## What it does

1. **Draft.** The freelancer pastes the client's message ("Love it! Send me the invoice, $120, I'll pay by Friday"). The assistant extracts what the job is, the client and the due-date phrase; code parses the amount and the date from the message itself, so a number the model invents never becomes the invoice amount. Every value lands in an editable form.
2. **Sign.** One EIP-712 signature in the freelancer's wallet makes the PayLink invoice: a link and a QR card, no transaction, no gas.
3. **Twin it on PayPal.** One tap creates a PayPal invoice for the same amount, with the link's key in PayPal's own reference field, shares it, and reads it back from PayPal before saying it exists.
4. **One link, two rails.** The client opens the link. Four checks are read from the chain first (signature, network, genuine contract, still payable). Then "Pay with PayPal" goes to PayPal's hosted invoice page, shown only when PayPal's amount equals the signed amount and PayPal's page is on a host pinned in the code; or the client pays in USDC (or PayPal USD) on Ethereum Sepolia from their own wallet, with one EIP-3009 authorisation.
5. **Paid means checked.** A PayPal webhook is verified with PayPal and then only triggers a read of the invoice from PayPal; a chain payment counts only as a verified Paid event at the exact amount. The freelancer's till turns green "via PAYPAL · verified with PayPal" or for the chain payment, never because of a message.
6. **The collections desk.** For every invoice, a deterministic table of ten situations reads both rails and decides what may happen next, with exact values. Paid on PayPal: cancel the PayLink link so the client cannot pay twice (the freelancer taps, then signs the cancellation in their own wallet). Paid on chain: the payment is recorded on the PayPal invoice automatically, with an Undo for 24 hours, so both books agree. Overdue: PayPal's own reminder, or a reminder message in the client's language for the freelancer to send. Cancelled on one rail: cancel on the other. Paid twice: an alert with the refund steps, never automatic. "Check my invoices" reads every open invoice again on PayPal and on the chain.
7. **Was I really paid?** Paste a payment notice; the verdict (received, partly, not received, can't check now) comes from PayPal and the chain only, never from the notice.
8. **Status.** One page shows the API, PayPal, the last verified webhook, the assistant's neurons left today, the store and the contract.

The app is in English, French and Malagasy, and is tested at 320 px wide in light and dark themes with axe-core.

## How we built it

**PayPal.** PayPal REST in the sandbox, from a Cloudflare Worker: OAuth 2.0 client credentials (the token cached in a Durable Object); Invoicing v2 search (by our reference, so a retried twin is found instead of duplicated), create, send, get (the truth for every PayPal state), record payment, delete payment (Undo), cancel and remind; Webhooks verify-webhook-signature (the delivery's raw bytes posted back to PayPal) and webhook creation for INVOICING.INVOICE.PAID, CANCELLED and UPDATED. Every write carries a PayPal-Request-Id; a write whose answer is lost is settled by reading, never repeated blind. The client has no operation that captures, refunds, pays out or disputes money. The desk's read tools follow the PayPal Agent Toolkit tool contract (names and schemas parity-tested against @paypal/agent-toolkit 1.11.0) and read only the freelancer's own reconciled invoices. Because PayPal's sandbox API could not be reached from our development environment, we built against PayPal's OpenAPI files and a PayPal fake whose every answer is validated against those schemas, plus a capture script that records the sandbox's real behaviour; whatever we could not observe is marked UNVERIFIED in the repository.

**AI.** Cloudflare Workers AI through the Worker's binding: @cf/google/gemma-4-26b-a4b-it, with @cf/meta/llama-3.3-70b-instruct-fp8-fast as fallback. Two jobs. Drafting: one structured call; personal data is replaced by placeholders before the model sees the message, and code parses amounts and dates. The desk: six read tools and propose_action, which only queues a proposal if the deterministic fence allows that action, and keeps the fence's values, never the model's; a reminder's text is kept only if its amount, its dates and its invoice number are that invoice's own, as code reads them from the record. Seven invariants are each enforced by a named test: the model cannot sign or submit a transaction, cannot move PayPal money, every effect needs a tap on exact values, no model text on money screens, numbers come from code, payment truth is PayPal's GET or the chain, untrusted text is data. Memos, PayPal notes and client names never reach the desk's model. An injection suite of 40 cases blocks a release, and an end-to-end test drives a model that obeys every injected instruction through the real provider, desk and fence: only the fence's own proposals survive. The assistant runs on the free daily allocation; when it is spent, it rests and every manual path works.

**Chain and app.** PayLinkV2 (Solidity 0.8.30, OpenZeppelin 5.3.0): immutable, ownerless, fee-less, exact-delta settlement, deployed by CREATE2 at the same address on every chain. API: Hono and zod on Cloudflare Workers, SQLite-backed Durable Objects (one per payee, one global), one cron a minute. Web: strict TypeScript without a UI framework, a PWA with its own Content-Security-Policy and Trusted Types, viem.

**Tests.** 335 Foundry tests for the contract; more than 2,100 TypeScript unit and integration tests, 448 of them for the API; 92 Playwright end-to-end tests, 51 of them for this edition: every screen state in English, French and Malagasy, light and dark, with axe-core, and both rails end to end on a fork of the real Ethereum Sepolia with Circle's USDC contract and the PayPal fake.

## Challenges we ran into

- No live PayPal sandbox from our development environment: contract-tested fake, capture script, UNVERIFIED tags.
- Two rails echo each other: PayLink's own record on the PayPal invoice must never look like a second payment. An echo filter matches PayPal's payment method, our note naming the chain transaction, and a verified Paid event in that transaction.
- Ethereum Sepolia now runs Amsterdam, whose state-creation gas makes our contract's deployment cost about 19.2 million gas, seven times what our registry assumed. We caught it on a fork of the real chain and re-measured every gas bound before any real deployment.
- Prompt injection everywhere: client messages, memos and PayPal notes are untrusted text, and the agent's tools can only propose.

## Accomplishments that we're proud of

- An agent that reads both rails and proposes useful next steps, yet structurally cannot move money: the fence is code, approvals are bound to exact values, and the chain cancellation is the freelancer's own signature.
- Both rails end to end, repeated eight times each without a failure on a fork of the real Ethereum Sepolia: paid on PayPal, then the verified webhook, the desk's proposal and the freelancer's own cancellation on chain; paid in USDC, then the automatic record on the PayPal invoice and its Undo; and injected instructions in a memo and in a PayPal note that change nothing, even with a model built to obey them.

## What we learned

PayPal's GET of an invoice is a better source of truth than any event; webhooks are hints. An agent becomes trustworthy when its tools are narrower than its prompt. Measured numbers beat assumed ones: the gas surprise came from a fork, not from documentation.

## What's next

Run the live sandbox capture and pin PayPal's real behaviours; publish a live, dated eval scoreboard; per-freelancer PayPal onboarding instead of one demo merchant; PayPal USD as soon as test tokens can be obtained; mainnet only after a legal review of payments and foreign exchange in Madagascar.

## Honest status

PayPal sandbox and Ethereum Sepolia testnet only; no real money. One sandbox PayPal merchant stands for every freelancer in the demo; whether a Malagasy PayPal account can receive is unverified, and the product claims nothing about it. Not audited: our own review only. No users, revenue or partners yet. PayLinkV2 on Ethereum Sepolia: [TO FILL: deployed on <date>, transaction <hash>]. Built during the hackathon, from 2026-10-21, on top of PayLink v2 (built from 2026-10-05, also entered in other events); the commit range is in the repository. [TO FILL: the live evals' date and scores, or delete this sentence.]

AI in the product: Cloudflare Workers AI (@cf/google/gemma-4-26b-a4b-it, fallback @cf/meta/llama-3.3-70b-instruct-fp8-fast). Development assisted by Claude Code (Anthropic); the owner directed, reviewed and is responsible for the work.
```
Characters: 9,979 (no stated limit)

### Built with

Devpost takes tags; paste them one by one. The Agent Toolkit is not in the list: the product follows its tool contract without running it ([§1](#1-facts-this-pack-relies-on)).

<!-- field: paypal.built-with max=0 -->
```text
paypal-invoicing, paypal-webhooks, paypal-sandbox, cloudflare-workers-ai, gemma, llama, cloudflare-workers, cloudflare-durable-objects, cloudflare-pages, typescript, hono, zod, viem, solidity, ethereum-sepolia, usdc, pyusd, playwright, vitest, fast-check, foundry
```
Characters: 263 (no stated limit)

### PayPal technologies used (if the form asks)

<!-- field: paypal.paypal-tech max=0 -->
```text
PayPal REST APIs in the sandbox, called from our Cloudflare Worker (apps/api/src/paypal/client.ts):
- OAuth 2.0 client credentials: POST /v1/oauth2/token
- Invoicing v2: search-invoices, create, send, get, record payment, delete payment, cancel, remind (POST /v2/invoicing/search-invoices; POST /v2/invoicing/invoices; POST .../{id}/send; GET .../{id}; POST .../{id}/payments; DELETE .../{id}/payments/{transaction_id}; POST .../{id}/cancel; POST .../{id}/remind)
- Webhooks: POST /v1/notifications/verify-webhook-signature on every delivery; POST /v1/notifications/webhooks to subscribe to INVOICING.INVOICE.PAID, INVOICING.INVOICE.CANCELLED and INVOICING.INVOICE.UPDATED
- PayPal's hosted invoice page (sandbox) as the payer's PayPal rail
- PayPal Agent Toolkit tool contract: the desk's read tools use its tool names and parameter schemas, parity-tested against @paypal/agent-toolkit 1.11.0 (not run as a dependency)
- PayPal USD (PYUSD) on Ethereum Sepolia as a stablecoin rail next to USDC (rehearsed on a fork; no test PYUSD could be obtained)
No capture, refund, payout or dispute call exists in the code.
```
Characters: 1,112 (no stated limit)

### AI tools and models used (if the form asks)

<!-- field: paypal.ai-line max=0 -->
```text
AI in the product: Cloudflare Workers AI (@cf/google/gemma-4-26b-a4b-it, fallback @cf/meta/llama-3.3-70b-instruct-fp8-fast). Development assisted by Claude Code (Anthropic); the owner directed, reviewed and is responsible for the work.
```
Characters: 235 (no stated limit)

### What was built during the hackathon (if the form asks about significant updates)

<!-- field: paypal.updates max=0 -->
```text
The hackathon opened on 2026-10-01. PayLink's first commit is 2026-10-04: PayLink v1 (Oct 4–5) and PayLink v2 (the contract, SDK, chain registry and web app, from Oct 5) were built for other events (Arc Microgrants, Monad Metropolis, Colosseum, the Mezo Buildathon), where they are also entered. Everything PayPal and everything AI was built for this hackathon, on the branch paypal from 2026-10-21 (first commit 828b9ff): Ethereum Sepolia with USDC and PayPal USD in the chain registry and the deploy kit; the API Worker (PayPal client, webhook verification, twins, the reconciler and its fence, approvals, sessions, Durable Objects, cron); the Workers AI assistant (drafting and the collections desk) with its invariants, injection suite and evals; the PayPal edition of the web app (assistant sheet, twin panel, two-rail pay page, desk, till via PayPal, Status); and the end-to-end tests of both rails. The PayLinkV2 contract itself is unchanged.
```
Characters: 949 (no stated limit)

### Try it out (links)

- `https://paypal.paylink-mg.pages.dev/paypal/` [TO FILL: check it answers, after the preview is built]
- `https://github.com/nambininasafidison/paylink/tree/paypal`

### Video

[TO FILL: the YouTube link, public, under 3:00] ([§8](#8-video-storyboard-under-300-captions-no-invented-numbers)).

### Testing instructions

The rules ask for test credentials here when access is private ([rules §9](../research/paypal/rules.md#9-required-deliverables-s2-ah-unless-marked)). **The sandbox buyer logins go into Devpost's testing-instructions field only**: never into this repository, the story, the video or a chat. Whether Devpost shows that field to judges only is **UNVERIFIED** (question Q6 to the organisers is unanswered); they are sandbox logins with no real money behind them, and you change their passwords after the winners are announced ([runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links)).

<!-- field: paypal.testing max=0 -->
```text
Everything runs on the PayPal sandbox and the Ethereum Sepolia testnet: no real money. Live edition: https://paypal.paylink-mg.pages.dev/paypal/ (its Status page, in the footer, shows whether each service answers right now).

PATH B: PayPal only, no wallet, about 5 minutes
1. Open one of your invoice links:
   Judge A: [TO FILL: three links]
   Judge B: [TO FILL: three links]
2. The page checks the invoice on the chain and shows "Two ways to pay". Press "Pay with PayPal".
3. On PayPal's sandbox page, log in with your sandbox buyer and pay.
   Judge A sandbox buyer: [TO FILL in Devpost only: email / password]
   Judge B sandbox buyer: [TO FILL in Devpost only: email / password]
4. Open the same link again: the pay page now says "PayPal says this invoice is paid." and no longer offers PayPal.

PATH A: the whole flow, about 15 minutes
Needs a browser wallet (MetaMask or another EIP-6963 wallet) on Ethereum Sepolia with a little Sepolia ETH, and test USDC from https://faucet.circle.com for the paying side.
1. Open the live edition. Press "Assistant", paste a client message such as "Love it! Send me the invoice, $12, I'll pay by Friday", press "Draft": the wallet connects and signs a desk session (one signature, no transaction, no fee). Check the values, press "Use draft", then "Review and sign" and sign the invoice in the wallet (one more signature, no transaction).
2. "PayPal twin" comes first under the signed invoice: give a client name (and an email if you like) and press "Make the PayPal twin". The panel reads the twin back from PayPal.
3. Copy the link and open it in another browser profile. Pay with PayPal as your sandbox buyer, or pay in USDC from a second wallet account (one signature, one transaction).
4. Back on the first profile, open "Desk" (if it asks, "Open my desk": one signature, no transaction), then press "Check my invoices". Paid on PayPal: the desk proposes cancelling the PayLink link, with the exact values; approve, then confirm the cancellation in your wallet. Paid in USDC: the desk shows "Recorded on PayPal invoice ..." with Undo.
5. "Was I really paid?" at the bottom of the desk: paste a made-up payment notice and see the verdict from PayPal and the chain.

PATH C: no account at all, on your machine
git clone https://github.com/nambininasafidison/paylink && cd paylink && git checkout paypal
pnpm install --frozen-lockfile && pnpm --filter @paylink/e2e exec playwright install chromium
pnpm --filter @paylink/e2e test specs/paypal-rails.spec.ts
(Node 22.22, pnpm 10.28, Foundry's anvil, and internet access to Ethereum Sepolia's public RPC for the fork; nothing is sent to Sepolia or PayPal.)
```
Characters: 2,652 (no stated limit)

## 4. The PayPal integration, explained

Operation keys are those of [SPEC §7.1](../paypal/SPEC.md#71-operations); paths and scopes are `PAYPAL_OPERATIONS` in `apps/api/src/paypal/client.ts`, taken from PayPal's OpenAPI files at `90e8041`. P12 (PayPal's QR code) is cut (decision D-SCOPE).

| Key | PayPal call | What PayLink uses it for | Called from |
|---|---|---|---|
| P1 | `POST /v1/oauth2/token` | Client-credentials token, cached in the `Global` Durable Object until 10 minutes before it expires; a refused token is replaced once | `apps/api/src/paypal/token.ts` |
| P2 | `POST /v2/invoicing/search-invoices` | Find an existing twin by the link's key in `reference` before creating one (idempotency); exact matches only | `apps/api/src/paypal/twin.ts` |
| P3 | `POST /v2/invoicing/invoices` | Create the twin: the signed amount in USD, the link's key as `reference`, the due date | `apps/api/src/paypal/twin.ts` |
| P4 | `POST /v2/invoicing/invoices/{invoice_id}/send` | Share it (PayPal's payer link) | `apps/api/src/paypal/twin.ts` |
| P5 | `GET /v2/invoicing/invoices/{invoice_id}` | **The truth** for every PayPal state: after creating, after each webhook, on "Check my invoices", in the minute cron and before every approved action | `apps/api/src/paypal/twin.ts`, `apps/api/src/routes/webhook.ts`, `apps/api/src/reconciler/engine.ts` |
| P6 | `POST /v2/invoicing/invoices/{invoice_id}/payments` | Record a verified chain payment on the twin (method `OTHER`, a note naming the chain transaction and the key), automatically (S3) | `apps/api/src/reconciler/engine.ts` |
| P7 | `DELETE /v2/invoicing/invoices/{invoice_id}/payments/{transaction_id}` | Undo that record within 24 hours | `apps/api/src/reconciler/executor.ts` |
| P8 | `POST /v2/invoicing/invoices/{invoice_id}/cancel` | Cancel the twin after the payee's tap (link cancelled or expired on chain, or PayPal still open after a record) | `apps/api/src/reconciler/executor.ts` |
| P9 | `POST /v2/invoicing/invoices/{invoice_id}/remind` | PayPal's own reminder after the payee's tap, at most once per invoice per 24 hours, only for twins with a client email | `apps/api/src/reconciler/executor.ts` |
| P10 | `POST /v1/notifications/verify-webhook-signature` | Every delivery, with the raw body spliced in byte for byte; a delivery that does not verify changes nothing | `apps/api/src/paypal/webhook.ts` |
| P11 | `POST /v1/notifications/webhooks` | Subscribe the Worker's URL to `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `INVOICING.INVOICE.UPDATED` (the owner's script) | `apps/api/scripts/capture/main.ts` |
| P13, P14 | `GET /v2/invoicing/invoices`, `GET /v1/notifications/webhooks-events/{event_id}` | In the client and its contract tests; no route calls them in this release | `apps/api/src/paypal/http.ts` |

Trust: a webhook body never decides anything (it triggers P5); the pay page follows PayPal's payer link only on the pinned host `www.sandbox.paypal.com` and only when PayPal's amount equals the signed one (`apps/web/src/editions/paypal/rails.ts`); PayLink's own P6 record is recognised by the echo filter (`apps/api/src/reconciler/echo.ts`) so it is never a second payment. What only the sandbox can show (statuses after a share and after a record, the payer page's host, `reference` search exactness, reminder limits, 200 or 202 on send) is listed with the code's behaviour meanwhile in [runbook §5](../runbooks/paypal.md#5-what-the-capture-decides).

## 5. The AI, explained

| | |
|---|---|
| Provider | Cloudflare Workers AI, through the Worker's `AI` binding (no API key), behind an `AiProvider` interface (`apps/api/src/ai/types.ts`) |
| Models | `@cf/google/gemma-4-26b-a4b-it` (JSON-schema output and tool calls in its catalog entry); fallback `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; every call with `rejectIfBusy`; why and from which Cloudflare files: `apps/api/src/ai/models.ts` |
| A1, draft | `POST /v1/ai/draft`: the client's message, personal data replaced by placeholders, one structured call; code parses the amount (only if the model's copy is in the message) and resolves the due date; an address in the message is never the payee (`apps/api/src/ai/draft.ts`) |
| A2, desk | On "Check my invoices": six read tools (`list_invoices`, `get_invoice`, `search_invoicing` with the Agent Toolkit's names and schemas; `chain_invoice_state`, `list_chain_payments`, `allowed_actions`) and `propose_action`, which keeps only an action of the fence with the fence's values; a reminder's text is kept only when its amount, dates and invoice number are that invoice's own (grounding by type, `apps/api/src/ai/desk/grounding.ts`), checked again by the fence |
| Never | Sign, submit, hold a key, call a PayPal write, see a memo, a PayPal note, a client name or email, or decide a payment state ([invariants AI-1 to AI-7](../../apps/api/evals/README.md#the-invariants-and-the-test-of-each)) |
| Budget | The free 10,000 neurons a day; daily quotas per wallet, per IP address and for the whole public, with 2,500 neurons reserved for the demo payee (`apps/api/src/ai/admission.ts`); when spent, "Assistant resting" and every manual path works; Status shows the neurons left |
| Evidence | `apps/api/test/ai/invariants.test.ts`, `injection.test.ts` (40 cases, blocking), `obedient.test.ts`, `parity.test.ts`; L3 case (c) in `e2e/specs/paypal-rails.spec.ts` |
| Not measured yet | The models' answers: no live call yet. Run the live evals before quoting any score ([evals README](../../apps/api/evals/README.md#running-the-live-evals-the-owner)); the story says nothing about quality until then |

## 6. Judge access instructions

The text judges read is the testing-instructions field of [§3](#testing-instructions). What it needs from you, in [runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links): two sandbox buyer accounts with balances, three judge links each (path B), the live edition with PayLinkV2 deployed (paths A and B), the Worker with its five secrets and the webhook. Path C needs nothing from you.

What a judge sees on each path, and what can go wrong:

| Path | Sees | If it fails |
|---|---|---|
| B (PayPal only) | The pay page's four lamps, "Two ways to pay" with **Pay with PayPal** as the main key, PayPal's sandbox page, then "PayPal says this invoice is paid." | The PayPal key is missing: the link expired or was paid (the PAYABLE lamp is red: make judge links with "Expires: Never", [runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links)), the twin's amount or PayPal's payer host did not match (the page says "PayPal option withheld"), or the API is down (Status) |
| A (whole flow) | Draft, sign, twin, both rails, the till, the desk's proposals and approvals, Undo, "Was I really paid?" | "Assistant resting": the day's neurons are spent; write the invoice by hand. No Sepolia ETH: the pay page says so |
| C (local) | Three Playwright tests passing against a fork of Sepolia and the PayPal fake | anvil missing (install Foundry), or no route to `ethereum-sepolia-rpc.publicnode.com` |

## 7. Honest limitations

| Limitation | What it means | Where it is said |
|---|---|---|
| Sandbox and testnet only | No real money moves; PayPal's live API is not used | story, Status, every page's notes |
| PayLinkV2 not deployed on Sepolia yet | Until you deploy it, nothing can be signed or paid on the live edition | [§1](#1-facts-this-pack-relies-on); runbook §9 |
| PayPal sandbox behaviour unverified | Built against PayPal's OpenAPI files and a fake; the capture run decides the payer page's host, statuses after a share and a record, reminder limits | [runbook §5](../runbooks/paypal.md#5-what-the-capture-decides) |
| One PayPal merchant | One sandbox business account stands for every freelancer; per-freelancer onboarding is future work | story, "What's next" |
| Receiving PayPal in Madagascar | Secondary sources say Malagasy PayPal accounts may be send-only (**UNVERIFIED**); the product claims nothing about it. The story says so: the PayPal rail is for freelancers wherever PayPal lets them receive, and in Madagascar the on-chain rail is the one that can still pay them | story ("Inspiration", "Honest status"); [SPEC §1.2](../paypal/SPEC.md#12-reality-check-published-at-the-top-of-the-readme-and-the-devpost-text) |
| AI quality unmeasured | No live Workers AI call yet; CI measures code only | [§5](#5-the-ai-explained) |
| Free AI allocation | 10,000 neurons a day; the assistant rests when they are spent, every manual path works | Status |
| PayPal USD | Supported and shown; paid only on fork rehearsals (no test PYUSD obtainable from Madagascar) | [§1](#1-facts-this-pack-relies-on) |
| No gasless payments | The payer pays Sepolia gas (no relayer in this edition, decision D-SCOPE) | pay page |
| No passkeys | Browser wallets only in this edition | [ADR 0018](../adr/0018-paypal-edition.md) |
| Cut | The free-text desk question, the AI reason codes of "Was I really paid?", PayPal's QR code on the print card | [SPEC D-SCOPE](../paypal/SPEC.md#d-scope-what-is-kept-and-what-is-cut) |
| Malagasy | The Malagasy strings and eval cases are drafts awaiting the owner's review | `packages/i18n/src/locales/mg.review.json` |
| Hosting | A Pages preview of a branch and a Worker on the owner's account; both must stay up until 2026-12-15 | runbook §12 |
| Not audited | Our own review of the contract only | landing page |
| No rate limit per IP on the public rail route | `GET /v1/rails/:key` is public; it reads the store and PayPal is read by the cron, not per request | `apps/api/README.md` |

## 8. Video storyboard (under 3:00, captions, no invented numbers)

**Goal:** both rails (PayPal, and USDC on chain) and the desk on the live edition, in 2:45. English captions burned in (the video works muted); narration optional, in English. No music, or royalty-free only. No third-party logos other than PayPal's own sandbox pages (PayPal is the sponsor; still **UNVERIFIED** that showing its pages needs no permission, question Q11).

**Rules** ([demo recording runbook §1](../runbooks/demo-recording.md#1-honesty-rules)): real sandbox and testnet operations only; every number on screen is what the app showed during that take (never typed into the edit); mark every cut ("cut: waiting for the block"); say "sandbox · testnet" on screen; never "audited"; nothing private on screen (no sandbox password, no secret, no wallet seed). If a beat fails on the day, use a take recorded earlier and say so on screen.

**Preconditions**

- [ ] [§10](#10-liste-de-contrôle-en-français) steps 1 to 9 done; `/paypal/status/` green with your pushed commit; the rehearsal of [runbook §11](../runbooks/paypal.md#11-rehearsal) passed the same week.
- [ ] Chrome with two profiles at 1280 × 800: **Payee** (MetaMask account "Rina Design", a little Sepolia ETH) and **Client** (MetaMask account "Sarah", Sepolia ETH and at least 20 test USDC, and the "video" sandbox buyer's login typed off camera). Light theme, English, Do Not Disturb, no other extension, bookmarks bar hidden.
- [ ] "Rina" and "Sarah" are made-up names: the first caption says the story is a composite.

| # | Time | Screen and exact clicks | Caption |
|---|---|---|---|
| 1 | 0:00–0:10 | Payee: `/paypal/` home | "Rina (a composite) designs logos in Antananarivo. Her clients pay from abroad, some with PayPal, some in dollars on chain." · "PayPal sandbox · Ethereum Sepolia testnet · no real money" |
| 2 | 0:10–0:30 | **Assistant**; paste "Love it! Send me the invoice, $12, I'll pay by Friday"; **Draft** → MetaMask: connect, then sign the desk session (typed data, no transaction); hold on the AI draft card (amount "as written", due date, the model's name) | "Rina opens her desk: one signature, no transaction." · "The assistant drafts. Code checks every number against the message." |
| 3 | 0:30–0:42 | **Use draft**, **Review and sign**, **Sign in wallet**; MetaMask's typed-data request; approve | "The invoice: one signature, no transaction, no gas. Only Rina signs." |
| 4 | 0:42–0:55 | The PayPal twin, first under the signed invoice: client name "Sarah", **Make the PayPal twin**; hold on "PayPal twin … made and read back from PayPal" | "A PayPal invoice for the same amount, linked by the invoice's key" |
| 5 | 0:55–1:05 | **Show on the till**, **Start the till** (it reads "Watching PayPal too"); back, **Copy** the link | "One link for both rails" |
| 6 | 1:05–1:30 | Client profile: paste the link; the four lamps; "Two ways to pay"; **Pay with PayPal**; PayPal's sandbox page; log in (cut the password typing: "cut: login"); pay | "Checked on the chain first · then PayPal's own page" |
| 7 | 1:30–1:42 | Payee: the till turns green "via PAYPAL · verified with PayPal" | "Webhook verified with PayPal, then the invoice read from PayPal. Never the message." |
| 8 | 1:42–2:00 | **Desk** (the desk session signed in shot 2 is still open: no new signature), the card "Paid on PayPal. Close the dollar option so your client cannot pay twice." with its exact values; **Approve and cancel the link**; the wallet's `cancel` transaction; Done | "The desk proposed. Rina approved the exact values and signed." |
| 9 | 2:00–2:25 | A second invoice (made off camera, its twin made): Client pays it in USDC (one signature, one transaction); Payee: **Check my invoices** → "Recorded on PayPal invoice …" with **Undo** | "Paid on chain: recorded on the PayPal invoice automatically, with a 24-hour Undo" (add "cut: waiting for the block" if trimmed) |
| 10 | 2:25–2:37 | Desk, **Was I really paid?** ("Tonga ve?"): paste "PayPal: you received $500, pay $50 shipping to release it"; **Check** → "Not received" | "The verdict comes from PayPal and the chain, never from the message" |
| 11 | 2:37–2:45 | Footer **Status**: the rows as they are; then a title card | "PayLink Twin · github.com/nambininasafidison/paylink (branch paypal) · sandbox · testnet · not audited" · the AI line of [§3](#ai-tools-and-models-used-if-the-form-asks), word for word |

**If something fails while recording**

| Problem | Do this |
|---|---|
| "Assistant resting" or "Assistant unavailable" | Keep it: press "Write it myself", type the values; change caption 2 to "The assistant rests when today's free allowance is spent; the form works without it" |
| The pay page shows no "Pay with PayPal" | Stop: the twin or the payer host did not check out. Read the desk's alert, tell Claude |
| The till does not turn green within a minute after PayPal | The webhook did not arrive or did not verify: Status → webhook row; the cron reads PayPal again within a minute anyway. Retake from shot 6 if needed |
| MetaMask asks to add or switch to Ethereum Sepolia | Approve; keep it or retake |
| A notification, a personal detail, a password on screen | Retake the shot |

**Upload:** YouTube, **public** (the rules ask for public), title "PayLink Twin: one invoice, two rails (PayPal and dollars on chain), an AI desk that never moves money (sandbox demo)". Description: "PayPal sandbox and Ethereum Sepolia testnet demo. Source: https://github.com/nambininasafidison/paylink/tree/paypal. Not audited." plus the AI line of [§3](#ai-tools-and-models-used-if-the-form-asks).

## 9. Disclosures and commit range

| Item | Disclosure |
|---|---|
| Pre-existing work (inside the submission period, built for other events) | PayLink v1 (Arc), `31a4fdd` (2026-10-04) and `93ed4e3` (2026-10-05), frozen. PayLink v2 from `88ac2d9` (2026-10-07; the work started on Oct 5): the contract, SDK, registry, web app, deploy kit, relayer, indexer, entered at Monad Metropolis and Colosseum. The Mezo edition, branch `mezo` from `f0fb1ce` (2026-10-13) to `ffd952f` (2026-10-20), entered at the Mezo Buildathon |
| Built for this hackathon | The branch `paypal`, from `828b9ff` (2026-10-21) to the submitted commit, on top of `ffd952f`: Ethereum Sepolia in `packages/chains`, the deploy kit and `tools/verify-deployment`; `apps/api` (PayPal, reconciler, approvals, sessions, AI, Durable Objects, cron); `packages/api-contract`; the PayPal edition (`apps/web/src/editions/paypal/`, the desk, the `paypal` catalogues of `packages/i18n`); `e2e/specs/paypal.spec.ts`, `paypal-ui.spec.ts`, `paypal-rails.spec.ts`; [ADR 0018](../adr/0018-paypal-edition.md), [the specification](../paypal/SPEC.md), the research notes in `docs/research/paypal/`, the [runbook](../runbooks/paypal.md) and this pack |
| Unchanged | `protocol/src` (PayLinkV2 is immutable and already released); production (`main`); the frozen v1 paths |
| Other events | Monad Metropolis, Colosseum, the Mezo Buildathon and Arc Microgrants, same repository and contract (decision D-12 of the specification: name them) |
| AI | The exact line of [§3](#ai-tools-and-models-used-if-the-form-asks); the repository's full disclosure, including how commits are attributed, is [AI_DISCLOSURE.md](../../AI_DISCLOSURE.md) |
| Third-party components | PayPal's OpenAPI files (vendored as test data with their licence), the PayPal Agent Toolkit's tool sources (vendored as test data for the parity test), OpenZeppelin Contracts 5.3.0, viem, Hono, zod, qrcode-generator, the Archivo and Martian Mono fonts ([NOTICE.md](../../NOTICE.md)) |
| Tag | `submission/paypal-<date>` on the submitted commit, created and pushed by you |

## 10. Liste de contrôle (en français)

Dans l'ordre : chaque étape a besoin de la précédente. Ne pousse jamais `main` ni `mezo` : seulement `paypal`. Les détails de chaque étape sont dans le [runbook PayPal](../runbooks/paypal.md). Les secrets (secret client PayPal, clés HMAC) ne vont **que** dans Cloudflare ou dans la variable d'environnement d'un terminal : jamais dans le dépôt, un fichier, une capture d'écran, un journal ou une conversation (y compris avec Claude).

**État au 28 octobre 2026.** Étape 2 faite (l'app « PayLink Twin » existait déjà, type Merchant, Invoicing activé ; le Secret n'a jamais été affiché). Étape 3 faite (branches de prévisualisation `mezo` et `paypal`, variables Preview vérifiées, Production inchangée). Étape 4 : Worker `paylink-api` créé avec les réglages ci-dessous ; son premier build part de ce commit sur `paypal`.

1. **Devpost.** Ouvre `https://paypalaihackathon.devpost.com/rules`, la FAQ et les « updates » dans ton navigateur : vérifie l'heure limite (12 novembre 2026, 12:00 PST = 23:00 à Antananarivo), les champs du formulaire et leurs limites, et si le champ « testing instructions » est privé. Ce dossier n'a pas pu les lire. Inscris-toi au hackathon si ce n'est pas fait.
2. **Application PayPal sandbox « PayLink Twin »** ([runbook §1](../runbooks/paypal.md#1-the-sandbox-app)) : Invoicing activé ; note le Client ID ; ne révèle le Secret qu'au moment de le coller dans Cloudflare.
3. **Prévisualisation Pages de la branche `paypal`** ([runbook §7](../runbooks/paypal.md#7-the-pages-preview-of-the-branch-paypal)) : projet `paylink-mg` → Settings → Build → Branch control → Preview branch « Custom branches » : **ajoute `paypal`** et garde `mezo`. Dans Environment variables → **Preview**, vérifie `NODE_VERSION` = `22.22.0`, `PNPM_VERSION` = `10.28.0`, `SKIP_DEPENDENCY_INSTALL` = `1`. Le prochain push de `paypal` construit `https://paypal.paylink-mg.pages.dev/paypal/` ; vérifie `/paypal/status/` (« Build » donne le commit poussé, édition `paypal`) et que `https://paylink-mg.pages.dev/monad/` n'a pas changé.
4. **Worker `paylink-api` par l'intégration Git** ([runbook §8](../runbooks/paypal.md#8-the-worker-paylink-api)) : Workers & Pages → Create → Import a repository → `nambininasafidison/paylink` ; nom `paylink-api`, branche de production `paypal`, commande de build vide, commande de déploiement `npx wrangler@4.148.0 deploy`, dossier racine `apps/api/deploy`, aucune variable, builds des branches non-production désactivés. Le journal de build doit lister `env.PAYEE (Payee)`, `env.GLOBAL (Global)`, `env.AI` et le cron, puis l'URL `workers.dev` : si elle n'est pas `https://paylink-api.raherizonambinina.workers.dev`, dis-le à Claude.
5. **Secrets du Worker** ([runbook §2](../runbooks/paypal.md#2-the-workers-secrets)), type **Secret**, jamais « Text » : `APPROVAL_HMAC_KEY` et `SESSION_HMAC_KEY` (chacune faite par `openssl rand -hex 32`, deux valeurs différentes, collées directement, aucune copie gardée), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`. Vérifie `https://paylink-api.raherizonambinina.workers.dev/v1/health` : PayPal, assistant, chaîne et stockage répondent ; le webhook reste « non configuré » jusqu'à l'étape 8.
6. **Déployer PayLinkV2 sur Ethereum Sepolia avec le kit** ([runbook §9](../runbooks/paypal.md#9-paylinkv2-on-ethereum-sepolia)) : `https://paypal.paylink-mg.pages.dev/v2/deploy/?chain=11155111` (ou, avant la prévisualisation, `python3 -m http.server 8080 --directory web` dans une copie de `paypal`, puis `http://localhost:8080/v2/deploy/?chain=11155111`). Vérifie l'`initCodeHash` `0x289dcd64…7ac5` et l'adresse `0x448eCce9711860502806A3d5B021a4f9Ba715082` (sinon, arrête). MetaMask en compte standard (mode smart account désactivé), réseau Ethereum Sepolia. **Limite de gas d'environ 21,2 millions** : Sepolia applique Amsterdam et le déploiement coûte environ 19,25 millions de gas ; ne touche pas la limite. Coût : environ 0,02 ETH de Sepolia avec un pourboire de 1 gwei (ton portefeuille « PayPal Demo » en a 0,05). Tous les voyants verts, **Deploy**, confirme. Télécharge `11155111.json` et donne-le à Claude avec le hash de la transaction et la date : Claude revérifie, enregistre, régénère, remplit ce dossier et le README, puis pousse `paypal`. Le même jour, vérifie le code source sur Etherscan (Sepolia) avec le fichier que Claude prépare.
7. **Capture sandbox** ([runbook §3](../runbooks/paypal.md#3-the-capture-run)) : sur ton ordinateur, dans `apps/api`, `read -rs PAYPAL_CLIENT_SECRET && export PAYPAL_CLIENT_SECRET`, `export PAYPAL_CLIENT_ID=…`, puis `node --conditions=@paylink/source scripts/capture/main.ts --wait-payment 10 --events --out paypal-capture.json`, et `unset PAYPAL_CLIENT_SECRET` à la fin. Paie la facture qu'il affiche avec un acheteur sandbox. Note les réponses aux trois vérifications manuelles (K4, P9, P10). Donne le rapport `paypal-capture.json` à Claude (il ne contient ni secret ni e-mail) : Claude fixe l'hôte de la page payeur, les statuts, et pousse.
8. **Abonnement webhook** ([runbook §4](../runbooks/paypal.md#4-the-webhook-subscription)) : dans le même terminal (secret exporté), `node --conditions=@paylink/source scripts/capture/main.ts subscribe --url https://paylink-api.raherizonambinina.workers.dev/v1/paypal/webhook` ; il abonne cette URL à `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED` et `INVOICING.INVOICE.UPDATED` et affiche `PAYPAL_WEBHOOK_ID=…` une fois (ou dans le tableau de bord : l'app → Webhooks → Add Webhook, même URL et mêmes événements). Mets cet identifiant dans le secret `PAYPAL_WEBHOOK_ID`. Après un vrai paiement sandbox, Status affiche « Last verified webhook » et les journaux du Worker `webhook.received` avec `outcome: processed`.
9. **Acheteurs sandbox des juges** ([runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links)) : Testing tools → Sandbox accounts : trois comptes personnels (« video », « judge A », « judge B ») avec un solde sandbox suffisant jusqu'au 15 décembre ; leurs identifiants dans ton gestionnaire de mots de passe **uniquement**. Puis, avec le portefeuille du vendeur, trois factures par juge (par exemple 5,00, 7,50 et 12,00 USDC), chacune avec son jumeau PayPal : ce sont les liens du parcours B. **Pour chaque lien des juges et de la vidéo, choisis « Expire : Jamais »** (et coche la confirmation) : par défaut un lien expire après 7 jours, au plus 30, et un lien signé vers le 1er novembre ne serait plus payable pendant l'évaluation (du 1er au 15 décembre) ; un lien expiré éteint le voyant PAYABLE et la page de paiement cache alors aussi « Pay with PayPal ». Sinon, refais-les chaque semaine. Donne aussi à Claude l'adresse du portefeuille du vendeur (elle est publique) : il l'ajoute à `demoPayees` (`apps/api/src/core/config.ts`), pour que ses sessions et l'assistant aient une réserve que le public ne peut pas épuiser.
10. **Répétition, deux fois** ([runbook §11](../runbooks/paypal.md#11-rehearsal)) : les deux rails, le bureau, l'assistant, « Was I really paid? », les journaux du Worker. Note ce qui diffère du runbook et dis-le à Claude.
11. **Évaluations en direct (facultatif mais nécessaire pour citer un score)** : avec un jeton Cloudflare « Workers AI » dans l'environnement, `node --conditions=@paylink/source apps/api/test/ai/evals/run.ts --live --set all` ([evals](../../apps/api/evals/README.md#running-the-live-evals-the-owner)). Donne le tableau daté à Claude ; sans lui, ne cite aucun score.
12. **Vidéo** ([§8](#8-video-storyboard-under-300-captions-no-invented-numbers)) : moins de 3:00, sous-titres anglais incrustés, aucun chiffre inventé (seulement ce que l'application affiche pendant la prise), chaque coupe signalée, aucun mot de passe ni secret à l'écran, « sandbox · testnet » visible. À filmer : l'assistant qui rédige, la signature, le jumeau PayPal relu, le paiement PayPal sur la page sandbox, la caisse verte « via PAYPAL », la proposition d'annulation et ta signature, le paiement USDC et l'enregistrement automatique avec Annuler, « Was I really paid? », Status. YouTube **public**.
13. **Remplir et soumettre** : donne à Claude le lien de la vidéo, les liens des juges (pas les identifiants) et les dates, ou remplace toi-même chaque `[TO FILL: …]` puis `python3 docs/tools/submission_fields.py --update`. Sur Devpost : les textes du [§3](#3-devpost-fields) ; les identifiants des acheteurs sandbox **seulement** dans le champ « testing instructions » ; le dépôt `…/tree/paypal` ; la vidéo. Soumets avant le 12 novembre 20:00 UTC (vise le 1er novembre), puis pose le tag `submission/paypal-<date>` et pousse-le.
14. **Jusqu'au 15 décembre** ([runbook §12](../runbooks/paypal.md#12-until-judging-ends)) : chaque semaine un paiement sandbox, les soldes des acheteurs, les neurones de l'assistant sur Status, l'ETH de Sepolia du vendeur, et **chaque lien des juges encore PAYABLE** (ouvre-le : les quatre voyants verts et « Pay with PayPal » affiché ; sinon remplace-le). Une alerte `record-missing` sur le bureau : l'enregistrement d'un paiement sur la chaîne a quitté la facture PayPal, qui peut de nouveau être payée ; enregistre-le de nouveau ou annule la facture PayPal depuis le bureau. Ne pousse rien de cassant sur `paypal`. Après le 22 décembre, change chaque secret et les mots de passe des acheteurs.
