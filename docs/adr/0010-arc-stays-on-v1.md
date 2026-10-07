---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering)
informed: Arc Microgrants reviewers, contributors
---

# ADR 0010: The Arc Microgrants entry stays on frozen v1

## Context and problem statement

PayLink v1 is a small, dependency-free contract: `contracts/PayLink.sol`, about 120 lines, solc 0.8.26, EVM `paris`, 7 passing contract tests. A static web app (`web/`) is served by GitHub Pages at `https://nambininasafidison.github.io/paylink/web/`. It is the Arc Microgrants entry. The redesign is pushed to `main` at `93ed4e3` (**C**, `git ls-remote origin` on 2026-10-05).

- Arc Microgrants requires a **mainnet** deployment; testnet-only entries are rejected (**UV**). Review is rolling, and decisions come before Oct 21 (**UV**).
- Deploying v1 on Arc mainnet costs about 920,964 gas, about 0.018 USDC at a base fee of 2e10 wei (**C**, live estimate).
- v2 is unfrozen until 2026-10-07 and unaudited. Native-coin payments in v2 on Arc are tier T2.

Should the Arc entry move to v2?

## Decision drivers

- The Arc entry must not depend on v2's schedule or risks.
- The URLs already submitted must keep working.
- Minimal cost and effort on Arc: the wallet needs about 0.1 USDC.
- Honest, simple disclosure of what each entry contains.

## Considered options

- **A.** Keep Arc on v1, byte-identical on `main`, tagged `arc-microgrants-v1` = `93ed4e3`. v2 work goes into new folders only.
- **B.** Move the Arc entry to v2.
- **C.** Deploy both v1 and v2 on Arc.

## Decision outcome

Chosen option: **A**, because it insulates a rolling-review, mainnet-only entry from v2's risk, and costs nothing.

Rules:

- These v1 files are frozen byte for byte: `contracts/PayLink.sol`, `web/**`, `scripts/compile.js`, `scripts/deploy.js`, `test/paylink.test.js`, `verify/**`, `package.json`, `package-lock.json`. The only planned change is `web/config.js` (the contract address) after the Arc deployment, together with `deployments/arc-mainnet.json` and the tag `arc-microgrants-v1.1`.
- v2 lives in new top-level folders. Workspace tooling must keep `npm test` for v1 green ([ADR 0011](0011-workspace-layout.md)).
- Go/no-go for the Arc mainnet deployment: **2026-10-14 18:00 UTC**. Without a mainnet transaction by then, the entry is dropped, never submitted as testnet-only.
- v1 has no owner, so a third party can broadcast the deploy without being trusted. The owner's wallet still needs about 0.01 USDC to `create()` its own link.

### Consequences

- Good, because the Arc entry is independent of the v2 freeze, the v2 deployments and any v2 incident.
- Good, because GitHub Pages keeps serving `/paylink/web/` unchanged.
- Good, because the disclosure is clear: v1 (Oct 4–5) is the pre-existing component, and v2 is what was built for Monad and Colosseum.
- Bad, because two link formats and two contracts are live at once. The README and the submissions must say which is which.
- Bad, because v1 lacks v2's improvements: v1 allows self-payment, stores memos on-chain and needs an on-chain `create`. These are acceptable for the Arc demo scope, with small amounts.
- Bad, because there is lasting maintenance: a CI smoke test for `/paylink/web/` and a frozen-files check.

### Confirmation

- `pages-v1-smoke.yml` checks that `/paylink/web/` still serves v1.
- CI fails if any frozen v1 path differs from the tagged commit: `git diff --exit-code arc-microgrants-v1 -- <frozen paths>`, with the allowlisted `web/config.js` exception after the deployment.
- `npm test` (7 tests) stays green on the pnpm-installed tree ([ADR 0011](0011-workspace-layout.md)).
- After the Arc deployment, code, events and balances are verified from the sandbox through `rpc.mainnet.arc.io` (reachable, **C**).

## Pros and cons of the options

### A. Arc on frozen v1 (chosen)

- Good, because it has zero coupling to v2, zero cost and keeps the submitted links working.
- Bad, because two formats are live, and v1's limitations remain.

### B. Move Arc to v2

- Good, because there would be one product everywhere.
- Bad, because the entry would depend on the v2 freeze and audit status. Arc's dual-decimal native USDC (18 decimals native, 6 decimals through the ERC-20 interface) needs v2's T2 native path, and the rolling review could see a moving target.

### C. Both v1 and v2 on Arc

- Good, because it would show both.
- Bad, because it splits attention and funds, confuses reviewers, and is unnecessary for the grant.

## More information

- PAYLINK-V2-SPEC §0 decision 6, §2.3, §6.5, §3.11.
- [Deploy runbook, Arc v1 section](../runbooks/deploy.md#6-arc-v1-on-mainnet).
