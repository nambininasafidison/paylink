# Architecture decision records

PayLink records significant engineering decisions as ADRs in the [MADR 4](https://adr.github.io/madr/) structure:

- context and problem statement;
- decision drivers;
- considered options;
- decision outcome, with consequences and confirmation;
- pros and cons of each option.

Each record starts with YAML front matter for its status, date and decision-makers. ADRs 0011 to 0014 were written with the workspace and toolchain changes they decide, and use an equivalent header list (status, date, deciders, related) with Context, Options, Decision and Consequences sections.

An ADR is never edited to reverse a decision. A new ADR supersedes it, and the old one's status becomes `superseded by ADR-NNNN`. Editorial fixes are allowed.

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-signed-invoices-no-onchain-create.md) | Signed invoices, no on-chain create | accepted | 2026-10-05 |
| [0002](0002-one-paris-bytecode-oz-5-3-0.md) | One paris bytecode with OpenZeppelin Contracts 5.3.0 | accepted | 2026-10-05 |
| [0003](0003-bind-3009-nonce-to-payment.md) | Bind the EIP-3009 nonce to the payment | accepted | 2026-10-05 |
| [0004](0004-immutable-ownerless-feeless.md) | Immutable, ownerless, fee-less contract | accepted | 2026-10-05 |
| [0005](0005-dedicated-origin-and-rpid.md) | Dedicated web origin and passkey rpId | accepted | 2026-10-05 |
| [0006](0006-vanilla-typescript-port-at-parity.md) | Port the v1 web app to vanilla TypeScript at parity (no framework) | accepted | 2026-10-05 |
| [0007](0007-relayer-durable-object-per-chain.md) | Relayer on Cloudflare Workers with one Durable Object per chain | accepted | 2026-10-05 |
| [0008](0008-editions.md) | One product, one contract, several editions | accepted | 2026-10-05 |
| [0009](0009-read-model-chain-device-indexer.md) | Read model: chain > device > indexer | accepted | 2026-10-05 |
| [0010](0010-arc-stays-on-v1.md) | The Arc Microgrants entry stays on frozen v1 | accepted | 2026-10-05 |
| [0011](0011-workspace-layout.md) | pnpm workspace at the repository root, with the frozen v1 manifest as the root project | accepted | 2026-10-05 |
| [0012](0012-toolchain-pinning-and-vendoring.md) | Toolchain pinning, sandbox bootstrap and vendored forge-std | accepted | 2026-10-05 |
| [0013](0013-browser-deploy-page.md) | Browser deploy page on the current Pages root, sharing one verifier with a CLI | accepted | 2026-10-07 |
| [0014](0014-web-app-and-single-pages-site.md) | The v2 web app, and one Pages site for v2, its editions, v1 and the deploy kit | accepted | 2026-10-08 |

## Writing a new ADR

1. Copy [template.md](template.md) to `NNNN-short-title.md`, using the next free number.
2. Fill in every section. Tag each external fact with its confidence (**UV**, **C**, **L** or **U**), as in [ARCHITECTURE.md](../ARCHITECTURE.md).
3. Add the record to the table above and to [ARCHITECTURE §13](../ARCHITECTURE.md#13-decision-index). `python3 docs/tools/check-docs.py` fails if either is missing or if a status differs from the record's header.
4. Open a pull request with the label `adr`. The owner accepts or rejects it in review, and the [threat model](../security/THREAT_MODEL.md#10-review-triggers) is reviewed in the same pull request.
