---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering)
informed: contributors, hackathon reviewers
---

# ADR 0008: One product, one contract, several editions

## Context and problem statement

PayLink v2 is entered in several events whose rules differ:

- **Monad Metropolis** Track 02 and bounties. The Mera bounties exclude Dynamic and Privy, and Mera passkeys must be the account layer.
- **Colosseum**, on Base, with Arbitrum optional: Base Account and EIP-6963 wallets.
- **Mezo:** MUSD is mandatory (**UV**).
- **PayPal:** PayPal technology **and** AI are mandatory (**UV**).

Each event wants a focused experience, and judges look at one edition. Maintaining separate products would split a solo developer's attention.

How do we serve different event requirements without forking the product?

## Decision drivers

- One contract and one artefact for every edition ([ADR 0002](0002-one-paris-bytecode-oz-5-3-0.md)).
- One codebase, so a fix lands everywhere.
- Small per-edition bundles: Mera code must not ship in the Base edition, and the reverse.
- Each edition matches its event's rules exactly (for example, "Mera only" in Monad).
- Honest disclosure of shared components across submissions.

## Considered options

- **A.** Build-time editions selected with `VITE_EDITION` (`all`, `monad`, `base`, later `mezo` and `paypal`), tree-shaken, sharing the core packages.
- **B.** Separate repositories or long-lived forks per event.
- **C.** One bundle with runtime feature flags.
- **D.** Separate contracts per event.

## Decision outcome

Chosen option: **A**, because it keeps one codebase and one contract, while each edition ships only its own account layer, default token and payment rail. Those three are the only axes that vary.

| Edition | Chains | Account layer | Default token | Rail |
|---|---|---|---|---|
| `monad` | 10143 (143 ready) | Mera passkeys only | AUSD | gasless EIP-3009 through the relayer |
| `base` | 84532 (+ 421614) | EIP-6963 wallets; Base Account for payers | USDC | gasless for EOAs; EIP-5792 batch for smart accounts |
| `all` | every registry chain | EIP-6963 wallets | per chain | per PaymentRouter |
| `mezo` (later) | 31611 | EIP-6963 wallets | MUSD | permit, or approve then pay |
| `paypal` (later) | per edition | — | — | PayPal sandbox plus on-chain |

`?chain=` switches only among an edition's own chains. Endpoints come from same-origin `/config.json`, never from the URL.

### Consequences

- Good, because one contract, SDK and design system serve every event, and a security fix lands everywhere at once.
- Good, because per-edition bundles stay small, and judges see a focused product.
- Good, because disclosure is simple: every submission names the same repository with its edition and commit range.
- Bad, because CI must build and test every edition (a build matrix).
- Bad, because edition-specific code paths can hide bugs that other editions do not exercise. Each edition gets its own e2e run.
- Bad, because configuration grows: registry flags, per-edition `config.json`, and routes such as `/send/` and `/till/` that exist only in some editions.

### Confirmation

- `ci.yml` builds every edition, and `size-limit` runs per edition.
- The e2e suite runs each edition's flows. The Monad edition is tested with the WebAuthn virtual authenticator (PRF), the Base edition with the EIP-1193 test wallet.
- Bundle inspection confirms that Mera code is absent from the `base` build and Base Account code is absent from the `monad` build.

## Pros and cons of the options

### A. Build-time editions (chosen)

- Good, because it combines one codebase with focused, small bundles.
- Bad, because of the build and test matrix.

### B. Separate repositories or forks

- Good, because each event gets maximum freedom.
- Bad, because fixes diverge, effort is duplicated, and "same project in several events" disclosures get harder.

### C. Runtime flags in one bundle

- Good, because there is only one build.
- Bad, because every user downloads every SDK (Mera, Base Account), which increases bundle size and attack surface on the origin that holds passkey keys.

### D. Separate contracts per event

- Good, because each contract could be tailored.
- Bad, because of multiple audits and artefacts, contrary to [ADR 0002](0002-one-paris-bytecode-oz-5-3-0.md).

## More information

- PAYLINK-V2-SPEC §0 decision 1, §2, §3.6 (editions).
- [ARCHITECTURE §8](../ARCHITECTURE.md#8-editions).
