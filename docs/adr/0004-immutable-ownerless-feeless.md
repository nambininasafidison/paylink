---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering); judge reviews in PAYLINK-V2-SPEC (donation-griefing correction)
informed: users, contributors, reviewers
---

# ADR 0004: Immutable, ownerless, fee-less contract

## Context and problem statement

PayLinkV2 is written and reviewed by one developer in under a week, is **not** audited by a third party, and is deployed to testnets (plus Arc v1 on mainnet for small amounts). Contracts usually get some administrative power: upgradeability, pause, fee switches, rescue functions. Each of those adds a privileged key, and a key is a target: a stolen upgrade key can redirect every payment.

PayLinkV2 is non-custodial. It never holds funds across a call (relative conservation, invariant I1), so a pause would protect no stored balance.

What administrative powers, if any, should the contract have?

## Decision drivers

- No privileged key whose theft compromises users (SCSVS G1.16).
- Users and reviewers can reason about the contract from its code alone.
- An incident must still have a response, even without admin powers.
- Donations and stray transfers must not be able to break the contract.
- Simplicity before the 2026-10-07 freeze.

## Considered options

- **A.** Immutable, no owner, no fee, no pause, no sweep. Incident response is a redeploy.
- **B.** Upgradeable proxy (UUPS or transparent) with an owner, ideally a multisig behind a timelock.
- **C.** Immutable, but with a guardian who can pause payments.
- **D.** A protocol fee, set by an owner.
- **E.** Immutable, with an owner-only `sweep` for stray tokens.

## Decision outcome

Chosen option: **A**, because a non-custodial contract gains almost nothing from admin powers, and every power would add a key that is worth stealing.

Rules that follow:

- No proxy, `Ownable`, `AccessControl`, `Pausable`, `selfdestruct` or `delegatecall`.
- Settlement is **exact-delta**: PayLink's balance after any call equals its balance before. It is **never** required to be zero, because a 1-wei donation would then block every payment (PAYLINK-V2-SPEC §3.3.3, a judge's suggestion corrected).
- Stray tokens and coins stay inert forever; there is no sweep. This is documented for users.
- **Incident response is a redeploy.** A new deployment has a new `verifyingContract`, so no old signature verifies on it. Clients stop offering the old deployment through the registry and the `/config.json` banner ([incident response](../security/incident-response.md)).

### Consequences

- Good, because there is no admin key to steal, no rug-pull path, and no governance to attack.
- Good, because the code is the whole truth, which reviewers and judges can verify.
- Good, because donation griefing is neutralised by design (invariant I1, with a `Donor` handler in the invariant suite).
- Bad, because a bug cannot be patched in place. It needs a redeploy, a registry update and new links. Open invoices on the old deployment stay payable there by any third-party client until they expire or are cancelled.
- Bad, because there is no circuit breaker. That is a documented deviation from SCSVS G1.5 ([self-review](../security/self-review.md)). Mitigations: the client-side kill switch (banner and registry flag), short default expiries, and testnet-only deployment until audited.
- Bad, because stray funds are unrecoverable.
- Neutral, because there is no business model in the contract. Monetisation, if any, lives off-chain (PAYLINK-V2-SPEC §2.2, "PayLink Business" hypothesis).

### Confirmation

- Slither's and Aderyn's reports show no privileged roles, and review confirms that no `onlyOwner`-style modifier exists.
- Invariant **I1** (relative conservation) runs with stray-transfer handlers, for every token kind and for the native coin.
- `receive()` and `fallback()` revert with `WrongPaymentPath` (invariant I10).
- A deployments check confirms that the constructor takes no arguments and that the `initCodeHash` matches the release ([ADR 0002](0002-one-paris-bytecode-oz-5-3-0.md)).

## Pros and cons of the options

### A. Immutable and ownerless (chosen)

- Good, because it removes key risk entirely and is the simplest to review.
- Bad, because fixes require a redeploy, and there is no on-chain pause.

### B. Upgradeable proxy

- Good, because bugs can be fixed in place, and links survive upgrades.
- Bad, because the upgrade key can redirect every payment. Doing it safely needs a multisig, a timelock, storage-layout tooling and upgrade tests (SCSVS G3), none of which a solo developer can run safely in a week.

### C. Guardian pause

- Good, because it can stop payments during an incident.
- Bad, because the contract holds no funds, so pausing protects little. A pause key can also censor, and adds trust. The client-side kill switch gives most of the benefit without a key.

### D. Protocol fee

- Good, because it would be a revenue stream.
- Bad, because it adds custody of fees, an owner to change them, and harder exactness invariants, and it contradicts "the core stays free".

### E. Owner sweep

- Good, because it can return mistaken transfers.
- Bad, because it adds an owner key that can move any token the contract holds, which is exactly the place where transient balances live during an EIP-3009 settlement.

## More information

- PAYLINK-V2-SPEC §0 decision 4, §3.3.1, §3.3.3, §3.3.4, §5 (incident response).
- [THREAT_MODEL T-09](../security/THREAT_MODEL.md#t-09) (donation griefing); [incident response](../security/incident-response.md).
