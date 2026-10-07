# Security self-review checklist: PayLinkV2

> **This is a self-review by the developer and AI tools. It is not a third-party audit.** PayLinkV2 is unaudited and is deployed to testnets only. PayLink v1 on Arc mainnet handles small amounts only.

| | |
|---|---|
| **Scope** | `protocol/src/PayLinkV2.sol`, `protocol/src/interfaces/IPayLinkV2.sol`, `protocol/src/interfaces/IERC3009.sol`, and the client rules of the [invoice specification](../spec/paylink-invoice-v2.md) |
| **Baseline** | The working tree on 2026-10-05, read in full for this document, plus pre-freeze automated passes on 2026-10-06 and 2026-10-07 on a copy of the working tree (Slither 0.11.6, the full Forge suite, the import-closure and source scans; [§6](#6-findings-log), [§7](#7-sign-off)). The review is **re-run on the `contracts-v2.0.0` tag** after the 2026-10-07 freeze. Every "Met" below must be re-confirmed against that tag. |
| **Standards** | SWC Registry (SWC-100 to SWC-136; the registry is no longer maintained, **C**); Smart Contract Security Verification Standard v2 by Composable Security (SCSVS v2: chapters G, C and I, **C**: category list read from the upstream repository on 2026-10-05) |
| **Additional checklists** | Solcurity; Trail of Bits token-integration checklist; Claude Code `/security-review`; an independent review by a fresh agent with no shared context (PAYLINK-V2-SPEC §5) |
| **Related** | [THREAT_MODEL.md](THREAT_MODEL.md) · [invariants.md](invariants.md) · [incident-response.md](incident-response.md) · [ADR 0002](../adr/0002-one-paris-bytecode-oz-5-3-0.md) · [ADR 0004](../adr/0004-immutable-ownerless-feeless.md) |

Status values:

| Status | Meaning |
|---|---|
| **Met** | Satisfied, with evidence |
| **By design** | Satisfied structurally: the risky construct does not exist |
| **Deviation** | Not satisfied, deliberately, with the justification given |
| **Partial** | Partly satisfied; the gap is named |
| **N/A** | Does not apply to this system |
| **Verify** | Must be checked at the freeze tag |

SCSVS requirements are paraphrased and referenced by identifier. The upstream text is © Composable Security under CC BY-SA 4.0 ([NOTICE.md](../../NOTICE.md)).

## 1. Procedure

Run at the freeze (Oct 7, after 12:00 UTC), then before every redeploy. Each step records its output under `protocol/audit/`:

1. **Automated gates**, all blocking:

   ```bash
   cd protocol
   forge fmt --check && forge lint && forge build --sizes
   FOUNDRY_PROFILE=ci forge test                       # unit, fuzz 10k, invariants I1–I11 at 256 × 128
   pnpm run coverage                                   # ≥ 95 % lines, ≥ 90 % branches on src/ (clean checkout OK)
   pnpm run snapshot:check                             # unit and gas suites only, ±3 % (see below)
   slither . --config-file slither.config.json         # triage every medium-or-higher finding in audit/triage.md
   ```

   The gas gate is `pnpm run snapshot:check`, which is `FORGE_SNAPSHOT_CHECK=true forge snapshot --match-path 'test/{unit,gas}/*.t.sol' --check --tolerance 3`. A bare `forge snapshot --check --tolerance 3` fails on this tree by design: `.gas-snapshot` holds only the unit and gas suites, so every fuzz, invariant, vector, script, toolchain and audit test is reported missing. Without `FORGE_SNAPSHOT_CHECK=true`, `test/gas/Gas.t.sol` would also rewrite `snapshots/PayLinkV2.json` instead of comparing against it. This narrows the literal wording of PAYLINK-V2-SPEC §4.1, deliberately: fuzz and invariant gas varies with the random inputs and is not a regression signal ([protocol/README.md](../../protocol/README.md)).

   `pnpm run coverage` is `forge coverage --report summary --report lcov --no-match-coverage '(test|script|lib|node_modules)/'`. `forge coverage` builds without the optimizer and never writes `out/`, so the three suites that need the optimized release artifact skip themselves under it: `test/script/Scripts.t.sol`, `test/gas/Gas.t.sol` and `test/toolchain/ReleaseGraph.t.sol`. `forge test` runs them; `ReleaseGraph.t.sol` also refuses an `out/` artifact whose init code is not the code it was compiled with, so it can never check a stale build.

   Until `.github/workflows/` exists (planned, T0: `contracts.yml`), "CI" in these documents means this procedure run locally, and the `ci` Foundry profile.

2. **Nightly evidence:** Echidna 2.2.7 and Medusa 1.3.1 (1 hour each on the same property contract, `protocol/test/properties/PayLinkProperties.sol`) and Halmos 0.3.3 (`protocol/test/symbolic/PayLinkSymbolic.t.sol`: conservation and the state machine only, never presented as a proof about signatures). The harnesses exist and their first runs are recorded in `protocol/audit/properties.md`; the nightly workflow that repeats them, Aderyn 0.6.8 and the fork tests against the real tokens are *planned (T1)*.
3. **Checklists:** this document (SWC, SCSVS), Solcurity, and the Trail of Bits token-integration checklist for every registry token.
4. **Claude Code `/security-review`** on the full diff since the previous tag.
5. **Independent review** by a fresh agent with no shared context, given only the specification, the source and this checklist.
6. **Findings:** every finding becomes a GitHub issue (or a private advisory if it is exploitable) and a fix pull request, and is logged in [§6](#6-findings-log).

## 2. Compiler and dependencies

| Check | Status | Evidence |
|---|---|---|
| Pragma locked to `0.8.30` in every file | Met | `pragma solidity 0.8.30;` in all three source files |
| Known solc 0.8.30 bugs reviewed for applicability | Met | Seven listed, none applicable: legacy pipeline, `paris`, no transient storage, no storage arrays, no `layout at` ([ADR 0002](../adr/0002-one-paris-bytecode-oz-5-3-0.md)) |
| Latest compiler | Deviation | 0.8.37 (2026-09-10) is the latest, with no known bugs (**C**). Staying on 0.8.30 is justified in ADR 0002; upgrade planned for v2.1 |
| OpenZeppelin advisories | Met | GHSA-9rcw-c2f9-2j55 only. The full import closure of `src/PayLinkV2.sol` is 26 files, 3 in `src/` and 23 from OpenZeppelin 5.3.0, and `utils/Bytes.sol` is not among them (solc 0.8.30 standard-JSON source list, 2026-10-07, **C**). `ReleaseGraph.t.sol::test_BytesSolIsNotCompiledIn` asserts it on every `forge test`, from the release artifact's metadata source list (`out/PayLinkV2.sol/PayLinkV2.json`, `.metadata.sources`), after checking that the artifact's init code is the code the test was compiled with (a stale `out/` fails; the suite skips itself under `forge coverage`, which writes no `out/`); `contracts.yml` will run it in CI once the workflows land (planned, T0) |
| No post-paris opcodes | Met | `protocol/test/toolchain/EvmTarget.t.sol`; `Surface.t.sol::test_InitCodeHasNoPostParisOpcodes` |
| Runtime size within EIP-170 | Met | `Surface.t.sol::test_FitsEip170` |
| Library provenance | Met | OZ 5.3.0 from npm with sha512 in `pnpm-lock.yaml`; forge-std vendored and checked by manifest ([ADR 0012](../adr/0012-toolchain-pinning-and-vendoring.md)) |

## 3. SWC Registry mapping

| SWC | Title | Status | How it is addressed | Evidence |
|---|---|---|---|---|
| 100 | Function Default Visibility | By design | Solidity ≥ 0.5 requires explicit visibility | Compiler |
| 101 | Integer Overflow and Underflow | Met | Checked arithmetic, no `unchecked` blocks; `payments` (uint32) and `total` (uint128) revert at their bounds rather than wrap, which is documented | grep; [spec §14.14](../spec/paylink-invoice-v2.md#1414-arithmetic-bounds) |
| 102 | Outdated Compiler Version | Deviation | 0.8.30 rather than 0.8.37; no applicable known bug | [ADR 0002](../adr/0002-one-paris-bytecode-oz-5-3-0.md) |
| 103 | Floating Pragma | Met | Exact `0.8.30` | Source |
| 104 | Unchecked Call Return Value | Met | SafeERC20 for every token call; `Address.sendValue` checks and bubbles errors | `Pay.t.sol`, `PayNative.t.sol::test_RevertWhen_PayeeRejectsSilently` |
| 105 | Unprotected Ether Withdrawal | By design | No withdrawal function; native value is forwarded within `payNative` | `Surface.t.sol::test_NoAdminSurface` |
| 106 | Unprotected SELFDESTRUCT Instruction | By design | No `selfdestruct` | grep |
| 107 | Reentrancy | Met | `nonReentrant` on every state-changing entry point; checks-effects-interactions; read-only reentrancy sees post-effects state | `Reentrancy.t.sol` (token hooks, payee re-entry, read-only) |
| 108 | State Variable Default Visibility | Met | `_states` and `MAX_BATCH` are explicitly `private` | Source |
| 109 | Uninitialized Storage Pointer | By design | Not possible in ≥ 0.5; the storage reference in `cancel` is initialised from the mapping | Compiler |
| 110 | Assert Violation | By design | No `assert` | grep |
| 111 | Use of Deprecated Solidity Functions | Met | No `send`, `transfer`, `callcode`, `sha3` or `suicide` | grep; compiler warnings are errors |
| 112 | Delegatecall to Untrusted Callee | By design | No `delegatecall` | grep |
| 113 | DoS with Failed Call | Met | A failing payee or token reverts only that payment; other invoices are unaffected | `PayNative.t.sol::test_RevertWhen_PayeeRejectsWithError`; `RevertingPayee` mock |
| 114 | Transaction Order Dependence | Met | Permit front-running is harmless (`try/catch`); EIP-3009 is bound to the payment; bearer semantics documented | `test_PayWithPermit_FrontRunPermitIsHarmless`; `test_RelayerCannotRedirectAuthorization`; [spec §14.9](../spec/paylink-invoice-v2.md#149-front-running) |
| 115 | Authorization through tx.origin | Met | Not used: the payee is `msg.sender` (`cancel`) or a signer (`cancelBySig`, every payment), the payer is `msg.sender` (`pay`, `payWithPermit`, `payNative`) or `auth.payer`. A lured payee or payer (`TxOriginLure`) can neither have links cancelled nor a standing allowance spent; the invariant campaign seeds `tx.origin` independently of the caller; mutants M55–M59 (`tx.origin` accepted on each of these) are killed by the unit suites and by the campaign alone | `Cancel.t.sol::test_RevertWhen_CancelByStrangerWithPayeeAsTxOrigin`; `test_RevertWhen_LuredPayeeWouldCancel`; `test_RevertWhen_CancelBySigWithPayeeAsTxOriginButForeignSignature`; `Pay.t.sol::test_RevertWhen_LuredPayerAllowanceWouldBeSpent`; `test_Pay_PayerIsMsgSenderNotTxOrigin`; `test_PayWithPermit_PayerIsMsgSenderNotTxOrigin`; `test_PayNative_PayerIsMsgSenderNotTxOrigin`; `test_PayWithAuthorization_IgnoresTxOrigin`; invariant I9 |
| 116 | Block values as a proxy for time | Met | `block.timestamp` only for coarse validity windows and deadlines; inclusive bounds tested | `test_PayWithAuthorization_WindowBoundariesAreInclusive`; `test_CancelBySig_DeadlineIsInclusive` |
| 117 | Signature Malleability | Met | OZ ECDSA rejects high `s` and 64-byte compact forms; state is keyed by digest, never by signature | `test_RevertWhen_HighS`; `test_RevertWhen_CompactSignature`; `test_RevertWhen_CancelSigHighS` |
| 118 | Incorrect Constructor Name | By design | `constructor` keyword | Compiler |
| 119 | Shadowing State Variables | Met (pre-freeze) | No inheritance conflicts (`IPayLinkV2`, `EIP712`, `ReentrancyGuard`) | Slither `shadowing-*` detectors: no result on 2026-10-06; re-run at the tag |
| 120 | Weak Sources of Randomness from Chain Attributes | By design | No on-chain randomness; salts come from client CSPRNGs | Spec §3.1 |
| 121 | Missing Protection against Signature Replay Attacks | Met | EIP-712 domain (chain and contract); per-key `maxPayments` state; cancellation is one-way; the token tracks EIP-3009 nonces; distinct type hashes for invoices and cancellations | `test_RevertWhen_AuthorizationReplayed`; `test_RevertWhen_CancelSigReplayed`; `test_RevertWhen_InvoiceSignatureReusedAsCancel`; invariant I7 |
| 122 | Lack of Proper Signature Verification | Met | OZ `SignatureChecker`: ECDSA for code-less payees, ERC-1271 for contracts; verified on every payment | `Signatures.t.sol` (ERC-1271 wrong magic, short data, revert, gas burn, undeployed payee) |
| 123 | Requirement Violation | Met | Every revert path has a test, including the error's arguments | Unit suites; coverage gate |
| 124 | Write to Arbitrary Storage Location | By design | One mapping, keyed by digest; no arrays or assembly | Source |
| 125 | Incorrect Inheritance Order | Met (pre-freeze) | `PayLinkV2 -> IPayLinkV2, EIP712, ReentrancyGuard, [IERC5267]`; `IPayLinkV2` is a standalone interface, so no function or state overlaps | Slither inheritance printer, 2026-10-06; re-run at the tag |
| 126 | Insufficient Gas Griefing | Met | An ERC-1271 call that runs out of gas yields `InvalidSignature` and reverts the whole call; a permit that runs out of gas inside `try` then fails at `transferFrom`; a relayer can only hurt its own transaction | `test_RevertWhen_Erc1271BurnsAllGas` |
| 127 | Arbitrary Jump with Function Type Variable | By design | No function-type variables or assembly | Source |
| 128 | DoS With Block Gas Limit | Met | The only loop, `statesOf`, is capped at 256 keys | `test_RevertWhen_StatesOfBatchTooLarge` |
| 129 | Typographical Error | Met | Compound operators reviewed (`+=` on `total`); `payments = index + 1` | Invariants I3 and I11 |
| 130 | Right-To-Left-Override control character (U+202E) | Met (pre-freeze) | No bidirectional controls in `src/`; the only non-ASCII characters are `§` and `≤` in comments. Memos are sanitised on display ([spec §13.2](../spec/paylink-invoice-v2.md#132-payer-clients)) | Scan for U+202A–U+202E, U+2066–U+2069, U+200E, U+200F and U+061C on 2026-10-06; a CI grep repeats it |
| 131 | Presence of unused variables | Met (pre-freeze) | No unused state or locals | Slither `unused-*` and `write-after-write`: no result on 2026-10-06; `forge lint` on every build; re-run at the tag |
| 132 | Unexpected Ether balance | Met | No logic depends on the contract's balance; relative conservation; forced ether stays inert | `Donations.t.sol`; invariant I1 |
| 133 | Hash Collisions With Multiple Variable Length Arguments | By design | `abi.encode` everywhere; no `abi.encodePacked` | grep |
| 134 | Message call with hardcoded gas amount | By design | `Address.sendValue` forwards all gas; no `transfer` or `send` | Source |
| 135 | Code With No Effects | Met (pre-freeze) | Compiler warnings are errors (`deny = "warnings"`), and statements without effect raise a warning | Clean build and Slither on 2026-10-06; re-run at the tag |
| 136 | Unencrypted Private Data On-Chain | Partial | No personal data on-chain, and the memo stays off-chain. `memoHash` is unsalted and guessable ([THREAT_MODEL T-24](THREAT_MODEL.md#t-24)) | [Spec §15](../spec/paylink-invoice-v2.md#15-privacy-considerations) |

## 4. SCSVS v2 mapping

### G1. Architecture, design and threat modelling

| Req. | Summary (paraphrased) | Status | Notes and evidence |
|---|---|---|---|
| G1.1 | Threat modelling precedes design changes | Met | [THREAT_MODEL §10](THREAT_MODEL.md#10-review-triggers): every ADR triggers a review |
| G1.2 | Trust boundaries documented | Met | [ARCHITECTURE §5](../ARCHITECTURE.md#5-trust-boundaries); [THREAT_MODEL §4](THREAT_MODEL.md#4-trust-boundaries-and-assumptions) |
| G1.3 | Security requirements available to developers | Met | [Specification](../spec/paylink-invoice-v2.md), [CONTRIBUTING.md](../../CONTRIBUTING.md) |
| G1.4 | Events for state-changing operations | Met | `Paid` and `InvoiceCancelled`; every state write emits one of them |
| G1.5 | Emergency stop that does not block owners' assets | Deviation | No pause, because the contract is non-custodial ([ADR 0004](../adr/0004-immutable-ownerless-feeless.md)); client kill switch ([incident response §4](incident-response.md#4-kill-switches-and-levers)) |
| G1.6 | Minimal funds kept on the contract | Met | Relative conservation (I1); only inert donations can remain |
| G1.7 | Publicly callable fallback in the threat model | Met | `receive` and `fallback` revert `WrongPaymentPath` (I10) |
| G1.8 | Consistent business logic | Met | One artefact on every chain ([ADR 0002](../adr/0002-one-paris-bytecode-oz-5-3-0.md)) |
| G1.9 | Code-analysis tools in use | Met | Slither (`protocol/audit/slither.txt`), `forge lint` on every build, Halmos (`protocol/audit/properties.md`); Aderyn and CodeQL for TypeScript are *planned (T1)* |
| G1.10 | Latest Solidity release | Deviation | 0.8.30, not 0.8.37; see §2 |
| G1.11 | External implementations current, not superseded | Deviation | OZ 5.3.0, not 5.6.x: 5.4 and later emit MCOPY ([ADR 0002](../adr/0002-one-paris-bytecode-oz-5-3-0.md)) |
| G1.12 | `super` used in extending overrides | N/A | No overrides of library functions |
| G1.13 | Inheritance order specified | Met (pre-freeze) | See SWC-125 |
| G1.14 | Activity monitored through events | Met | Envio indexer, till mode, explorer |
| G1.15 | Whale transactions modelled | N/A | No prices, pools or shares; a large payment is just a payment, bounded by `uint128` |
| G1.16 | One leaked key does not compromise the project | Met | No privileged keys on-chain; the relayer key is bounded ([THREAT_MODEL T-03](THREAT_MODEL.md#t-03)) |
| G1.17 | MEV in the threat model | Met | T-01, T-10; bearer semantics ([spec §14.3](../spec/paylink-invoice-v2.md#143-bearer-semantics)) |
| G1.18 | L2-specific risks (sequencer downtime, forced inclusion) | Met | Base and Arbitrum sequencer downtime only delays payments; an invoice may expire meanwhile and is then re-issued; no liquidations or deadlines that cost users money |
| G1.19 | EIP-7702, ERC-4337 and ERC-1271 in authentication | Met | [Spec §6.3–§6.4](../spec/paylink-invoice-v2.md#63-contract-payees-erc-1271); T-12, T-23 |
| G1.20 | Transient-storage risks | N/A | `paris` has no transient storage; OZ 5.3.0 `ReentrancyGuard` uses regular storage |
| G1.21 | Flash loans and atomic composability | Met | No price- or balance-dependent logic; invariants hold atomically |

### G2. Policies and procedures

| Req. | Summary | Status | Notes |
|---|---|---|---|
| G2.1 | Constant security monitoring | Partial | `deployments-check` and fork tests nightly (*planned (T1)*: the workflows do not exist yet); `/status/`; no around-the-clock monitoring (single maintainer) |
| G2.2 | Policy for tracking bugs and updating libraries | Met | Dependabot weekly; `pnpm audit` gate; solc known-bugs check per release |
| G2.3 | Public security contact and procedure | Met | [SECURITY.md](../../SECURITY.md) |
| G2.4 | Process before adding components | Met | ADR plus threat-model review ([CONTRIBUTING.md](../../CONTRIBUTING.md)) |
| G2.5 | External threat modelling for major changes | Deviation | No budget; mitigated by the independent fresh-agent review and by publishing the model |
| G2.6 | External audit for component changes | Deviation | Unaudited; testnet-only deployment |
| G2.7 | Known hack procedure | Met | [incident-response.md](incident-response.md) |
| G2.8 | Named individuals in the procedure | Met | Owner as incident commander |
| G2.9 | Alerting other projects | Met | [Incident response §6](incident-response.md#6-communication) |
| G2.10 | Procedure for a leaked private key | Met | PB-3, PB-8 |
| G2.11 | Emergency contact with the last auditor | N/A | No auditor |
| G2.12 – G2.14 | TVL, multisig and governance monitoring | N/A | No TVL, multisig or governance |
| G2.15 | Frontline staff trained | N/A | Single maintainer; runbooks serve as the training material |
| G2.16 | Monitoring services with playbooks | Partial | Playbooks exist; no paid monitoring service |
| G2.17 | Dependency advisories monitored | Met | Dependabot; npm advisories; token issuers' announcements |
| G2.18 | Out-of-band incident channel | Partial | In-app banner and GitHub advisories; no signed status page |
| G2.19 | Privileged keys in hardware or threshold setups | N/A / Deviation | No privileged contract keys. The relayer and deployer keys are hot testnet keys with bounded value |
| G2.20 | Bug bounty commensurate with TVL | Partial | Hall of fame, no cash ([SECURITY.md](../../SECURITY.md)); no TVL |

### G3. Upgradeability

All of G3.1 to G3.17 are **N/A**: no proxy, no initializer and no upgrade path ([ADR 0004](../adr/0004-immutable-ownerless-feeless.md)). A redeploy is a new contract with a new EIP-712 domain, and the change of immutables is intentional (G3.17).

### G4. Business logic

| Req. | Summary | Status | Notes and evidence |
|---|---|---|---|
| G4.1 | Implementation matches the documentation | Met | Spec §7–§9 mirror the NatSpec, including error precedence; golden vectors |
| G4.2 | Flows cannot be skipped or reordered | Met | Each settlement is one call: checks, effects, then interactions |
| G4.3 | Business limits enforced | Met | `maxPayments`, the window, the amount rule, `BatchTooLarge` |
| G4.4 | No reliance on untrusted contracts' values | Partial | Delta checks read the token's `balanceOf`. A malicious token can only affect payments in itself; the client offers allowlisted tokens only |
| G4.5 | No reliance on `balance == 0` | Met | I1; `Donations.t.sol` |
| G4.6 | Block data not exploitable | Met | Coarse timestamp windows only |
| G4.7 | Front-running mitigated | Met | See SWC-114 |
| G4.8 | Pull over push | Deviation | Pushing to the payee is the product. A failing payee only blocks payments to itself (SWC-113) |
| G4.9 | Symmetric functions | N/A | No deposits or withdrawals |
| G4.10 | Calling once with XY equals X calls with Y | Met | Open-amount payments simply add up; no rounding |
| G4.11 | Global state updated when working on a copy | Met | `_record` loads `LinkState` into memory, then writes it back in full (`_states[key] = st`) |
| G4.12 | ETH and WETH handling | N/A | No WETH; a zero native value fails the amount rule |
| G4.13 | No off-by-one errors | Met | Inclusive bounds tested; `payments >= maxPayments` |
| G4.14 | Decoded string lengths bounded | Met | No strings in calldata; `payeeSig` lengths tested (`test_RevertWhen_SignatureTooLong`) |
| G4.15 | Signed actions include chain ID, nonce and expiry | Met, with a documented exception | Domain binds the chain. Replay is bounded by per-key state and token nonces. Cancellations have deadlines. **Invoices may have no expiry** (`validUntil = 0`, receive cards), which needs explicit confirmation in the UI |
| G4.16 | Invariants hold under flash loans and callbacks | Met | `nonReentrant`; `Reentrancy.t.sol` |
| G4.17 | Token callbacks cannot break invariants | Met | `HookReentrant` mock tests; read-only reentrancy test |
| G4.18 | Robust to ±15 s timestamps and repeated L2 timestamps | Met | Windows are business-level; equal timestamps are harmless |

### G5. Access control

| Req. | Summary | Status | Notes |
|---|---|---|---|
| G5.1 – G5.3 | Least privilege; creator rights as documented | Met | No roles; the deployer has no rights (`test_NoAdminSurface`) |
| G5.4 | Rules enforced on-chain, not only in the client | Met | Every rule is in the contract; client checks are for UX only |
| G5.5 | External calls only when necessary | Met | Token calls, ERC-1271 `staticcall`, `sendValue` |
| G5.6 | Simple modifiers | Met | Only `nonReentrant` |
| G5.7 | Access attributes kept in trusted state | Met | The payee's authority comes from its signature over the key |
| G5.8 | Fail securely | Met | Any failure reverts the whole call |
| G5.9 | Positive validation (allowlisting) | Partial | The contract is permissionless by design; token allowlisting is done by the client (spec §13.2) |
| G5.10 – G5.12 | Two-step admin transfer, role events, root role | N/A | No admin |
| G5.13 | Reject unintended `delegatecall` | N/A | No privileged functions. A `delegatecall` into PayLinkV2 code only affects the caller's own storage |
| G5.14 | Correct `msg.sender` with EIP-7702 and ERC-4337 | Met | Payer = `msg.sender` (smart accounts supported on the allowance path); payee through `SignatureChecker` |
| G5.15 | EIP-712 with a chain- and contract-bound domain | Met | Spec §4 |

### G6. Communications

| Req. | Summary | Status | Notes |
|---|---|---|---|
| G6.1 | Libraries identified | Met | [NOTICE.md](../../NOTICE.md); ADR 0002 |
| G6.2 | No `delegatecall` to untrusted targets | By design | None |
| G6.4 | No `extcodesize` as a contract check | Met, with a note | OZ `SignatureChecker` chooses ECDSA or ERC-1271 by `code.length`. This is a dispatch, not an authorisation gate: a code-less address can only pass with its own ECDSA key |
| G6.5 | Reentrancy mitigated | Met | SWC-107 |
| G6.6 | Low-level call results checked | Met | SWC-104 |
| G6.7 | No `tx.origin` | Met | Not used, and pinned by regression tests and mutants (see SWC-115) |
| G6.8 | No phantom functions | Met | `permit` on a token without permit (a phantom fallback) has no effect: the owner is `msg.sender`, and `transferFrom` still needs a real allowance from the caller |
| G6.9 | No ether accepted that cannot be withdrawn | Met | `receive` and `fallback` revert; forced ether stays inert (documented) |
| G6.10 | Read-only reentrancy | Met | `test_ReadOnlyReentrySeesPostEffectsState` |
| G6.11 | `try/catch` where failure must not revert; return bombs | Met | Permit in `try/catch`. SafeERC20 reads only 32 bytes on success. The OZ ERC-1271 path copies return data: a bomb costs only that payee's payers (`test_Erc1271ReturnBombOnlyCostsItsOwnPayers`) |
| G6.12 | ERC-2771 forwarders | N/A | Not used |
| G6.13 | Transient reentrancy locks | N/A | Storage-based guard |

### G7. Arithmetic

| Req. | Summary | Status | Notes |
|---|---|---|---|
| G7.2 | `unchecked` blocks safe | By design | None |
| G7.3 | Extreme values considered | Met | `msg.value > 2^128 − 1` handled; counter bounds revert; [spec §14.14](../spec/paylink-invoice-v2.md#1414-arithmetic-bounds) |
| G7.4 | Non-strict inequality for balance equality | Deviation | Exact equality is intentional for delta checks: fee-on-transfer must fail, and so must a token that moves more than asked (PayLink would keep a surplus, or the payee be over-credited). Both directions are tested (`Pay.t.sol::test_RevertWhen_PayeeOverCredited` and its siblings, `OverCreditToken` in the campaign, mutants M50–M54). Donations cannot affect the checks, because they compare deltas |
| G7.5 – G7.11, G7.13 | Precision, rounding, shares, fixed point | N/A | No division or conversion on-chain |
| G7.12 | Common precision across tokens | N/A on-chain | Decimals are a client concern ([THREAT_MODEL T-30](THREAT_MODEL.md#t-30)) |

### G8. Denial of service

| Req. | Summary | Status | Notes |
|---|---|---|---|
| G8.1, G8.7, G8.8, G8.13 | Bounded loops; no costly or untrusted calls in loops | Met | `statesOf` ≤ 256 keys, storage reads only |
| G8.3 | Absent participants cannot block flows | Met | No multi-party flows |
| G8.4 | Cost does not deter use | Met | Prototype measurements: about 110k gas (`pay`) and 160k (`payWithAuthorization`); re-measured at the freeze |
| G8.5 | Every `require` or `revert` has a passing variant | Met | Positive tests for every path |
| G8.6 | Fallback does not block functionality | Met | — |
| G8.9 | Pause can be resumed | N/A | No pause |
| G8.10 | Allow and deny lists do not interfere | N/A on-chain | — |
| G8.11 | No overflow-based DoS | Met, with a note | Per-key counter bounds are unreachable in practice and documented |
| G8.12 | Forced ETH tolerated | Met | I1 includes the native coin |
| G8.14 | Permit nonce front-running cannot grief | Met | T-10 |
| G8.15 | L2 sequencer downtime | Met | See G1.18 |

### G9. Blockchain data

| Req. | Summary | Status | Notes |
|---|---|---|---|
| G9.1, G9.2 | On-chain data is public; no confidential data | Met | Memos off-chain; [spec §15](../spec/paylink-invoice-v2.md#15-privacy-considerations) |
| G9.3 | No string literals as mapping keys | Met | `bytes32` keys |
| G9.4 – G9.7 | Randomness | N/A | None on-chain |
| G9.8 | Sensitive off-chain data committed as hash or ciphertext | Partial | `memoHash` is an unsalted hash (T-24) |

### G10. Gas

| Req. | Summary | Status | Notes |
|---|---|---|---|
| G10.1 | Gas usage anticipated and limited | Met | `forge snapshot` gate; clamped limits per chain ([ARCHITECTURE §10](../ARCHITECTURE.md#10-chain-specific-engineering)) |
| G10.2 | No hard-coded gas | By design | — |
| G10.3 | No return-bomb inflation | Met, with a note | See G6.11; `Address.sendValue` copies a failing payee's revert data, which only affects payments to that payee |
| G10.4 | No checks that always pass | Verify | Review at the tag |
| G10.5 | The 63/64 rule | Met | Out-of-gas inside the permit `try` or the ERC-1271 call leads to a full revert; only the submitter loses gas |
| G10.6 | L2 data-availability costs | Met | Calldata of a few hundred bytes per payment |
| G10.7 | Opcode cost changes across forks | Met | Monad cold-access prices (**L**) are covered by the per-chain gas table validated on testnet |

### G11. Code clarity

| Req. | Summary | Status | Notes |
|---|---|---|---|
| G11.1, G11.5 | Modular, reuses tested code | Met | OZ modules; private helpers per concern |
| G11.2 | Contract purpose described at the top | Met | `@title` and `@notice` |
| G11.3 | Ready-made code marked | Met | OZ imports; NOTICE.md |
| G11.4 | Inheritance and shadowing considered | Met (pre-freeze) | SWC-119, SWC-125 |
| G11.6, G11.7 | Consistent naming; no near-duplicate names | Verify | Review at the tag |
| G11.8 | Declared returns are returned | Met | Named returns assigned on every path; warnings are errors |
| G11.9 | No unused code | Met (pre-freeze) | SWC-131 |
| G11.10 | Custom errors instead of `require` strings | Met | 14 custom errors |
| G11.11 | `assert` only for internal errors | By design | No `assert` |
| G11.12 | Assembly only if necessary | By design | None in `src/` |
| G11.13 | Only intended functions payable | Met | `payNative`; `receive` and `fallback` are payable only so that they can revert with `WrongPaymentPath` |
| G11.14 | Locked, mature pragma | Met (locked); see G1.10 | — |
| G11.15 | SPDX identifiers | Met | MIT in every file |
| G11.16 | NatSpec on external functions | Verify | solhint NatSpec check (nightly) at 100 % |
| G11.17 | Named constants | Met | `MAX_BATCH`, type hashes |

### G12. Test coverage

| Req. | Summary | Status | Notes |
|---|---|---|---|
| G12.1 | Abuser stories covered by tests | Met | [THREAT_MODEL §7](THREAT_MODEL.md#7-abuser-stories-and-their-tests) |
| G12.2 | Sensitive functions tested | Met | Every function and every custom error |
| G12.3 | Static and dynamic analysis | Met | Static: Slither (`protocol/audit/slither.txt`), `forge lint`. Dynamic: Foundry fuzz (10,000 runs in CI) and the I1–I11 campaign; Echidna 2.2.7 and Medusa 1.3.1 on `protocol/test/properties/PayLinkProperties.sol`, first runs recorded in `protocol/audit/properties.md`; 63 hand-written mutants, all killed. Aderyn and the nightly hour-long fuzzing runs are *planned (T1)* |
| G12.4, G12.5, G12.10 | Formal verification, documented | Partial | Halmos 0.3.3 (`protocol/test/symbolic/PayLinkSymbolic.t.sol`, run recorded in `protocol/audit/properties.md`): bounded symbolic checks that every successful payment, on all four paths and for any token behaviour, leaves PayLink's balance unchanged and credits the payee exactly `amount`, and that `pay` and `cancel` move a link's state exactly as documented from any stored state. Not a full formal verification, and never claimed as a proof about signatures: the payee signature and the token's EIP-3009 signature are stubbed |
| G12.7 | Coverage reported; every external function exercised | Met | Gate at ≥ 95 % lines and ≥ 90 % branches |
| G12.8 | Invariants under stateful fuzzing | Met | I1–I11 handler suite with a ghost ledger, 3 actors, five tokens (standard, permit-only, two fee models, over-credit) and native coin, seeded transaction origins, a donor and a model that predicts every outcome ([invariants.md](invariants.md)); the same invariants as Echidna and Medusa properties (`protocol/audit/properties.md`) |
| G12.9 | Fork tests against real deployments | Partial | `fork-nightly.yml` (GitHub runners have egress) is *planned (T1)* and does not exist yet; until then `Mock3009` reproduces FiatToken v2.2's observable EIP-3009 and EIP-2612 behaviour, which is not a substitute |

### C. Components

**C1 Token** to **C9**: N/A. PayLinkV2 implements no token, governance, oracle, vault, bridge, NFT, staking, pool or hook.

### I. Integrations (the tokens PayLinkV2 calls)

| Req. | Summary | Status | Notes |
|---|---|---|---|
| I1.1 – I1.4 | Integrated contracts' team, audit, verification, SCSVS | Partial | Allowlisted tokens come from identified issuers (Circle USDC, AUSD, MUSD). Their audits are the issuers'. Explorer verification is checked when a token enters the registry |
| I1.5 | Addresses correct and documented | Met | EIP-55-tested registry; PAYLINK-V2-SPEC §3.4 confidence tags; the `…dCF7c` typo rejected |
| I1.6, I1.7, I1.15 | Upgradeability of integrated contracts | Partial, accepted | Issuer-controlled token upgrades are accepted issuer trust. `fork-nightly.yml` is to detect changes to the domain, type hash or decimals (*planned (T1)*) |
| I1.9 | Returned structures handled | Met | SafeERC20 handles optional `bool` returns |
| I1.10, I1.16 | Monitoring and interface assertion | Partial | `fork-nightly.yml` checks, *planned (T1)*: the workflow does not exist yet |
| I1.12 | Called address has code | Met | SafeERC20 checks for code when nothing is returned (`test_RevertWhen_TokenHasNoCode`) |
| I1.14 | EIP-7702 and ERC-4337 `msg.sender` | Met | G5.14 |
| I1.17 | Return bombs and arbitrary revert data | Met, with a note | G6.11 |
| I1.8, I1.11, I1.13 | Minimum rights, change thresholds, ERC-165 | N/A | — |
| I2.1, I2.6, I2.7 | Standard compliance, decimals, supply | Met (supply N/A) | Registry plus fork checks |
| I2.2, I2.3 | Rules for adding tokens; allowlist | Met | Adding a token needs a registry pull request with fork-test evidence and a decimals and domain check; the client enforces the allowlist |
| I2.4, I2.15 | Fee-on-transfer, rebasing, blocklists | Met | Delta checks; rebasing unsupported; blocklists revert without loss |
| I2.5, I2.9 | Token external calls and callbacks | Met | `Reentrancy.t.sol` |
| I2.8 | No entity can freeze users' tokens | Deviation, accepted | USDC and similar issuers can freeze holders. PayLinkV2 holds nothing, so nothing is frozen inside PayLink |
| I2.10 – I2.12, I2.14 | Balance deltas; false-returning tokens; revert on failure; SafeERC20 | Met | — |
| I2.13 | Double-entry tokens | N/A | No stored balances |
| I2.16, I2.17 | Low decimals; zero-value transfers | Met | No on-chain conversion; amount is always > 0 |
| I2.18 | Issuer blocklist monitoring | N/A | No protocol-held funds |
| I2.19 | Permit in `try/catch` | Met | — |
| I3 (all) | Oracles | N/A | No prices, rates or oracle reads on-chain. The MGA and EUR figures in the UI are display-only estimates and never enter an amount ([ARCHITECTURE §7.2](../ARCHITECTURE.md#72-what-is-stored-where)) |
| I4 (all) | Cross-chain messaging | N/A | No bridges or messages. Cross-chain replay of PayLink's own signatures is prevented by domain separation (I7) |

## 5. Client-side checklist (SDK, web, relayer)

| Check | Status | Evidence |
|---|---|---|
| Strict decoder per [spec §10.5](../spec/paylink-invoice-v2.md#105-strict-decoding), length checked first | Verify | SDK fast-check suite |
| `verifyingContract` only from the registry; `revoked` deployments refused | Verify | e2e foreign-contract and revoked-deployment specs |
| Signature dispatch identical to the contract (code-less: ECDSA; with code: ERC-1271) | Verify | SDK verifier tests against the golden vectors |
| Exact-amount allowances only | Verify | Unit test of the PaymentRouter |
| Memo sanitisation (bidirectional and control characters) and untrusted label | Verify | Unit and e2e tests |
| No DOM sinks; CSP; Trusted Types at T1; frame lock | Verify | ESLint gate; production-CSP e2e |
| The relayer accepts only two selectors, `value = 0`, a recomputed nonce and a successful simulation | Verify | Relayer unit tests |
| Clamped gas limits per function and chain | Verify | `@paylink/chains` tests |
| Receipt verifier checks status, contract, topic, payee, token, amount and key on RPC, and displays what it proved, never a bare "valid" ([spec §12](../spec/paylink-invoice-v2.md#12-receipt-verification)) | Verify | SDK receipt-verifier tests ([THREAT_MODEL T-43](THREAT_MODEL.md#t-43)) |
| The till signals only verified `Paid` events, only for the armed key and amount, and shows the amount for receive cards ([spec §13.4](../spec/paylink-invoice-v2.md#134-payment-arrival-displays)) | Verify | e2e till specs ([THREAT_MODEL T-44](THREAT_MODEL.md#t-44)) |

## 6. Findings log

Filled in during the review at the tag. Severity follows CVSS v3.1 or v4.0, as SCSVS recommends.

| ID | Source | Title | Severity | Status | Issue or PR |
|---|---|---|---|---|---|
| SR-01 | Slither 0.11.6 `reentrancy-balance` (reported impact High, confidence Medium), pre-freeze pass 2026-10-06 | `_receiveAndForward` reads PayLink's token balance, calls `receiveWithAuthorization`, then compares against the earlier reading | Not exploitable (triage below) | **Triaged, suppressed with justification.** The source carries a `slither-disable-next-line reentrancy-balance` with a comment that points to triage entry S-1 in `protocol/audit/triage.md`. Slither reports 0 results on the 2026-10-07 working tree. **Verify at the tag** that `triage.md` S-1 exists and matches the triage below | — |
| SR-02 | Slither 0.11.6 `timestamp` (Low), 2 results | `block.timestamp` compared with `validAfter`, `validUntil` and the `cancelBySig` deadline | Informational | Accepted by design (SWC-116, [THREAT_MODEL T-34](THREAT_MODEL.md#t-34)); suppressed in the source with a pointer to triage entry S-2. **Verify at the tag** that S-2 exists | — |
| SR-03 | Pre-freeze audit 2026-10-07, A-01 | A retried relayed payment settled twice on links with `maxPayments ≠ 1`: spec §8.2 asked for a fresh `payerSalt` per attempt and the router offered permit and approve-and-pay after a slow relay, while the first authorisation stayed valid until `validBefore` | Medium | **Fixed** (no contract change; NatSpec corrected): spec §8.2 and new §8.6; `IPayLinkV2` NatSpec; SDK `attempts.ts` (persisted outstanding authorisation, assessment, resubmission, `cancelAuthorization`), `authorizePayment` requires the assessment, the router resubmits only. Evidence: `A01_RetryDoublePay.t.sol::test_Fix_ResubmitSameAuthorizationIsIdempotent`, `test_Fix_CancelAuthorizationBeforeFallback`, `test_Fix_ExpiredAuthorizationNeverLands`; `packages/sdk/test/attempts.test.ts`; the anvil suite ("relayer slow, then lands"; "cancel, then permit"); [T-45](THREAT_MODEL.md#t-45) | — |
| SR-04 | Pre-freeze audit 2026-10-07, A-02 | Relayed calls could pass `eth_call` and revert on inclusion at the relayer's expense (flaky or toggling ERC-1271 payee; an EOA payee's `cancel` under queued relays); T-13 understated it | Medium | **Fixed** in the relayer policy (contract by design): `RelayAdmissionLedger` (in-flight bounds per key, payee, payer and token; day-long bans; requester strikes; payee-code allowlist); spec §13.3; [T-03](THREAT_MODEL.md#t-03), [T-13](THREAT_MODEL.md#t-13) corrected; ADR 0007 amended. Evidence: `A02_RelayerGriefing.t.sol`; `packages/sdk/test/relay-admission.test.ts`; the anvil suite | — |
| SR-05 | Pre-freeze audit 2026-10-07, A-03 | `checkRelayPayRequest` verified the payer with local ECDSA, while FiatToken dispatches to ERC-1271 for payers with code (EIP-7702 included); the router classified delegated EOAs as `eoa` | Low | **Fixed:** the payer is verified with the token's dispatch and its code reported; payers with code are not relayed and are routed as `smart-account` (`payerAccountKind`); spec §8.3. Evidence: `packages/sdk/test/relayer.test.ts`, `packages/sdk/test/payments.test.ts`, `A02_RelayerGriefing.t.sol::test_SimulationDoesNotBind_Delegated7702PayerRevertsOnInclusion`; [T-46](THREAT_MODEL.md#t-46) | — |
| SR-06 | Pre-freeze audit 2026-10-07 (mutation testing) | The invariant campaign could not catch an EIP-3009 conservation or forward-leg bug alone: its only fee token stopped every attempt at the receive check (mutants M11, M13 survived the campaign) | Medium (test gap) | **Fixed:** a second fee token exempting PayLink, with `reconfigureFee` (deduct from the amount, or charge the sender) and a seeded donation; the model predicts both outcomes from the stray balance. M11 and M13 are now killed by the CI campaign alone ([invariants.md](invariants.md), `protocol/audit/invariants.md`) | — |
| SR-07 | Pre-freeze audit 2026-10-07 (mutation testing) | The documented check order was not pinned: swapping `Cancelled` and `InvalidSignature` (M27) survived the suite | Low (test gap) | **Fixed:** `Precedence.t.sol` (every pair of checks on all four paths, plus the cancel paths) and `testFuzz_FirstFailingCheckIsReported` (any subset) | — |
| SR-08 | Pre-freeze audit 2026-10-07 (mutation testing) | The checked `payments` counter of unlimited links was untested (M44, `unchecked` increment, survived) | Low (test gap) | **Fixed:** `Amount.t.sol::test_PaymentsCounterNeverWraps` on all four paths | — |
| SR-09 | Pre-freeze audit 2026-10-07 (mutation testing) | `_increase` returning 0 for a falling balance was untested (M29, checked subtraction, survived) | Low (test gap) | **Fixed:** `RecipientDebit` mock; `PayeeShortPaid(amount, 0)` on `pay`, `payWithPermit` and the EIP-3009 forward leg, `ReceivedMismatch(amount, 0)` on the receive leg | — |
| SR-10 | Pre-freeze audit 2026-10-07 | The gas gate was documented as a bare `forge snapshot --check --tolerance 3`, which fails on this tree | Medium (process) | **Fixed:** every document now names `pnpm --filter @paylink/protocol run snapshot:check`; the narrowing of PAYLINK-V2-SPEC §4.1 is explained in `protocol/README.md` | — |
| SR-11 | Pre-freeze audit 2026-10-07 | Packages accepted Node ≥ 22.12 but their scripts run TypeScript directly, which needs Node ≥ 22.18 | Low | **Fixed:** `engines.node`, `PAYLINK_NODE_MIN_VERSION` and the bootstrap check raised to 22.18.0; ADR 0011 §6 | — |
| SR-12 | Pre-freeze audit 2026-10-07 | Documents claimed CI enforcement that does not exist yet, and named a `Bytes.sol` check on `out/build-info` that nobody could find | Low (documentation) | **Fixed:** claims name `ReleaseGraph.t.sol::test_BytesSolIsNotCompiledIn` (artifact metadata source list) and mark CI as planned for T0 | — |
| SR-13 | Pre-freeze audit 2026-10-07 | The threat model cited e2e, relayer and CI evidence that is not built as if it existed | Low (documentation) | **Fixed:** *planned (Tn)* markers on every such item, provisional residuals; `check-docs.py` now checks cited paths and markers | — |
| SR-14 | Pre-freeze audit 2026-10-07 | The ESLint DOM-sink ban missed `Object.assign(el, { innerHTML })`, `setHTMLUnsafe`, `srcdoc` and computed access | Low | **Fixed:** selectors for computed members, object-literal keys, `Reflect.set`/`defineProperty`, `setAttribute("srcdoc")` and `setAttribute("on…")` and every HTML-parsing method; `packages/eslint-config/test/dom-sinks.test.js` | — |
| SR-15 | Re-audit 2026-10-07, A-04 | The relayer admitted time bounds one second ahead (the payer's `validBefore`, an invoice's last second, a cancellation with `deadline = now`): they pass every check and `eth_call` and revert on inclusion with no attacker transaction (224k gas per pay relay on Monad). Every post-simulation revert then banned the key, the payee and the payer, so a sybil payer holding one base unit could ban an honest merchant's payee for a day, and the payer's own spec §8.6 resubmission banned honest parties | Medium | **Fixed** in the relayer policy (contract by design): per-chain relay margin `relay.minRemainingSeconds` (120 s) in `@paylink/chains`, applied by `checkRelayPayRequest`, `checkRelayCancelRequest`, `RelayAdmissionLedger.admit` and `assertRelayWindow` before broadcast; `attributeRelayRevert` attributes reverts from chain evidence and `REVERT_PENALTIES` bans only the party named (a superseding settlement bans nobody); requesters per IPv4 address or IPv6 /64 (`requesterFromIp`) with a per-requester rate limit; spec §13.3; [T-03](THREAT_MODEL.md#t-03), [T-13](THREAT_MODEL.md#t-13) corrected; ADR 0007 amended. Evidence: `A04_TimeBoundaryBan.t.sol`; `packages/sdk/test/audit/A04-time-boundary-ban.test.ts`; `packages/sdk/test/relay-attribution.test.ts`; `packages/sdk/test/relay-admission.test.ts`; `packages/sdk/test/requester.test.ts`; the anvil suite | — |
| SR-16 | Re-audit 2026-10-07 (mutation testing) | Checks-effects-interactions was pinned on `pay` and `payWithPermit` only: deferring the link-state write past the interaction on `payNative` (the payee's `receive` runs mid-call) or `payWithAuthorization` survived the suite (re-audit mutants R47, R48) | Medium (test gap) | **Fixed:** `PayNative.t.sol::test_PayNative_ReadOnlyReentrySeesPostEffectsState` (`PeekingPayee` mock) and `Reentrancy.t.sol::test_ReadOnlyReentrySeesPostEffectsState_PayWithAuthorization`; the four deferred-write mutants are M46–M49 in `protocol/audit/mutation/mutants.py`, each killed by its path's test | — |
| SR-17 | Re-audit 2026-10-07 | ADR 0003 still said `payerSalt` was drawn for every attempt, contradicting the revised retry rule (spec §8.2, §8.6) and reintroducing the [T-45](THREAT_MODEL.md#t-45) double charge for anyone following the ADR | Medium (documentation) | **Fixed:** ADR 0003 amended with a dated note in the decision outcome, consequences and confirmation; `check-docs.py` check 8 (`stale`) now fails on the superseded retry and ban rules wherever they reappear as normative text | — |
| SR-18 | Test-quality review 2026-10-07 (mutation testing; its R01–R04 and R20, the first re-audit's R14–R17) | I1 and I6 are equalities, but every mock only made balances come up short: each exactness check weakened from `!=` to `<` (PayLink keeping a surplus, the payee over-credited) passed the whole suite and the CI campaign | Medium (test gap) | **Fixed:** `OverCreditToken` mock (one leg moves more than asked); unit tests pinning `PayeeShortPaid(amount, amount + 1)` on `pay`, `payWithPermit` and the EIP-3009 forward leg, `ReceivedMismatch(amount, amount + 1)` on the receive leg and `ReceivedMismatch(before, before + 1)` from the post-check; the handler's `reconfigureOverCredit`; mutants M50–M54, each killed by the unit suites and by the campaign alone; Halmos conservation checks over arbitrary token behaviour | — |
| SR-19 | Test-quality review 2026-10-07 (its R05) | No test separated `msg.sender` from `tx.origin`: `cancel` accepting `tx.origin == payee` (SWC-115) passed every gate; SWC-115 cited only a grep | Medium (test gap) | **Fixed:** unit tests with `vm.prank(sender, origin)` on `cancel`, `cancelBySig` and the payer of every path; `TxOriginLure` (a lured payee cannot have links cancelled, a lured payer cannot have a standing allowance spent); the campaign seeds `tx.origin`; mutants M55–M59 killed by the unit suites and by the campaign alone; SWC-115 now cites them | — |
| SR-20 | Test-quality review 2026-10-07 (two findings) | The documented coverage gate failed on a clean checkout: `forge coverage` never writes `out/`, and `ReleaseGraph.t.sol` read `out/PayLinkV2.sol/PayLinkV2.json`; with a stale `out/` the `Bytes.sol` and import-graph checks passed falsely under coverage | Medium (process) | **Fixed:** `ReleaseGraph.t.sol` skips itself under `forge coverage`, like the script and gas suites, and refuses an artifact whose init code differs from the PayLinkV2 it was compiled with. Verified on a copy without `out/` (exit 0, 100 % of `src/`), and with the reviewer's stale-artifact scenario (`forge test` fails on the unreviewed import; coverage skips instead of passing) | — |
| SR-21 | Test-quality review 2026-10-07 | G12.3 was "Met" citing Echidna and Medusa, G12.4 and the threat model's residual-risk treatment cited Halmos and nightly evidence, and none of it existed | Medium (documentation) | **Fixed by delivering it:** `protocol/test/symbolic/PayLinkSymbolic.t.sol` (7 Halmos checks) and `protocol/test/properties/` (one Echidna/Medusa property contract for I1–I11, configs, and a forge test that keeps it live), with their first runs and mutant runs recorded in `protocol/audit/properties.md`; tool pins in `scripts/toolchain/pins.env`. The nightly workflow stays *planned (T1)*, and the same review of this table corrected G1.9, G12.9, I1.10 and I1.16, which cited Aderyn, CodeQL or `fork-nightly.yml` as if they ran | — |

**SR-01 triage.** The before-and-after reading is the intended exact-delta measurement ([spec §7.5](../spec/paylink-invoice-v2.md#75-exactness-and-conservation)), so a "stale" balance cannot mislead it:

1. Every entry point is `nonReentrant`, so the token cannot re-enter PayLink to move its balance. PayLink grants no allowance, so nothing else can move tokens out of it during the call either.
2. The balance can therefore only *increase* during the call, through a third-party transfer to PayLink. If the token pulls the full `amount` and someone also transfers `X` to PayLink, then `received = amount + X` and the call reverts with `ReceivedMismatch`: it fails safe.
3. If a non-standard token pulls only `amount − X` from the payer while a hook transfers `X` to PayLink, the checks pass, the payee still receives exactly `amount` (payee-delta check), and PayLink's final balance equals its initial balance (conservation check), so pre-existing donations are never spent. Only whoever chose to send `X` paid it. Allowlisted tokens (Circle USDC, AUSD) have no transfer hooks.

Evidence: `Reentrancy.t.sol::test_RevertWhen_TokenHookReentersDuringPayWithAuthorization`, `PayWithAuthorization.t.sol::test_RevertWhen_TokenTakesFeeOnForward`, `Donations.t.sol::test_DonationCannotFundAPayment`, invariant I1 with the `Donor` handler.

## 7. Sign-off

| Date | Commit or tag | Reviewer | Tool versions | Result |
|---|---|---|---|---|
| 2026-10-05 | working tree (pre-freeze) | Claude Code, for the owner | Foundry 1.8.5, solc 0.8.30, Slither 0.11.6 | Checklist drafted; "Verify" items open |
| 2026-10-06 | working tree (pre-freeze) | Claude Code, for the owner | Slither 0.11.6 (102 detectors, `src/` only), source scans | SWC-119, 125, 130, 131, 135 met pre-freeze; SR-01 open for triage, SR-02 accepted; the remaining "Verify" items stay open for the tag |
| 2026-10-07 | working tree (pre-freeze), copied to a scratch directory so as not to disturb the contract workstream | Claude Code (documentation workstream), for the owner | Foundry 1.8.5, solc 0.8.30, Slither 0.11.6 | `forge test` (local profile): 236 tests in 20 suites passed, 0 failed, including invariants I1–I11 and model agreement at 64 runs × depth 128 (8,192 calls, 0 reverts). Slither: 0 results (102 detectors). Import closure: 26 files, no `utils/Bytes.sol`. `SpecExamples.t.sol` green, so the specification's vectors match the contract. SR-01 and SR-02 suppressed in the source with triage pointers. Not a substitute for the run at the tag: the CI profile (fuzz 10k, invariants 256 × 128), coverage and the gas snapshot are recorded there |
| 2026-10-07 | working tree (pre-freeze), after the audit fixes SR-03 to SR-14 | Claude Code, for the owner | Foundry 1.8.5, solc 0.8.30, Slither 0.11.6, Node 22.22.0, pnpm 10.28.0 | `FOUNDRY_PROFILE=ci forge test`: 292 tests in 27 suites passed (fuzz 10,000 runs; invariants 256 × 128, 32,768 calls, 0 reverts, 0 violations). Coverage of `src/`: 100 % lines, statements, branches and functions. Mutation: 49 of 49 hand-written mutants killed (`protocol/audit/mutation/`). Slither: 0 results, 3 suppressed and triaged (unchanged). `pnpm run snapshot:check` passes. SDK 483 tests (99.9 % statements, 97 % branches), chains 184 tests (100 %), ESLint config 25 tests. Release `initCodeHash` `0x289dcd64…7ac5` (NatSpec change only; masked runtime hash unchanged). Not a substitute for the run at the tag |
| 2026-10-07 | working tree (pre-freeze), after the re-audit fixes SR-15 to SR-17 (no change in `src/`) | Claude Code, for the owner | Foundry 1.8.5, solc 0.8.30, Slither 0.11.6, Node 22.22.0, pnpm 10.28.0 | `FOUNDRY_PROFILE=ci forge test`: 302 tests in 28 suites passed (invariants 256 × 128, 32,768 calls, 0 reverts). Coverage of `src/`: 100 % lines, statements, branches and functions. Mutation: 53 of 53 hand-written mutants killed, M11 and M13 by the CI campaign alone. Slither: 0 results, 3 suppressed, identical. `pnpm run snapshot:check` passes (199 entries; named per-entry-point figures unchanged). SDK: 564 Vitest tests (anvil suite included), 100 % statements, functions and lines, 97.7 % branches; `@paylink/chains` 190 tests at 100 %; `tsc` and ESLint clean. `check-docs.py`: 0 errors, with the new `stale` check. v1 `npm test`: 7 of 7 |
| 2026-10-07 | working tree (pre-freeze), after the test-quality review fixes SR-18 to SR-21 (no change in `src/`) | Claude Code, for the owner | Foundry 1.8.5, solc 0.8.30, Slither 0.11.6, Halmos 0.3.3, Echidna 2.2.7, Medusa 1.3.1, Node 22.22.0, pnpm 10.28.0 | `FOUNDRY_PROFILE=ci forge test`: 335 tests in 32 suites passed (fuzz 10,000 runs; invariants 256 × 128, 32,768 calls over 15 selectors, 0 reverts, 0 violations). Coverage of `src/`: 100 % lines, statements, branches and functions, and `pnpm run coverage` exits 0 on a checkout without `out/`. Mutation: 63 of 63 hand-written mutants killed (`protocol/audit/mutation/results.json`); the CI campaign alone kills M11, M13 and M50–M59. Halmos: 7 of 7 checks pass (conservation on all four paths over arbitrary token behaviour; the `pay` and `cancel` state machines), and they kill 21 of the 23 mutants in their scope (the two survivors only change the reported error). Echidna and Medusa: 12 of 12 properties hold after 20 minutes each (88,149 and 935,655 calls); Medusa kills all 14 mutants it was given, Echidna 3 of 4 in five minutes. Slither: 0 results, 3 suppressed, identical. `pnpm run snapshot:check` passes (217 entries; the named per-entry-point figures unchanged). SDK: 564 Vitest tests (anvil suite included), 100 % statements, functions and lines, 97.7 % branches; `@paylink/chains` 190 tests; ESLint config 25 tests; `tsc` and ESLint clean. `check-docs.py --strict`: 0 errors. v1 `npm test`: 7 of 7, v1 files byte-identical |
