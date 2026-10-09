# Monad Metropolis: support forum questions

| | |
|---|---|
| **Event** | Monad Metropolis, Track 02 "Consumer Products & Payments", plus the Agora and Mera bounties |
| **Status** | Ready to paste. Questions 2, 3 and 5 are open; questions 1 and 4 are resolved (see [§1](#1-status-of-each-question)) |
| **Date** | 2026-10-06; Q5 added 2026-10-09 |
| **Source** | PAYLINK-V2-SPEC Appendix A and §2.1, updated with the owner's registration-time checks of 2026-10-05/06 |
| **Who posts** | The owner, from the owner's own account. Claude Code drafts only and never posts ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)) |
| **Where** | The support forum linked from the Metropolis dashboard. The Monad developer Discord (Metropolis role) is also recommended for quick answers (**UV**, 2026-10-06) |

Confidence tags as in [ARCHITECTURE.md](../ARCHITECTURE.md): **UV** verified by the owner on the official page (2026-10-05, or the date given), **C** confirmed from a primary source, **L** likely, **U** unverified.

## 1. Status of each question

| # | Question | Status | Evidence |
|---|---|---|---|
| Q1 | Is a testnet deployment enough, or is mainnet 143 required? | **Resolved; posting optional.** | The Metropolis dashboard provides a MON **testnet** faucet, which the owner reads as testnet being the intended path (**UV**, 2026-10-06). The participants' copies of the T&C §4.1(3) say "mainnet OR testnet" (**L**). Post Q1 only if you want the answer in writing. |
| Q2 | Does the invoice and "send to a receive card" flow meet the Agora bounty's "send AUSD across borders"? Does "instant settlement" mean Agora's Instant Settlement product? | **Open. Post.** | Bounty wording known only from secondary copies (**L**) |
| Q3 | Can one project be considered for both Mera bounties? | **Open. Post.** | Bounty names and amounts (**L**): "Best Mera-Powered UX" $2.5k and "One Passkey, Many Keys" $2.5k |
| Q4 | What is the exact registration cut-off? | **Resolved. Do not post.** | Registration closed on Oct 6, and PayLink is registered (**UV**, 2026-10-06) |
| Q5 | The Agora bounty requires "a mobile app": does an installable PWA count, or must it be a native or app-store app? | **Open. Check, then post if needed.** | The requirement is on the bounty page (**UV**, FACTS 2026-10-08). FACTS also record that a support question was posted on 2026-10-08 and awaits the organisers, without its text: if it did not ask this, post Q5 |

Not asked on purpose: the Mercuryo and Kimi requirement texts (PAYLINK-V2-SPEC §12). Both bounties are out of scope before Oct 12 (PAYLINK-V2-SPEC §2.7). Ask only if that scope changes.

**Deadline reminder.** Final submission: **2026-10-14 03:59 UTC** (Oct 14, 06:59 EAT) (**UV**, 2026-10-06). Our own target stays **Oct 12, 20:00 UTC** (PAYLINK-V2-SPEC §1.2). Answers that arrive after Oct 10, 18:00 UTC (the T1 feature freeze) can only change text and bounty selection, not code.

## 2. Before you post

- [ ] Post from your own account. Keep the tone short and factual; one post per question gets searchable answers, and the combined post in [§4](#4-combined-post-alternative) is fine if the forum prefers one thread per project.
- [ ] Never include a private key, a seed phrase, a wallet export, your e-mail address or a phone number.
- [ ] Link only public material: the repository `https://github.com/nambininasafidison/paylink`. Do not link the `<app>.pages.dev` origin before the T0 release is live (Oct 8 target).
- [ ] Describe what is built as built, and what is planned as planned. The drafts below already do: on Oct 6 the contract is not yet deployed (deployment target: Oct 7 after the 12:00 UTC go/no-go, PAYLINK-V2-SPEC §10).
- [ ] After posting, record the link in the [answers log](#5-answers-log).

## 3. Paste-ready questions

### Q2. Agora bounty fit (post)

**Title:** `Agora bounty: does an invoice + "send to a payment card" flow count as "send AUSD across borders"?`

```text
Hi! We are building PayLink for Track 02: signed dollar invoices and payment links on Monad testnet (10143), with AUSD as the default token.

A user can pay an invoice, or send AUSD to a contact's saved payment card (a reusable "pay me any amount" link), including to someone in another country. In our Monad edition, accounts are Mera passkeys and payments are gasless: the payer signs an EIP-3009 authorization for AUSD and a relayer submits it, so neither side needs to hold MON.

Two questions about the Agora bounty:
1. Does this flow meet the "send AUSD across borders" requirement?
2. Does "instant settlement" in the bounty text refer specifically to Agora's Instant Settlement product, or to fast settlement in general?

Repository: https://github.com/nambininasafidison/paylink
Thank you!
```

### Q5. Agora: does an installable PWA count as a mobile app? (post, or check)

First read the question you posted on 2026-10-08 and its answer, if any. Post this only if that question did not already ask it, and only after the rehearsal has run the flow from the installed app ([video-scripts.md §0.2](video-scripts.md#02-devices-pick-one-setup-and-rehearse-it-once-the-day-before)); if it has not, end the first paragraph after "opens full screen from its own icon".

**Title:** `Agora bounty: does an installable PWA count as "a mobile app"?`

```text
Hi! The Agora bounty asks for a mobile app. Our Track 02 project, PayLink, is a mobile-first progressive web app on Monad testnet: it installs from the phone's browser ("Add to Home Screen" in iOS Safari, "Install app" in Android Chrome), opens full screen from its own icon, and runs the whole flow there: Mera passkey onboarding, AUSD balance, and a gasless AUSD send. There is no app-store build.

Does an installable PWA meet the "mobile app" requirement, or does the bounty need a native or app-store app?

Repository: https://github.com/nambininasafidison/paylink
Thank you!
```

### Q3. Both Mera bounties (post)

**Title:** `Mera bounties: can one project be considered for both?`

```text
Hi! Can one project be considered for both Mera bounties ("Best Mera-Powered UX" and "One Passkey, Many Keys")?

Our Track 02 project, PayLink, uses Mera passkeys as the only account layer for both the merchant and the payer (no other wallet SDK, no Dynamic or Privy). We are also considering a second PRF-derived key, with a separate salt, to encrypt a backup of the merchant's books, which is why we ask about "One Passkey, Many Keys".

Repository: https://github.com/nambininasafidison/paylink
Thank you!
```

### Q1. Testnet or mainnet (optional; resolved by the dashboard)

**Title:** `Track 02 judging: is a Monad testnet deployment sufficient?`

```text
Hi! Our Track 02 project, PayLink, will be deployed on Monad testnet (10143), with a build that is ready for mainnet (143). The dashboard's testnet faucet suggests testnet is the intended path; could you confirm that a testnet deployment is sufficient for judging, and that mainnet is not required?

Repository: https://github.com/nambininasafidison/paylink
Thank you!
```

### Q4. Registration cut-off (do not post)

Resolved: registration closed on Oct 6 and PayLink is registered (**UV**, 2026-10-06). The original draft from PAYLINK-V2-SPEC Appendix A is kept for the record only: "What is the exact registration close time and timezone on Oct 6?"

## 4. Combined post (alternative)

Use this instead of separate posts if the forum asks for one thread per project.

**Title:** `PayLink (Track 02): two bounty questions (Agora, Mera)`

```text
Hi! PayLink is our Track 02 project: signed dollar invoices and payment links on Monad testnet (10143), AUSD by default, Mera passkeys as the only account layer, and gasless payments (the payer signs an EIP-3009 authorization; a relayer submits it, so nobody needs MON).

1. Agora: a user can pay an invoice, or send AUSD to a contact's saved payment card, including across borders. Does this meet "send AUSD across borders"? And does "instant settlement" refer specifically to Agora's Instant Settlement product?
2. Mera: can one project be considered for both "Best Mera-Powered UX" and "One Passkey, Many Keys"? We are considering a second PRF-derived key (separate salt) to encrypt a backup of the merchant's books.

Repository: https://github.com/nambininasafidison/paylink
Thank you!
```

## 5. Answers log

Fill in as answers arrive. Quote the answer and link it; never paraphrase an organiser's answer into something stronger than what they wrote.

| Question | Posted (UTC) | Link | Answered (UTC) | Answer (quote) | By (role) |
|---|---|---|---|---|---|
| Q2 | | | | | |
| Q3 | | | | | |
| Q1 (optional) | | | | | |
| Q5 (or the 2026-10-08 question) | 2026-10-08 (a support question; text not recorded here) | | | | |

## 6. What each answer changes

| Question | If the answer is yes | If the answer is no |
|---|---|---|
| Q1: testnet sufficient | Nothing changes; the demo stays on testnet | Deploy the same artefact to Monad mainnet 143 with at most one tiny transaction ([deploy runbook §7](../runbooks/deploy.md#7-monad-mainnet-143-conditional)); budget about 0.5 MON |
| Q2a: flow meets "send AUSD across borders" | Keep the receive card and Send (tier T1) as the Agora story in the README and video | Ask what is missing. If it needs more than text, drop the Agora bounty; Track 02 is unaffected |
| Q2b: "instant settlement" means the Agora product | Consider the tier T2 "receive as" option through Agora Instant Settlement (AUSD/CTK `0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae`, whitelister `0x7c10F56d6f04a51376393a1C3670e966863F6BD5`, both **L**), only if T1 is green by the Oct 10 freeze | Nothing to build; "instant" is shown as the measured settlement time |
| Q5: an installable PWA counts as "a mobile app" | Keep Agora selected, with the answer's "Mobile:" sentence and video (c) opening from the home-screen icon | Untick Agora on the dashboard (Track 02 and the other bounties are unaffected), unless you choose to keep it and accept that it may not qualify; no app-store app can be built and reviewed before the deadline |
| Q3: both Mera bounties allowed | Keep the tier T2 passkey-encrypted books backup (second PRF salt `"paylink.books.v1"`, [ARCHITECTURE §7.2](../ARCHITECTURE.md#72-what-is-stored-where)) as the "One Passkey, Many Keys" entry | Select only "Best Mera-Powered UX"; the backup stays T2 and unclaimed |

The Mera go/no-go on **Oct 9, 18:00 UTC** (PAYLINK-V2-SPEC §10) overrides all of this: if passkey PRF fails on real phones, the Monad edition falls back to an injected wallet, and the Mera and Agora bounties are dropped.

## Related

- [Deploy runbook](../runbooks/deploy.md) (Monad testnet and the conditional mainnet deployment)
- [Demo recording runbook](../runbooks/demo-recording.md) (the Monad demo script and its honesty rules)
- [ADR 0008](../adr/0008-editions.md) (the Monad edition is Mera-only)
- [AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)
