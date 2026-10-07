# Contributing to PayLink

Thank you for your interest. PayLink is maintained by one person, so the rules below exist to keep every change reviewable, reproducible and safe. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. Report security issues through [SECURITY.md](SECURITY.md), never in a public issue or pull request.

## 1. Ground rules

1. **v1 is frozen.** These paths must stay byte-identical: `contracts/PayLink.sol`, `web/**`, `scripts/compile.js`, `scripts/deploy.js`, `test/paylink.test.js`, `verify/**`, `package.json` and `package-lock.json` ([ADR 0010](docs/adr/0010-arc-stays-on-v1.md)). The only planned exception is `web/config.js` (the contract address) after the Arc mainnet deployment. CI enforces the freeze. `npm test` must stay green.
2. **v2 lives in its own folders:** `protocol/`, `packages/`, `apps/`, `e2e/`, `docs/`, `.github/`, plus root workspace files ([ADR 0011](docs/adr/0011-workspace-layout.md)).
3. **No secrets in the repository, chat logs or CI logs.** Private keys go only into a wallet, a GitHub environment secret or a Cloudflare secret ([deploy runbook](docs/runbooks/deploy.md)).
4. **Facts carry confidence tags.** Any external fact you add to the documentation (an address, a limit, a deadline, a fee) is tagged **UV**, **C**, **L** or **U**, as defined in [ARCHITECTURE.md](docs/ARCHITECTURE.md). Token and chain addresses come only from the registry (`packages/chains`) and must pass the EIP-55 test.
5. **Significant decisions get an ADR** ([docs/adr/README.md](docs/adr/README.md)), and every ADR triggers a threat-model review ([THREAT_MODEL §10](docs/security/THREAT_MODEL.md#10-review-triggers)).

## 2. Setting up

```bash
# Node 22.22.0 (.nvmrc) and pnpm 10.28.0
pnpm install --frozen-lockfile

# Contracts toolchain: Foundry 1.8.5, solc 0.8.30, Slither 0.11.6
foundryup --install 1.8.5        # on a developer machine
# In the Claude Code sandbox (no access to binaries.soliditylang.org):
scripts/bootstrap-sandbox.sh && source ~/.paylink-toolchain/env.sh
```

Details: [docs/runbooks/sandbox-bootstrap.md](docs/runbooks/sandbox-bootstrap.md), [ADR 0012](docs/adr/0012-toolchain-pinning-and-vendoring.md).

## 3. Workflow

- Work on a short-lived branch named `<type>/<short-topic>`, for example `feat/till-mode` or `fix/receipt-logindex`.
- Open a pull request against `main`. Fill in the template, including its security checklist.
- `main` requires every blocking status check (§5) to pass. There is no required review, because the project has one maintainer, but the owner reads every diff before merging.
- Merge with **merge commits**, so that the history of the build window stays visible to hackathon reviewers.
- Never force-push `main`. Never rewrite published tags.

## 4. Commit messages: Conventional Commits 1.0.0

```text
<type>(<scope>): <imperative summary, ≤ 72 characters>

<body: what and why, wrapped at 72 characters>

<footers: BREAKING CHANGE: …, Refs: #123, Co-Authored-By: …>
```

| Type | Use for |
|---|---|
| `feat` | a user-visible feature |
| `fix` | a bug fix |
| `perf` | a performance improvement |
| `refactor` | a code change with no behaviour change |
| `test` | tests only |
| `docs` | documentation only |
| `build` | the build system, dependencies, toolchain pins |
| `ci` | GitHub Actions workflows |
| `chore` | anything else that does not touch source or tests |

Security fixes use `fix(security): …`, and their details go into the commit message only after coordinated disclosure ([SECURITY.md](SECURITY.md)).

Scopes: `protocol`, `sdk`, `chains`, `design`, `i18n`, `web`, `relayer`, `indexer`, `api`, `e2e`, `docs`, `adr`, `spec`, `security`, `deps`, `ci`, `v1`.

Examples:

```text
feat(sdk): strict decoder for v2 invoice fragments
fix(relayer): reject authorisations whose bound nonce does not match
docs(spec): document error precedence for payWithAuthorization
build(deps): pin viem 2.57.3 in the catalog
```

A breaking change to the invoice format, the contract interface or the SDK API needs a `BREAKING CHANGE:` footer **and** an ADR. A format change also needs a new specification version ([spec §16](docs/spec/paylink-invoice-v2.md#16-versioning-and-extensibility)).

Commits made with an AI assistant keep its `Co-Authored-By` trailer ([AI_DISCLOSURE.md](AI_DISCLOSURE.md)).

## 5. Quality gates

### Blocking on every pull request

The workflows that enforce these gates on pull requests (`.github/workflows/`, PAYLINK-V2-SPEC §4.5) are planned for T0 and do not exist yet. Until they land, run every gate locally with the commands below; "in CI" names the `ci` Foundry profile and the planned workflow.

| Area | Gate |
|---|---|
| Contracts (`protocol/`) | `forge fmt --check`; `forge lint`; `forge build --sizes`; unit tests (every function, custom error and branch); fuzz (1,000 runs locally, **10,000 in CI**); invariants I1–I11 (256 runs × depth 128 in CI); coverage **≥ 95 % lines and ≥ 90 % branches** on `src/` (`pnpm --filter @paylink/protocol run coverage`, which passes on a clean checkout: the script, gas and release-graph suites need the optimized release build and skip themselves under `forge coverage`); `pnpm --filter @paylink/protocol run snapshot:check` (the unit and gas suites at ±3 %; a bare `forge snapshot --check` fails by design, see [protocol/README.md](protocol/README.md)); Slither 0.11.6 with no untriaged medium or higher finding (triage in `protocol/audit/triage.md`); golden-vector parity; the `Bytes.sol`-absent check (`ReleaseGraph.t.sol::test_BytesSolIsNotCompiledIn`); `EvmTarget.t.sol` (no post-paris opcodes) |
| TypeScript (`packages/`, `apps/`) | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`); ESLint with typescript-eslint `strictTypeChecked`, `no-floating-promises` and `no-misused-promises` as errors, and the DOM-sink bans; Vitest with coverage-v8 (**SDK ≥ 90 %, chains 100 %, relayer ≥ 85 %**); fast-check properties (URL codec, amounts at 6 and 18 decimals, error decoder); i18n completeness; `size-limit` (pay route ≤ 110 kB gzipped JavaScript) |
| End to end (`e2e/`) | Playwright 1.56.1 on Chromium 141 covering the flows in PAYLINK-V2-SPEC §4.2; **axe: 0 violations** on every route, light and dark; the production-CSP spec |
| Supply chain | Frozen lockfile; exact pins; `python3 scripts/toolchain/audit-workspace.py --prod --audit-level high`; gitleaks; dependency review |
| Documentation | `python3 docs/tools/check-docs.py --strict`: relative links and anchors, cited test names, cited repository paths and the threat model's *planned (Tn)* evidence markers, addresses against the [allowlist](docs/tools/address-allowlist.json) with EIP-55, the ADR index, and the JSON Schema with its example (needs the `jsonschema` package) |
| v1 | `npm test` (7 tests) and the frozen-path check |

### Nightly or before a submission (evidence, not blocking)

Echidna 2.2.7 and Medusa 1.3.1 (1 hour each, on `protocol/test/properties/PayLinkProperties.sol`: `pnpm --filter @paylink/protocol run fuzz:echidna` and `run fuzz:medusa`) and Halmos 0.3.3 (conservation and the state machine only, never a proof about signatures: `run symbolic`). The harnesses exist and their first runs are recorded in `protocol/audit/properties.md`; the nightly workflow that repeats them is *planned (T1)*, like the rest of this list: Aderyn 0.6.8, fork tests against the real tokens, the deployments check, Lighthouse CI, visual regression (light and dark × 375/768/1280 px × EN/FR/MG), Firefox and WebKit, CodeQL and OpenSSF Scorecard.

Run locally before pushing:

```bash
pnpm -r --filter '!@paylink/protocol' run lint
pnpm -r --filter '!@paylink/protocol' run typecheck
pnpm -r --filter '!@paylink/protocol' run test
(cd protocol && forge fmt --check && forge build --sizes && forge test)
python3 docs/tools/check-docs.py
npm test   # v1
```

Script names in the TypeScript packages follow the same convention as `protocol/package.json`. Check each package's `package.json` for the exact names.

## 6. Coding standards

- **Solidity:** solc 0.8.30, exact pragma; OpenZeppelin 5.3.0 modules only, with no hand-rolled cryptography; custom errors; NatSpec on every external function; checks-effects-interactions plus `nonReentrant`. Never add owner, pause, proxy or fee logic ([ADR 0004](docs/adr/0004-immutable-ownerless-feeless.md)).
- **TypeScript:** no `any`; no non-null assertions on external data; validate every input from URLs, RPCs, the relayer and IndexedDB, with zod where it crosses a trust boundary.
- **DOM:** build elements with the typed `h()` helper. `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and `new Function` are banned. No third-party scripts, CDNs or analytics ([ADR 0005](docs/adr/0005-dedicated-origin-and-rpid.md)).
- **Endpoints:** RPC, relayer and indexer URLs come only from the registry and the same-origin `/config.json`, never from URL parameters.
- **i18n:** whole sentences with named placeholders, in `packages/i18n` for EN, FR and MG. Malagasy strings are written or reviewed by the owner.
- **Accessibility:** WCAG 2.2 AA; keyboard-only flows; targets of at least 24 × 24 px; live regions for payment status; respect `prefers-reduced-motion`.
- **Design:** reuse the tokens in `packages/design` (the v1 "Precision Terminal" values). The laterite `--signal` is the only signal colour; never use brand colours for chains.

## 7. Dependencies

- Add dependencies with `pnpm add` (exact versions; `savePrefix: ''`), and use `catalog:` for versions shared between packages.
- A new build script needs an explicit decision in `pnpm-workspace.yaml` (`onlyBuiltDependencies` or `ignoredBuiltDependencies`, with a reason).
- Update [NOTICE.md](NOTICE.md) in the same pull request.
- For SDKs that run on the origin holding passkey keys (Mera, Base Account, viem), review the lockfile integrity diff on every bump, and say so in the pull request.

## 8. Documentation

- Changes to behaviour update the relevant document in the same pull request: the specification, the ARCHITECTURE document, the threat model or a runbook.
- Keep [CHANGELOG.md](CHANGELOG.md) under "Unreleased", in the Keep a Changelog format. Package-level changelogs are generated by Changesets once the packages exist.
- Use relative links. `python3 docs/tools/check-docs.py` checks that they resolve, that every cited test exists, and that every address is in [the allowlist](docs/tools/address-allowlist.json).
- A new address in a document needs an allowlist entry with its source and confidence tag. Never copy an address from anywhere but PAYLINK-V2-SPEC §3.4 or the registry.

## 9. Tags

| Tag | Meaning |
|---|---|
| `arc-microgrants-v1` | v1 as submitted to Arc Microgrants (`93ed4e3`) |
| `arc-microgrants-v1.1` | v1 with the Arc mainnet address |
| `contracts-v2.0.0` | the frozen PayLinkV2 release (go/no-go 2026-10-07 12:00 UTC) |
| `submission/colosseum-2026-10-12`, `submission/monad-2026-10-12` | the code as submitted |
| `submission/mezo-w1`, `submission/paypal-2026-11-11` | later submissions |
