# Video scripts: Monad Metropolis and Colosseum

| | |
|---|---|
| **Videos** | (a) Monad technical demo, at most 3:00 · (b) Monad pitch, at most 2:00 · (c) Agora bounty demo, at most 2:00 · (d) Colosseum pitch, 2 to 3 min, and Colosseum demo, at most 3:00 · optional 30 s advertisement |
| **Form rules** | Monad: the technical demo shows the product running, with no slides and no code tour; the pitch covers team, problem and why; the Agora video shows passkey onboarding, an AUSD balance and a completed send or receive settled instantly (**UV**, FACTS 2026-10-08). Colosseum: judges watch the pitch first, founder on camera (PAYLINK-V2-SPEC §2.2) |
| **Recording rules** | The [demo recording runbook](../runbooks/demo-recording.md) §1 (real testnet transactions only, measured numbers only, mark every cut, say "testnet", never "audited", nothing private on screen) and §6 (retakes) apply to every video here. This file replaces its draft scripts (§3 to §5) |
| **Language** | Narration in English, with a French translation of every spoken line under each script, for you to rehearse. Speak in your own words if you prefer: keep the facts |
| **Written** | 2026-10-09, against the code at `d9662c3`. Button labels below are the app's own English strings |

## Contents

0. [Before any recording](#0-before-any-recording)
1. [(a) Monad technical demo (at most 3:00)](#1-a-monad-technical-demo-at-most-300)
2. [(b) Monad pitch (at most 2:00)](#2-b-monad-pitch-at-most-200)
3. [(c) Agora demo (at most 2:00)](#3-c-agora-demo-at-most-200)
4. [(d) Colosseum pitch (2–3 min) and demo (at most 3:00)](#4-d-colosseum-pitch-23-min-and-demo-at-most-300)
5. [Optional 30-second advertisement](#5-optional-30-second-advertisement)
6. [Upload](#6-upload)

## 0. Before any recording

### 0.1 What must be live (blocking)

| Check | How | If it fails |
|---|---|---|
| The site serves v2, with the last commits | `https://paylink-mg.pages.dev/monad/status/`: "Build" names the commit you pushed and edition `monad`; `/base/status/` the same with `base` | Push `main`; check the Pages build settings ([Cloudflare Pages runbook](../runbooks/cloudflare-pages.md)) |
| The contract is genuine on both chains | the same Status pages: "Genuine contract: Release 2.0.0: code and immutables match." for Monad testnet and Base Sepolia | Do not record; tell Claude |
| The relayer answers and has gas | Status: "Relayer: Answering …"; or open `https://paylink-relayer.raherizonambinina.workers.dev/v1/health` | [Relayer runbook](../runbooks/relayer.md) §5 to §6. **Without it there is no Monad demo**: a PayLink key holds no MON, so it cannot pay its own fee |
| The AUSD faucet still pays | one "Get 10,000 test AUSD" on a throwaway key the day before | If it is dry or busy: from MetaMask (which holds MON), call `requestFunds(<payer address>)` on the faucet contract `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C` yourself, for example from an explorer's write-contract tab if it offers one for this proxy (**U**), off camera, and say so with a caption |
| History service (optional) | Status: the "History service" lamp is green and reads "Monad testnet: indexed to block …" (not "Not configured" or "Not answering.") | Record anyway: the ledger then says "From the network's latest blocks only"; never claim Envio on screen or in the narration if that line shows (pitch (b) row 4 has the sentence to add only when the lamp is green) |

### 0.2 Devices: pick one setup and rehearse it once, the day before

PayLink keys need a passkey manager with PRF (iCloud Keychain, Google Password Manager or 1Password) and the exact host `paylink-mg.pages.dev`. Whether your laptop's browser can create one, alone or through your phone (the QR code Chrome shows for "use a phone"), is not something we have tested (**U**): find out in the rehearsal.

| Setup | Merchant (seller) | Payer (client abroad) | How the link travels on camera |
|---|---|---|---|
| **A** (best) | Phone 1, Chrome or Safari, later the till | Phone 2 | Phone 2's camera scans the QR on phone 1's card |
| **B** | Laptop, Chrome, 1280 × 800 window; the till in a second window | Phone | The phone's camera scans the QR on the laptop screen |
| **C** (one phone) | Phone, normal Chrome tab | Same phone, a Chrome Incognito tab (separate storage) | "Copy" on the card, paste in the Incognito tab's address bar |

Every script below says MERCHANT and PAYER; the clicks are the same in every setup.

**Install it as an app, once, in the same rehearsal.** The Agora bounty asks for "a mobile app" (**UV**, FACTS 2026-10-08), and our answer says PayLink is an installable PWA ([monad.md §5.1](monad.md#51-agora-best-cross-border-payments-app)). On the PAYER phone (Setup A or B), open `https://paylink-mg.pages.dev/monad/` and install it: iOS Safari, Share → **Add to Home Screen**; Android Chrome, ⋮ → **Install app** (or **Add to Home screen**). Then, from the **PayLink** icon: create the payer's PayLink key with the fingerprint, get test AUSD and pay one invoice. Note the result (phone, system version, browser). If the installed app cannot create or use a PayLink key, record (c) shot 1 from the browser instead, and tell Claude: the Agora answer's "Mobile:" sentence then goes ([README §1](README.md#1-monad-metropolis) step 7).

### 0.3 Screen and sound

- Dark theme on every device (the moon key of the theme dial at the top of each page), English, Do Not Disturb, no other tabs, bookmarks bar hidden, no extensions other than the one wallet you show.
- Phone screen recording: iOS Control Centre → Screen Recording; Android quick settings → Screen recorder. Some phones black out the fingerprint sheet in recordings; that is fine, a caption says "fingerprint".
- Laptop: 1080p, 30 or 60 fps. Microphone 20 cm away; quiet room; no music with copyright.
- Personas only: "Rakoto Design" (merchant, Antananarivo) and "a client abroad". No real names, phone numbers, inboxes or seed phrases on screen.
- Amounts: **12.50 AUSD** (Monad invoice), **25.00 USDC** (Base invoice), any amount on a receive card.

### 0.4 Caption style

Captions are short, in English, bottom third, white on a dark band. Two captions are mandatory in every demo: **"Monad testnet"** (or "Base Sepolia") on the first shot, and **"Real testnet transaction"** on the explorer shot. Mark any cut: "cut: waiting for the faucet", "sped up ×2".

## 1. (a) Monad technical demo (at most 3:00)

**Goal:** the whole hero flow on Monad testnet, product only: create with a passkey, pay gaslessly with a fingerprint, the till, the verified receipt on the explorer, the books.

**Preconditions**

- [ ] §0.1 all green; one setup from §0.2 rehearsed end to end the day before.
- [ ] MERCHANT is signed in with a PayLink key named **"Rakoto Design"**, created during the rehearsal on this device (the KeyCard is shown on camera by the PAYER, shot 6). The terminal's key then reads **Review and sign**.
- [ ] One open invoice already exists on the MERCHANT device for the cancel shot: memo **"Deposit, to cancel"**, 5.00 AUSD, made off camera with the same key.
- [ ] PAYER has no key yet on its device or profile, and its new account will hold 0 AUSD and 0 MON.
- [ ] URLs ready: `https://paylink-mg.pages.dev/monad/` on the MERCHANT. Nothing typed on camera except the amount and the memo.

| # | Time | Screen and exact clicks | Caption | Narration (EN) |
|---|---|---|---|---|
| 1 | 0:00–0:10 | MERCHANT: `/monad/`, the terminal, dark | "PayLink · Monad testnet · paylink-mg.pages.dev/monad" | "This is PayLink, live on Monad testnet. Rakoto is a freelance designer in Antananarivo, and he is about to bill a client abroad." |
| 2 | 0:10–0:28 | Amount `12.50`, memo `Logo design, invoice 042`. Press **Review and sign**. The signing display "You are about to sign this invoice" | "A Mera passkey is the account. No wallet, no seed phrase, no MON." | "He has no wallet and no MON. His PayLink key is a passkey, and Mera derives his Monad account from it. Before every fingerprint, PayLink shows exactly what it signs." |
| 3 | 0:28–0:50 | Press **Sign in wallet** (with a PayLink key it asks for the fingerprint); fingerprint; the card with its QR code appears; hold on it | "Signed off-chain (EIP-712): no transaction, no gas" | "One fingerprint, and the invoice is signed. It is a signature, not a transaction: it costs nothing, and it is ready to share as a link, on WhatsApp or as this QR code." |
| 4 | 0:50–1:00 | PAYER scans the QR (A, B) or pastes the link (C). MERCHANT presses **Show on the till**, then **Start the till** | "Till armed for this invoice" | "His client scans the code. Rakoto turns his phone into a till that waits for this exact payment." |
| 5 | 1:00–1:12 | PAYER: the pay view; hold on the four lamps (Signature, Network, Contract, Payable) | "Checked on chain before you can pay" | "Before the Pay key unlocks, four checks run against the chain: the signature, the network, the genuine PayLink contract, and that the invoice is still payable." |
| 6 | 1:12–1:32 | PAYER: **Use my PayLink key to pay**; KeyCard `My phone`, **Create my PayLink key**, fingerprint. "This account holds 0.00 AUSD." Press **Get 10,000 test AUSD**; wait for "Test AUSD received." | "Agora's AUSD testnet faucet, through our relayer" | "The client gets a PayLink key too. On testnet, one tap asks Agora's AUSD faucet for test dollars. He still holds no MON." |
| 7 | 1:32–1:50 | PAYER: scroll to the signing display "Pay exactly this, once"; press **Pay 12.50 AUSD**; fingerprint; "Approved" and "Settled in N.N s" | "Measured on this device" | "One fingerprint signs an authorization for exactly this payment. Our relayer submits it and pays the fee, but it cannot redirect the money. Approved, in the time you see, measured live." |
| 8 | 1:50–2:00 | MERCHANT: the till turns green, PAID, chime | "Lit only by a verified Paid event at the exact amount" | "Rakoto's till lights up, because the payment for this invoice is verified on chain." |
| 9 | 2:00–2:20 | PAYER: **Open the receipt**; the receipt page re-checks; **View the transaction**; MonadVision opens the transaction | "Real testnet transaction" | "Both sides keep a receipt that re-checks itself on chain every time it opens. Here is the transaction on Monad testnet." |
| 10 | 2:20–2:40 | MERCHANT: **Ledger**; the invoice reads Paid; the "Payments received" block; on "Deposit, to cancel": **Cancel**, **Confirm cancel**, fingerprint; "Cancelled" | "Gasless cancel (cancelBySig)" | "His ledger reads every state from the contract. Cancelling an invoice is one more fingerprint, and still no gas." |
| 11 | 2:40–2:55 | MERCHANT: "Ledger backup" panel; **Back up my ledger**; fingerprint; "Backup saved …" | "Same passkey, second key: paylink.books.v1" | "And the same passkey gives a second, separate key that encrypts his books, so only he can restore them, on any device." |
| 12 | 2:55–3:00 | MERCHANT: hold on the ledger | "github.com/nambininasafidison/paylink · testnet · not audited" | "PayLink. Get paid in dollars, with a fingerprint." |

**If something fails while recording**

| Problem | Do this |
|---|---|
| "This passkey cannot hold a PayLink key (no PRF)" | Wrong passkey manager: switch to the setup you rehearsed. Never record a workaround you have not rehearsed |
| The faucet says to wait a minute | Wait 60 s, retake from shot 6, or keep the take and add "cut: faucet cooldown (60 s)" |
| "The service that covers the network fee did not answer" | Stop: the relayer is down or out of gas. Check `/v1/health`, refill or redeploy ([relayer runbook](../runbooks/relayer.md)), retake. Do not edit around it |
| The till does not light within 10 s | Check `/monad/status/`; retake shots 7–8. Never splice a till from another take |
| "Payments received" says "From the network's latest blocks only" | Keep it (it is true) and change the narration of shot 10 to "his ledger reads every state from the contract" only |
| A notification, a personal detail, the wrong theme | Retake the shot ([runbook §6](../runbooks/demo-recording.md#6-retake-list)) |

**French translation of the narration (for you)**

1. « Voici PayLink, en ligne sur le testnet de Monad. Rakoto est graphiste indépendant à Antananarivo, et il va facturer un client à l'étranger. »
2. « Il n'a ni portefeuille ni MON. Sa clé PayLink est une passkey, et Mera en dérive son compte Monad. Avant chaque empreinte, PayLink montre exactement ce qu'elle signe. »
3. « Une empreinte, et la facture est signée. C'est une signature, pas une transaction : elle ne coûte rien, et elle est prête à partager, en lien, sur WhatsApp ou avec ce QR code. »
4. « Son client scanne le code. Rakoto transforme son téléphone en caisse qui attend ce paiement précis. »
5. « Avant que la touche Payer se déverrouille, quatre vérifications se font sur la chaîne : la signature, le réseau, le vrai contrat PayLink, et que la facture est encore payable. »
6. « Le client se crée aussi une clé PayLink. Sur le testnet, une touche demande des dollars de test au robinet AUSD d'Agora. Il n'a toujours aucun MON. »
7. « Une empreinte signe une autorisation pour exactement ce paiement. Notre relais la soumet et paie les frais, mais il ne peut pas détourner l'argent. Approuvé, dans le temps affiché, mesuré en direct. »
8. « La caisse de Rakoto s'allume, parce que le paiement de cette facture est vérifié sur la chaîne. »
9. « Les deux parties gardent un reçu qui se revérifie sur la chaîne à chaque ouverture. Voici la transaction sur le testnet de Monad. »
10. « Son registre lit chaque état dans le contrat. Annuler une facture, c'est une empreinte de plus, et toujours sans frais de gaz. »
11. « Et la même passkey donne une deuxième clé, distincte, qui chiffre ses comptes : lui seul peut les restaurer, sur n'importe quel appareil. »
12. « PayLink. Être payé en dollars, avec une empreinte. »

## 2. (b) Monad pitch (at most 2:00)

**Goal:** you, on camera: who you are, the problem, who it is for, why Monad, why now. One 10-second insert of the product. **No number that does not come from your own interviews**: the lines with `[…]` change with what you actually have.

**Preconditions:** a quiet room, light on your face, camera at eye level, landscape 1080p; the 10-second insert cut from video (a), shots 7–8 (the fingerprint payment and the till lighting up).

| # | Time | Picture | Narration (EN) |
|---|---|---|---|
| 1 | 0:00–0:15 | You, medium shot. Caption: "[Your name] · founder, PayLink · Antananarivo, Madagascar" | "I'm [your first name], and I build PayLink from Antananarivo, in Madagascar. PayLink turns a dollar invoice into a link you get paid through with a fingerprint." |
| 2 | 0:15–0:45 | You | "Many people here earn from clients abroad: designers, developers, translators, small shops serving visitors. [Say one true thing you have seen or lived, in one sentence.] We believe getting paid from abroad is still slow, costly or uncertain for them, and we are testing that in structured interviews. [Only if you have held some: 'So far, n of N people we interviewed described …'.]" |
| 3 | 0:45–1:10 | Insert (10 s): the payer's fingerprint, "Approved", the till lighting up. Then you | "With PayLink, the freelancer signs an invoice with a passkey and sends it on WhatsApp. The client opens it anywhere, checks it, and pays in AUSD with one fingerprint, without any gas token. The money goes straight to the freelancer, and both keep a receipt anyone can verify." |
| 4 | 1:10–1:35 | You | "Why Monad: a payment has to feel like a card tap, and on Monad the client sees it settle in the time measured on the screen. We built for Monad's rules: gas limits computed exactly, a relayer that never sends value, and Mera passkeys, so neither side ever holds MON." [Only if, on the day you record, the Status page's "History service" lamp is green (§0.1): add "Payment history comes from an Envio indexer."] |
| 5 | 1:35–1:50 | You | "Why now: dollar stablecoins, passkeys in every phone and fast EVM chains finally make 'get paid in dollars with a fingerprint' possible for people who were left out." |
| 6 | 1:50–2:00 | You. Caption: "paylink-mg.pages.dev/monad · testnet" | "PayLink is open source and live on Monad testnet. Next, we test it with real freelancers in Antananarivo. Thank you." |

**If something goes wrong:** read from notes placed under the camera rather than a teleprompter that makes your eyes move; record each row separately and join them with straight cuts; keep each answer under its time. If you have no interview yet, drop the bracketed sentence of row 2: the pitch stands without it.

**French translation (for you)**

1. « Je m'appelle [prénom], et je construis PayLink depuis Antananarivo, à Madagascar. PayLink transforme une facture en dollars en un lien par lequel on est payé avec une empreinte. »
2. « Beaucoup de gens ici gagnent leur vie avec des clients à l'étranger : graphistes, développeurs, traducteurs, petites boutiques qui servent des visiteurs. [Une chose vraie que vous avez vue ou vécue, en une phrase.] Nous pensons qu'être payé depuis l'étranger reste lent, coûteux ou incertain pour eux, et nous le vérifions par des entretiens structurés. [Seulement si vous en avez fait : « Jusqu'ici, n personnes sur N que nous avons interrogées ont décrit … ».] »
3. « Avec PayLink, le freelance signe une facture avec une passkey et l'envoie sur WhatsApp. Le client l'ouvre où qu'il soit, la vérifie et paie en AUSD avec une seule empreinte, sans jeton de gaz. L'argent va directement au freelance, et chacun garde un reçu que tout le monde peut vérifier. »
4. « Pourquoi Monad : un paiement doit ressembler à un passage de carte, et sur Monad le client le voit se régler dans le temps mesuré à l'écran. Nous avons construit pour les règles de Monad : des limites de gaz calculées au plus juste, un relais qui n'envoie jamais de valeur, et des passkeys Mera, pour qu'aucune des deux parties n'ait jamais besoin de MON. » [Seulement si, le jour de l'enregistrement, le voyant « History service » de la page Status est vert (§0.1) : ajoutez « L'historique des paiements vient d'un indexeur Envio. »]
5. « Pourquoi maintenant : les dollars numériques, les passkeys dans chaque téléphone et des chaînes EVM rapides rendent enfin possible « être payé en dollars avec une empreinte » pour des gens qui en étaient exclus. »
6. « PayLink est open source et en ligne sur le testnet de Monad. Prochaine étape : le tester avec de vrais freelances à Antananarivo. Merci. »

## 3. (c) Agora demo (at most 2:00)

**Goal:** exactly the three things the bounty names: **passkey onboarding**, an **AUSD balance**, and a **completed send or receive settled instantly**, with AUSD between two people.

**Honest limits to respect:** the app shows an account's AUSD balance only while it is too low to pay ("This account holds 0.00 AUSD."). The balances after the payment are shown on MonadVision, the block explorer. Say "settled in the time shown" rather than "instantly" unless the measured figure is under a second on your take.

**Preconditions**

- [ ] §0.1 green. One setup from §0.2.
- [ ] RECEIVER (Rakoto, Antananarivo): a PayLink key and a receive card made off camera: `/monad/send/`, **Use my account**, then **Create my receive card**, tick "I understand this link stays payable until I cancel it.", **Use my PayLink key to sign** (or **Review and sign**), **Sign in wallet**, fingerprint. Then **Watch it on the till** in a window you can show.
- [ ] The receive card's link is on the SENDER's device before recording (Setup A or B: scan its QR once and copy the address bar into a note; Setup C: **Copy**).
- [ ] SENDER (a client abroad): no PayLink key yet on its device or profile, and PayLink installed on its home screen in the rehearsal (§0.2). This needs the SENDER on a phone of its own (Setup A, or B with the phone as SENDER). In Setup C the SENDER is an Incognito tab, which an installed app cannot be: open `https://paylink-mg.pages.dev/monad/send/` there for shot 1, and leave the words "installed on her phone like an app" out of the narration and the caption.
- [ ] MonadVision open in the phone's browser (Chrome or Safari) on the SENDER device, outside the installed app (you will paste the sender's address there at the end).

| # | Time | Screen and exact clicks | Caption | Narration (EN) |
|---|---|---|---|---|
| 1 | 0:00–0:10 | SENDER: the phone's home screen; tap the **PayLink** icon. PayLink opens full screen, without the browser's address bar; tap **Send** in the top menu | "PayLink, installed on the phone from the browser · AUSD on Monad testnet" | "A client abroad opens PayLink, installed on her phone like an app, to send dollars to Rakoto in Antananarivo." |
| 2 | 0:10–0:25 | Under "Save a contact": "Name" `Rakoto (Antananarivo)`; "Their receive card or payment link": paste the card link; **Save contact** | "His receive card, checked before it is saved" | "She saves Rakoto's receive card once. PayLink checks it on chain and remembers the address it pays." |
| 3 | 0:25–0:50 | Press **Send** next to "Rakoto (Antananarivo)". The pay view shows "Saved as: Rakoto (Antananarivo)". Press **Use my PayLink key to pay**; KeyCard: "Name on the key" `My phone`, **Create my PayLink key**, fingerprint | "Passkey onboarding: one fingerprint, no wallet, no seed phrase" | "She has never used crypto. One fingerprint creates her PayLink key, a Mera passkey, and her account on Monad." |
| 4 | 0:50–1:08 | The funds row: "This account holds 0.00 AUSD." Press **Get 10,000 test AUSD**; "Test AUSD received." | "AUSD balance: 0.00, then 10,000 test AUSD from Agora's faucet" | "Her account holds no AUSD yet. On testnet, one tap asks Agora's AUSD faucet for test dollars, with no MON needed." |
| 5 | 1:08–1:30 | "Your amount": type `25`; the signing display shows 25.00 AUSD to Rakoto's address; press **Send AUSD** (an open-amount card's key); fingerprint; "Approved", "Settled in N.N s" | "Gasless: one EIP-3009 signature" | "She types twenty-five dollars, reads exactly what she approves, and pays with one fingerprint. Approved, in the time you see." |
| 6 | 1:30–1:42 | RECEIVER: the till is green: 25.00 AUSD received | "Received in Antananarivo, verified on chain" | "In Antananarivo, Rakoto's till lights up for the payment." |
| 7 | 1:42–1:57 | SENDER: **Open the receipt**, **View the transaction** (MonadVision: the AUSD transfer; from the installed app it opens in the phone's browser view). Then switch to the browser's MonadVision tab and paste her address: token balance 9,975 AUSD | "Real testnet transaction · AUSD balances on MonadVision" | "The transfer is on Monad testnet: twenty-five AUSD moved, and her balance shows what is left." |
| 8 | 1:57–2:00 | Hold | "paylink-mg.pages.dev/monad · testnet" | "PayLink: send dollars with a fingerprint." |

The 9,975 AUSD of shot 7 assumes the 10,000 test AUSD of shot 4 and one payment of 25; say the number you see.

**If something fails:** the faucet asks to wait: wait 60 s and mark the cut, or fund the sender off camera (§0.1) and replace shot 4 with the funds row before and after, captioned "funded off camera from the faucet". The relayer does not answer: stop and fix it; there is no honest workaround for a passkey account without MON. "This is not a valid PayLink link for this edition." on Save contact: the card link is from another edition or was cut; copy it again from the card's printed link.

**French translation (for you)**

1. « Une cliente à l'étranger ouvre PayLink, installé sur son téléphone comme une application, pour envoyer des dollars à Rakoto, à Antananarivo. »
2. « Elle enregistre une fois la carte de réception de Rakoto. PayLink la vérifie sur la chaîne et retient l'adresse qu'elle paie. »
3. « Elle n'a jamais utilisé de crypto. Une empreinte crée sa clé PayLink, une passkey Mera, et son compte sur Monad. »
4. « Son compte n'a pas encore d'AUSD. Sur le testnet, une touche demande des dollars de test au robinet AUSD d'Agora, sans avoir besoin de MON. »
5. « Elle tape vingt-cinq dollars, lit exactement ce qu'elle approuve, et paie avec une empreinte. Approuvé, dans le temps affiché. »
6. « À Antananarivo, la caisse de Rakoto s'allume pour ce paiement. »
7. « Le transfert est sur le testnet de Monad : vingt-cinq AUSD ont bougé, et son solde montre ce qu'il reste. »
8. « PayLink : envoyer des dollars avec une empreinte. »

## 4. (d) Colosseum pitch (2–3 min) and demo (at most 3:00)

### 4.1 Pitch (2:00 to 3:00, founder on camera)

**Preconditions:** as for (b). The 10-second insert comes from the Base demo below, shot 5 (the payer's single signature and "Approved").

| # | Time | Picture | Narration (EN) |
|---|---|---|---|
| 1 | 0:00–0:15 | You. Caption: "[Your name] · founder, PayLink · Antananarivo, Madagascar" | "I'm [your first name], a solo founder in Antananarivo, Madagascar. I'm building PayLink: dollar invoices you share as a link and get paid in USDC, with no fee and no middleman holding the money." |
| 2 | 0:15–0:50 | You | "Here, many people earn from clients abroad, and getting that money can be slow, costly or uncertain. [One true sentence from your own experience.] That is our hypothesis, and we test it in structured interviews. [Only if held: 'So far, n of N …'; otherwise: 'We are starting those interviews now.']" |
| 3 | 0:50–1:25 | Insert (10 s), then you | "With PayLink, the seller signs an invoice once: no transaction, no gas. The buyer opens the link anywhere. Before they can pay, four checks run on chain. On Base, a normal wallet signs once and our relayer pays the fee; a smart wallet approves and pays in one step. The money goes straight to the seller, and both keep a receipt anyone can re-verify." |
| 4 | 1:25–1:50 | You | "It is one immutable contract with no owner and no fee, at the same address on Base Sepolia and Monad testnet, and the invoice format is an open specification with test vectors, so any wallet or app can issue or pay a PayLink invoice." |
| 5 | 1:50–2:15 | You | "Why now: stablecoins can be paid with a signature, smart wallets batch approvals, and Base makes small payments cheap. Together they make 'get paid in dollars by link' practical for people who were left out." |
| 6 | 2:15–2:40 | You | "Our plan, and these are hypotheses: the core stays free; a PayLink Business tier for accounting exports, webhooks and teams; later, referrals to licensed cash-out partners, which we do not have yet. The biggest risk is cash-out to local money, and we say so." |
| 7 | 2:40–2:55 | You. Caption: "paylink-mg.pages.dev/base · testnet · open source" | "PayLink is live on Base Sepolia and open source. Next: interviews and a pilot with freelancers in Antananarivo. Thank you." |

**French translation (for you)**

1. « Je m'appelle [prénom], fondateur solo à Antananarivo, Madagascar. Je construis PayLink : des factures en dollars qu'on partage comme un lien et qu'on se fait payer en USDC, sans frais et sans intermédiaire qui garde l'argent. »
2. « Ici, beaucoup de gens gagnent leur vie avec des clients à l'étranger, et recevoir cet argent peut être lent, coûteux ou incertain. [Une phrase vraie tirée de votre expérience.] C'est notre hypothèse, et nous la vérifions par des entretiens structurés. [Seulement si réalisés : « Jusqu'ici, n sur N … » ; sinon : « Nous commençons ces entretiens maintenant. »] »
3. « Avec PayLink, le vendeur signe une facture une seule fois : pas de transaction, pas de gaz. L'acheteur ouvre le lien où qu'il soit. Avant de pouvoir payer, quatre vérifications se font sur la chaîne. Sur Base, un portefeuille classique signe une fois et notre relais paie les frais ; un portefeuille intelligent approuve et paie en une seule étape. L'argent va directement au vendeur, et chacun garde un reçu que tout le monde peut revérifier. »
4. « C'est un seul contrat immuable, sans propriétaire et sans frais, à la même adresse sur Base Sepolia et sur le testnet de Monad, et le format de facture est une spécification ouverte avec des vecteurs de test : n'importe quel portefeuille ou application peut émettre ou payer une facture PayLink. »
5. « Pourquoi maintenant : les stablecoins se paient avec une signature, les portefeuilles intelligents regroupent les approbations, et Base rend les petits paiements peu coûteux. Ensemble, ils rendent « être payé en dollars par un lien » réaliste pour des gens qui en étaient exclus. »
6. « Notre plan, et ce sont des hypothèses : le cœur reste gratuit ; une offre PayLink Business pour les exports comptables, les webhooks et les équipes ; plus tard, des recommandations vers des partenaires agréés de retrait d'argent, que nous n'avons pas encore. Le plus grand risque est la conversion en monnaie locale, et nous le disons. »
7. « PayLink est en ligne sur Base Sepolia et open source. Prochaine étape : des entretiens et un pilote avec des freelances à Antananarivo. Merci. »

### 4.2 Demo (at most 3:00, Base edition)

**Preconditions**

- [ ] §0.1 green for Base Sepolia (Status of `/base/`, and the relayer answering for 84532 with Base Sepolia ETH on its key).
- [ ] MetaMask with **two plain accounts** on Base Sepolia, created for the demo and never switched to a smart account: "Payee" and "Payer". Your main account has an EIP-7702 delegation on Base Sepolia since the contract deployment (FACTS 2026-10-08), so the app treats it as a smart account and it would pay its own gas: do not use it for the gasless shot.
- [ ] "Payer" holds test USDC from `https://faucet.circle.com` (Base Sepolia, 20 USDC a request) and **no ETH is needed**.
- [ ] Optional shot 7: a smart-account payer with USDC and a little Base Sepolia ETH: Coinbase Wallet (the key then reads "Pay with Base") or a MetaMask smart account (the key reads "Pay 25.00 USDC" and the note says "One approval in your wallet"). Skip shot 7 if you have neither; never claim it.
- [ ] Two Chrome profiles on the laptop: profile 1 with MetaMask on "Payee", profile 2 with MetaMask on "Payer" (or one profile and switch accounts between shots).

| # | Time | Screen and exact clicks | Caption | Narration (EN) |
|---|---|---|---|---|
| 1 | 0:00–0:10 | Profile 1: `https://paylink-mg.pages.dev/base/` | "PayLink · Base Sepolia (testnet)" | "This is PayLink on Base Sepolia. A freelancer bills a client abroad in USDC." |
| 2 | 0:10–0:40 | Amount `25.00`, memo `Website hosting, October`. **Connect a wallet to sign** → MetaMask → connect "Payee". **Review and sign**; the signing display; **Sign in wallet**; MetaMask shows the typed data; **Sign** | "An EIP-712 signature: no transaction, no gas" | "The invoice is a signature, and the screen shows exactly what the wallet signs. No transaction, no gas, no platform fee." |
| 3 | 0:40–0:50 | The card with the QR code; **Copy** | "Share by link, QR, WhatsApp or print" | "The link goes out by WhatsApp, QR code or a printed card." |
| 4 | 0:50–1:10 | Profile 2: paste the link. The pay view: amount, memo, four lamps, the payee's address in full | "Checked on chain before paying" | "The client opens it. Four checks run on chain: the signature, the network, the genuine contract, and that it is still payable." |
| 5 | 1:10–1:40 | **Connect a wallet to pay** → MetaMask "Payer"; the key reads **Pay 25.00 USDC**, "One signature; the fee is covered."; press it; MetaMask shows a typed-data signature (EIP-3009 authorization for USDC, the PayLink contract as recipient); **Sign**; "Approved" | "One signature, no ETH: the relayer pays the gas and cannot redirect the money" | "A normal wallet signs one authorization for exactly this payment. Our relayer submits it and pays the gas, but it cannot send the money anywhere else. Approved." |
| 6 | 1:40–2:00 | **Open the receipt**; **View the transaction**: Basescan | "Real testnet transaction" | "Both sides keep a receipt that re-verifies itself on chain. Here is the transaction on Base Sepolia." |
| 7 | 2:00–2:25 | (optional) A second invoice (2.25 USDC) paid by the smart-account payer: the key **Pay with Base** (Coinbase Wallet) or **Pay 2.25 USDC** with "One approval in your wallet…" (MetaMask smart account); one approval; "Approved" | "EIP-5792: approve and pay in one batch" | "A smart wallet approves exactly the amount and pays in one step." |
| 8 | 2:25–2:45 | Profile 1: **Ledger**: the invoice is Paid; the tally; **Export CSV**; then **Status** in the footer: "Genuine contract" on Base Sepolia | "One immutable, fee-less contract · same address on Base Sepolia and Monad testnet" | "The ledger reads every state from the contract, and the status page checks that the contract is the genuine release." |
| 9 | 2:45–3:00 | The open specification on GitHub: `docs/spec/paylink-invoice-v2.md` | "Open invoice spec · MIT · test vectors" | "The invoice format is an open specification, so any wallet or app can issue and pay PayLink invoices." |

**If something fails:** MetaMask offers to "switch to a smart account": decline, and check the account has no code. The key reads "One approval in your wallet" on the Payer account: that account is a smart account; use a fresh plain account. "The service that covers the network fee did not answer": the relayer is down on Base Sepolia; stop and fix it. Basescan is slow: use the Blockscout link from the receipt's network instead, or wait.

**French translation (for you)**

1. « Voici PayLink sur Base Sepolia. Une freelance facture un client à l'étranger en USDC. »
2. « La facture est une signature, et l'écran montre exactement ce que le portefeuille signe. Pas de transaction, pas de gaz, pas de frais de plateforme. »
3. « Le lien part par WhatsApp, par QR code ou sur une carte imprimée. »
4. « Le client l'ouvre. Quatre vérifications se font sur la chaîne : la signature, le réseau, le vrai contrat, et qu'elle est encore payable. »
5. « Un portefeuille classique signe une autorisation pour exactement ce paiement. Notre relais la soumet et paie le gaz, mais il ne peut pas envoyer l'argent ailleurs. Approuvé. »
6. « Chacun garde un reçu qui se revérifie sur la chaîne. Voici la transaction sur Base Sepolia. »
7. « Un portefeuille intelligent approuve exactement le montant et paie en une seule étape. »
8. « Le registre lit chaque état dans le contrat, et la page d'état vérifie que le contrat est bien la version officielle. »
9. « Le format de facture est une spécification ouverte : n'importe quel portefeuille ou application peut émettre et payer des factures PayLink. »

## 5. Optional 30-second advertisement

Monad's form takes an optional advertisement of at most 30 s. Cut it from (a), no new recording:

| Time | From | Caption |
|---|---|---|
| 0:00–0:06 | (a) shot 3, the card appearing | "Sign a dollar invoice with your fingerprint" |
| 0:06–0:14 | (a) shot 6, the KeyCard and "Test AUSD received." | "Your client pays with theirs. No wallet. No gas." |
| 0:14–0:22 | (a) shots 7–8, "Approved" and the till lighting up | "Settled on Monad testnet, verified on chain" |
| 0:22–0:30 | (a) shot 9, the receipt | "PayLink · paylink-mg.pages.dev/monad · testnet" |

No narration needed; if you add music, use a track you have the rights to.

## 6. Upload

- [ ] Each video within its limit (check the exported file, not the timeline).
- [ ] English captions burned in or uploaded; the narration tables above are the caption text.
- [ ] YouTube, **public** (or unlisted only if the form accepts it), checked from a logged-out browser.
- [ ] Title "PayLink: <video> (testnet)"; description with the repository, the contract address `0x448eCce9711860502806A3d5B021a4f9Ba715082`, the explorer link of the transaction shown, and one line on AI use ("Built with Claude Code; see AI_DISCLOSURE.md").
- [ ] Paste the links into [monad.md](monad.md#2-form-fields), [colosseum.md](colosseum.md#9-links) and the forms.
