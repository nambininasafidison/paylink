# PayLink documentation

Start with the [architecture](ARCHITECTURE.md). Every external fact in these documents carries a confidence tag: **UV** (verified by the owner on the official page), **C** (confirmed from a primary source or checked live), **L** (likely) or **U** (unverified), as defined in [ARCHITECTURE.md](ARCHITECTURE.md).

| Area | Document | What it answers |
|---|---|---|
| **Design** | [ARCHITECTURE.md](ARCHITECTURE.md) | Components, data flows, trust boundaries, the read model (chain > device > indexer), editions, failure modes |
| | [Architecture decision records](adr/README.md) | Why each significant choice was made, with the options that were rejected (ADRs 0001–0016) |
| **Open standard** | [Invoice format specification v2](spec/paylink-invoice-v2.md) | The normative signed-invoice format: EIP-712 domain and types, key derivation, payment binding, cancellation, URL encodings, receipt verification, test vectors |
| | [JSON Schema](spec/paylink-invoice-v2.schema.json) | Machine-readable form of the specification's JSON objects (draft 2020-12) |
| **Security** | [Threat model](security/THREAT_MODEL.md) | Assets, actors, STRIDE per component, mitigations with their evidence, residual risks |
| | [Invariants](security/invariants.md) | The contract properties I1–I11: meaning, rationale, threats covered and the tests that enforce them |
| | [Self-review checklist](security/self-review.md) | SWC and SCSVS v2 mapping. A self-review, **not** a third-party audit |
| | [Incident response](security/incident-response.md) | Severity levels, kill switches, playbooks, communication and post-mortems |
| | [SECURITY.md](../SECURITY.md) | How to report a vulnerability; safe harbour |
| **Operations** | [Deploy runbook](runbooks/deploy.md) | Wallets, secrets, the contract go/no-go, testnet deployments, Arc v1 on mainnet, rollback |
| | [Cloudflare Pages runbook](runbooks/cloudflare-pages.md) | The one Pages project that serves the v2 app, its editions, v1 under `/arc/` and the deploy kit: exact build settings, checks, rollback, and a prompt for a browser assistant |
| | [Relayer runbook](runbooks/relayer.md) | Putting the gasless relayer online from the repository, its key and gas, checks, operations, and a prompt for a browser assistant |
| | [Envio runbook](runbooks/envio.md) | Putting the history indexer online on Envio Cloud from the repository (free plan, branch `envio`), checking its endpoint, wiring it into `/config.json`, redeploying before judging, a prompt for a browser assistant, and the Envio bounty answer draft |
| | [Faucets runbook](runbooks/faucets.md) | Funding the testnet wallets, with a claim log |
| | [Demo recording runbook](runbooks/demo-recording.md) | Video scripts, honesty rules, setup and retakes |
| | [Sandbox bootstrap runbook](runbooks/sandbox-bootstrap.md) | Restoring the pinned toolchain in the development sandbox |
| **Submissions** | [Submissions checklist](submissions/README.md) | Where things stand, what is done and what the owner must still do for Monad Metropolis and Colosseum, in order; the assets (logo, social card, screenshots) and what the screenshots are |
| | [Monad Metropolis pack](submissions/monad.md) | Every field of the Monad form, paste-ready with character counts: description, go-to-market, judge access instructions, the four bounty answers, disclosures |
| | [Colosseum pack](submissions/colosseum.md) | Description, Base track (Arbitrum only if deployed), architecture, business plan and go-to-market as hypotheses, why now, the open invoice spec as a public good, team, prior work and other events |
| | [Video scripts](submissions/video-scripts.md) | Shot-by-shot scripts with exact clicks, captions, preconditions and fallbacks (Monad demo and pitch, Agora demo, Colosseum pitch and demo), French translations of the narration |
| | [Monad forum questions](submissions/monad-forum.md) | Paste-ready questions to the Monad Metropolis organisers, and what each answer changes |
| **Research** | [Interview protocol and script](research/interview-script.md) | The demand-validation interviews: hypotheses, ethics, script, reporting rules |
| | [Information sheet and consent](research/consent.md) | What participants are told and what they agree to (EN, FR; MG by the founder) |
| **Tooling** | [check-docs.py](tools/check-docs.py) | Checks links and anchors, cited test names, cited repository paths, the threat model's evidence-status markers, addresses (allowlist and EIP-55), the ADR index, the JSON Schema and the submission fields' character counts. Run `python3 docs/tools/check-docs.py` before every documentation pull request |
| | [Address allowlist](tools/address-allowlist.json) | Every EVM address the documents may contain, with its source and confidence tag |
| | [submission_fields.py](tools/submission_fields.py) | Counts the characters of every paste-ready submission field against its form limit and rewrites the count lines (`--update`); check-docs runs it |
| **Project** | [CONTRIBUTING.md](../CONTRIBUTING.md) | Workflow, Conventional Commits, quality gates, coding standards |
| | [CHANGELOG.md](../CHANGELOG.md) | Notable changes |
| | [NOTICE.md](../NOTICE.md) | Third-party components, licences and fonts (OFL) |
| | [AI_DISCLOSURE.md](../AI_DISCLOSURE.md) | How Claude Code was used, what it was not allowed to do, and who is responsible |

PayLink v1 (the Arc Microgrants entry) is frozen and documented only where v2 depends on it: [ADR 0010](adr/0010-arc-stays-on-v1.md).
