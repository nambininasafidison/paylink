# Demand-validation interviews: protocol and script

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-10-06 |
| **Interviewer and data controller** | The founder (nambininasafidison) |
| **Sessions** | 5 to 6 interviews of about 20 minutes, Oct 8 to Oct 10, 2026 (PAYLINK-V2-SPEC §10) |
| **Consent** | [consent.md](consent.md): information sheet, consent form and verbal-consent script. **No question is asked before consent is recorded.** |
| **Used by** | The Colosseum business plan, go-to-market and pitch ([demo-recording runbook §5](../runbooks/demo-recording.md#5-pitch-23-min-founder-on-camera)); the submissions under `docs/submissions/` |

> **Rule zero: numbers are never invented.** Every number that leaves this research comes from a real, consented session and is reported as a count over the real sample, for example "4 of 6 participants". Nothing is estimated, extrapolated, rounded up or filled in. A session that did not happen is not reported. If the sample is smaller than planned, the report says so. If the findings contradict the plan, the report says that too.

## Contents

1. [Purpose and hypotheses](#1-purpose-and-hypotheses)
2. [Participants and recruitment](#2-participants-and-recruitment)
3. [Ethics and data protection](#3-ethics-and-data-protection)
4. [Session plan](#4-session-plan)
5. [Script](#5-script)
6. [Note-taking template](#6-note-taking-template)
7. [Analysis and reporting rules](#7-analysis-and-reporting-rules)
8. [Waitlist](#8-waitlist)
9. [Checklists](#9-checklists)

---

## 1. Purpose and hypotheses

The interviews test whether the problem PayLink addresses is real, frequent and painful for the people it is built for, before anyone claims it is. They are **discovery interviews**: they look for past behaviour and real constraints, not compliments about the product.

Each hypothesis states what would support it and what would weaken it, so that a "no" is as reportable as a "yes".

| ID | Hypothesis | Supported if participants… | Weakened if participants… |
|---|---|---|---|
| H1 | Freelancers and sellers in Madagascar who are paid from abroad find it slow, costly or unreliable today | describe a recent payment that took days, lost a noticeable share to fees or exchange, failed, or needed a workaround | describe a method they find fast, cheap and reliable enough |
| H2 | The person sending the payment request does most of the chasing, and a shareable invoice would reduce it | describe re-sending details, confirming by hand, or disputes about what was paid | say requests and confirmations are not a problem |
| H3 | Payers abroad would complete a payment from a link opened on their phone, without installing anything and without holding a gas token | describe paying by link or QR in the past, or abandoning a payment because of setup steps | say they only pay through one channel they will not change |
| H4 | Receiving digital dollars (USDC, AUSD) is acceptable when cashing out locally is solved separately | already hold or receive digital dollars, or name a concrete local cash-out path | reject digital dollars outright, or need local currency immediately with no path |
| H5 | Merchants value a receipt both sides can verify, and an instant "paid" signal at the counter | describe disputes, screenshots of fake transfers, or waiting to confirm a payment | say confirmation is never an issue |
| H6 | Some users would pay for business features (accounting export, webhooks, team access): the "PayLink Business" hypothesis (PAYLINK-V2-SPEC §2.2) | already pay for invoicing or bookkeeping tools, or spend time on manual exports | do not keep books, or would not pay for tooling |

H6 is the weakest to test in a 20-minute interview. It is reported only from past spending on tools, never from "would you pay" answers.

## 2. Participants and recruitment

### 2.1 Segments

| Segment | Who | Target |
|---|---|---|
| **A. Freelancers** | Based in Madagascar, paid by at least one client abroad in the last 6 months (design, development, writing, translation, remote support) | 2 |
| **B. Merchants** | Small sellers in Madagascar (a counter, a market stall or online sales) who take payments from customers, including occasional customers abroad | 2 |
| **C. Payers abroad** | People outside Madagascar (diaspora or foreign clients) who paid someone in Madagascar in the last 6 months | 1 or 2 |

Five to six interviews are enough to discover problems and language. They are **not** enough for statistics, and the report never presents them as representative.

### 2.2 Inclusion and exclusion

- **Include:** adults (18 or older) in one of the segments above, who can take part in English, French or Malagasy.
- **Exclude:** minors; anyone who cannot freely refuse, such as the founder's employees, close dependents or people who owe the founder money; anyone working on a competing product, to avoid conflicts of interest.
- **Record, do not exclude:** people who already know the founder well, or who saw an earlier PayLink demo. Both bias the answers and are noted per session.

### 2.3 Recruitment

- Recruit through the founder's own network and public communities where posting is allowed. Ask each participant whether they know someone else who fits (snowball sampling), and record the source of each participant.
- **No incentive** is offered. If an incentive is ever offered, it is disclosed in the report, because it changes who says yes.
- No purchased lists, no scraping, no cold messages to strangers' private numbers.

Invitation text (adapt freely; MG written by the founder):

```text
EN: Hi <name>, I'm building a tool for getting paid in dollars from abroad, and I'd like to learn how you handle that today. Would you have 20 minutes for a conversation this week? It's not a sales call, there's nothing to buy, and you can say no or stop at any time. I'll send you a short information sheet first.

FR : Bonjour <prénom>, je développe un outil pour se faire payer en dollars depuis l'étranger, et j'aimerais comprendre comment vous faites aujourd'hui. Auriez-vous 20 minutes pour en discuter cette semaine ? Ce n'est pas une démarche commerciale, il n'y a rien à acheter, et vous pouvez refuser ou arrêter à tout moment. Je vous envoie d'abord une courte fiche d'information.

MG: <written by the founder>
```

## 3. Ethics and data protection

The full participant-facing text is in [consent.md](consent.md). The interviewer's obligations:

1. **Informed, voluntary consent first.** Send or read the information sheet. Record consent, written or verbal, with the date and time, before the first question. Participants may skip any question and stop at any time, without giving a reason.
2. **Data minimisation.** Notes use a participant ID (`P01`, `P02`, …), never a name. Never ask for, and never write down: bank or mobile-money account numbers, balances, identity numbers, passwords, private keys, seed phrases, exact income, or screenshots of financial apps. Amounts are discussed only if the participant offers them, preferably as ranges.
3. **No recording by default.** Audio is recorded only if the participant ticks the separate audio box. Video is never recorded.
4. **No selling, no advice, no money.** The interview is not a pitch. Never ask a participant to send money, install a wallet or buy a token. Never give financial, legal or tax advice. If a participant asks, say that PayLink is a prototype running on test networks with no real money.
5. **No false claims.** Do not say that PayLink is live, audited or available to the public. Use the words the participant uses; do not introduce "blockchain" or "crypto" before the participant does.
6. **Storage and retention.** Raw notes and any audio stay in the founder's private storage, never in this repository, an issue, a public chat or a shared document. Only pseudonymised, consented summaries go into the repository ([§7.4](#74-sessionsmd-format)). Raw notes and audio are deleted by **2027-01-31** at the latest, or earlier on request.
7. **AI assistance is opt-in.** Pseudonymised notes may be summarised with an AI assistant (Claude) only if the participant ticked that box. Audio and anything identifying are never given to an AI tool ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)).
8. **Rights.** Participants can ask to see, correct or delete their data. Requests are honoured within 7 days. Withdrawal is possible until the findings are first published (target: Oct 11, 2026). After that, the aggregated counts already published cannot be recalled, but the participant's quotes are removed from every later version.
9. **Legal context.** In Madagascar, personal data is governed by Law No. 2014-038 on the protection of personal data, enforced by the Commission Malagasy de l'Informatique et des Libertés (CMIL), whose members took office in 2025 (**L**, consistent secondary sources, 2026-10-06). Participants abroad may be covered by their own laws, such as the EU GDPR. This protocol applies the same principles to everyone, whatever the jurisdiction: consent, purpose limitation, minimisation, storage limitation, security and data-subject rights. It is not legal advice; the founder should check whether a small research activity like this one needs any formality with the CMIL (**U**).

## 4. Session plan

About 20 minutes, conducted by the founder alone, in the participant's preferred language, in person or by voice or video call.

| Minutes | Part | Goal |
|---|---|---|
| 0–2 | Opening and consent ([consent.md §3](consent.md#3-verbal-consent-script)) | Consent recorded before any question |
| 2–4 | Warm-up | Context: work, clients, where they are |
| 4–14 | Segment module A, B or C | Past behaviour: the last real payment, step by step |
| 14–17 | Common questions | Trust, alternatives, tools and spending |
| 17–19 | Close | Anything missed; referrals; optional waitlist |
| 19–20 | Optional demo, only if the participant wants it | Reactions recorded **separately**, as weaker evidence |

## 5. Script

### 5.1 Interviewing rules

- Ask about **the last time** something happened, not about "usually" or "would you". Past behaviour is evidence; predictions are not.
- Follow up with "What happened next?", "How did you handle that?", "What did that cost you, in time or money, if you remember?"
- Do not explain PayLink, and do not finish the participant's sentences. Silence is fine.
- When the participant gives a number, write it down **as reported**, with their wording, and do not correct it. Reported numbers are unverified.
- Never lead: not "Isn't it annoying when…?", but "How did that go?".
- If the participant becomes uncomfortable, move on or stop.

### 5.2 Opening (read, then record consent)

```text
EN: Thank you for your time. I'm working on a tool for invoices and payments between Madagascar and other countries, and I want to understand how you handle payments today. There are no right or wrong answers, and I'm not selling anything. Before we start, I'd like to go through the information sheet and your consent. [→ consent.md §3]

FR : Merci pour votre temps. Je travaille sur un outil de factures et de paiements entre Madagascar et l'étranger, et je veux comprendre comment vous gérez vos paiements aujourd'hui. Il n'y a pas de bonne ou de mauvaise réponse, et je ne vends rien. Avant de commencer, je voudrais parcourir avec vous la fiche d'information et votre consentement. [→ consent.md §3]
```

### 5.3 Warm-up (all segments)

1. EN: What do you do, and who are your clients or the people you pay?
   FR : Que faites-vous, et qui sont vos clients ou les personnes que vous payez ?
2. EN: Roughly how often do payments cross a border in your work: every week, every month, a few times a year?
   FR : À quelle fréquence, à peu près, vos paiements passent-ils une frontière : chaque semaine, chaque mois, quelques fois par an ?

### 5.4 Module A: freelancers in Madagascar

1. EN: Tell me about the last time a client abroad paid you. How did you ask for the money, and what happened, step by step?
   FR : Racontez-moi la dernière fois qu'un client à l'étranger vous a payé. Comment avez-vous demandé l'argent, et que s'est-il passé, étape par étape ?
2. EN: How long did it take between your request and the money being usable by you?
   FR : Combien de temps s'est-il écoulé entre votre demande et le moment où vous avez pu utiliser l'argent ?
3. EN: What did it cost you, in fees or exchange, if you know? How did you find out?
   FR : Combien cela vous a-t-il coûté en frais ou en change, si vous le savez ? Comment l'avez-vous su ?
4. EN: Has a payment ever failed, been blocked or been delayed? What did you do?
   FR : Un paiement a-t-il déjà échoué, été bloqué ou retardé ? Qu'avez-vous fait ?
5. EN: Which methods have you tried, and which ones did you stop using? Why?
   FR : Quelles méthodes avez-vous essayées, et lesquelles avez-vous abandonnées ? Pourquoi ?
6. EN: How do you send your client the details they need to pay you? How often do you have to resend or correct them?
   FR : Comment envoyez-vous à votre client les informations nécessaires pour vous payer ? Combien de fois devez-vous les renvoyer ou les corriger ?
7. EN: Once you are paid, what do you do with the money: keep dollars, convert, spend locally? How?
   FR : Une fois payé, que faites-vous de l'argent : le garder en dollars, le convertir, le dépenser sur place ? Comment ?

### 5.5 Module B: merchants in Madagascar

1. EN: Walk me through your last sale where the customer did not pay in cash. What happened?
   FR : Décrivez-moi votre dernière vente où le client n'a pas payé en espèces. Que s'est-il passé ?
2. EN: How did you know the payment had really arrived? How long did that take?
   FR : Comment avez-vous su que le paiement était vraiment arrivé ? Combien de temps cela a-t-il pris ?
3. EN: Has anyone ever shown you a payment confirmation that turned out to be false, or disputed a payment? What happened?
   FR : Quelqu'un vous a-t-il déjà montré une confirmation de paiement qui s'est révélée fausse, ou contesté un paiement ? Que s'est-il passé ?
4. EN: Have you ever sold to someone abroad, or turned a sale down because they were abroad? Tell me about it.
   FR : Avez-vous déjà vendu à quelqu'un à l'étranger, ou refusé une vente parce que la personne était à l'étranger ? Racontez-moi.
5. EN: How do you keep track of what was paid: a notebook, an app, messages, nothing?
   FR : Comment suivez-vous ce qui a été payé : un cahier, une application, des messages, rien ?
6. EN: What do you give the customer as proof of payment, if anything?
   FR : Que donnez-vous au client comme preuve de paiement, si vous en donnez une ?

### 5.6 Module C: payers abroad

1. EN: Tell me about the last time you paid someone in Madagascar. Who, why, and how?
   FR : Racontez-moi la dernière fois que vous avez payé quelqu'un à Madagascar. Qui, pourquoi, et comment ?
2. EN: What did you need to set up before you could pay? How long did that take?
   FR : Qu'avez-vous dû mettre en place avant de pouvoir payer ? Combien de temps cela a-t-il pris ?
3. EN: How did you check that you were paying the right person and the right amount?
   FR : Comment avez-vous vérifié que vous payiez la bonne personne et le bon montant ?
4. EN: Have you ever given up on a payment, or paid later than you wanted, because of the process? What happened?
   FR : Avez-vous déjà renoncé à un paiement, ou payé plus tard que prévu, à cause de la procédure ? Que s'est-il passé ?
5. EN: Have you ever paid by opening a link or scanning a QR code? What did you think of it?
   FR : Avez-vous déjà payé en ouvrant un lien ou en scannant un QR code ? Qu'en avez-vous pensé ?
6. EN: Do you hold, or have you ever used, digital dollars such as USDC? Only if you are comfortable answering.
   FR : Détenez-vous, ou avez-vous déjà utilisé, des dollars numériques comme l'USDC ? Seulement si vous êtes à l'aise pour répondre.

### 5.7 Common questions (all segments)

1. EN: What would make you trust a payment request you receive by message? What would make you distrust it?
   FR : Qu'est-ce qui vous donnerait confiance dans une demande de paiement reçue par message ? Qu'est-ce qui vous en ferait douter ?
2. EN: Do you pay for any tool today to send invoices, keep books or receive payments? Which one, and roughly how much?
   FR : Payez-vous aujourd'hui un outil pour envoyer des factures, tenir vos comptes ou recevoir des paiements ? Lequel, et à peu près combien ?
3. EN: If you could change one thing about how cross-border payments work for you, what would it be?
   FR : Si vous pouviez changer une seule chose dans la façon dont les paiements internationaux fonctionnent pour vous, ce serait quoi ?

### 5.8 Close

1. EN: Is there anything I should have asked but didn't?
   FR : Y a-t-il une question que j'aurais dû vous poser et que je n'ai pas posée ?
2. EN: Is there someone else you think I should talk to? (Only share their contact if they agree.)
   FR : Y a-t-il quelqu'un d'autre à qui je devrais parler ? (Partagez son contact seulement s'il est d'accord.)
3. EN: I'm keeping a list of people who want to hear when a test version is ready. Would you like to be on it? It's completely optional. [→ [§8](#8-waitlist); tick the separate box in consent.md]
   FR : Je tiens une liste de personnes qui veulent être prévenues quand une version de test sera prête. Voulez-vous y figurer ? C'est entièrement facultatif. [→ [§8](#8-waitlist) ; cocher la case séparée dans consent.md]
4. EN: Thank you. If you change your mind about anything you said, or want your notes deleted, just tell me.
   FR : Merci. Si vous changez d'avis sur ce que vous avez dit, ou voulez que vos notes soient supprimées, dites-le-moi simplement.

### 5.9 Optional demo (after the close, only on request)

Show the test version on a test network, and say so ("This is a test version, with test money only"). Never ask the participant to sign anything or to connect their own wallet. Record reactions in the separate "post-demo" field of the notes. Post-demo reactions are **opinions about a demo** and are reported as such, never as demand.

## 6. Note-taking template

One file per session, kept in private storage, never in the repository.

```text
Session ID:           P0_
Date and time (UTC):  2026-10-__ __:__
Segment:              A freelancer | B merchant | C payer abroad
Language:             EN | FR | MG
Mode:                 in person | voice call | video call
Recruited through:    <network | referral by P0_ | community>
Prior relationship:   none | acquaintance | close
Saw PayLink before:   yes | no
Consent:              information sheet given | verbal or written consent at __:__ UTC
Boxes ticked:         notes [ ] audio [ ] quotes [ ] AI summary [ ] waitlist [ ] recontact [ ]

Last real payment (story, in the participant's words):
  - ...

Reported numbers (as said; unverified):
  - "<quote>": <what it refers to>

Workarounds and alternatives tried:
  - ...

Evidence per hypothesis (B = behaviour, R = reported fact, O = opinion):
  H1: supports | weakens | no evidence: <note> (B/R/O)
  H2: ...
  H3: ...
  H4: ...
  H5: ...
  H6: ...

Quotes the participant allowed (original language, then translation):
  - ...

Post-demo reactions (only if a demo was shown; opinion):
  - ...

Follow-ups promised:
  - ...
```

## 7. Analysis and reporting rules

### 7.1 Evidence strength

| Level | What counts | Illustrative example (not data) |
|---|---|---|
| **Commitment** | A costly action taken for us: waitlist sign-up with a contact, an introduction to someone else, a request to pilot | "Add me, and talk to my cousin who sells online" |
| **Behaviour (B)** | Something the participant did in the past | "Last month I resent my bank details three times" |
| **Reported fact (R)** | A number or fact the participant states, which we cannot verify | "The transfer cost me about ten dollars" |
| **Opinion (O)** | Predictions, preferences, reactions to a demo | "I would use that" |

Opinions are reported, but never as evidence of demand.

### 7.2 Counting

- Code each session against H1 to H6 with the note template, then count. Report counts as **"n of N"** with N the number of sessions actually held, in the form "<n> of <N> freelancers and merchants described a payment delayed by more than a day (reported)".
- **No percentages** while N is below 10.
- Keep segments apart when it matters ("2 of 2 merchants"), and never merge a segment's count into a larger denominator to make it look bigger.
- Count a participant once per finding, even if they told several stories.
- Report findings that weaken a hypothesis with the same prominence as those that support it.
- Reported numbers (fees, delays) are presented as ranges of what participants said, labelled "reported by participants, not verified", and never averaged into a market statistic.

### 7.3 Mandatory limitations paragraph

Every published summary includes this paragraph, adapted to the facts:

> These findings come from N interviews of about 20 minutes, held by the founder between <dates>, with participants recruited through the founder's network and referrals. The sample is small and not representative. Answers may be biased by the participants' relationship to the founder. Numbers are as reported by participants and were not verified. Quotes were translated from <languages> by the founder.

### 7.4 sessions.md format

After the first real session (*planned (T1)*), the founder creates `docs/research/sessions.md` with one row per **held** session and nothing else. It never contains names, contact details or raw notes; quotes appear only with consent.

| ID | Date (UTC) | Segment | Language | Mode | Recruited through | Key findings (codes) | Consented quotes |
|---|---|---|---|---|---|---|---|

A summary table of counts per hypothesis follows the session rows, with the limitations paragraph. The file is reviewed by the founder before every commit that touches it.

### 7.5 Where findings may be used

- The Colosseum pitch and business plan ([demo-recording runbook §5](../runbooks/demo-recording.md#5-pitch-23-min-founder-on-camera)), and the submissions under `docs/submissions/`.
- Product priorities, as input to the next ADR or plan revision.

They may not be used to describe PayLink as having "users" or "customers". Interviewees are participants; waitlist entries are sign-ups.

## 8. Waitlist

- **Opt-in only**, through the separate box in [consent.md](consent.md) or an explicit written request. Never add someone who did not ask.
- The founder collects it by hand (a message or a form of the founder's choosing). The PayLink web app itself has no server database and no analytics ([ARCHITECTURE §7](../ARCHITECTURE.md#7-data-and-privacy)), so it does not collect sign-ups.
- Store only a contact method, the segment, the date and the source. Keep it private; never commit it.
- The reported count is the number of distinct people who opted in, with the date of the count ("<n> sign-ups as of <date>"). No bought lists, no automated sign-ups, duplicates removed.
- Anyone can leave at any time, and is then deleted.

## 9. Checklists

### Before each session

- [ ] Participant meets the inclusion criteria; segment noted.
- [ ] Information sheet sent or ready to read ([consent.md](consent.md)).
- [ ] Note template open, in private storage; session ID assigned.
- [ ] Recording off unless the audio box is ticked.
- [ ] No PayLink screen open, unless a demo is requested at the end.

### After each session

- [ ] Notes completed within 2 hours, while memory is fresh; reported numbers marked as reported.
- [ ] Consent boxes copied into the notes; anything not consented removed.
- [ ] Follow-ups sent (thank-you, deletion requests, referrals).
- [ ] Row added to `docs/research/sessions.md` (*planned (T1)*: created after the first session; pseudonymised; consented quotes only).

### Before publishing any number

- [ ] Each number traces to named session IDs in `sessions.md`.
- [ ] N is the number of sessions actually held.
- [ ] Supporting and weakening evidence are both shown.
- [ ] The limitations paragraph is present.
- [ ] Withdrawal requests received so far are applied.
