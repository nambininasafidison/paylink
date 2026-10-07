# AI use disclosure

PayLink is a solo project by **nambininasafidison** (the owner). Much of its engineering was done with **Claude Code**, Anthropic's agentic coding tool. Several hackathons ask entrants to disclose AI use. This page states how AI was used, what it was not allowed to do, and who is responsible.

## Summary

| | |
|---|---|
| **Tool** | Claude Code (Anthropic), in a sandboxed development environment, including sub-agents started by Claude Code |
| **Period** | PayLink v2: from Oct 5, 2026. For PayLink v1 (built Oct 4–5, 2026), each submission states the extent of AI assistance, as confirmed by the owner |
| **Human ownership** | The owner decides scope and design, reviews and accepts every change, owns all keys, accounts and submissions, and is accountable for the result |
| **Licence of the output** | MIT, like the rest of the repository ([LICENSE](LICENSE)) |

## What Claude Code did

- **Planning.** Drafted the v2 engineering plan (PAYLINK-V2-SPEC) by combining three independent design proposals and three reviews, then revised it with facts the owner checked on official pages. Facts carry confidence tags (UV, C, L, U), so readers can tell which were verified and how.
- **Code.** Wrote the v2 contract `PayLinkV2` and its tests (unit, fuzz, invariants), the TypeScript packages, the web app, the relayer, the indexer and the CI configuration. The commit history shows which commits were made with Claude Code ([below](#attribution-in-git)).
- **Documentation.** Wrote the architecture document, the ADRs, the open invoice specification, the threat model, the self-review checklist, the incident response plan, the runbooks and the submission drafts.
- **Verification.** Ran compilers, tests, static analysers (Slither, Aderyn), fuzzers and browser tests inside its sandbox. It cross-checked specification test vectors with two independent implementations. It read primary sources (library source code, the Solidity known-bugs list, package licences) instead of relying on memory, and recorded where it did.
- **Translations.** Drafted French and Malagasy strings. **Every Malagasy string is written or reviewed by the owner**, and AI drafts are flagged for that review.

## What Claude Code was not allowed to do

- **Hold or see private keys.** Keys live only in wallets, GitHub environment secrets or Cloudflare secrets ([deploy runbook](docs/runbooks/deploy.md)). No key is ever pasted into the chat or the sandbox.
- **Deploy contracts or move funds.** Deployments are approved by the owner, either in a GitHub environment with a required reviewer or by signing in the owner's own wallet.
- **Push to `main`, merge pull requests or publish releases** without the owner's review.
- **Submit to any competition** or post on any forum. The owner submits and posts. Claude only drafts the texts ([docs/submissions/](docs/submissions/monad-forum.md)).
- **Invent facts or numbers.** Demand-validation numbers come only from real, consented interviews ([research protocol](docs/research/interview-script.md)). Unverified external facts are labelled as such.

## Safeguards against AI failure modes

| Risk | Safeguard |
|---|---|
| Plausible but wrong code | Blocking gates on every pull request: types, lint, unit, fuzz and invariant tests, coverage thresholds, Slither, e2e and accessibility ([CONTRIBUTING.md](CONTRIBUTING.md)) |
| Security blind spots shared by one model | A second, independent review by a fresh agent with no shared context, and a published self-review that is clearly labelled as **not** a third-party audit ([self-review](docs/security/self-review.md)) |
| Hallucinated facts (addresses, deadlines, APIs) | Every external fact is tagged with its confidence. Addresses come only from the specification's verified list and pass EIP-55 tests. Fork tests in CI check the live tokens |
| Prompt injection through untrusted content | Memos, issues, pull-request text and tool output are treated as data, not instructions. AI agents in the product (GitLab Duo flows, the PayPal copilot) use tool allowlists, cannot merge or push the default branch, and need a person's approval for anything that moves money ([THREAT_MODEL T-21](docs/security/THREAT_MODEL.md#t-21)) |
| Licence contamination | Third-party code is added only as declared dependencies or vendored with its licence ([NOTICE.md](NOTICE.md)). Standards are referenced and paraphrased, not copied |

## Attribution in git

Commits produced with Claude Code carry a `Co-Authored-By: Claude …` trailer. The owner is the author of record and reviews every commit before it lands on `main`.

## Pre-existing work

PayLink v1 (the Arc contract and web app, created Oct 4–5, 2026) is pre-existing work for later events. It is frozen and disclosed as such ([ADR 0010](docs/adr/0010-arc-stays-on-v1.md)). Per-event disclosures with commit ranges are kept under `docs/submissions/`.
