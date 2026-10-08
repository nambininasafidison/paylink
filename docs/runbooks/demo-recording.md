# Runbook: recording the demo and pitch videos

| Video | Length | Content | Deadline |
|---|---|---|---|
| **Monad demo** | ≤ 3:00 | Monad edition, real Monad testnet transactions | Uploaded by Oct 11, 20:00 UTC |
| **Colosseum demo** | ≤ 3:00 | Base edition on Base Sepolia (plus Arbitrum if deployed) | Uploaded by Oct 11, 20:00 UTC |
| **Colosseum pitch** | 2–3 min | Founder on camera; judges watch it first | Recorded Oct 11 by 16:00 EAT; uploaded by 20:00 UTC |

Timeline:

- scripts final by **Oct 9**;
- the hero flow recorded once on real testnets on **Oct 10, evening EAT**, then cut into the two demos;
- the pitch recorded on **Oct 11**.

Every video is **publicly accessible on YouTube**, with **no copyrighted music**.

## 1. Honesty rules

These are not optional. Judges and users must be able to trust what they see.

- **Real transactions only.** Show the explorer page of at least one real testnet transaction (`testnet.monadvision.com` for Monad, `base-sepolia.blockscout.com` or `sepolia.basescan.org` for Base). The Monad submission requires real testnet transactions.
- **Measured numbers only.** The "settled in N.N s" readout is measured live on the payer's device, from submission to verified receipt; the till's own readout measures something else and says what ([ARCHITECTURE §4.6](../ARCHITECTURE.md#46-till-mode)). Never edit either, never present one as the other, and never quote a speed you did not measure. Monad's 300 ms blocks and 600 ms finality are **L**; the on-screen number is the evidence.
- **Mark any cut or speed-up** with an on-screen label ("sped up ×2", "cut: waiting for faucet").
- **Say "testnet"** whenever a testnet is shown. Never say "audited". Never claim P256VERIFY, because Mera keys are secp256k1.
- **Interview numbers** in the pitch come only from the real, consented interviews ([research protocol](../research/interview-script.md)). If there are none yet, say so.
- **Nothing private on screen:** no private keys, seed phrases, recovery codes, personal phone numbers, real contact names, or email inboxes. Use the demo personas below.

## 2. Setup

### Devices and layout

| Role | Device | Edition | Account |
|---|---|---|---|
| Merchant: "Rakoto Design", a freelancer in Antananarivo | Phone (screen-recorded) | `/monad/`, installed as a PWA | Mera passkey (merchant) |
| Payer: a client abroad | Laptop browser, second profile | `/monad/pay/` | Mera passkey (payer) |
| Till | Laptop, second window or a tablet | `/monad/till/` | — |
| Base demo payee and payer | Laptop, two browser profiles | `/base/` | W-pay injected wallet; Base Account for the payer |

Screen layout for editing: phone on the left (portrait, 1080 × 2340 captured), laptop on the right (1920 × 1080). The till window stays visible in the final shot so that its LED lights up on camera.

### Pre-flight checklist (30 minutes before)

- [ ] Relayer `/v1/health` is green for 10143 and 84532, and W-relay has gas ([faucets](faucets.md)).
- [ ] The indexer is healthy (the `/status/` LED). If not, record without the history segment rather than faking it.
- [ ] The Mera payer holds AUSD (onboarding tested once). The Base payer holds USDC and a little Sepolia ETH for the self-submit fallback.
- [ ] Both themes checked. Pick **dark** for the recording, and keep it for every take.
- [ ] Language set (EN for the narration). FR and MG appear briefly in the language-switch shot.
- [ ] Do Not Disturb on the phone and the laptop. No other tabs, bookmarks bar hidden, notifications off.
- [ ] The browser profile is clean: no unrelated wallet extensions, no personal history.
- [ ] Demo amounts prepared: **12.50 AUSD** (Monad invoice) and **25.00 USDC** (Base invoice).
- [ ] Screen recorder at 1080p, 30 or 60 fps; microphone tested; room quiet.

## 3. Script: Monad demo (≤ 3:00)

| Time | Shot | Narration (draft) |
|---|---|---|
| 0:00–0:15 | Phone, merchant home screen | "Rakoto is a freelance designer in Antananarivo. His clients are abroad, and getting paid in dollars is slow and expensive." |
| 0:15–0:45 | Phone: create an invoice for 12.50 AUSD; the SigningDisplay; fingerprint; share to WhatsApp | "He creates an invoice and signs it with his fingerprint. It costs nothing: he holds no MON at all. The link goes out on WhatsApp." |
| 0:45–1:20 | Laptop: open the link; the verification strip lights four green LEDs; onboarding gives test AUSD | "His client opens it. PayLink checks the signature, the network and the contract before the Pay key unlocks." |
| 1:20–1:40 | Laptop: pay with a fingerprint (gasless) | "One fingerprint. No gas token. A relayer submits the payment, but it cannot redirect it: the authorisation is bound to this exact invoice." |
| 1:40–1:55 | Till window: the green LED, the chime and the amount; then the payer's screen with "settled in N.N s" | "Rakoto's till lights up for this invoice. The settlement time on the payer's screen is measured live on Monad testnet." |
| 1:55–2:15 | Receipt page, then the explorer transaction | "Both sides keep a receipt that anyone can verify against the chain." |
| 2:15–2:35 | Ledger with history and the trust line (Envio); gasless cancel of a second invoice | "His books come from on-chain events indexed by Envio. He can cancel an invoice without gas, too." |
| 2:35–2:55 | Text card: why Monad | "Measured sub-second settlement, explicit gas limits because Monad charges the limit, Envio for history beyond the RPC log cap, and a relayer that never sends value." |
| 2:55–3:00 | End card: repository URL, open spec, "testnet" | — |

## 4. Script: Colosseum demo (≤ 3:00)

| Time | Shot | Narration (draft) |
|---|---|---|
| 0:00–0:15 | Problem card | The same problem statement. |
| 0:15–0:45 | Create a 25.00 USDC invoice on Base Sepolia with the injected wallet; share the QR code | "One signature, zero gas, works offline." |
| 0:45–1:25 | Payer: verification strip; gasless USDC through the relayer (EOA) | "The payer signs once; the relayer pays the gas and cannot redirect the funds." |
| 1:25–1:55 | A second payer with **Pay with Base**: `wallet_sendCalls([approve, pay])` in one approval | "Smart-account payers batch the approval and the payment." |
| 1:55–2:20 | Receipt and Blockscout-verified contract | "Verified contract, verifiable receipts." |
| 2:20–2:45 | The open invoice specification page | "The invoice format is an open spec with test vectors. Any wallet or app can issue or pay PayLink invoices." |
| 2:45–3:00 | End card | — |

## 5. Pitch (2–3 min, founder on camera)

An outline only. The founder speaks in their own words.

1. **Who and what** (20 s): name, Madagascar, PayLink in one sentence.
2. **Problem** (30 s): a concrete story, with numbers only from the interviews ([research](../research/interview-script.md)).
3. **Solution** (40 s): the hero flow in three sentences, with a 10-second screen insert.
4. **Why now** (20 s): stablecoins, passkeys and fast EVM chains make "fingerprint to dollars" possible.
5. **Validation** (20 s): interviews and waitlist, with real counts only ("n of 6 said …").
6. **Business hypotheses** (20 s): the core stays free; a "PayLink Business" tier (accounting export, webhooks, team); later, licensed off-ramp partners. Present them as hypotheses.
7. **Ask and close** (10 s).

Framing: well lit, eye level, a quiet room, an external microphone if available, landscape 1080p.

## 6. Retake list

| Problem | Fix |
|---|---|
| A notification or popup appears | Enable Do Not Disturb and retake that segment |
| Wrong theme or language visible | Reset to dark and EN, then retake |
| The faucet or onboarding is empty | Use a pre-funded payer (send AUSD from a wallet that holds some); never fake a balance |
| A network-switch prompt appears unexpectedly | Pre-switch the wallet; retake |
| The till did not light up within 10 s | Check `/status/`; retake rather than splice |
| A typo in the payee name or amount | Recreate the invoice; keep the amounts consistent across shots |
| Personal data visible | Retake, or blur in editing, and recheck the whole video before upload |
| Audio clipping or noise | Re-record the narration separately and sync it |

## 7. Upload checklist

- [ ] Length checked (≤ 3:00 for the demos).
- [ ] Captions added (EN), with the narration text above as the base.
- [ ] Title: "PayLink: <edition> demo (testnet)". The description includes the repository link, the contract addresses, the explorer links and the AI-use note ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)).
- [ ] Visibility: **public**. Checked from a logged-out browser.
- [ ] The links are pasted into `docs/submissions/` and the submission forms.
