# verify-deployment

Re-verifies a PayLinkV2 deployment **on-chain** and writes `protocol/deployments/<chainId>.json`. It runs the deploy page's own verifier ([`web/v2/deploy/lib`](../../web/v2/deploy/lib/)) against the registry's RPC endpoints ([`web/v2/deploy/data/chains.json`](../../web/v2/deploy/data/chains.json), generated from `@paylink/chains`), so the file it writes is the file the page printed and the file `forge script script/Deploy.s.sol --sig 'record()'` writes, byte for byte (`e2e/specs/record-parity.spec.ts`).

Zero runtime dependencies: plain Node ≥ 22.18, nothing to install. It only reads; no key is involved.

## Usage

```bash
# Verify only (no record without the deployment transaction)
node tools/verify-deployment/verify-deployment.mjs --chain 10143 --address 0x448eCce9711860502806A3d5B021a4f9Ba715082

# Verify and write protocol/deployments/10143.json
node tools/verify-deployment/verify-deployment.mjs --chain 10143 --address 0x448e… --tx 0x…

# … and require the JSON the deploy page printed to be identical
node tools/verify-deployment/verify-deployment.mjs --chain 10143 --address 0x448e… --tx 0x… --compare ~/Downloads/10143.json

# Then regenerate what is built from the records
pnpm --filter @paylink/chains run generate && pnpm --filter @paylink/deploy-page run generate
```

In the Claude Code sandbox, Node's `fetch` ignores `HTTPS_PROXY`: prefix the command with `NODE_USE_ENV_PROXY=1`.

| Option | Meaning |
|---|---|
| `--chain <id>` | 10143, 84532 or 421614; any other chain id is refused (exit 2) |
| `--address <0x…>` | the contract; a mixed-case address must carry a valid EIP-55 checksum |
| `--tx <hash>` | the deployment transaction; required to write the record (deployer, hash and block come from it) |
| `--out <path>` | default `protocol/deployments/<chainId>.json`; `-` prints the record |
| `--compare <file>` | the record must equal this file byte for byte |
| `--commit <sha>` | `source.commit`; default: the release data's `sourceCommit`, as the page |
| `--check` | verify and compare with the existing record; write nothing |
| `--force` | replace an existing record that differs (one deployment per chain: incident response only) |
| `--rpc <url>` | a **loopback** endpoint (anvil) instead of the registry's, for tests and rehearsals; anything else is refused |
| `--json` | the verification as JSON on stdout |

Exit status: `0` verified (written or up to date), `1` a check failed or the record differs, `2` usage error or unknown chain.

## What it checks

Every reachable registry endpoint is asked **independently** (Monad lists two); all that answer must pass and produce the same record, and at least one must answer.

1. The endpoint reports the expected chain id.
2. Code at the address; masked runtime hash = `release.json` (immutable ranges zeroed, CBOR metadata removed); code size and CBOR metadata of the release; the seven EIP-712 immutables recomputed for this chain and address (copied code fails here); `eip712Domain()` = `{0x0f, "PayLink", "2", chainId, address, 0, []}`.
3. With `--tx`: the transaction is on this chain and succeeded, and either calls the factory `0x4e59…956C` with `salt ++ initCode` and the address is the CREATE2 prediction, or creates the contract with the release init code at `getCreateAddress(sender, nonce)`.

## Tests

`pnpm --filter @paylink/verify-deployment test` runs the CLI against an anvil chain with Base Sepolia's chain id: usage refusals, unknown chains, write / up to date / protected / `--force` / `--check` / `--compare`, copied code, a transaction that did not deploy the contract, an RPC on the wrong chain, an empty address.
