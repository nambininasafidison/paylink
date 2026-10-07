# protocol/audit: evidence for PayLinkV2 v2.0.0

> **Self-review evidence by the developer and AI tools. Not a third-party audit.** PayLinkV2 is unaudited and is deployed to testnets only (PAYLINK-V2-SPEC §5).

Generated on 2026-10-07 from `main` at `93ed4e3` plus the uncommitted v2 tree, and re-run the same day after the re-audit fixes (finding A-04 and the checks-effects-interactions test gap) and after the test-quality review fixes (SR-18 to SR-21 in the self-review: exactness tested in both directions, `tx.origin`, the coverage gate on a clean checkout, and the Halmos, Echidna and Medusa harnesses; no change in `src/` either time), with the pinned toolchain (Foundry 1.8.5, solc 0.8.30, Slither 0.11.6). Re-run every gate on the `contracts-v2.0.0` tag and refresh these files before tagging; the checklist that consumes them is [docs/security/self-review.md](../../docs/security/self-review.md).

| File | What it holds | Status on this tree |
|---|---|---|
| [triage.md](triage.md) | Every Slither result (including suppressed ones), every `forge lint` suppression, and manual-review observations, each with a disposition | 0 untriaged; S-1 false positive, S-2 accepted, O-1 to O-3 informational |
| [slither.txt](slither.txt) | Raw Slither output: the gate run, the run with `--show-ignored-findings`, the human summary | 0 results (3 suppressed, all in triage.md); identical after the re-audit and test-quality fixes |
| [coverage.txt](coverage.txt) | `forge coverage` summary for `src/`, and the clean-checkout and stale-artifact checks of the gate itself | 100 % lines, statements, branches and functions; the gate passes without `out/` |
| [invariants.md](invariants.md) | I1–I11 mapped to the campaign, fuzz and unit tests; CI campaign result | 256 runs × 128 depth, 32,768 calls (15 selectors), 0 reverts, 0 violations |
| [properties.md](properties.md) | Halmos checks (conservation, state machine) and the Echidna/Medusa property contract for I1–I11: how to install and run them, the recorded runs, and the mutants each tool kills | Halmos 7 of 7; Echidna and Medusa 12 of 12 properties after 20 minutes each; the nightly hour-long runs are *planned (T1)* |
| [gas.md](gas.md) | Transaction gas from real anvil receipts, the Foundry baselines, provisional limits for `packages/chains` | Deploy 2.68M; `payWithAuthorization` 141.9k first payment |
| [deployment.md](deployment.md) | End-to-end run of `Predict.s.sol`, `Deploy.s.sol` and `record()` on anvil: factory present, absent, London | Same `initCodeHash` (`0x289dcd64…7ac5`) and masked hash everywhere; re-runs send nothing |
| [`../test/audit/`](../test/audit/) | Regression evidence from the 2026-10-07 audits: retries (A01), relayer simulation versus inclusion (A02, A03 payer dispatch), attack-surface probes, relayed time bounds and the log evidence behind revert attribution (A04), over-credit exactness (A05), concurrent permit griefing (A06), calldata and dispatch probes (A07) | 43 tests, all green; what each pins is in its NatSpec and in [mutation testing](#mutation-testing) below |
| [`../.gas-snapshot`](../.gas-snapshot) | `forge snapshot` of the unit and gas suites only; checked with `pnpm run snapshot:check` (`--match-path 'test/{unit,gas}/*.t.sol' --check --tolerance 3`) | 217 entries (the 19 new unit tests added; earlier entries moved by at most 72 gas, test-harness dispatch only) |
| [`../snapshots/PayLinkV2.json`](../snapshots/PayLinkV2.json) | Named per-entry-point gas figures (compared, not rewritten, under `FORGE_SNAPSHOT_CHECK=true`) | 13 figures, unchanged by the re-audit and test-quality fixes |

## Gate results (2026-10-07)

| Gate (spec §4.1) | Command | Result |
|---|---|---|
| Format | `forge fmt --check` | pass |
| Lint | `forge lint` | pass, no finding |
| Build | `forge build --sizes` | pass; PayLinkV2 runtime 12,045 B (margin 12,531 B), init code 12,979 B |
| Tests, local profile | `forge test` | **335 passed**, 0 failed, 0 skipped (32 suites) |
| Tests, CI profile | `FOUNDRY_PROFILE=ci forge test` | **335 passed** in 2 min 48 s (32 suites); fuzz 10,000 runs; invariants 256 × 128, 32,768 calls, 0 reverts |
| Coverage | `pnpm run coverage` (src/ only) | 100 % lines (98/98), statements (121/121), branches (26/26), functions (22/22); 293 passed, 30 skipped by design (script, gas and release-graph suites need the release build); exit 0 on a clean checkout |
| Mutation | 63 hand-written mutants of `src/PayLinkV2.sol` against the suite (below) | **63 killed, 0 survived**; the CI campaign alone kills M11, M13 and M50–M59 |
| Symbolic (nightly evidence) | `pnpm run symbolic` (Halmos 0.3.3) | 7 of 7 checks pass ([properties.md](properties.md)) |
| Property fuzzing (nightly evidence) | `pnpm run fuzz:echidna`, `pnpm run fuzz:medusa` | 12 of 12 properties hold on both after 20 minutes each ([properties.md](properties.md)) |
| Gas baselines | `pnpm run snapshot:check` (`FORGE_SNAPSHOT_CHECK=true forge snapshot --match-path 'test/{unit,gas}/*.t.sol' --check --tolerance 3`) | pass (199 entries; the bare `forge snapshot --check` exits 1 by design, [README](../README.md#the-gas-gate)) |
| Slither | `slither . --config-file slither.config.json` | 0 results; 3 suppressed results triaged |
| Golden vectors | `test/vectors/*.json` rewritten by every test run | byte-identical across runs (checked by hash before and after the gates, and against the reviewer's copy) |
| `Bytes.sol` absent | `test/toolchain/ReleaseGraph.t.sol` | pass: the release compiles exactly the 26 reviewed sources; the artifact read is this build's (stale `out/` refused); skipped under coverage |
| Paris-only bytecode | `test/toolchain/EvmTarget.t.sol`, `Surface.t.sol` | pass: no PUSH0, MCOPY, TLOAD/TSTORE, BLOBHASH, BLOBBASEFEE or CLZ |

## Test inventory

| Suite | Tests | Focus |
|---|---|---|
| `test/unit/` (12 files) | 205 | every function, every custom error, every event field, signatures (EOA, ERC-1271, hostile ERC-1271, high-s, compact), reentrancy through token hooks and payees (read-only re-entry sees the post-payment state on all four settlement paths), storage layout, donations, contract surface, falling balances reported as zero credit, credits one unit *over* the amount refused with the documented errors, the payer and the canceller taken from `msg.sender` never `tx.origin` (including lure contracts), error precedence for every pair of checks on every path |
| `test/fuzz/` (5 files) | 22 | amounts and the `payments` counter bound, time windows and caps, cancel deadlines, I7 domains across chain ids and deployments, I8 binding, error precedence for any subset of failing checks |
| `test/invariant/` | 12 invariants | I1–I11 plus model agreement; fee and over-credit tokens; seeded transaction origins |
| `test/gas/` | 13 | per-entry-point gas baselines |
| `test/vectors/` | 11 | golden vectors for the SDK (`eip712.json`, `nonce.json`, `cancel.json`) and every literal in the invoice spec's worked examples |
| `test/script/` | 27 | release lock, CREATE2 and CREATE paths, idempotence, one deployment per chain, code verification (foreign, tampered, copied, wrong-chain code), broadcast parsing, record format |
| `test/toolchain/` | 11 | solc pin, paris-only opcodes (with negative controls), release import graph |
| `test/audit/` | 43 | audit regressions: what the contract does not deduplicate and why retries are safe when clients follow spec §8.6 (A01); simulation does not bind inclusion, for payees and payers (A02); attack-surface probes with an independent EIP-712 engine, phantom permit and 3009, no-return tokens, counter saturation (A03); time bounds one second ahead pass simulation and revert on inclusion, the relay margin is exact at the second, and the settling logs that let the SDK recognise a superseding payment (A04); over-credit exactness (A05); concurrent permit griefing (A06); calldata and dispatch probes (A07) |
| `test/properties/` | 2 (+ 12 fuzz properties) | `PayLinkProperties.sol` for Echidna and Medusa (I1–I11, `SelfPayment`); its forge test keeps the harness live |
| `test/symbolic/` | 7 Halmos checks | conservation and exact credit on all four paths over arbitrary token behaviour; the `pay` and `cancel` state machines; cancelled links refuse every path |

## Mutation testing

Hand-written mutants of `src/PayLinkV2.sol`, one change each (dropped checks, off-by-one bounds, swapped check order, `unchecked` counters, wrong event fields, missing `nonReentrant`, weakened permit handling, and so on), each run against `forge test` without the script and gas suites. Definitions: [`mutation/mutants.py`](mutation/mutants.py); runner: [`mutation/run.py`](mutation/run.py) (`full` or `campaign` mode, copies `protocol/` to a work directory, never touches the tree); per-mutant results with the killing tests: [`mutation/results.json`](mutation/results.json).

| Run | Result |
|---|---|
| Before the 2026-10-07 audit fixes | 45 + 4 precedence mutants; **M27** (`InvalidSignature` before `Cancelled`), **M29** (checked subtraction in `_increase`) and **M44** (`unchecked` payments counter) survived the suite; **M11** (no conservation post-check) and **M13** (no forward-leg payee check) survived the invariant campaign alone; P1–P3 were killed only by the stochastic campaign |
| After the pre-freeze fixes | **49 of 49 killed.** M27, M28, M30 and P1–P4 by `test/unit/Precedence.t.sol` and `test/fuzz/Precedence.t.sol` deterministically; M29 by the `RecipientDebit` tests; M44 by `Amount.t.sol::test_PaymentsCounterNeverWraps`; and, at the CI profile, the campaign **alone** kills M11 (I1 and model agreement) and M13 |
| Re-audit (2026-10-07) | 50 reviewer mutants (R01–R50), none duplicating the catalogue: 44 killed, 6 survived. **R47** and **R48** (the link-state write deferred past the interaction on `payNative` and `payWithAuthorization`, so code running during the transfer reads the pre-payment state) survived because read-only re-entry was pinned on `pay` and `payWithPermit` only; with R49 and R50, the same mutation on those two paths, they are now **M46–M49**. **R14–R17** (the four exactness checks weakened from `!=` to `<`, accepting over-credit) are a separate re-audit finding, not addressed by this change and not in the catalogue yet |
| After the re-audit fixes | **53 of 53 killed.** M46 by `PayNative.t.sol::test_PayNative_ReadOnlyReentrySeesPostEffectsState` (a `PeekingPayee` reads `stateOf` from its `receive`), M47 by `Reentrancy.t.sol::test_ReadOnlyReentrySeesPostEffectsState_PayWithAuthorization`, M48 by `test_ReadOnlyReentrySeesPostEffectsState`, M49 by `PayWithPermit.t.sol::test_PayWithPermit_PermitRunsAfterEffects`; each of these four is killed by exactly that one test, as coverage cannot see an ordering of effects. The rest as before, and at the CI profile the campaign alone kills M11 and M13 |
| Test-quality review (2026-10-07) | Its R01–R04 and R20 (the first re-audit's R14–R17: each exactness check one-sided, and the receive and conservation checks together) and R05 (`cancel` accepting `tx.origin == payee`) survived the suite **and** the CI campaign: every mock only made balances come up short, and no test separated `msg.sender` from `tx.origin`. They are now **M50–M55**, with **M56–M59** (`tx.origin` standing in for the `cancelBySig` signature, and for the payer of `pay`, `payWithPermit` and `payNative`) |
| After (this tree) | **63 of 63 killed.** M50–M54 by the over-credit unit tests (`Pay.t.sol::test_RevertWhen_PayeeOverCredited`, `PayWithPermit.t.sol::test_RevertWhen_PayeeOverCredited`, the five `PayWithAuthorization.t.sol` over-credit tests), `A05_OverCreditExactness.t.sol` and the property-harness test; M55–M59 by the `tx.origin` unit tests of `Cancel.t.sol`, `Pay.t.sol`, `PayWithPermit.t.sol` and `PayNative.t.sol`; and at the CI profile **the campaign alone kills all ten** (and still M11 and M13). Halmos, Echidna and Medusa were also run against the mutants in their scope ([properties.md](properties.md#mutants-the-hand-written-catalogue-mutationmutantspy)) |

## Regenerate

```bash
source ~/.paylink-toolchain/env.sh && cd protocol
slither . --config-file slither.config.json                          # slither.txt, section 1
slither . --config-file slither.config.json --show-ignored-findings  # section 2
slither . --config-file slither.config.json --print human-summary    # section 3
forge coverage --report summary --report lcov --no-match-coverage '(test|script|lib|node_modules)/'   # coverage.txt
FOUNDRY_PROFILE=ci forge test --match-contract InvariantsTest        # invariants.md
pnpm run snapshot                                                    # .gas-snapshot and snapshots/
python3 audit/mutation/run.py full all --workers 4 --out audit/mutation/results-full.json   # about 40 min on 4 cores
python3 audit/mutation/run.py campaign M11,M13,M50,M51,M52,M53,M54,M55,M56,M57,M58,M59   # the CI campaign alone
pnpm run symbolic                                                    # properties.md (Halmos)
pnpm run fuzz:echidna; pnpm run fuzz:medusa                          # properties.md (1 hour each by default)
```

`audit/mutation/results.json` combines one `full` run of all 63 mutants and one `campaign` run of M11, M13 and M50–M59, both after the test-quality review fixes.
