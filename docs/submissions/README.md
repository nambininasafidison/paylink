# Submissions: what is done, what you must still do

| | |
|---|---|
| **Competitions** | Monad Metropolis (Monad edition) and Colosseum Crypto World's Fair (Base edition). Arc Microgrants (v1), Mezo and PayPal have their own timelines (PAYLINK-V2-SPEC §1.2) and are not covered here |
| **Written** | 2026-10-09 ~03:00 UTC, against the repository at `d9662c3` plus the commit that adds this folder. Re-check every "Done" line that depends on something outside the repository (the live site, the relayer, the indexer) on the day you submit |
| **Who does what** | Claude drafts, builds and checks; you push, deploy, record, paste and submit ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)) |

| File | What it holds |
|---|---|
| [monad.md](monad.md) | Every field of the Monad form: name, one-line, description, go-to-market, judge access instructions, the four bounty answers, disclosures |
| [colosseum.md](colosseum.md) | Description, Base track framing (and why not Arbitrum yet), architecture, business plan and go-to-market, demand validation, why now, the open invoice specification as a public good, team, prior work and other events, a judge's quick test |
| [video-scripts.md](video-scripts.md) | Shot-by-shot scripts with exact clicks, captions, preconditions and fallbacks: Monad demo, Monad pitch, Agora demo, Colosseum pitch and demo, an optional 30 s advertisement; French translations of every spoken line |
| [monad-forum.md](monad-forum.md) | The questions to the Monad organisers (Q2 Agora fit and Q3 both Mera bounties are still open) |
| `assets/` | Logo, social card and product screenshots ([§3](#3-assets)) |

Placeholders read `[TO FILL: …]`. Each one is a fact that does not exist yet (a URL, a video, an interview count, your own words). Fill it or delete its sentence; never invent its content. `python3 docs/tools/submission_fields.py --update` recounts the characters after you edit a field, and `python3 docs/tools/check-docs.py` checks the count lines, links and addresses.

## 0. Where things stand (2026-10-09)

| Item | State | Evidence |
|---|---|---|
| PayLinkV2 on Monad testnet and Base Sepolia | **Live**, same address `0x448eCce9711860502806A3d5B021a4f9Ba715082` | runtime code read from both chains on 2026-10-09 |
| PayLinkV2 on Arbitrum Sepolia | **Not deployed** (no code at the address) | same check |
| Real payments through the contract | **None yet** on either chain | every block since deployment scanned for its events on 2026-10-09 |
| Code on GitHub | `main` at `088f4f7`. **Three commits are local only**: the ledger backup (`7b9b2b5`), the history indexer (`d9662c3`) and this folder | `git log origin/main..` |
| Live site `paylink-mg.pages.dev` | **Unknown from here**: the sandbox could not reach it today. FACTS (2026-10-08) say the deploy kit is live; whether the build settings now serve v2 at `/monad/` and `/base/` is for you to check | [Cloudflare Pages runbook §3, §5](../runbooks/cloudflare-pages.md#5-check-the-live-site) |
| Relayer (gasless payments, test AUSD, gasless cancel) | Built and tested; **not deployed** | [relayer runbook](../runbooks/relayer.md) |
| History indexer (Envio) | Built and tested; **not deployed**; `/config.json` has `"indexer": null` | [Envio runbook](../runbooks/envio.md) |
| Tests | All green on 2026-10-09: 335 Foundry, 1,441 TypeScript, 30 Playwright end-to-end, v1 `npm test` 7 of 7 | the runs listed in [monad.md §1](monad.md#1-facts-this-pack-relies-on) |
| Contract source on explorers | **Not verified yet** on MonadVision, Basescan or Blockscout | [deploy runbook](../runbooks/deploy.md) checklist |
| Videos | **None recorded** | [video-scripts.md](video-scripts.md) |
| Interviews, waitlist, users | **None** to report | [interview protocol](../research/interview-script.md) |

## 1. Monad Metropolis

Deadline **2026-10-14 03:59 UTC** (Oct 14, 06:59 EAT); our target **Oct 12, 20:00 UTC** (23:00 EAT). The project is a draft on the dashboard, with Track 02 and the four bounties selected.

### Done (in the repository)

- [x] The Monad edition: Mera passkeys as the only account layer, gasless AUSD, test AUSD through the relayer, till, receive card and Send, gasless cancel, ledger with history, encrypted ledger backup with a second PRF namespace, EN/FR/MG.
- [x] Contract deployed on Monad testnet; record in `protocol/deployments/10143.json`.
- [x] Relayer and indexer code, with runbooks for putting them online.
- [x] Paste-ready texts for every field, with character counts: [monad.md](monad.md).
- [x] Logo (1024 and 512 px PNG) and product screenshots: [§3](#3-assets).
- [x] Video scripts (a), (b), (c) and the optional advertisement: [video-scripts.md](video-scripts.md).

### You must still do, in this order

| # | Priority | Step | Where | Time |
|---|---|---|---|---|
| 1 | **P0** | Push `main` (the three local commits) | `git push origin main` | 1 min |
| 2 | **P0** | Make sure Pages serves v2: `/monad/status/` shows "Build … edition monad" with the pushed commit. If `/monad/` is 404 or shows v1, change the build settings once | [Cloudflare Pages runbook §3, §5](../runbooks/cloudflare-pages.md#3-change-the-build-settings) | 10 min |
| 3 | **P0** | Put the relayer online: create the Worker from the repository, create **its own new key yourself** and store it only as the Worker secret `RELAYER_PK`, fund it with MON (and Base Sepolia ETH for Colosseum), run the smoke test | [relayer runbook](../runbooks/relayer.md) §2 to §6 | 30–45 min |
| 4 | **P0** | Rehearse the hero flow once on real devices (§0.2 of the scripts): this also makes the first real testnet payment. Note which device setup works for PayLink keys | [video-scripts.md §0](video-scripts.md#0-before-any-recording) | 30 min |
| 5 | **P0** | Record and upload (a) technical demo, (b) pitch, (c) Agora demo, public on YouTube | [video-scripts.md](video-scripts.md) | 2–3 h |
| 6 | **P0** | Fill the form: track (already set), logo `assets/logo-1024.png`, name, one-line, description, go-to-market (fill its two placeholders or delete their sentences), GitHub, live product `https://paylink-mg.pages.dev/monad/`, the three video links, judge access instructions (delete its first paragraph once the relayer answers), Agora, Mera UX and Mera Many Keys answers | [monad.md](monad.md) | 30 min |
| 7 | **P0** | Envio bounty: tick it **only** if step 8 is done; otherwise untick it rather than describe a service that is not running | [monad.md §5.2](monad.md#52-envio-best-use-of-envio) | — |
| 8 | P1 | Put the indexer online on Envio Cloud (branch `envio`, Root Directory `apps/indexer`), then send Claude the GraphQL URL: Claude sets `/config.json`, regenerates the headers and commits; you push. Fill the two Envio placeholders. Redeploy before judging (Oct 14–27): the free plan keeps a deployment at most 30 days and changes its URL on every deploy | [Envio runbook](../runbooks/envio.md) | 30 min |
| 9 | P1 | Verify the contract source on MonadVision (and on Basescan or Blockscout for Colosseum) | [deploy runbook](../runbooks/deploy.md) | 20 min |
| 10 | P1 | Review the Malagasy strings flagged for you (`packages/i18n/src/locales/mg.review.json`); the history and books catalogues have their own Malagasy files | `packages/i18n/src/locales/` | 30 min |
| 11 | P1 | Read the forum for answers to Q2 (Agora fit, "instant settlement") and Q3 (both Mera bounties); adapt the bounty texts if an answer changes them | [monad-forum.md](monad-forum.md) | 10 min |
| 12 | P2 | Optional bounty videos (Envio, Mera UX, Mera Many Keys, at most 2 min each): cut them from video (a), shots 10–11 for Envio and Many Keys, 2–3 and 6–7 for Mera UX | [video-scripts.md (a)](video-scripts.md#1-a-monad-technical-demo-at-most-300) | 30 min |
| 13 | P2 | Optional 30 s advertisement and X profile | [video-scripts.md §5](video-scripts.md#5-optional-30-second-advertisement) | 20 min |
| 14 | **P0** | Submit; then tag the submitted commit `submission/monad-2026-10-12` and push the tag | the dashboard | 5 min |

Keep alive through judging (Oct 14–27): the relayer funded, the indexer redeployed within its 30 days, the site on `main`.

## 2. Colosseum

Submit by **2026-10-12, 12:00 UTC** (15:00 EAT), well before the ambiguous official deadline.

### Done (in the repository)

- [x] The Base edition: browser wallets (EIP-6963), gasless USDC for EOA payers, EIP-5792 batches for smart-account payers ("Pay with Base" in the Base app or Coinbase Wallet), receipts, till, ledger, EN/FR/MG.
- [x] Contract deployed on Base Sepolia; record in `protocol/deployments/84532.json`.
- [x] The open invoice specification with its JSON Schema and test vectors ([spec](../spec/paylink-invoice-v2.md)).
- [x] Texts: [colosseum.md](colosseum.md). Thumbnail `assets/social-card.png` (1200 × 630) and logo.
- [x] Scripts for the pitch and the demo: [video-scripts.md (d)](video-scripts.md#4-d-colosseum-pitch-23-min-and-demo-at-most-300).

### You must still do, in this order

| # | Priority | Step | Where |
|---|---|---|---|
| 1 | **P0** | Steps 1–3 of §1 (push, Pages serves `/base/`, relayer online with Base Sepolia ETH on its key) | above |
| 2 | **P0** | MetaMask: two **new plain accounts** for the demo ("Payee", "Payer"); test USDC for "Payer" from `https://faucet.circle.com` (Base Sepolia). Your main account has an EIP-7702 delegation on Base Sepolia since the deployment, so it pays as a smart account with its own gas | [video-scripts.md §4.2](video-scripts.md#42-demo-at-most-300-base-edition) |
| 3 | **P0** | Record the pitch (founder on camera, 2–3 min) and the demo (at most 3 min); upload both, public | [video-scripts.md (d)](video-scripts.md#4-d-colosseum-pitch-23-min-and-demo-at-most-300) |
| 4 | **P0** | Fill the form from [colosseum.md](colosseum.md): select the **Base** track; leave **Arbitrum** unselected unless the contract is deployed there first ([colosseum.md §2](colosseum.md#2-tracks-base-yes-arbitrum-only-if-deployed)); fill the team bio, the communities and the interview placeholders, or delete their sentences | [colosseum.md](colosseum.md) |
| 5 | **P0** | Disclose prior work and the other events exactly as written ([colosseum.md §7](colosseum.md#7-team-prior-work-and-other-events)) | — |
| 6 | **P0** | Submit; tag `submission/colosseum-2026-10-12` and push the tag | the Colosseum dashboard |
| 7 | P1 | Arbitrum, only if Sepolia ETH arrives before Oct 12 morning: deploy from `/deploy/`, send Claude the transaction hash, push the record Claude commits, then add the one sentence of [colosseum.md §2](colosseum.md#2-tracks-base-yes-arbitrum-only-if-deployed) | [deploy runbook](../runbooks/deploy.md) |
| 8 | P1 | Verify the source on Basescan or Blockscout | [deploy runbook](../runbooks/deploy.md) |

Keep alive until results (around mid-November): the site, the relayer on Base Sepolia.

## 3. Assets

All in `docs/submissions/assets/`, made by Chromium from the repository with `pnpm --filter @paylink/e2e capture` (sources: `packages/design/brand/`, `e2e/capture/`).

| File | Size | What it is | Use it for |
|---|---|---|---|
| `logo-1024.png` | 1024 × 1024, 135 kB | The PayLink mark: the app's own mark (favicon, PWA icon) drawn at ×32 from `packages/design/brand/mark.svg`, with the laterite dot's LED glow; transparent corners | Monad "Project logo" (PNG, ≥ 500 px, ≤ 2 MB, ≤ 4 MP), Colosseum logo |
| `logo-512.png` | 512 × 512, 46 kB | The same, smaller | Avatars, small slots |
| `social-card.png` | 1200 × 630, 218 kB | Thumbnail: the mark, "Signed dollar invoices. Paid with a fingerprint.", the Monad pay screen and the till's PAID display (cut above its timing line), "Monad testnet · Base Sepolia · Open invoice spec" | Colosseum thumbnail, X/Open Graph |
| `screen-1-monad-create.png` … `screen-5-base-pay.png` | 1080 × 2160, 175–235 kB | Each product screenshot in a 390 px phone frame, with its title and its provenance line burned in under it | README, X posts, slides |
| `screens/screen-*.png` | 780 × 1688 (390 × 844 at 2×), 113–173 kB | The raw screenshots, dark theme, English | Your own layouts |
| `capture.json` | — | When, from which commit and against which fork blocks the screenshots were made | Provenance |

**What the screenshots are, exactly.** The production build of the site (`apps/web/dist`, the same build Cloudflare Pages serves: production registry, `/config.json`, passkey rpId), opened at its real origin `https://paylink-mg.pages.dev` through request routing, against **local anvil forks** of Monad testnet and Base Sepolia. The forks hold the real deployed PayLinkV2, Agora's AUSD and its faucet, and Circle's USDC; the relayer is `apps/relayer` with a key made for that run; passkeys come from Chromium's WebAuthn virtual authenticator with PRF. So:

- every transaction they show exists **only on the fork**: do not present one as a testnet transaction, and do not use a screenshot where a real transaction is required (the videos are the evidence of real ones);
- times on screen ("Settled in", the till's "Seen … after its block") are the fork's and say nothing about Monad or Base; the framed versions say so under each picture, and the social card shows no time figure;
- the QR codes and links in the pictures belong to throwaway keys that no longer exist: never pay them.

The screens: (1) the merchant's invoice card after signing with a PayLink key; (2) the payer's signing display ("Pay exactly this, once") and Pay key after onboarding; (3) the receipt page, re-verified on chain; (4) the armed till lit for that payment; (5) the Base edition pay view for an EOA wallet, gasless route. Re-run the capture after a visible change to the app; it needs egress to `testnet-rpc.monad.xyz` and `sepolia.base.org`.

## 4. Things noticed while writing this pack

None is fixed here; each is your call.

| Observation | Effect | Option |
|---|---|---|
| The Monad edition's signing key reads "Sign in wallet" although there is no wallet (it asks for a fingerprint) | A Mera UX judge may notice the wording | A passkey-specific label; it adds English bytes to every page, and the Monad pay route had 80 bytes left in the end-to-end build when the indexer commit measured it (109,920 of 110,000) |
| The app shows an AUSD balance only while it is too low to pay | The Agora video shows "This account holds 0.00 AUSD.", then the balance after paying on MonadVision ([script (c)](video-scripts.md#3-c-agora-demo-at-most-200)) | A balance line on a page off the pay route (Send or the ledger); not on the KeyCard, which the pay route carries |
| The payer-facing trust line ("N payments received since …") is not on the pay view | Payers do not see the merchant's record; the merchant does, on the ledger | Free room on the pay route, or raise its budget (the indexer commit explains the measurements) |
| Arbitrum Sepolia is not deployed | No Arbitrum track for Colosseum | [colosseum.md §2](colosseum.md#2-tracks-base-yes-arbitrum-only-if-deployed) |
| Restoring a ledger backup on a second physical phone with a synced passkey has not been tried | The Many Keys answer says "on any device the passkey syncs to", which Mera documents but we have not seen ourselves | Try it once during the rehearsal; if it fails, change that phrase in [monad.md §5.4](monad.md#54-mera-one-passkey-many-keys) |
