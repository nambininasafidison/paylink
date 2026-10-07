# ADR 0012: Toolchain pinning, sandbox bootstrap and vendored forge-std

- **Status:** accepted
- **Date:** 2026-10-05
- **Deciders:** nambininasafidison (owner), Claude Code (engineering)
- **Related:** PAYLINK-V2-SPEC §3.2, §3.3.5, §4.1, §4.5, §4.6; ADR 0002 (one paris bytecode with OZ 5.3.0); ADR 0011 (workspace layout)

## Context

- The contract release must be reproducible bit for bit: one paris artifact, one `initCodeHash` (§3.3.7). The compiler, its settings and every Solidity dependency are part of that artifact.
- The Claude Code sandbox is restarted often. Its egress allows GitHub release assets, PyPI, the npm registry and git over HTTPS. It **blocks** `binaries.soliditylang.org`, which is used by svm, `foundryup --install` (for solc) and solc-select. It also blocks `codeload.github.com` archives for repositories not attached to the session, which return HTTP 403.
- The spec asks for `forge-std` v1.17.0 as a git submodule, OpenZeppelin Contracts 5.3.0 from pnpm with lockfile integrity, Foundry 1.8.5, solc 0.8.30 and Slither 0.11.6.

## Decision

### 1. One pin file

`scripts/toolchain/pins.env` is the single source of truth for every version and digest outside the JS lockfile. It holds plain `PAYLINK_*=value` lines. Bash sources it, and CI can append it to `$GITHUB_ENV` with
`grep -E '^PAYLINK_[A-Z0-9_]+=' scripts/toolchain/pins.env >> "$GITHUB_ENV"`.

### 2. Verified artifacts

| Tool | Source | Integrity |
|---|---|---|
| Foundry 1.8.5 (`forge`, `cast`, `anvil`, `chisel`, `solar`) | `github.com/foundry-rs/foundry/releases/download/v1.8.5/foundry_v1.8.5_linux_amd64.tar.gz` | sha256 `6c66ffcc…ccffb226`, identical across two downloads taken about an hour apart (trust on first use). The binaries report commit `51a52c59…`. The release has a GitHub build-provenance attestation (`gh attestation verify … --repo foundry-rs/foundry`); Sigstore is unreachable from the sandbox, so that check belongs in CI. |
| solc 0.8.30 (`solc-static-linux`) | `github.com/ethereum/solidity/releases/download/v0.8.30/solc-static-linux` | sha256 `f3e987dc…c428f7` and keccak256 `0xc47307cc…ec8bdc1`, **equal to the official** solc-bin `linux-amd64/list.json` entry for `0.8.30+commit.73712a01` (fetched from `raw.githubusercontent.com/ethereum/solc-bin`) |
| Slither 0.11.6, crytic-compile 0.4.2, solc-select 1.2.0 | PyPI | `scripts/toolchain/requirements-slither.txt`: the full 47-package closure, `--generate-hashes`. Installed with `--require-hashes --no-deps --only-binary=:all:`, so no sdist build code runs and nothing outside the lock can enter. `scripts/toolchain/lock-python.sh` regenerates the lock; it was re-run and gave a byte-identical lock. |
| OpenZeppelin Contracts 5.3.0 | npm, via pnpm `catalog:` | sha512 integrity in `pnpm-lock.yaml` |
| forge-std v1.17.0 | git tag, vendored (see §4) | commit and tree hashes plus a pinned manifest digest |

### 3. Install layout

`scripts/bootstrap-sandbox.sh` is idempotent and safe as a SessionStart hook. A no-op run takes about 2 s.

- solc goes to **`~/.svm/0.8.30/solc-0.8.30`**, the svm layout. Forge then finds it offline even without `FOUNDRY_SOLC`, and `foundry.toml` keeps the portable `solc_version = "0.8.30"`. The bootstrap also exports `FOUNDRY_SOLC` and `FOUNDRY_OFFLINE=true`, as the spec asks. `foundry.toml` contains nothing sandbox-specific, so CI and developer machines use svm normally.
- solc-select artifacts in `~/.solc-select` and in `<venv>/.solc-select` are symlinks to that one binary. solc-select switches its state directory when a venv is active, which is why both are set.
- Only the analysis entry points (`slither*`, `crytic-compile`, `solc-select`, `solc`) are put on PATH, through `~/.paylink-toolchain/bin`, so the venv's `python` never shadows the system one.
- Downloads are HTTPS-only (`--proto =https`, also for redirects) and retried. A file reaches its destination only after its digest has matched. Binaries are installed by an atomic rename. The Foundry archive is rejected if it contains paths, links or traversal.

### 4. forge-std is vendored, not a submodule (deviation from spec §3.2)

`protocol/lib/forge-std` holds the upstream `src/`, `LICENSE-APACHE`, `LICENSE-MIT` and `package.json` of tag v1.17.0: 35 files, 1.1 MB. `scripts/toolchain/vendor-forge-std.sh` manages it:

- `--sync` fetches `refs/tags/v1.17.0` over git with `transfer.fsckObjects`. It requires commit `f3dae6e6…` and tree `1b681a9f…`, exports the subset with `git archive`, and requires the manifest digest pinned in `pins.env`.
- `--check` is offline. It recomputes the per-file sha256 manifest, requires it to equal the committed `protocol/lib/forge-std.manifest`, and requires that file's sha256 to equal the pin. Any local edit, added file or removed file fails. The check runs in the bootstrap and is meant for CI.
- `--check-upstream` re-fetches and diffs. It is meant for a nightly job.

Rationale:

- **Hermetic builds.** Builds stay offline-capable (`FOUNDRY_OFFLINE`), including after a sandbox restart.
- **Nothing to initialise.** No `submodules: recursive` is needed in every CI checkout, and third-party builders such as Envio Cloud and Cloudflare never meet an uninitialised submodule.
- **Reviewable bumps.** A bump is a reviewable source diff, not an opaque gitlink change.
- **Clean workflow fit.** Recording a submodule means staging a gitlink in the index, which is impractical while several agents share one working tree and commits are made only on the owner's review.
- **No tarball.** The pinned codeload tarball download that was first considered returns HTTP 403 in the sandbox. The git commit hash is a stronger, content-addressed pin anyway.

Cost: Dependabot cannot bump a vendored tree. The bump procedure is:

1. Set `PAYLINK_FORGE_STD_TAG`, `_COMMIT` and `_TREE` in `pins.env`.
2. Run `vendor-forge-std.sh --print-digest`.
3. Set `PAYLINK_FORGE_STD_MANIFEST_SHA256` to the printed digest.
4. Run `vendor-forge-std.sh --sync`.

### 5. The settings are enforced by tests, not only by configuration

`protocol/test/toolchain/EvmTarget.t.sol` uses every OpenZeppelin module that PayLinkV2 may import: EIP712, SignatureChecker, ECDSA, SafeERC20, ReentrancyGuard and Address. It asserts the following:

- the runtime's CBOR metadata names **solc 0.8.30**;
- neither the runtime nor the init code contains a **post-paris opcode**: PUSH0, TLOAD, TSTORE, MCOPY, BLOBHASH, BLOBBASEFEE or CLZ. The scanner skips PUSH immediates and the metadata.

The scanner is self-tested with negative controls and a fuzz test. Rebuilding with `FOUNDRY_EVM_VERSION=shanghai`, `cancun` or `osaka` makes the two opcode tests fail, which shows the gate works. Foundry 1.8.5 defaults to `evm_version = "osaka"`, so this test is the guard for ADR 0002. `OpcodeScanner` is reusable on the PayLinkV2 artifact.

## Consequences

- A sandbox restart costs one command, and that command also verifies everything (`--check`, no network).
- CI uses the official installers (`foundry-rs/foundry-toolchain` at v1.8.5, svm for solc) with the same versions, while `pins.env` documents the digests the sandbox trusts.
- Only linux-amd64 is pinned for the sandbox. Other platforms use `foundryup --install 1.8.5` and `pip install --require-hashes -r scripts/toolchain/requirements-slither.txt`.
- The Python lock was generated on CPython 3.11. The hashes cover every wheel of each pinned version, but environment markers may differ on other interpreters; the bootstrap warns.

## Verification (2026-10-05)

```bash
scripts/bootstrap-sandbox.sh && source ~/.paylink-toolchain/env.sh
scripts/bootstrap-sandbox.sh --check                       # offline, exit 0
scripts/toolchain/vendor-forge-std.sh --check-upstream     # identical to upstream v1.17.0
cd protocol && forge build && forge test                   # 8/8 pass
forge fmt --check && forge lint                            # clean
slither . --config-file slither.config.json --foundry-compile-all   # 0 results (src/ is still empty)
```
