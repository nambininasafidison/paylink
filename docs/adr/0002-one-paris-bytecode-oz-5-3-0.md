---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering); toolchain experiments riskfirst-ozcheck and ozaudit (2026-10-05)
informed: contributors, reviewers
---

# ADR 0002: One paris bytecode with OpenZeppelin Contracts 5.3.0

## Context and problem statement

The same contract must run on Monad testnet (10143), Base Sepolia (84532), Arbitrum Sepolia (421614), later Mezo testnet (31611), and possibly Monad mainnet (143) and Arc. Mezo's EVM level is probably **London** (**L**, PAYLINK-V2-SPEC §3.4), which has no PUSH0 (Shanghai), MCOPY or transient storage (Cancun).

Three facts constrain the build:

- OpenZeppelin Contracts **5.4 and later** compile `EIP712` and `SignatureChecker` to code that uses **MCOPY** (**C**, PAYLINK-V2-SPEC §3.3.5), which a London-level chain cannot execute.
- Foundry 1.8.5 defaults to `evm_version = "osaka"` ([ADR 0012](0012-toolchain-pinning-and-vendoring.md)).
- The validated prototype used OZ 5.6.1 with `cancun`.

We want **one** artefact: one bytecode to review, one `initCodeHash` to publish, and the option of the same CREATE2 address on every chain.

Which compiler settings and library version produce a single artefact that is safe on every target?

## Decision drivers

- Runs unchanged on every target chain, including a London-level one.
- Only audited library code for EIP-712, ERC-1271, ECDSA, SafeERC20, ReentrancyGuard and Address. No hand-rolled cryptography.
- No known library advisory that reaches the code we import.
- Reproducible: pinned compiler binary, pinned settings, pinned dependency integrity.
- Verifiable deployments: an `initCodeHash` identical across chains.

## Considered options

- **A.** solc 0.8.30, `evm_version = paris`, OpenZeppelin 5.3.0, optimizer at 10,000 runs, no via-IR.
- **B.** OpenZeppelin 5.6.1 with `cancun`, as in the prototype.
- **C.** Per-chain artefacts: `cancun` where supported, `paris` for Mezo.
- **D.** Hand-written EIP-712 and ERC-1271 code that avoids MCOPY, on a newer OpenZeppelin.
- **E.** Option A with via-IR enabled.

## Decision outcome

Chosen option: **A**, because it is the only option that yields one audited-library artefact that runs on a London-level EVM. The checks behind it:

- OpenZeppelin 5.3.0 at `paris` compiles and deploys on a London-level chain. This was verified in `scratchpad/v2plan/riskfirst-ozcheck` on an anvil chain started with `--hardfork london` (**C**).
- The only advisory against 5.3.0 is **GHSA-9rcw-c2f9-2j55**, a `Bytes.lastIndexOf` out-of-bounds read affecting `>=5.2.0 <5.4.0`, severity moderate (**C**, `npm audit` on 2026-10-05). `utils/Bytes.sol` is not in our import graph:
  - EIP712 → MessageHashUtils → Strings → Math, SafeCast, SignedMath; ShortStrings → StorageSlot;
  - SignatureChecker → ECDSA, IERC1271;
  - SafeERC20 → IERC20, IERC1363;
  - Address → Errors.

Settings: solc 0.8.30, `evm_version = "paris"`, `optimizer = true`, `optimizer_runs = 10000`, `via_ir = false`, default CBOR metadata (`bytecode_hash = "ipfs"`), warnings are errors. They are recorded in `protocol/foundry.toml`.

### Compiler known-bugs review (2026-10-05)

The Solidity team's `bugs_by_version.json` lists seven known bugs for 0.8.30 (**C**, fetched from `ethereum/solidity` on 2026-10-05). The latest release is 0.8.37 (2026-09-10), with none listed. Applicability to PayLinkV2, which uses the legacy pipeline with no via-IR, targets `paris`, has no storage arrays, no `layout at` specifier, no transient storage and no recursion:

| Bug | Severity | Conditions | Applies? |
|---|---|---|---|
| TransientStorageClearingHelperCollision | high | via-IR and EVM ≥ cancun | No: no via-IR, `paris`, no transient storage |
| UnsoundSpillInMutualRecursion | medium | via-IR | No |
| InheritanceOrderReversalOnStorageEndWarning | medium | only when the compiler warns that a custom storage base is close to the end of storage | No: no `layout at` specifier, and the build fails on any warning (`deny = "warnings"`) |
| SpillSlotCollisionAcrossMutualRecursion | low/medium | via-IR | No |
| MemoryByteArrayElementDeleteClearsWholeWord | low/medium | legacy pipeline; `delete` on one element of a memory `bytes` array | No: no such `delete` in `src/` or in the imported OpenZeppelin files (grep, 2026-10-05) |
| LostStorageArrayWriteOnSlotOverflow | low | storage arrays straddling the end of storage | No: no storage arrays |
| MisorderedNamedParametersInRequireWithCustomErrors | very low | via-IR | No |

The pin therefore stays at 0.8.30 for v2.0. Every toolchain tool (Foundry 1.8.5, Slither 0.11.6, Echidna, Medusa, Halmos, Aderyn) was validated with it, its static binary digest is pinned in `scripts/toolchain/pins.env`, and changing compilers two days before the contract freeze carries more risk than seven inapplicable bugs. **Revisit for v2.1:** move to the latest solc that still supports `paris` (0.8.37 deprecates only `constantinople` to `berlin`, **C**, Solidity changelog), and re-run the full gate set. The [self-review](../security/self-review.md) re-checks this table at every release.

### Consequences

- Good, because one bytecode is reviewed, tested, fuzzed and deployed everywhere, with one `initCodeHash`.
- Good, because the same CREATE2 address on every chain is possible (tier T2).
- Good, because only audited OpenZeppelin modules implement the cryptography.
- Bad, because the build forgoes the gas savings of PUSH0, MCOPY and transient-storage reentrancy locks.
- Bad, because runtime code still differs per chain: OpenZeppelin `EIP712` stores immutables (chain ID, domain separator, `address(this)`, name and version hashes). Deployment checks must therefore compare runtime code with the immutable ranges masked ([ARCHITECTURE §6](../ARCHITECTURE.md#6-deployments-and-code-integrity)).
- Bad, because the audit configuration carries one documented exception (`auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`). It is safe only while `Bytes.sol` stays out of the import graph, which `protocol/test/toolchain/ReleaseGraph.t.sol::test_BytesSolIsNotCompiledIn` enforces on every `forge test`.
- Bad, because 0.8.30 is not the newest compiler. That is a documented deviation from SCSVS G1.10 ([self-review](../security/self-review.md)).

### Confirmation

- `protocol/test/toolchain/EvmTarget.t.sol` scans the compiled init and runtime code and fails on PUSH0, TLOAD, TSTORE, MCOPY, BLOBHASH, BLOBBASEFEE or CLZ ([ADR 0012](0012-toolchain-pinning-and-vendoring.md)).
- `protocol/test/toolchain/ReleaseGraph.t.sol::test_BytesSolIsNotCompiledIn` asserts that `utils/Bytes.sol` is absent from the release artifact's metadata source list (`out/PayLinkV2.sol/PayLinkV2.json`, `.metadata.sources`), which is exactly what the deployed bytecode was compiled from; `test_ReleaseCompilesExactlyTheReviewedSources` pins the whole list of 26 files. It runs in every `forge test`, and in CI in `contracts.yml` once the workflows land (planned, T0). PAYLINK-V2-SPEC §4.1 words this as a check on `out/build-info`; the artifact's own source list is the stricter target, because `out/build-info` also holds the test and script compilation units.
- `deployments-check.yml` compares the `initCodeHash` and the masked runtime code of every deployment with the release artefact.
- `fork-nightly.yml` runs the artefact against the real tokens on every target chain.

## Pros and cons of the options

### A. solc 0.8.30, paris, OZ 5.3.0 (chosen)

- Good, because one artefact runs on every target, including London-level chains.
- Good, because it is pure audited library code.
- Bad, because it carries one advisory exception (not reachable) and forgoes newer opcodes.

### B. OZ 5.6.1 with cancun (prototype)

- Good, because it is the latest library, with no advisory exception, and was proven in the prototype.
- Bad, because MCOPY makes it unusable on a London-level Mezo, which forces a second artefact (option C).

### C. Per-chain artefacts

- Good, because every chain gets its best opcodes.
- Bad, because two artefacts mean two reviews, two `initCodeHash` values, two sets of golden vectors and twice the deployment checks.

### D. Hand-written EIP-712 and ERC-1271

- Good, because it allows any OpenZeppelin version.
- Bad, because hand-rolled signature code is a top source of critical bugs, and the spec forbids it ("No hand-rolled EIP-712 or ERC-1271").

### E. via-IR

- Good, because it can produce smaller or cheaper code.
- Bad, because several of 0.8.30's known bugs are specific to via-IR, it changes code generation relative to the validated prototype, and it makes compilation slower. There is no gain worth the risk at this size.

## More information

- PAYLINK-V2-SPEC §0 decision 3, §3.3.5, §3.3.7, §4.1.
- [ADR 0012](0012-toolchain-pinning-and-vendoring.md) (toolchain pins and the opcode scanner); `protocol/foundry.toml`; `protocol/README.md`.
- Solidity known bugs: `https://github.com/ethereum/solidity/blob/develop/docs/bugs_by_version.json`.
