# PayLinkV2 deployments

This folder holds one file for the release artifact and one file per chain that PayLinkV2 is deployed on. Both are written by Foundry scripts with a deterministic JSON writer (fixed key order, two-space indentation), so a regenerated file only differs when the facts differ. Do not edit them by hand.

| File | Written by | Checked by |
|---|---|---|
| `release.json` | `forge script script/Predict.s.sol --sig 'writeRelease()'` | `test/script/Scripts.t.sol::test_ReleaseLockMatchesBuild` (fails until the file matches the build) |
| `<chainId>.json` | `forge script script/Deploy.s.sol --rpc-url <rpc> --sig 'record()'`, after the broadcast | `record()` re-verifies the live code before writing; `deployments-check.yml` re-checks every file nightly |

Spec: PAYLINK-V2-SPEC §3.3.7. Procedure: [docs/runbooks/deploy.md](../../docs/runbooks/deploy.md).

## Why two hashes

The constructor takes no argument, so the **init code is identical on every chain** and `initCodeHash` identifies the release. The **runtime code is not identical**: OpenZeppelin `EIP712` stores seven immutables in it (the hashed name and version, the cached domain separator, chain id and contract address, and the two `ShortStrings`). So a deployment is checked with:

1. `initCodeHash`: keccak256 of the creation code. It must equal `release.json` and the `contracts-v2.0.0` release notes.
2. `maskedRuntimeHash`: keccak256 of the deployed runtime code with every `immutableReferences` range set to zero and the trailing CBOR metadata removed. The CBOR length is the big-endian `uint16` in the last two bytes; those two bytes are removed too. The value is the same on every chain.
3. The seven immutable words themselves, recomputed from `(chainId, address)`, so copied code (a genuine runtime from another deployment, returned verbatim by some other init code at another address) and code verified under the wrong chain are both rejected.
4. The ERC-5267 domain read from the contract: `fields = 0x0f`, name `PayLink`, version `2`, this chain id, this address, no salt and no extensions.

`script/utils/PayLinkRelease.sol::_verifyDeployed` implements all four. The `/status/` page and `deployments-check.yml` apply the same rule.

## Addresses

- **CREATE2** through the deterministic-deployment proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C` with salt `keccak256("paylink.v2.0.0")`, when `eth_getCode` shows the proxy on the chain. The address is the same on every such chain: `create2.address` in `release.json`.
- **CREATE** from the deployer otherwise (or with `PAYLINK_FORCE_CREATE=true`). The address then depends on the deployer and its nonce, and differs per chain.

`forge script script/Predict.s.sol --rpc-url <rpc> --sig 'run(address)' <deployer>` prints which method applies, the target address, `initCodeHash`, `maskedRuntimeHash` and the settings hash before anything is signed, and the recorded address when `<chainId>.json` already exists.

**One deployment per chain.** When `<chainId>.json` exists, `Deploy.s.sol` only verifies the recorded contract and sends nothing; it reverts `RecordedDeploymentMissing` if that address has no code (a reset testnet). `PAYLINK_REDEPLOY=true` deploys anyway, for incident response; run `record()` afterwards to replace the record.

## `release.json` (schema `paylink.release/1`)

| Key | Meaning |
|---|---|
| `schema`, `contract`, `release` | `paylink.release/1`, `PayLinkV2`, `2.0.0` |
| `bytecode.initCodeHash`, `bytecode.initCodeSize` | Identity of the creation code |
| `bytecode.maskedRuntimeHash`, `bytecode.runtimeCodeSize` | Identity of the runtime code, masked as above |
| `bytecode.masking` | The masking rule, in words |
| `bytecode.immutableReferences` | `[{start, length}]` byte ranges, sorted by `start` |
| `bytecode.cborMetadata` | The CBOR suffix (IPFS hash of the metadata, solc version, length) |
| `compiler.*` | `solc`, `evmVersion`, `optimizer`, `optimizerRuns`, `viaIR`, `bytecodeHash`, the canonical `settings` string and its keccak256 `settingsHash` |
| `dependencies` | `@openzeppelin/contracts` (read from the installed package, refused unless `5.3.0`) and `forge-std` |
| `create2` | `factory`, `salt`, `saltPreimage`, the predicted `address`, and a note that CREATE fallback addresses differ |
| `source` | Repository and source path |

The scripts refuse any build that is not the release build (`NotReleaseBuild`): another solc, EVM version, optimizer setting, `viaIR`, bytecode-hash mode or OpenZeppelin version.

## `<chainId>.json` (schema `paylink.deployment/1`)

| Key | Meaning |
|---|---|
| `schema`, `contract`, `release` | `paylink.deployment/1`, `PayLinkV2`, `2.0.0` |
| `chainId`, `caip2`, `network` | `84532`, `eip155:84532`, `Base Sepolia` |
| `address`, `caip10` | EIP-55 address and its CAIP-10 form |
| `deployment.method` | `CREATE2` or `CREATE` |
| `deployment.deployer`, `deployment.txHash`, `deployment.blockNumber` | From Foundry's broadcast receipt (`broadcast/Deploy.s.sol/<chainId>/run-latest.json`) |
| `deployment.factory`, `deployment.salt`, `deployment.saltPreimage` | CREATE2 parameters; `null` for CREATE, so every record has the same keys |
| `bytecode.initCodeHash`, `bytecode.maskedRuntimeHash` | Equal to `release.json` |
| `bytecode.runtimeCodeHash`, `bytecode.runtimeCodeSize` | keccak256 and size of the code actually on that chain (differs per chain) |
| `bytecode.masking`, `bytecode.immutableReferences` | As in `release.json` |
| `compiler`, `dependencies` | As in `release.json` |
| `source.commit` | `PAYLINK_GIT_COMMIT`, else `GITHUB_SHA`, else `unknown` |
| `eip712Domain` | `{name, version, chainId, verifyingContract}` as verified on chain |
| `explorers` | `[{name, address, tx}]` links for the chains in the spec's registry (§3.4); empty for chains without a known explorer |

`record()` refuses a broadcast for another chain, a failed receipt, a transaction to another factory, a CREATE2 `contractAddress` other than the prediction, and an unknown transaction type, then verifies the live code (the four checks above) before writing the file.

## Commands

```bash
cd protocol
forge build
# 1. Preview (read-only)
forge script script/Predict.s.sol --rpc-url "$RPC" --sig 'run(address)' "$DEPLOYER"
# 2. Deploy (the key stays in the keystore or the CI secret)
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --account w-deploy --sender "$DEPLOYER"
# 3. Record
PAYLINK_GIT_COMMIT=$(git rev-parse HEAD) forge script script/Deploy.s.sol --rpc-url "$RPC" --sig 'record()'
```

A re-run of step 2 sends no transaction once the CREATE2 address is occupied or the chain has a record; it only verifies the existing contract. The end-to-end run against anvil (factory present, factory absent) is recorded in [../audit/deployment.md](../audit/deployment.md).
