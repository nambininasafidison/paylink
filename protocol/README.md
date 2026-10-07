# @paylink/protocol

The PayLinkV2 Solidity contracts: a Foundry project inside the pnpm workspace. The design is in PAYLINK-V2-SPEC §3.3 and the [invoice specification](../docs/spec/paylink-invoice-v2.md); the toolchain decisions are in [ADR 0012](../docs/adr/0012-toolchain-pinning-and-vendoring.md).

## The contract

`src/PayLinkV2.sol` settles payment links that a payee signs off-chain as EIP-712 `Invoice`s; the link id (`key`) is the invoice's EIP-712 digest. It is immutable, ownerless and fee-less, never holds funds across a call, and has no on-chain "create": a link's single storage slot is written on its first payment or cancellation.

| Entry point | Who calls it | Funds move |
|---|---|---|
| `payWithAuthorization(inv, payeeSig, auth)` | anyone, usually the relayer | payer → PayLink → payee in one call, via EIP-3009 `receiveWithAuthorization`; the token nonce is bound to (key, payer, amount, payerRef, payerSalt), so the relayer cannot redirect it |
| `pay(inv, payeeSig, amount, payerRef)` | the payer | payer → payee (`transferFrom`) |
| `payWithPermit(inv, payeeSig, amount, payerRef, permit)` | the payer | EIP-2612 permit in `try/catch`, then as `pay` |
| `payNative(inv, payeeSig, payerRef)` | the payer | `msg.value` forwarded to the payee |
| `cancel(inv)` / `cancelBySig(inv, deadline, sig)` | the payee / anyone with the payee's `Cancel` signature | none |
| `invoiceKey`, `paymentNonce`, `stateOf`, `statesOf` (≤ 256), `eip712Domain` | anyone (views) | none |

Every payment verifies the payee's signature (ECDSA, low-s only, or ERC-1271 for deployed contract payees), the window, the seat cap, the amount and `payer != payee`, then records the payment and emits `Paid` before any token call, and checks the exact amounts that moved. Fee-on-transfer and rebasing tokens revert. Interface and NatSpec: `src/interfaces/IPayLinkV2.sol`.

## Build settings

| | |
|---|---|
| Compiler | solc **0.8.30**, `evm_version = "paris"`, optimizer 10,000 runs, no via-IR, default CBOR metadata, warnings are errors |
| Framework | Foundry **1.8.5** (`foundry.toml`); the `ci` profile runs fuzz 10k and invariants 256 × 128 |
| Dependencies | OpenZeppelin Contracts **5.3.0** (pnpm `catalog:`, sha512 in `pnpm-lock.yaml`); forge-std **v1.17.0** (vendored in `lib/forge-std`, checked by manifest digest) |
| Remappings | `forge-std/` → `lib/forge-std/src/`, `@openzeppelin/contracts/` → `node_modules/@openzeppelin/contracts/` (explicit; auto-detection is off) |

## Setup

```bash
# Sandbox (no access to binaries.soliditylang.org): install and verify everything, then load the env
scripts/bootstrap-sandbox.sh && source ~/.paylink-toolchain/env.sh

# Elsewhere: foundryup --install 1.8.5, then from the repository root
pnpm install --frozen-lockfile
```

## Commands (run in `protocol/`)

| Task | Command |
|---|---|
| Build, with contract sizes | `forge build --sizes` |
| Tests (fuzz 1k, invariants 64 × 128) | `forge test` |
| CI-strength tests (fuzz 10k, invariants 256 × 128; about 2.5 min) | `FOUNDRY_PROFILE=ci forge test` |
| Format / check | `forge fmt` / `forge fmt --check` |
| Lint | `forge lint` (also runs on every build) |
| Gas baselines | `pnpm run snapshot` / `pnpm run snapshot:check` (unit and gas suites into `.gas-snapshot`, and the named figures in `snapshots/PayLinkV2.json`; see [the gas gate](#the-gas-gate)) |
| Coverage of `src/` | `pnpm run coverage` (works on a clean checkout: the script, gas and release-graph suites need the optimized release build and skip themselves under `forge coverage`; `forge test` runs them) |
| Symbolic checks (Halmos 0.3.3: conservation and the state machine) | `pnpm run symbolic` |
| Property fuzzing (Echidna 2.2.7, Medusa 1.3.1; 1 hour each by default) | `pnpm run fuzz:echidna` / `pnpm run fuzz:medusa` (install and evidence: [audit/properties.md](audit/properties.md)) |
| Slither | `slither . --config-file slither.config.json` (runs `forge clean` first) |
| Golden vectors | written by `forge test` into `test/vectors/*.json`; any diff is a format change |
| Release lock | `forge script script/Predict.s.sol --sig 'writeRelease()'` after an intended bytecode change |
| Deployment preview / deploy / record | see [deployments/README.md](deployments/README.md) |
| Every entry point on a local anvil | `anvil &` then `pnpm run smoke:local` |
| forge-std integrity | `../scripts/toolchain/vendor-forge-std.sh --check` |

The same commands are available as `pnpm --filter @paylink/protocol <script>`. They need Foundry on PATH, so leave `@paylink/protocol` out of JavaScript-only CI jobs (`--filter '!@paylink/protocol'`).

## Layout

```
src/PayLinkV2.sol            the only deployable contract
src/interfaces/              IPayLinkV2 (structs, events, errors, NatSpec), IERC3009
test/unit/                   every function, revert path and event field; error precedence for every pair of checks
test/fuzz/                   amounts and counter bounds, time windows and caps, domains (I7), nonce binding (I8),
                             error precedence for any subset of failing checks
test/invariant/              Handler + GhostLedger + Invariants.t.sol: I1-I11 (audit/invariants.md)
test/properties/             PayLinkProperties.sol: I1-I11 for Echidna and Medusa (echidna.yaml, medusa.json), and a
                             forge test that keeps the harness live (audit/properties.md)
test/symbolic/               Halmos check_ functions: conservation and the link state machine (audit/properties.md)
test/gas/                    per-entry-point gas baselines -> snapshots/PayLinkV2.json
test/vectors/                golden vectors (eip712.json, nonce.json, cancel.json) and the spec's worked examples
test/script/                 Predict/Deploy scripts: release lock, CREATE2/CREATE, code verification, records
test/toolchain/              solc 0.8.30 and paris-only opcodes; the release import graph (no utils/Bytes.sol)
test/mocks/                  Mock3009, MockPermit, FeeOnTransfer, Rebasing, HookReentrant, Wallet1271, Wallet1271Gas,
                             RevertingPayee, Donor, RecipientDebit, PeekingPayee (reads stateOf from its receive),
                             OverCreditToken (one leg moves more than asked), TxOriginLure (SWC-115 phishing contract)
test/audit/                  regression evidence from the 2026-10-07 audits: retries (A01), relayer simulation versus
                             inclusion (A02, A03), attack-surface probes (A03_AttackSurface), relayed time bounds and
                             revert-attribution evidence (A04), over-credit exactness (A05), concurrent permit griefing
                             (A06), calldata and dispatch probes (A07); mocks under audit/mocks/
script/Predict.s.sol         initCodeHash, masked runtime hash, CREATE2/CREATE address preview (read-only)
script/Deploy.s.sol          one deployment per chain, verified; record() writes deployments/<chainId>.json
script/dev/LocalSmoke.s.sol  every entry point as real transactions on anvil (local chain id only)
deployments/                 release.json and one record per chain (format: deployments/README.md)
audit/                       Slither output and triage, coverage, invariants, gas, deployment run, mutation testing,
                             Halmos, Echidna and Medusa runs
lib/forge-std/               vendored upstream subset; never edit it (the check fails)
lib/forge-std.manifest       per-file sha256 of the vendored tree
```

## The gas gate

`pnpm run snapshot:check` is the gate: `FORGE_SNAPSHOT_CHECK=true forge snapshot --match-path 'test/{unit,gas}/*.t.sol' --check --tolerance 3`. It deliberately narrows PAYLINK-V2-SPEC §4.1, which writes the bare `forge snapshot --check --tolerance 3`:

- `.gas-snapshot` holds the unit and gas suites only. Fuzz and invariant gas varies with the random inputs, and the vector, script, toolchain and audit suites measure nothing about the contract's cost, so they are not baselined. A bare `--check` therefore reports every one of them missing and exits 1 on this tree.
- `FORGE_SNAPSHOT_CHECK=true` makes `test/gas/Gas.t.sol` compare against `snapshots/PayLinkV2.json` instead of rewriting it; without it the named figures would silently follow the code.

After an intended gas change, `pnpm run snapshot` regenerates both files; review the diff.

## Invariants of this configuration

- Never change compiler settings casually. They define the release artifact and its `initCodeHash` (spec §3.3.7).
- `test/toolchain/EvmTarget.t.sol` must stay green. It fails if a dependency or setting introduces PUSH0, MCOPY, TLOAD/TSTORE, BLOBHASH, BLOBBASEFEE or CLZ, which would break the London-level Mezo target.
- `fs_permissions` lists `./out` (read) explicitly, because restating `fs_permissions` replaces Foundry's default. `test/vectors` is read-write for the golden vectors.
- `test/toolchain/ReleaseGraph.t.sol` pins the exact set of source files compiled into PayLinkV2. A new import, direct or transitive, fails it until reviewed; it also asserts `utils/Bytes.sol` (GHSA-9rcw-c2f9-2j55) is absent. It reads the release artifact in `out/`, so it refuses an artifact whose init code differs from the PayLinkV2 it was compiled with (a stale `out/`), and it skips itself under `forge coverage`, which never writes `out/`.
- `deployments/release.json` must match the build (`test_ReleaseLockMatchesBuild`). Regenerate it only for an intended release change.
