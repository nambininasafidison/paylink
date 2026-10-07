# Deployment scripts: end-to-end run on anvil

The sandbox cannot reach any testnet (PAYLINK-V2-SPEC §0.10), so `script/Predict.s.sol`, `script/Deploy.s.sol` and `record()` were run end to end against local anvil nodes that use the chain ids of the target networks. Real deployments run from `deploy-testnet.yml` ([docs/runbooks/deploy.md](../../docs/runbooks/deploy.md)).

- **Date:** 2026-10-07, working tree on `main` (`93ed4e3` plus the uncommitted v2 tree). Re-run the same day after the pre-freeze audit changed the `IPayLinkV2` NatSpec: the `initCodeHash`, the CBOR metadata and therefore the CREATE2 address changed; the masked runtime hash, the immutable ranges and every deploy `gasUsed` are identical to the first run.
- **Toolchain:** Foundry 1.8.5 (`forge`, `anvil`), solc 0.8.30, release build of `deployments/release.json`.
- **Keys:** anvil's public test account 0 (`0xf39F…2266`). No real key was used.
- **Records:** `record()` wrote `deployments/<chainId>.json` for each run. Those files describe throwaway anvil chains, so they were **moved out of the repository** after the run; a record in `deployments/` must only ever describe a real deployment.

## Scenarios

| Chain id (anvil) | Hardfork | Factory `0x4e59…956C` | Method chosen | Address | Deploy tx `gasUsed` | Re-run |
|---|---|---|---|---|---|---|
| 84532 (Base Sepolia id) | anvil default | present (69 bytes) | CREATE2 | `release.json` `create2.address` (`0x448e…5082`) | 2,678,851 | verified only, deployer nonce 1 → 1 |
| 10143 (Monad testnet id) | anvil default | absent (`--disable-default-create2-deployer`) | CREATE | `0x5FbDB2315678afecb367f032d93F642f64180aa3` (deployer nonce 0) | 2,677,645 | verified only, deployer nonce 1 → 1 |
| 31611 (Mezo testnet id) | **london** | present | CREATE2 | `release.json` `create2.address` (`0x448e…5082`) | 2,678,039 | verified only, deployer nonce 1 → 1 |

Every run printed the same `initCodeHash` `0x289dcd6477a467fcd8cc185bb4fb6c3cd58c06132d08fa11822f21f824627ac5` and `maskedRuntimeHash` `0x59c48f00a8e437c74bf6b0b5ac1363149c8977c9185d1cf23405fa09c18aeb4d`, equal to `deployments/release.json`. The CREATE2 address is the same on 84532 and 31611, as designed. The London run shows that the paris artifact deploys and verifies on a London-level chain (no `PUSH0`), as Mezo may be.

## What each run checked

1. `Predict.s.sol run(address)`: factory presence by `eth_getCode`, method, target address, `initCodeHash`, masked runtime hash, settings hash. Read-only.
2. `Deploy.s.sol` with `--broadcast`: refuses a non-release build; deploys through the factory (or CREATE); checks the landing address against the prediction; then `_verifyDeployed`: masked runtime hash, the seven EIP-712 immutables recomputed for `(chainId, address)`, and the ERC-5267 domain.
3. `Deploy.s.sol record()`: parses `broadcast/Deploy.s.sol/<chainId>/run-latest.json` (chain, receipt status, transaction hash, factory target, contract address), re-verifies the live code and writes the record.
4. Re-run of step 2: **no transaction** in all three scenarios.

### Finding fixed during this run

The first pass showed the CREATE scenario was **not** idempotent: a re-run deployed a second instance at the deployer's next nonce (nonce 1 → 2), which would have spent another ~0.3 MON on Monad. `Deploy.s.sol` now treats an existing `deployments/<chainId>.json` as the chain's deployment and only verifies it; `PAYLINK_REDEPLOY=true` overrides (reset chain, incident response). An existing record whose address has no code reverts with `RecordedDeploymentMissing`. Covered by `test_RunVerifiesTheRecordedDeploymentInsteadOfRedeploying`, `test_RunRedeploysWhenExplicitlyAsked` and `test_RevertWhen_RecordedDeploymentHasNoCode`; the second pass above shows nonce 1 → 1.

## Record produced (chain 10143, CREATE)

Abbreviated; the format is documented in [../deployments/README.md](../deployments/README.md).

```json
{
  "schema": "paylink.deployment/1",
  "chainId": 10143,
  "caip2": "eip155:10143",
  "network": "Monad testnet",
  "address": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "deployment": {
    "method": "CREATE",
    "deployer": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "txHash": "0x3cf24fa96b8c2a6d991949d5963027c9bb19128dc6cd21f32fb5a3789fa8015d",
    "blockNumber": 1,
    "factory": null,
    "salt": null,
    "saltPreimage": null
  },
  "bytecode": {
    "initCodeHash": "0x289dcd6477a467fcd8cc185bb4fb6c3cd58c06132d08fa11822f21f824627ac5",
    "maskedRuntimeHash": "0x59c48f00a8e437c74bf6b0b5ac1363149c8977c9185d1cf23405fa09c18aeb4d",
    "runtimeCodeHash": "0x9a89b3fad3d9a5506b61ed6d1cae32ed895107fd85f05291e3d1d971fdc7a467",
    "runtimeCodeSize": 12045
  },
  "eip712Domain": {"name": "PayLink", "version": "2", "chainId": 10143, "verifyingContract": "0x5FbDB2315678afecb367f032d93F642f64180aa3"}
}
```

## Reproduce

```bash
source ~/.paylink-toolchain/env.sh && cd protocol && forge build
anvil --chain-id 84532 --port 18545 &                                       # factory present
anvil --chain-id 10143 --port 18546 --disable-default-create2-deployer &    # factory absent
anvil --chain-id 31611 --port 18547 --hardfork london &
for port in 18545 18546 18547; do
  rpc=http://127.0.0.1:$port
  forge script script/Predict.s.sol --rpc-url $rpc --sig 'run(address)' 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  forge script script/Deploy.s.sol --rpc-url $rpc --broadcast --private-key <anvil test key 0>
  PAYLINK_GIT_COMMIT=$(git rev-parse HEAD) forge script script/Deploy.s.sol --rpc-url $rpc --sig 'record()'
  forge script script/Deploy.s.sol --rpc-url $rpc --broadcast --private-key <anvil test key 0>   # sends nothing
done
# then move deployments/{84532,10143,31611}.json and broadcast/Deploy.s.sol/{84532,10143,31611} out of the tree
```
