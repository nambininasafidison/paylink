# PayPal AI Hackathon (Devpost): submission pack, PayLink Twin

| | |
|---|---|
| **Event** | PayPal AI Hackathon on Devpost ("Build what's next with PayPal and AI"), `https://paypalaihackathon.devpost.com/`. No tracks; the honourable mentions that fit are "Best Use of PayPal + AI" and "Best Use of Agentic Commerce". A project wins at most one sponsor prize plus one Grand Prize or one Honorable Mention (FAQ, **O**; [rules §7](../research/paypal/rules.md#7-prizes-usd)) |
| **Deadline** | **Thursday 2026-11-12, 12:00 pm PT = 20:00 UTC = 23:00 in Antananarivo** (the Rules page, **O**, as the two participant copies of [rules §2](../research/paypal/rules.md#2-dates) said). Projects submitted before **Thursday 2026-11-05** get an early eligibility check and stay editable until the deadline (update "Two weeks to go", **O**). Plan: submit by 2026-11-01 ([SPEC, decisions of 2026-10-21](../paypal/SPEC.md#decisions-of-2026-10-21)). Judging from 2026-12-01 2:00 pm PT to 2026-12-15 8:00 am PT; the demo stays live and free until then |
| **Status** | Paste-ready. §3 follows the Devpost form field by field, as read on 2026-10-29, with the owner's answers. `[TO FILL: …]` placeholders remain only where a fact does not exist yet: the judge links, the sandbox buyer logins (typed into Devpost only), the video, the live evals. PayLinkV2 is deployed on Ethereum Sepolia and its source verified on Etherscan; the edition, the API Worker and the PayPal webhook are online; the sandbox capture ran (all on 2026-10-29) |
| **Written** | 2026-10-22, on the branch `paypal` (branched from `mezo` at `ffd952f`), by the integration step that applied every workstream's handoff; §1, §3, §6, §7 and §10 rebuilt on 2026-10-29 from the Devpost form read after "Start project", the sandbox capture and the Etherscan verification. `git log -- docs/submissions/paypal.md` lists the commits |
| **Who submits** | The owner, from the owner's Devpost account (the private draft "PayLink Twin", with only its name entered on 2026-10-29). Claude Code drafts only ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)) |
| **Checklist** | [§10](#10-liste-de-contrôle-en-français), in French; going live step by step: [PayPal runbook](../runbooks/paypal.md) |

Every text in a `text` block is the exact text to paste into the field named above it. The line under it is checked by `python3 docs/tools/submission_fields.py` (tests: `python3 docs/tools/submission_fields_test.py`), which holds the Devpost form itself, field by field, with its order, kinds, limits and options: a text over its limit, more than 25 tags, an answer the form does not offer, a field out of order or a field of the form missing from this pack fails it, and `check-docs.py` with it (check 9). Run it with `--update` after you edit a text. Replace every `[TO FILL: …]` or delete the sentence that holds it; never paste a placeholder.

Tags: **C** confirmed (on chain, in a primary file, or by a test in this repository), **O** read by the owner or the owner's browser agent on the official page or dashboard, on the date given, **S** a participant copy or snippet of an official page, **UNVERIFIED** not checked.

## Contents

1. [Facts this pack relies on](#1-facts-this-pack-relies-on)
2. [Where judges see it](#2-where-judges-see-it)
3. [The Devpost form, step by step](#3-the-devpost-form-step-by-step)
4. [The PayPal integration, explained](#4-the-paypal-integration-explained)
5. [The AI, explained](#5-the-ai-explained)
6. [Judge access instructions](#6-judge-access-instructions)
7. [Honest limitations](#7-honest-limitations)
8. [Video storyboard (under 3:00, captions, no invented numbers)](#8-video-storyboard-under-300-captions-no-invented-numbers)
9. [Disclosures and commit range](#9-disclosures-and-commit-range)
10. [Liste de contrôle (en français)](#10-liste-de-contrôle-en-français)

## 1. Facts this pack relies on

Checked on 2026-10-29 unless stated otherwise. If one of them changes, change the texts that use it.

| Fact | Value | Evidence |
|---|---|---|
| Devpost: dates | Submission period opened 2026-10-01 9:15 am PT; deadline Thursday 2026-11-12 12:00 pm PT; early eligibility check for projects submitted before Thursday 2026-11-05 (still editable until the deadline); judging 2026-12-01 2:00 pm PT to 2026-12-15 8:00 am PT; results around Monday 2026-12-21 2:00 pm PT | Rules, FAQ and Updates, read by the owner's browser agent on 2026-10-29 (**O**) |
| Devpost: what an entry needs | A text description; a working demo (a hosted URL or complete run instructions; mock-ups are refused); the AI tools used and how; a public open-source repository with its licence visible in its About box, holding all code, assets and instructions; a public YouTube video under 3 minutes showing the project on its target device, with no third-party trademarks or music without permission; everything in English. The update "Two weeks to go" adds: name PayPal and the AI in the description, in Built with and in the video; give a hosted demo or clear instructions in the repository; never commit keys | same (**O**) |
| Devpost: testing | Give judges access; a private site needs credentials in the testing instructions; the demo stays free and accessible until judging ends; test or sandbox credentials may also be in the repository (this one keeps none: they go into Devpost only); judges may judge on the text, images and video alone | same (**O**) |
| Devpost: who may enter | No maximum team size; excluded: Brazil, Quebec, Russia, Crimea, Cuba, Iran, North Korea and OFAC-sanctioned countries. Prizes announced at 69,750 USD (the home page still showed 67,500 USD) | FAQ, Updates (**O**) |
| Devpost: the form | Five steps after "Start project": Manage team, Project overview, Project details (the public page), Additional info (for judges and organizers; only the country appears in the project gallery) and Submit. The testing-instructions field is private to judges and organizers. Every field, its limit and the owner's answer: [§3](#3-the-devpost-form-step-by-step). The draft "PayLink Twin" (slug `paylink-twin`) exists, private, with only the name entered; nothing is submitted | read by the owner's browser agent on 2026-10-29, after "Start project" (**O**) |
| The product | The PayPal edition of PayLink, "PayLink Twin", at `/paypal/`: one EIP-712-signed invoice payable on two rails, a PayPal Invoicing v2 "twin" (PayPal's hosted invoice page, sandbox) and USDC or PayPal USD on Ethereum Sepolia through the unchanged PayLinkV2 contract; a collections desk that reconciles both rails and proposes the next step; an assistant on Cloudflare Workers AI that drafts invoices and words proposals, and can only propose | [ADR 0018](../adr/0018-paypal-edition.md); `apps/web/src/editions/paypal/`; `apps/api/` |
| Contract on Ethereum Sepolia (11155111) | **Deployed on 2026-10-29** at `0x448eCce9711860502806A3d5B021a4f9Ba715082`, through the CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C`, sent directly from the deploy kit by your "PayPal Demo" wallet: transaction `0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3`, block 12,017,054. `tools/verify-deployment` passed its ten checks (code, masked runtime hash, CBOR metadata, EIP-712 immutables, `eip712Domain()`, the transaction) and the kit's record is byte-identical to the committed one. **Source verified on Etherscan the same day**: "Source Code Verified - Exact Match", contract `PayLinkV2`, compiler `v0.8.30+commit.73712a01`, optimization on with 10,000 runs, EVM version `paris`, licence MIT, Solidity Standard Json-Input, at `https://sepolia.etherscan.io/address/0x448eCce9711860502806A3d5B021a4f9Ba715082#code` | `protocol/deployments/11155111.json`; [sepolia.md](../research/paypal/sepolia.md) (**C**); Etherscan (**O**, [runbook §9](../runbooks/paypal.md#9-paylinkv2-on-ethereum-sepolia)) |
| Deployment gas | Sepolia runs Amsterdam: `eth_estimateGas` of the CREATE2 deployment is 19,249,557 on Sepolia (19,240,803 on a fork); a first USDC payment by EIP-3009 authorisation uses 457,705 gas and a cancellation 146,812, on the fork. The registry and the kit were re-measured under these rules on 2026-10-22, before any real deployment; the real deployment of 2026-10-29 used 18,946,483 gas (its receipt), at 1.5 gwei a gas: 0.0284 Sepolia ETH | [sepolia.md §5](../research/paypal/sepolia.md#5-gas-sepolia-runs-amsterdam-read-2026-10-22); `packages/chains/data/fork-gas-measurements.json` (**C**) |
| Tokens | Circle USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (the default and the demo's) and PayPal USD (PYUSD, Paxos) `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9`, both with EIP-3009 and EIP-2612 on Sepolia. No test PYUSD could be obtained (faucet.paxos.com is geo-blocked from Madagascar), so PYUSD is paid only on fork rehearsals | [SPEC D-CHAIN](../paypal/SPEC.md#d-chain-ethereum-sepolia-11155111-not-arbitrum-sepolia) (**C** on chain) |
| PayPal | Sandbox only. REST app "PayLink Twin". Invoicing v2 and Webhooks: twelve operations in `apps/api/src/paypal/client.ts` ([§4](#4-the-paypal-integration-explained)), none that captures, refunds, pays out or disputes money. Built against PayPal's OpenAPI files (`paypal-rest-api-specifications` at `90e8041`, vendored in `apps/api/test/openapi/`) and a fake validated against them, because `api-m.sandbox.paypal.com` is not reachable from the build machine. The owner's capture run of 2026-10-29 then recorded what the sandbox does: a shared twin reads `UNPAID`, a payer's payment `PAID`, PayLink's record `MARKED_AS_PAID` (its note kept exactly), an undo `UNPAID` again, a cancel `CANCELLED`; the payer page is `https://www.sandbox.paypal.com/invoice/p/#{id}`; a twin needs no client e-mail, but PayPal's reminder does; the reference search also matches part of a reference; a payment id has 22 characters; a token lives 32,326 s. The code and the fake follow it. Open: K4, whether PayPal still takes a payment on a twin marked as paid, checked at the rehearsal | [capture report](../research/paypal/capture-2026-10-29.md) (**C**); [SPEC, Capture of 2026-10-29](../paypal/SPEC.md#capture-of-2026-10-29); `apps/api/test/openapi/contract.test.ts` |
| PayPal webhook | Proven on 2026-10-29 by real sandbox deliveries: five `webhook.received` events in the Worker's logs (two `INVOICING.INVOICE.PAID`, two `INVOICING.INVOICE.CANCELLED`, one `INVOICING.INVOICE.UPDATED`), each verified with PayPal and processed, no error; `/v1/health` read `webhook` ok (`last-verified`). PayPal's simulator events do not verify by postback | the owner's Worker logs and health read (**O**); [runbook §4](../runbooks/paypal.md#4-the-webhook-subscription) |
| PayPal Agent Toolkit | Not a dependency. The desk's read tools take the toolkit's tool names and parameter schemas (`list_invoices`, `get_invoice`, `search_invoicing`), parity-tested against the vendored sources of `@paypal/agent-toolkit` 1.11.0. Wording rule: "follows the PayPal Agent Toolkit tool contract", never "built with" it ([SPEC §7.6](../paypal/SPEC.md#76-paypal-agent-toolkit-paypalagent-toolkit-1110)) | `apps/api/test/ai/parity.test.ts` |
| AI in the product | Cloudflare Workers AI through the Worker's `AI` binding: `@cf/google/gemma-4-26b-a4b-it`, fallback `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; free allocation 10,000 neurons a day; chosen from Cloudflare's docs repository at `3fe915d`. **No live call has been made yet** (on 2026-10-29 the API's health read the assistant "unknown", not used yet): the model's quality (A1 extraction, French and Malagasy) is unmeasured until your live evals; the CI evals replay scripted answers and measure code only | `apps/api/src/ai/models.ts`; [evals](../../apps/api/evals/README.md) |
| AI in the making | Claude Code (Anthropic), the project's AI assistant for code, tests and documentation, under the owner's direction | [AI_DISCLOSURE.md](../../AI_DISCLOSURE.md) |
| The fence | The desk's situation table S0–S9 decides which actions exist for each invoice, with their exact values; an approval is an HMAC token over the proposal's hash, single use; a cancellation of the PayLink link is signed and sent by the payee's own wallet; the API holds no chain key | [reconciler README](../../apps/api/src/reconciler/README.md) |
| Tests | On 2026-10-29, on this branch: 335 Foundry tests (the contract is unchanged); 2,162 TypeScript unit and integration tests (API 487, web app 498, SDK 573, chain registry 240, relayer 131, deploy kit 84, the other packages 149), plus 19 opt-in fork and workerd tests not run by default; the PayPal edition's 51 Playwright end-to-end tests (its shell 9, every screen state 39, both rails 3) and the record-parity test pass. On 2026-10-22 the whole Playwright suite had 92 tests passing and 1 opt-in skipped, and v1's 7 passed | `forge test`; `pnpm -r test`; `e2e/specs/paypal.spec.ts`, `e2e/specs/paypal-ui.spec.ts`, `e2e/specs/paypal-rails.spec.ts` |
| L3, both rails end to end | On an anvil fork of the real Ethereum Sepolia (PayLinkV2 at its release address, real Circle USDC) with the PayPal fake: (a) paid on PayPal, verified webhook, the desk's cancel proposal, the payee's own `cancel`; (b) paid in USDC, automatic record on the PayPal twin, Undo; (c) injections in the memo and the PayPal note with a model that obeys them. On 2026-10-22 each case passed 8 times in 8 runs (two single runs and two runs with `--repeat-each=3`; Playwright retries off), about 42 s, 10 s and 8 s each; on 2026-10-29, with the capture's decisions in, again: 45.2 s, 9.1 s and 7.1 s | `e2e/specs/paypal-rails.spec.ts` |
| Where it is served | Online since 2026-10-29. Web: the Cloudflare Pages preview of the branch `paypal`, `https://paypal.paylink-mg.pages.dev/paypal/`, whose Status page read Build `452c0ee` and "Release 2.0.0: code and immutables match". API: the Worker `paylink-api`, `https://paylink-api.raherizonambinina.workers.dev`, whose `/v1/health` read the chain ok (deployed), PayPal ok, the webhook ok, the store ok and the assistant unknown (not used yet). Production (`main`) is unchanged | the owner's reads (**O**); [runbook §7, §8](../runbooks/paypal.md#7-the-pages-preview-of-the-branch-paypal) |
| Judges' sandbox buyers | Three personal US accounts, "video", "judge A" and "judge B", 5,000 USD each, Verified; their logins stay in the owner's password manager and go only into Devpost's testing-instructions field | the owner (**O**); [runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links) |
| Users, revenue, partners | None to report | — |
| Organisers | Madagascar is eligible; prizes are paid by mail or bank wire (the owner's Discord thread with Devpost, 2026-10-20, **S**); the FAQ's excluded places do not include it (**O**). Unanswered: a US sandbox merchant, PYUSD, the AI provider | [SPEC, decisions of 2026-10-21](../paypal/SPEC.md#decisions-of-2026-10-21) |

## 2. Where judges see it

| What | Where | On 2026-10-29 |
|---|---|---|
| The edition | `https://paypal.paylink-mg.pages.dev/paypal/` | Online |
| Status of every service | `https://paypal.paylink-mg.pages.dev/paypal/status/` (PayLink API, PayPal sandbox, PayPal webhook, assistant with today's neurons left, API store, contract) | Online |
| The API | `https://paylink-api.raherizonambinina.workers.dev/v1/health` | Online |
| Paying with PayPal | PayPal's sandbox payer page, `https://www.sandbox.paypal.com/invoice/p/#…`, reached from the pay page's **Pay with PayPal** key, with a sandbox buyer login | The buyers exist; the judge links remain to make ([runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links)) |
| The contract's source | `https://sepolia.etherscan.io/address/0x448eCce9711860502806A3d5B021a4f9Ba715082#code` | Verified (Exact Match) |
| The source | `https://github.com/nambininasafidison/paylink/tree/paypal` (MIT); the branch's landing page has a section "PayPal edition (PayLink Twin)" with a judges' tour | After each push of `paypal` |
| Running it without any account | `pnpm --filter @paylink/e2e test specs/paypal-rails.spec.ts` (both rails against an anvil fork of Sepolia and the PayPal fake) | Now |

Judges may score from the text, the images and the video alone and are not required to run anything ([§1](#1-facts-this-pack-relies-on)): the video carries most of the weight.

## 3. The Devpost form, step by step

The form as the owner's browser agent read it on 2026-10-29 ([§1](#1-facts-this-pack-relies-on)), in its order. Each field gives the form's own words, whether it is required and its limit, then the text to paste or the owner's answer (the answers of Additional info are the owner's, given on 2026-10-29). Fields marked **(you)** are filled by you in the form itself: files, images, the video and the checkboxes.

### Step 1: Manage team

The owner alone: nothing to add.

### Step 2: Project overview

#### Project name

Required, 60 characters.

<!-- field: paypal.name max=60 -->
```text
PayLink Twin
```
Characters: 12 / 60

#### Elevator pitch

Required, 200 characters ("Provide a short tagline"). It names PayPal and the AI, as the update "Two weeks to go" asks.

<!-- field: paypal.pitch max=200 -->
```text
One invoice link your client can pay on PayPal or in USDC. An AI desk on Cloudflare Workers AI keeps both rails in agreement and proposes the next step; it never signs and never moves money.
```
Characters: 190 / 200

#### Thumbnail (you)

Optional; JPG, PNG or GIF, 5 MB, 3:2 advised. No 3:2 image of the PayPal edition is committed: take one from the live edition (for example the pay page with both rails), with nothing private on it.

### Step 3: Project details (the public page)

#### About the project

Required; Markdown and LaTeX; no limit shown. The form's template suggests Inspiration, What it does, How I built it, Challenges and so on; the text below uses those sections. Before pasting, fill the placeholder of "Honest status" (the live evals) or delete its sentence.

<!-- field: paypal.story max=0 -->
```text
## Inspiration

PayLink is built in Antananarivo for freelancers who are paid from abroad. Their clients want to pay the way they already do: many with PayPal, some with dollars on chain. Offering both today means two invoices for one job, two places to watch, and a real chance of being paid twice, or of chasing a client who already paid. Madagascar is where this started, and where it is sharpest: secondary sources say Malagasy PayPal accounts may be able to send but not receive (we could not verify it), so a freelancer there cannot count on the PayPal rail alone, and the same invoice's on-chain rail is the one that still gets them paid. The product is for freelancers anywhere PayPal lets them receive, with Madagascar as the case that shows why one invoice should carry both rails. Our working hypothesis, which we are testing in structured interviews and claim no results for, is that the chasing and the checking are the hard part. PayLink Twin gives one signed invoice two rails, PayPal and dollars on chain (USDC, or PayPal USD), and gives the follow-up to a desk that can propose but cannot touch the money.

## What it does

1. **Draft.** The freelancer pastes the client's message ("Love it! Send me the invoice, $120, I'll pay by Friday"). The assistant extracts what the job is, the client and the due-date phrase; code parses the amount and the date from the message itself, so a number the model invents never becomes the invoice amount. Every value lands in an editable form.
2. **Sign.** One EIP-712 signature in the freelancer's wallet makes the PayLink invoice: a link and a QR card, no transaction, no gas.
3. **Twin it on PayPal.** One tap creates a PayPal invoice for the same amount, with the link's key in PayPal's own reference field, shares it, and reads it back from PayPal before saying it exists.
4. **One link, two rails.** The client opens the link. Four checks are read from the chain first (signature, network, genuine contract, still payable). Then "Pay with PayPal" goes to PayPal's hosted invoice page, shown only when PayPal's amount equals the signed amount and the link is PayPal's own payer page, at an address pinned in the code; or the client pays in USDC (or PayPal USD) on Ethereum Sepolia from their own wallet, with one EIP-3009 authorisation.
5. **Paid means checked.** A PayPal webhook is verified with PayPal and then only triggers a read of the invoice from PayPal; a chain payment counts only as a verified Paid event at the exact amount. The freelancer's till turns green "via PAYPAL · verified with PayPal" or for the chain payment, never because of a message.
6. **The collections desk.** For every invoice, a deterministic table of ten situations reads both rails and decides what may happen next, with exact values. Paid on PayPal: cancel the PayLink link so the client cannot pay twice (the freelancer taps, then signs the cancellation in their own wallet). Paid on chain: the payment is recorded on the PayPal invoice automatically, with an Undo for 24 hours, so both books agree. Overdue: PayPal's own reminder when PayPal has the client's email (PayPal refuses one without it, and the desk says why), or a reminder message in the client's language for the freelancer to send. Cancelled on one rail: cancel on the other. Paid twice: an alert with the refund steps, never automatic. "Check my invoices" reads every open invoice again on PayPal and on the chain.
7. **Was I really paid?** Paste a payment notice; the verdict (received, partly, not received, can't check now) comes from PayPal and the chain only, never from the notice.
8. **Status.** One page shows the API, PayPal, the last verified webhook, the assistant's neurons left today, the store and the contract.

The app is in English, French and Malagasy, and is tested at 320 px wide in light and dark themes with axe-core.

## How we built it

**PayPal.** PayPal REST in the sandbox, from a Cloudflare Worker: OAuth 2.0 client credentials (the token cached in a Durable Object); Invoicing v2 search (by our reference, so a retried twin is found instead of duplicated), create, send, get (the truth for every PayPal state), record payment, delete payment (Undo), cancel and remind; Webhooks verify-webhook-signature (the delivery's raw bytes posted back to PayPal) and webhook creation for INVOICING.INVOICE.PAID, CANCELLED and UPDATED. Every write carries a PayPal-Request-Id; a write whose answer is lost is settled by reading, never repeated blind. The client has no operation that captures, refunds, pays out or disputes money. The desk's read tools follow the PayPal Agent Toolkit tool contract (names and schemas parity-tested against @paypal/agent-toolkit 1.11.0) and read only the freelancer's own reconciled invoices. Because PayPal's sandbox API could not be reached from our development environment, we built against PayPal's OpenAPI files and a PayPal fake whose every answer is validated against those schemas, then ran a capture script against the real sandbox (2026-10-29): it recorded how PayPal answers (a shared invoice reads UNPAID, a recorded payment MARKED_AS_PAID, the payer page's address, a reminder refused without the client's email, a reference search that also matches partially), and the code and the fake now follow it. Real sandbox payments proved the webhook path: each delivery verified with PayPal, then processed. What the run could not observe stays marked UNVERIFIED in the repository.

**AI.** Cloudflare Workers AI through the Worker's binding: @cf/google/gemma-4-26b-a4b-it, with @cf/meta/llama-3.3-70b-instruct-fp8-fast as fallback. Two jobs. Drafting: one structured call; personal data is replaced by placeholders before the model sees the message, and code parses amounts and dates. The desk: six read tools and propose_action, which only queues a proposal if the deterministic fence allows that action, and keeps the fence's values, never the model's; a reminder's text is kept only if its amount, its dates and its invoice number are that invoice's own, as code reads them from the record. Seven invariants are each enforced by a named test: the model cannot sign or submit a transaction, cannot move PayPal money, every effect needs a tap on exact values, no model text on money screens, numbers come from code, payment truth is PayPal's GET or the chain, untrusted text is data. Memos, PayPal notes and client names never reach the desk's model. An injection suite of 40 cases blocks a release, and an end-to-end test drives a model that obeys every injected instruction through the real provider, desk and fence: only the fence's own proposals survive. The assistant runs on the free daily allocation; when it is spent, it rests and every manual path works.

**Chain and app.** PayLinkV2 (Solidity 0.8.30, OpenZeppelin 5.3.0): immutable, ownerless, fee-less, exact-delta settlement, deployed by CREATE2 at the same address on every chain, its source verified on Etherscan. API: Hono and zod on Cloudflare Workers, SQLite-backed Durable Objects (one per payee, one global), one cron a minute. Web: strict TypeScript without a UI framework, a PWA with its own Content-Security-Policy and Trusted Types, viem.

**Tests.** 335 Foundry tests for the contract; more than 2,100 TypeScript unit and integration tests, 487 of them for the API; 51 Playwright end-to-end tests for this edition: every screen state in English, French and Malagasy, light and dark, with axe-core, and both rails end to end on a fork of the real Ethereum Sepolia with Circle's USDC contract and the PayPal fake.

## Challenges we ran into

- No route to PayPal's sandbox from our development environment: we built on a fake validated against PayPal's OpenAPI files, then one capture run on the real sandbox pinned what it does. PayPal's webhook simulator events do not verify by postback, so the webhook path was proven with real sandbox payments.
- Two rails echo each other: PayLink's own record on the PayPal invoice must never look like a second payment. An echo filter matches PayPal's payment method, our note naming the chain transaction, and a verified Paid event in that transaction.
- Ethereum Sepolia now runs Amsterdam, whose state-creation gas makes our contract's deployment cost about 19.2 million gas, seven times what our registry assumed. We caught it on a fork of the real chain and re-measured every gas bound before the real deployment.
- Prompt injection everywhere: client messages, memos and PayPal notes are untrusted text, and the agent's tools can only propose.

## Accomplishments that we're proud of

- An agent that reads both rails and proposes useful next steps, yet structurally cannot move money: the fence is code, approvals are bound to exact values, and the chain cancellation is the freelancer's own signature.
- Both rails end to end, repeated eight times each without a failure on a fork of the real Ethereum Sepolia: paid on PayPal, then the verified webhook, the desk's proposal and the freelancer's own cancellation on chain; paid in USDC, then the automatic record on the PayPal invoice and its Undo; and injected instructions in a memo and in a PayPal note that change nothing, even with a model built to obey them.

## What we learned

PayPal's GET of an invoice is a better source of truth than any event; webhooks are hints. The sandbox shows what no schema says: a payment recorded by the merchant reads MARKED_AS_PAID, a reminder needs the client's email, a reference search also matches part of a reference. An agent becomes trustworthy when its tools are narrower than its prompt. Measured numbers beat assumed ones: the gas surprise came from a fork, not from documentation.

## What's next

Publish a live, dated eval scoreboard; per-freelancer PayPal onboarding instead of one demo merchant; PayPal USD as soon as test tokens can be obtained; mainnet only after a legal review of payments and foreign exchange in Madagascar.

## Honest status

PayPal sandbox and Ethereum Sepolia testnet only; no real money. One sandbox PayPal merchant stands for every freelancer in the demo; whether a Malagasy PayPal account can receive is unverified, and the product claims nothing about it. Not audited: our own review only. No users, revenue or partners yet. PayLinkV2 on Ethereum Sepolia: deployed on 2026-10-29, transaction 0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3, source verified on Etherscan. Built during the hackathon, from 2026-10-21, on top of PayLink v2 (built from 2026-10-05, also entered in other events); the commit range is in the repository. [TO FILL: the live evals' date and scores, or delete this sentence.]

AI in the product: Cloudflare Workers AI (@cf/google/gemma-4-26b-a4b-it, fallback @cf/meta/llama-3.3-70b-instruct-fp8-fast). Development assisted by Claude Code (Anthropic); the owner directed, reviewed and is responsible for the work.
```
Characters: 10,879 (no stated limit)

#### Built with

Required; free tags with autocomplete, up to 25 ("Languages, frameworks, platforms, cloud..."). Type them one by one. The list names PayPal and the AI, as the update asks; the Agent Toolkit is not in it, since the product follows its tool contract without running it ([§1](#1-facts-this-pack-relies-on)).

<!-- field: paypal.built-with tags=25 -->
```text
paypal
paypal-invoicing
paypal-webhooks
paypal-sandbox
cloudflare-workers-ai
gemma
llama
claude-code
cloudflare-workers
cloudflare-durable-objects
cloudflare-pages
typescript
hono
zod
viem
solidity
ethereum-sepolia
usdc
pyusd
playwright
vitest
fast-check
foundry
```
Tags: 23 / 25

#### "Try it out" links

Optional, several.

<!-- field: paypal.try-it links -->
```text
https://paypal.paylink-mg.pages.dev/paypal/
https://github.com/nambininasafidison/paylink/tree/paypal
```
Links: 2 https addresses

#### Image gallery (you)

Optional; JPG, PNG or GIF, 5 MB each, at most 15, 3:2. Screenshots of the live edition: the assistant's draft, the twin read back from PayPal, the pay page's two rails, PayPal's sandbox page, the green till "via PAYPAL", the desk's proposal, Status. No sandbox login, no wallet secret, no personal detail on any of them.

#### Demo video (you)

Required; YouTube only, under 3 minutes (only the first 3 minutes are judged), public or unlisted, no password. The rules ask for a public video: upload it public. [TO FILL: the YouTube link] ([§8](#8-video-storyboard-under-300-captions-no-invented-numbers)).

### Step 4: Additional info (for judges and organizers)

The form: "For judges and organizers - Unless noted, additional info is for judges and hackathon organizers and will not appear on your public project page." Only the country appears in the project gallery.

#### Upload a File (you)

Optional, 35 MB. Leave it empty unless you want to add something: the repository holds the code, the documentation and the run instructions.

#### Submitter Type

Required.

<!-- field: paypal.submitter-type choice -->
```text
Individual
```
One of: Individual · Team · Organization

#### Submitter Country of Residence

Required; appears in the project gallery.

<!-- field: paypal.country select -->
```text
Madagascar
```
Select: one line from the form's list

#### Canada province

Required ("N/A" otherwise).

<!-- field: paypal.province max=0 -->
```text
N/A
```
Characters: 3 (no stated limit)

#### Organization Name

Required ("N/A" otherwise).

<!-- field: paypal.organization max=0 -->
```text
N/A
```
Characters: 3 (no stated limit)

#### New or existing

"Is your project new, or did it exist before Oct 1, 2026 (9:15 am PT)?" Required. Your answer of 2026-10-29. The git history has no commit before 2026-10-04 (`31a4fdd`), after the period opened; "Existing" tells the judges that this entry builds on PayLink work done earlier in October for other events, and the next field says both. If you choose "New" instead, the next field takes "N/A".

<!-- field: paypal.new-or-existing choice -->
```text
Existing
```
One of: New · Existing

#### What existed before

"If it existed before, explain what already existed and what you built or changed during the submission period." Required ("N/A" if new). From the git history and [§9](#9-disclosures-and-commit-range).

<!-- field: paypal.existed-before max=0 -->
```text
Nothing of this project existed before Oct 1, 2026 (9:15 am PT): the repository's first commit, 31a4fdd, is from 2026-10-04. Before this entry, inside the submission period, I built PayLink for other events, where it is also entered:
- PayLink v1 on Arc, 2026-10-04 and 2026-10-05 (commits 31a4fdd and 93ed4e3; Arc Microgrants).
- PayLink v2 from 2026-10-07 (88ac2d9): the PayLinkV2 contract, its SDK, the chain registry, the web app, the deploy kit, the relayer and the history indexer (Monad Metropolis, Colosseum).
- The Mezo edition, 2026-10-13 to 2026-10-20 (f0fb1ce to ffd952f; Mezo Buildathon).
Built for this hackathon, on the branch paypal from 2026-10-21 (first commit 828b9ff, on top of ffd952f): Ethereum Sepolia with USDC and PayPal USD in the chain registry and the deploy kit; the API Worker (PayPal client, webhook verification, twins, the reconciler and its fence, approvals, sessions, Durable Objects, cron); the Workers AI assistant (drafting and the collections desk) with its invariants, injection suite and evals; the PayPal edition of the web app (assistant, twin panel, two-rail pay page, desk, till via PayPal, Status); the end-to-end tests of both rails; and, on 2026-10-29, the deployment of the unchanged PayLinkV2 contract on Ethereum Sepolia and a capture run on PayPal's sandbox. All the PayPal and AI features of the project were built on this branch. The commit range is in the repository: docs/submissions/paypal.md, section 9.
```
Characters: 1,461 (no stated limit)

#### Main technology requirement

"Explain how your project meets the main technology requirement." Required: each PayPal tool and each AI tool, and what it is used for.

<!-- field: paypal.main-technology max=0 -->
```text
PayPal is one of the invoice's two rails and the source of truth for it; the AI drafts and advises, and can only propose.

PayPal tools, in the sandbox, called from the Cloudflare Worker that serves the API (apps/api/src/paypal/client.ts):
- OAuth 2.0 client credentials (POST /v1/oauth2/token): the Worker's access token, cached until 10 minutes before it expires.
- Invoicing v2: create (POST /v2/invoicing/invoices) and send (.../send) make the "twin", a PayPal invoice for the same amount as the signed PayLink invoice, with the link's key in PayPal's reference field; search-invoices finds an existing twin before a new one is made (keeping exact matches only, as PayPal's search also matches part of a reference); get (GET .../{id}) is the truth for every PayPal state; record payment (.../payments) writes a verified chain payment onto the twin, and delete payment undoes it within 24 hours; cancel (.../cancel) and remind (.../remind) run only after the freelancer approves a proposal with its exact values, and the reminder only for a twin with the client's email, which PayPal requires.
- Webhooks: verify-webhook-signature (POST /v1/notifications/verify-webhook-signature) on every delivery, with the raw body; a verified INVOICING.INVOICE.PAID, CANCELLED or UPDATED event only triggers a GET of the invoice. The subscription is made with POST /v1/notifications/webhooks or in the dashboard.
- PayPal's hosted invoice page (https://www.sandbox.paypal.com/invoice/p/#...) is the payer's PayPal rail: the pay page offers it only when PayPal's amount equals the signed one.
- PayPal USD (PYUSD) on Ethereum Sepolia: accepted as a stablecoin rail next to Circle's USDC (rehearsed on a fork; no test PYUSD could be obtained).
- PayPal Agent Toolkit: the desk's read tools use its tool names and parameter schemas (list_invoices, get_invoice, search_invoicing), parity-tested against @paypal/agent-toolkit 1.11.0; it is not run as a dependency.
- PayPal's OpenAPI files (paypal-rest-api-specifications): the PayPal fake the tests run against is validated against them.
No call captures, refunds, pays out or disputes money.

AI tools:
- Cloudflare Workers AI, through the Worker's AI binding: @cf/google/gemma-4-26b-a4b-it, with @cf/meta/llama-3.3-70b-instruct-fp8-fast as fallback. It drafts an invoice from a client's message (personal data replaced by placeholders first; code parses the amount and the date) and runs the collections desk's agent: six read tools and propose_action, which keeps only an action that the deterministic fence allows, with the fence's values. It cannot sign, submit a transaction, call a PayPal write or decide whether an invoice is paid.
- Claude Code (Anthropic): the AI assistant I used for the code, the tests and the documentation, under my direction.
```
Characters: 2,793 (no stated limit)

#### Sponsor tools

"Which additional sponsor tool(s) did you use for this project?" Required, multiple choice. Your answer.

<!-- field: paypal.sponsor-tools choices -->
```text
None, used other AI tools.
```
Any of: AG Grid · APIMatic · Astropods · Bryntum · Channel3 · Elastic · KERNEL · Postman · Render · Zapier · None, used other AI tools.

#### Repository

The form asks for the public code repository URL (required: an OSI licence, a README with setup, an explanation of the PayPal and AI usage). The branch `paypal` holds the edition, its landing README (setup, the PayPal edition, the AI, the judges' tour) and the MIT licence.

<!-- field: paypal.repository url -->
```text
https://github.com/nambininasafidison/paylink/tree/paypal
```
URL: one https address

#### Demo

The form asks for the working demo URL (required).

<!-- field: paypal.demo url -->
```text
https://paypal.paylink-mg.pages.dev/paypal/
```
URL: one https address

#### Testing instructions

The form's words: "Testing instructions or credentials the judges need to test your project, if any." Optional; private to judges and organizers. **The sandbox buyer logins go into this field only**, typed in the form where the text says `[TO FILL in Devpost only: …]`: never into this repository, the story, the video or a chat. They are sandbox logins with no real money behind them; change their passwords after the winners are announced ([runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links)).

<!-- field: paypal.testing max=0 -->
```text
Everything runs on the PayPal sandbox and the Ethereum Sepolia testnet: no real money. Live edition: https://paypal.paylink-mg.pages.dev/paypal/ (its Status page, in the footer, shows whether each service answers right now).

PATH B: PayPal only, no wallet, about 5 minutes
1. Open one of your invoice links:
   Judge A: [TO FILL: three links]
   Judge B: [TO FILL: three links]
2. The page checks the invoice on the chain and shows "Two ways to pay". Press "Pay with PayPal".
3. On PayPal's sandbox page (www.sandbox.paypal.com), log in with your sandbox buyer and pay.
   Judge A sandbox buyer: [TO FILL in Devpost only: email / password]
   Judge B sandbox buyer: [TO FILL in Devpost only: email / password]
4. Open the same link again: the pay page now says "PayPal says this invoice is paid." and no longer offers PayPal.

PATH A: the whole flow, about 15 minutes
Needs a browser wallet (MetaMask or another EIP-6963 wallet) on Ethereum Sepolia with a little Sepolia ETH, and test USDC from https://faucet.circle.com for the paying side.
1. Open the live edition. Press "Assistant", paste a client message such as "Love it! Send me the invoice, $12, I'll pay by Friday", press "Draft": the wallet connects and signs a desk session (one signature, no transaction, no fee). Check the values, press "Use draft", then "Review and sign" and sign the invoice in the wallet (one more signature, no transaction).
2. "PayPal twin" comes first under the signed invoice: give a client name (and an email if you like: PayPal's own reminder needs one) and press "Make the PayPal twin". The panel reads the twin back from PayPal.
3. Copy the link and open it in another browser profile. Pay with PayPal as your sandbox buyer, or pay in USDC from a second wallet account (one signature, one transaction).
4. Back on the first profile, open "Desk" (if it asks, "Open my desk": one signature, no transaction), then press "Check my invoices". Paid on PayPal: the desk proposes cancelling the PayLink link, with the exact values; approve, then confirm the cancellation in your wallet. Paid in USDC: the desk shows "Recorded on PayPal invoice ..." with Undo.
5. "Was I really paid?" at the bottom of the desk: paste a made-up payment notice and see the verdict from PayPal and the chain.

PATH C: no account at all, on your machine
git clone https://github.com/nambininasafidison/paylink && cd paylink && git checkout paypal
pnpm install --frozen-lockfile && pnpm --filter @paylink/e2e exec playwright install chromium
pnpm --filter @paylink/e2e test specs/paypal-rails.spec.ts
(Node 22.22, pnpm 10.28, Foundry's anvil, and internet access to Ethereum Sepolia's public RPC for the fork; nothing is sent to Sepolia or PayPal.)
```
Characters: 2,710 (no stated limit)

#### PayPal rating

"How would you rate your overall experience integrating PayPal?" Required, 1 to 10. Your answer.

<!-- field: paypal.rating scale=1-10 -->
```text
8
```
Scale: 1 to 10

#### Why that rating

"Overall experience rating: Please share why or provide additional feedback." Required. Only what was observed during the capture and the setup (2026-10-29).

<!-- field: paypal.rating-why max=0 -->
```text
8 out of 10. Invoicing v2 has every operation the twin needs, and PayPal's published OpenAPI files let me build and contract-test the integration from a development environment that could not reach the sandbox; one run on the real sandbox (2026-10-29) then settled what the files leave open. What cost time, observed during that run and the setup:
- Webhook simulator events cannot be verified by postback (verify-webhook-signature), so proving the webhook path needed a real sandbox payment.
- send_invoice_reminder refuses an invoice without a billing email: 400 INVALID_REQUEST, CANNOT_REMIND_AS_BILLING_INFO_ABSENT. My desk now offers PayPal's reminder only when PayPal has the client's email, and says why otherwise.
- The invoice search by reference also matches part of a reference, so an exact lookup must filter the results.
- Recording an external payment makes the invoice MARKED_AS_PAID, not PAID.
- The sandbox "Create custom account" form failed with "Something went wrong"; the default account creation worked.
- My first capture attempt failed with 401 invalid_client because I had pasted a secret from the wrong place: the dashboard's Sandbox/Live switch is easy to miss.
```
Characters: 1,188 (no stated limit)

#### Contact about PayPal

"Are you open to us contacting you for additional feedback regarding your experience with integrating PayPal?" Required. Your answer.

<!-- field: paypal.contact choice -->
```text
Yes
```
One of: Yes · No

#### APIMatic and AG Grid (you)

"APIMatic Context Plugin and AG Grid experience": optional. Leave them empty: neither was used.

#### Eligibility (you)

Three required checkboxes: age of majority; eligible jurisdiction; not an employee, representative or agent of the Promotion Entities. **Tick them yourself**, each only if it is true for you; this pack does not answer them.

#### AI tools

"Which AI tools have you leveraged while working on this project?" Required. Your wording of 2026-10-29, word for word.

<!-- field: paypal.ai-tools max=0 -->
```text
Claude Code (Anthropic) as the project's AI assistant (code, tests, documentation) under my direction; inside the product, Cloudflare Workers AI (Google Gemma model) for the drafting assistant and the desk agent.
```
Characters: 212 (no stated limit)

#### Learning

"Describe the level of learning you/your team derived from the project" Required. Your answer.

<!-- field: paypal.learning choice -->
```text
Significant
```
One of: None · Moderate · Significant

#### AI value

"Did you gain AI value that you can use in your career?" Required. Your answer.

<!-- field: paypal.ai-value choice -->
```text
Yes
```
One of: Yes · No

### Step 5: Submit (you)

One required checkbox, "I, and all of my team members, have read and agree to be bound by the Official Rules and the Devpost Terms of Service.", which you tick yourself, then **Submit project**. The project stays editable until the deadline.

## 4. The PayPal integration, explained

Operation keys are those of [SPEC §7.1](../paypal/SPEC.md#71-operations); paths and scopes are `PAYPAL_OPERATIONS` in `apps/api/src/paypal/client.ts`, taken from PayPal's OpenAPI files at `90e8041`. P12 (PayPal's QR code) is cut (decision D-SCOPE).

| Key | PayPal call | What PayLink uses it for | Called from |
|---|---|---|---|
| P1 | `POST /v1/oauth2/token` | Client-credentials token, cached in the `Global` Durable Object until 10 minutes before it expires (the sandbox's token lived 32,326 s on 2026-10-29); a refused token is replaced once | `apps/api/src/paypal/token.ts` |
| P2 | `POST /v2/invoicing/search-invoices` | Find an existing twin by the link's key in `reference` before creating one (idempotency); exact matches only, since PayPal's search also matches part of a reference | `apps/api/src/paypal/twin.ts` |
| P3 | `POST /v2/invoicing/invoices` | Create the twin: the signed amount in USD, the link's key as `reference`, the due date | `apps/api/src/paypal/twin.ts` |
| P4 | `POST /v2/invoicing/invoices/{invoice_id}/send` | Share it (PayPal's payer link); the sandbox then reads `UNPAID` | `apps/api/src/paypal/twin.ts` |
| P5 | `GET /v2/invoicing/invoices/{invoice_id}` | **The truth** for every PayPal state: after creating, after each webhook, on "Check my invoices", in the minute cron and before every approved action | `apps/api/src/paypal/twin.ts`, `apps/api/src/routes/webhook.ts`, `apps/api/src/reconciler/engine.ts` |
| P6 | `POST /v2/invoicing/invoices/{invoice_id}/payments` | Record a verified chain payment on the twin (method `OTHER`, a note naming the chain transaction and the key), automatically (S3); the sandbox then reads `MARKED_AS_PAID` | `apps/api/src/reconciler/engine.ts` |
| P7 | `DELETE /v2/invoicing/invoices/{invoice_id}/payments/{transaction_id}` | Undo that record within 24 hours, with P6's `payment_id` | `apps/api/src/reconciler/executor.ts` |
| P8 | `POST /v2/invoicing/invoices/{invoice_id}/cancel` | Cancel the twin after the payee's tap (link cancelled or expired on chain, or PayPal still open after a record) | `apps/api/src/reconciler/executor.ts` |
| P9 | `POST /v2/invoicing/invoices/{invoice_id}/remind` | PayPal's own reminder after the payee's tap, at most once per invoice per 24 hours, only for twins with a client email (PayPal refuses it without one: 400 `CANNOT_REMIND_AS_BILLING_INFO_ABSENT`) | `apps/api/src/reconciler/executor.ts` |
| P10 | `POST /v1/notifications/verify-webhook-signature` | Every delivery, with the raw body spliced in byte for byte; a delivery that does not verify changes nothing | `apps/api/src/paypal/webhook.ts` |
| P11 | `POST /v1/notifications/webhooks` | Subscribe the Worker's URL to `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `INVOICING.INVOICE.UPDATED` (the owner's script) | `apps/api/scripts/capture/main.ts` |
| P13, P14 | `GET /v2/invoicing/invoices`, `GET /v1/notifications/webhooks-events/{event_id}` | In the client and its contract tests; no route calls them in this release | `apps/api/src/paypal/http.ts` |

Trust: a webhook body never decides anything (it triggers P5); the pay page follows only PayPal's payer page itself, `https://www.sandbox.paypal.com/invoice/p/#{id}` (that host and path, the invoice in the fragment, no port and no query), and only when PayPal's amount equals the signed one (`apps/web/src/editions/paypal/rails.ts`); PayLink's own P6 record is recognised by the echo filter (`apps/api/src/reconciler/echo.ts`) so it is never a second payment. The capture run of 2026-10-29 settled what only the sandbox could show (the statuses after a share, a payment, a record, an undo and a cancel; the payer page; the reference search; reminders), [runbook §5](../runbooks/paypal.md#5-what-the-capture-decides); K4 remains for the rehearsal.

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

The text judges read is the field [Testing instructions](#testing-instructions) of §3 (Step 4). Devpost's form says it is private to judges and organizers (read on 2026-10-29), so the sandbox buyer logins go there and nowhere else: you type each one into the form where the text says `[TO FILL in Devpost only: …]`, and in this file those lines stay placeholders. Never put them in the repository, the public story, the video or a chat.

| What the field needs | State on 2026-10-29 |
|---|---|
| Two judge buyers with sandbox balances | Done: "judge A" and "judge B" (and "video" for the recording), personal, US, 5,000 USD each, Verified |
| Three judge links each (path B), with "Expires: Never" | To make ([runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links) step 3) |
| The live edition with PayLinkV2 deployed (paths A and B) | Online; the source is verified on Etherscan |
| The Worker with its secrets and the PayPal webhook | Online; five real deliveries verified and processed |
| Path C | Nothing from you |

What a judge sees on each path, and what can go wrong:

| Path | Sees | If it fails |
|---|---|---|
| B (PayPal only) | The pay page's four lamps, "Two ways to pay" with **Pay with PayPal** as the main key, PayPal's sandbox page, then "PayPal says this invoice is paid." | The PayPal key is missing: the link expired or was paid (the PAYABLE lamp is red: make judge links with "Expires: Never", [runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links)), the twin's amount or PayPal's payer page did not match (the page says "PayPal option withheld"), or the API is down (Status) |
| A (whole flow) | Draft, sign, twin, both rails, the till, the desk's proposals and approvals, Undo, "Was I really paid?" | "Assistant resting": the day's neurons are spent; write the invoice by hand. No Sepolia ETH: the pay page says so. No client email on the twin: the desk offers its own reminder message instead of PayPal's, and says why |
| C (local) | Three Playwright tests passing against a fork of Sepolia and the PayPal fake | anvil missing (install Foundry), or no route to `ethereum-sepolia-rpc.publicnode.com` |

## 7. Honest limitations

| Limitation | What it means | Where it is said |
|---|---|---|
| Sandbox and testnet only | No real money moves; PayPal's live API is not used | story, Status, every page's notes |
| PayPal sandbox: one capture run | The run of 2026-10-29 recorded the statuses after a share, a payment, a record, an undo and a cancel, the payer page, the reference search, reminders, the payment id and the token's lifetime; what it could not observe stays UNVERIFIED. **K4 is open**: whether PayPal still takes a payment on a twin marked as paid (`MARKED_AS_PAID`). It is checked at the rehearsal; if PayPal does, the desk must also propose cancelling the PayPal invoice after a record (SPEC §10.4) | [capture report](../research/paypal/capture-2026-10-29.md); [runbook §5, §11](../runbooks/paypal.md#11-rehearsal) |
| PayPal's reminder needs the client's email | PayPal refuses its own reminder for an invoice without a billing email (400 `CANNOT_REMIND_AS_BILLING_INFO_ABSENT`); the desk then offers only a message for the freelancer to send, and says why | the desk; [apps/api/README.md](../../apps/api/README.md) |
| One PayPal merchant | One sandbox business account stands for every freelancer; per-freelancer onboarding is future work | story, "What's next" |
| Receiving PayPal in Madagascar | Secondary sources say Malagasy PayPal accounts may be send-only (**UNVERIFIED**); the product claims nothing about it. The story says so: the PayPal rail is for freelancers wherever PayPal lets them receive, and in Madagascar the on-chain rail is the one that can still pay them | story ("Inspiration", "Honest status"); [SPEC §1.2](../paypal/SPEC.md#12-reality-check-published-at-the-top-of-the-readme-and-the-devpost-text) |
| AI quality unmeasured | No live Workers AI call yet (on 2026-10-29 Status read the assistant "unknown", not used yet); CI measures code only | [§5](#5-the-ai-explained) |
| Free AI allocation | 10,000 neurons a day; the assistant rests when they are spent, every manual path works | Status |
| PayPal USD | Supported and shown; paid only on fork rehearsals (no test PYUSD obtainable from Madagascar) | [§1](#1-facts-this-pack-relies-on) |
| No gasless payments | The payer pays Sepolia gas (no relayer in this edition, decision D-SCOPE) | pay page |
| No passkeys | Browser wallets only in this edition | [ADR 0018](../adr/0018-paypal-edition.md) |
| Cut | The free-text desk question, the AI reason codes of "Was I really paid?", PayPal's QR code on the print card | [SPEC D-SCOPE](../paypal/SPEC.md#d-scope-what-is-kept-and-what-is-cut) |
| Malagasy | The Malagasy strings and eval cases are drafts awaiting the owner's review | `packages/i18n/src/locales/mg.review.json` |
| Hosting | A Pages preview of a branch and a Worker on the owner's account; both must stay up until judging ends (2026-12-15) | runbook §12 |
| Not audited | Our own review of the contract only | landing page |
| No rate limit per IP on the public rail route | `GET /v1/rails/:key` is public; it reads the store and PayPal is read by the cron, not per request | `apps/api/README.md` |
| zod 4.6.5 has a high advisory | GHSA-mrhx-c7xc-m3w5 ("Zod can exhaust memory while validating oversized constrained collections", zod < 4.6.6), reported on the API; the relayer and the web app use the same version. zod 4.6.7 (published 2026-10-12, the same code as 4.6.6) was built and tested on 2026-10-29 and then reverted: it made the Monad edition's pay route 110.1 kB of gzipped JavaScript, over its 110 kB budget (109.9 kB with 4.6.5), and that budget is a gate. Meanwhile every request body the API reads is capped before parsing (8 KiB by default, 16 KiB for the draft and check routes, 64 KiB for PayPal's webhook; `apps/api/src/routes/types.ts`), and PayPal answers longer than 1,048,576 characters are not parsed. The workspace audit gate fails on it until zod moves | this table; `python3 scripts/toolchain/audit-workspace.py --prod` |
| An advisory in the indexer's dependencies | The same audit reports body-parser GHSA-27r3-jxmh-p828 (high) through `apps/indexer` > envio 3.12.1 > express, the path [ADR 0011](../adr/0011-workspace-layout.md#known-audit-item-for-the-indexer) examined for an earlier body-parser advisory; none of the edition's bundles contains it. A patched envio or a reasoned exception for that one path is the owner's decision | same |

## 8. Video storyboard (under 3:00, captions, no invented numbers)

**Goal:** both rails (PayPal, and USDC on chain) and the desk on the live edition, in 2:45. English captions burned in (the video works muted); narration optional, in English. Name PayPal and the AI on screen, as the update "Two weeks to go" asks. No music, or royalty-free only. No third-party logos other than PayPal's own sandbox pages (PayPal is the sponsor; still **UNVERIFIED** that showing its pages needs no permission, question Q11).

**Rules** ([demo recording runbook §1](../runbooks/demo-recording.md#1-honesty-rules)): real sandbox and testnet operations only; every number on screen is what the app showed during that take (never typed into the edit); mark every cut ("cut: waiting for the block"); say "sandbox · testnet" on screen; never "audited"; nothing private on screen (no sandbox password, no secret, no wallet seed). If a beat fails on the day, use a take recorded earlier and say so on screen.

**Preconditions**

- [ ] [§10](#10-liste-de-contrôle-en-français) steps 1 to 10 done (the judge links made, the rehearsal passed the same week); `/paypal/status/` green with your pushed commit.
- [ ] Chrome with two profiles at 1280 × 800: **Payee** (MetaMask: your "PayPal Demo" wallet, the API's demo payee of [runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links) step 4, its account named "Rina Design" in MetaMask for the take; a little Sepolia ETH) and **Client** (MetaMask account "Sarah", Sepolia ETH and at least 20 test USDC, and the "video" sandbox buyer's login typed off camera). Light theme, English, Do Not Disturb, no other extension, bookmarks bar hidden.
- [ ] "Rina" and "Sarah" are made-up names: the first caption says the story is a composite.

| # | Time | Screen and exact clicks | Caption |
|---|---|---|---|
| 1 | 0:00–0:10 | Payee: `/paypal/` home | "Rina (a composite) designs logos in Antananarivo. Her clients pay from abroad, some with PayPal, some in dollars on chain." · "PayPal sandbox · Ethereum Sepolia testnet · no real money" |
| 2 | 0:10–0:30 | **Assistant**; paste "Love it! Send me the invoice, $12, I'll pay by Friday"; **Draft** → MetaMask: connect, then sign the desk session (typed data, no transaction); hold on the AI draft card (amount "as written", due date, the model's name) | "Rina opens her desk: one signature, no transaction." · "The assistant (Cloudflare Workers AI) drafts. Code checks every number against the message." |
| 3 | 0:30–0:42 | **Use draft**, **Review and sign**, **Sign in wallet**; MetaMask's typed-data request; approve | "The invoice: one signature, no transaction, no gas. Only Rina signs." |
| 4 | 0:42–0:55 | The PayPal twin, first under the signed invoice: client name "Sarah", **Make the PayPal twin**; hold on "PayPal twin … made and read back from PayPal" | "A PayPal invoice for the same amount, linked by the invoice's key" |
| 5 | 0:55–1:05 | **Show on the till**, **Start the till** (it reads "Watching PayPal too"); back, **Copy** the link | "One link for both rails" |
| 6 | 1:05–1:30 | Client profile: paste the link; the four lamps; "Two ways to pay"; **Pay with PayPal**; PayPal's sandbox page; log in (cut the password typing: "cut: login"); pay | "Checked on the chain first · then PayPal's own page" |
| 7 | 1:30–1:42 | Payee: the till turns green "via PAYPAL · verified with PayPal" | "Webhook verified with PayPal, then the invoice read from PayPal. Never the message." |
| 8 | 1:42–2:00 | **Desk** (the desk session signed in shot 2 is still open: no new signature), the card "Paid on PayPal. Close the dollar option so your client cannot pay twice." with its exact values; **Approve and cancel the link**; the wallet's `cancel` transaction; Done | "The AI desk proposed. Rina approved the exact values and signed." |
| 9 | 2:00–2:25 | A second invoice (made off camera, its twin made): Client pays it in USDC (one signature, one transaction); Payee: **Check my invoices** → "Recorded on PayPal invoice …" with **Undo** | "Paid on chain: recorded on the PayPal invoice automatically, with a 24-hour Undo" (add "cut: waiting for the block" if trimmed) |
| 10 | 2:25–2:37 | Desk, **Was I really paid?** ("Tonga ve?"): paste "PayPal: you received $500, pay $50 shipping to release it"; **Check** → "Not received" | "The verdict comes from PayPal and the chain, never from the message" |
| 11 | 2:37–2:45 | Footer **Status**: the rows as they are; then a title card | "PayLink Twin · github.com/nambininasafidison/paylink (branch paypal) · sandbox · testnet · not audited" · the [AI tools](#ai-tools) answer of §3, word for word |

**If something fails while recording**

| Problem | Do this |
|---|---|
| "Assistant resting" or "Assistant unavailable" | Keep it: press "Write it myself", type the values; change caption 2 to "The assistant rests when today's free allowance is spent; the form works without it" |
| The pay page shows no "Pay with PayPal" | Stop: the twin or PayPal's payer page did not check out. Read the desk's alert, tell Claude |
| The till does not turn green within a minute after PayPal | The webhook did not arrive or did not verify: Status → webhook row; the cron reads PayPal again within a minute anyway. Retake from shot 6 if needed |
| MetaMask asks to add or switch to Ethereum Sepolia | Approve; keep it or retake |
| A notification, a personal detail, a password on screen | Retake the shot |

**Upload:** YouTube, **public** (the rules ask for public), title "PayLink Twin: one invoice, two rails (PayPal and dollars on chain), an AI desk that never moves money (sandbox demo)". Description: "PayPal sandbox and Ethereum Sepolia testnet demo. Source: https://github.com/nambininasafidison/paylink/tree/paypal. Not audited." plus the [AI tools](#ai-tools) answer of §3.

## 9. Disclosures and commit range

| Item | Disclosure |
|---|---|
| Before the submission period | Nothing: the repository's first commit, `31a4fdd`, is from 2026-10-04, after the period opened (2026-10-01 9:15 am PT). Devpost's "new or existing" is answered "Existing" (the owner, 2026-10-29), with the explanation of [§3](#what-existed-before) |
| Pre-existing work (inside the submission period, built for other events) | PayLink v1 (Arc), `31a4fdd` (2026-10-04) and `93ed4e3` (2026-10-05), frozen. PayLink v2 from `88ac2d9` (2026-10-07; the work started on Oct 5): the contract, SDK, registry, web app, deploy kit, relayer, indexer, entered at Monad Metropolis and Colosseum. The Mezo edition, branch `mezo` from `f0fb1ce` (2026-10-13) to `ffd952f` (2026-10-20), entered at the Mezo Buildathon |
| Built for this hackathon | The branch `paypal`, from `828b9ff` (2026-10-21) to the submitted commit, on top of `ffd952f`: Ethereum Sepolia in `packages/chains`, the deploy kit and `tools/verify-deployment`; `apps/api` (PayPal, reconciler, approvals, sessions, AI, Durable Objects, cron); `packages/api-contract`; the PayPal edition (`apps/web/src/editions/paypal/`, the desk, the `paypal` catalogues of `packages/i18n`); `e2e/specs/paypal.spec.ts`, `paypal-ui.spec.ts`, `paypal-rails.spec.ts`; [ADR 0018](../adr/0018-paypal-edition.md), [the specification](../paypal/SPEC.md), the research notes in `docs/research/paypal/`, the [runbook](../runbooks/paypal.md) and this pack. On 2026-10-29: the deployment on Ethereum Sepolia and its Etherscan verification, the sandbox capture and what it decided |
| Unchanged | `protocol/src` (PayLinkV2 is immutable and already released); production (`main`); the frozen v1 paths |
| Other events | Monad Metropolis, Colosseum, the Mezo Buildathon and Arc Microgrants, same repository and contract (decision D-12 of the specification: name them) |
| AI | The [AI tools](#ai-tools) answer of §3, word for word; the repository's full disclosure, including how commits are attributed, is [AI_DISCLOSURE.md](../../AI_DISCLOSURE.md) |
| Third-party components | PayPal's OpenAPI files (vendored as test data with their licence), the PayPal Agent Toolkit's tool sources (vendored as test data for the parity test), OpenZeppelin Contracts 5.3.0, viem, Hono, zod, qrcode-generator, the Archivo and Martian Mono fonts ([NOTICE.md](../../NOTICE.md)) |
| Tag | `submission/paypal-<date>` on the submitted commit, created and pushed by you |

## 10. Liste de contrôle (en français)

Dans l'ordre : chaque étape a besoin de la précédente. Ne pousse jamais `main` ni `mezo` : seulement `paypal`. Les détails de chaque étape sont dans le [runbook PayPal](../runbooks/paypal.md). Les secrets (secret client PayPal, clés HMAC) ne vont **que** dans Cloudflare ou dans la variable d'environnement d'un terminal : jamais dans le dépôt, un fichier, une capture d'écran, un journal ou une conversation (y compris avec Claude). Les identifiants des acheteurs sandbox ne vont **que** dans le champ « Testing instructions » de Devpost.

**Fait (étapes 1 à 8, au 29 octobre 2026).**

1. **Devpost : fait le 29 octobre.** Ton agent de navigateur a lu le règlement, la FAQ et les « updates » (date limite jeudi 12 novembre 2026 à 12:00 PT, soit 20:00 UTC et 23:00 à Antananarivo ; vérification d'éligibilité anticipée pour les projets soumis avant le jeudi 5 novembre ; nommer PayPal et l'IA dans la description, dans « Built with » et dans la vidéo), puis le formulaire après « Start project » : le brouillon privé « PayLink Twin » existe, seul son nom est saisi, rien n'est soumis. Chaque champ, sa limite et ta réponse sont au [§3](#3-the-devpost-form-step-by-step).
2. **Application PayPal sandbox « PayLink Twin » : faite** (elle existait déjà ; vérifiée le 28 octobre : type Merchant, Invoicing activé).
3. **Prévisualisation Pages de la branche `paypal` : faite le 28 octobre** (branches de prévisualisation `mezo` et `paypal`, variables Preview vérifiées, Production inchangée). Le 29, `/paypal/status/` affiche Build `452c0ee` et « Release 2.0.0: code and immutables match ».
4. **Worker `paylink-api` par l'intégration Git : fait le 28 octobre** avec les réglages du [runbook §8](../runbooks/paypal.md#8-the-worker-paylink-api). Le 29, `/v1/health` : chaîne ok (déployé), PayPal ok, webhook ok, stockage ok, assistant « unknown » (pas encore utilisé).
5. **Secrets du Worker : faits.** Le 29 octobre, tu as remplacé `PAYPAL_CLIENT_SECRET` par le secret vérifié (une demande de jeton avait répondu HTTP 200).
6. **PayLinkV2 sur Ethereum Sepolia : déployé le 29 octobre** par ton portefeuille « PayPal Demo » depuis le kit (transaction `0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3`, bloc 12 017 054, 18 946 483 gas consommés à 1,5 gwei, soit 0,0284 ETH de Sepolia). Claude l'a revérifié avec `tools/verify-deployment` (les dix contrôles passent, ton fichier `11155111.json` est identique octet pour octet à l'enregistrement) et l'a enregistré dans `protocol/deployments/11155111.json`. **Code source vérifié sur Etherscan le 29 octobre** : « Source Code Verified - Exact Match » pour le contrat `PayLinkV2` (compilateur `v0.8.30+commit.73712a01`, optimisation activée avec 10 000 runs, EVM `paris`, licence MIT, format Solidity Standard Json-Input).
7. **Capture sandbox : faite le 29 octobre vers 05:30 UTC.** Claude a fixé ce qu'elle montre dans le code, le faux PayPal et les tests (page payeur `https://www.sandbox.paypal.com/invoice/p/#…`, statuts `UNPAID`, `PAID`, `MARKED_AS_PAID`, `CANCELLED`, rappel refusé sans e-mail, recherche par référence partielle, identifiant de paiement de 22 caractères, durée du jeton). P9 et P10 ont leur réponse ; **K4 reste à vérifier pendant la répétition** (étape 10).
8. **Abonnement webhook : fait le 29 octobre.** Cinq livraisons réelles `processed` sans erreur dans les journaux du Worker, la ligne `webhook` de `/v1/health` ok (`last-verified`).

**Reste à faire.**

9. **Liens des juges** ([runbook §10](../runbooks/paypal.md#10-judge-sandbox-buyers-and-judge-links)) : les trois acheteurs sandbox existent (« video », « judge A », « judge B » : comptes personnels US, 5 000 USD chacun, Verified) ; leurs identifiants restent dans ton gestionnaire de mots de passe **uniquement**. Avec le portefeuille « PayPal Demo » sur `/paypal/`, fais trois factures par juge (par exemple 5,00, 7,50 et 12,00 USDC), chacune avec son jumeau PayPal : ce sont les liens du parcours B. **Pour chaque lien des juges et de la vidéo, choisis « Expire : Jamais »** (et coche la confirmation) : par défaut un lien expire après 7 jours, au plus 30, et un lien signé vers le 1er novembre ne serait plus payable pendant l'évaluation (du 1er au 15 décembre) ; un lien expiré éteint le voyant PAYABLE et la page de paiement cache alors aussi « Pay with PayPal ». Sinon, refais-les chaque semaine. Le portefeuille « PayPal Demo » est dans `demoPayees` (`apps/api/src/core/config.ts`) depuis le 29 octobre, pour que ses sessions et l'assistant aient une réserve que le public ne peut pas épuiser. Si tu en utilises un autre, donne son adresse à Claude (elle est publique) : il l'y ajoute.
10. **Répétition, deux fois** ([runbook §11](../runbooks/paypal.md#11-rehearsal)) : les deux rails, le bureau, l'assistant, « Was I really paid? », les journaux du Worker, **et K4** : après l'enregistrement d'un paiement en chaîne sur un jumeau (`MARKED_AS_PAID`), ouvre la page payeur de ce jumeau avec un acheteur sandbox et note si PayPal propose encore de payer (ne paie pas). Dis le résultat à Claude : si PayPal accepte encore un paiement, le bureau doit aussi proposer d'annuler la facture PayPal après un enregistrement. Note aussi ce qui diffère du runbook.
11. **Évaluations en direct (facultatif mais nécessaire pour citer un score)** : avec un jeton Cloudflare « Workers AI » dans l'environnement, `node --conditions=@paylink/source apps/api/test/ai/evals/run.ts --live --set all` ([evals](../../apps/api/evals/README.md#running-the-live-evals-the-owner)). Donne le tableau daté à Claude ; sans lui, ne cite aucun score.
12. **Vidéo** ([§8](#8-video-storyboard-under-300-captions-no-invented-numbers)) : moins de 3:00, sous-titres anglais incrustés, PayPal et l'IA nommés à l'écran, aucun chiffre inventé (seulement ce que l'application affiche pendant la prise), chaque coupe signalée, aucun mot de passe ni secret à l'écran, « sandbox · testnet » visible. À filmer : l'assistant qui rédige, la signature, le jumeau PayPal relu, le paiement PayPal sur la page sandbox, la caisse verte « via PAYPAL », la proposition d'annulation et ta signature, le paiement USDC et l'enregistrement automatique avec Annuler, « Was I really paid? », Status. YouTube **public**.
13. **Remplir et soumettre, avant le 1er novembre** (l'objectif du plan) et en tout cas **avant le jeudi 5 novembre** pour la vérification d'éligibilité anticipée ; la date limite est le jeudi 12 novembre à 12:00 PT (20:00 UTC, 23:00 à Antananarivo), et le projet reste modifiable jusque-là. Donne d'abord à Claude le lien de la vidéo, les liens des juges (pas les identifiants) et les dates, ou remplace toi-même chaque `[TO FILL: …]` puis `python3 docs/tools/submission_fields.py --update`. Sur Devpost, suis le [§3](#3-the-devpost-form-step-by-step) étape par étape : les textes et tes réponses tels quels ; les identifiants des acheteurs sandbox **seulement** dans « Testing instructions » ; les trois cases d'éligibilité et la case finale du règlement, **toi seul**, et seulement si elles sont vraies pour toi. Vérifie que la page GitHub du dépôt affiche la licence MIT dans « About ». Puis pose le tag `submission/paypal-<date>` et pousse-le.
14. **Jusqu'au 15 décembre** ([runbook §12](../runbooks/paypal.md#12-until-judging-ends)) : chaque semaine un paiement sandbox, les soldes des acheteurs, les neurones de l'assistant sur Status, l'ETH de Sepolia du vendeur, et **chaque lien des juges encore PAYABLE** (ouvre-le : les quatre voyants verts et « Pay with PayPal » affiché ; sinon remplace-le). Une alerte `record-missing` sur le bureau : l'enregistrement d'un paiement sur la chaîne a quitté la facture PayPal, qui peut de nouveau être payée ; enregistre-le de nouveau ou annule la facture PayPal depuis le bureau. Ne pousse rien de cassant sur `paypal`. Après le 22 décembre, change chaque secret et les mots de passe des acheteurs.
