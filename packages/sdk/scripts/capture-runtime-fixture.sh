#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Regenerates test/fixtures/paylinkv2-runtime-31337.json: the runtime code of the PayLinkV2 release artifact
# as anvil deploys it, and the raw return data of eip712Domain(). test/deployment.test.ts checks the SDK's
# code-integrity verifier (masked runtime hash, immutables, ERC-5267 domain) against it.
#
# Needs: Foundry (anvil, cast) and a release build in protocol/out (`forge build` in protocol/).
# Usage (from packages/sdk): scripts/capture-runtime-fixture.sh
set -Eeuo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ARTIFACT="${HERE}/../../../protocol/out/PayLinkV2.sol/PayLinkV2.json"
RELEASE="${HERE}/../../../protocol/deployments/release.json"
OUT="${HERE}/../test/fixtures/paylinkv2-runtime-31337.json"
PORT="${PAYLINK_FIXTURE_PORT:-8619}"
RPC="http://127.0.0.1:${PORT}"
# anvil's public default account 0 (mnemonic "test test ... junk"): a test key, never for real funds.
KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

anvil --port "${PORT}" --chain-id 31337 --silent &
ANVIL_PID=$!
trap 'kill "${ANVIL_PID}" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "${RPC}" >/dev/null 2>&1 && break; sleep 0.1; done

INIT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bytecode"]["object"])' "${ARTIFACT}")"
ADDRESS="$(cast send --rpc-url "${RPC}" --private-key "${KEY}" --create "${INIT}" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["contractAddress"])')"
ADDRESS="$(cast to-check-sum-address "${ADDRESS}")"
CODE="$(cast code --rpc-url "${RPC}" "${ADDRESS}")"
DOMAIN="$(cast call --rpc-url "${RPC}" "${ADDRESS}" 'eip712Domain()')"

python3 - "${OUT}" "${ADDRESS}" "${CODE}" "${DOMAIN}" "${RELEASE}" <<'PY'
import json, sys
out, address, code, domain, release = sys.argv[1:6]
init_code_hash = json.load(open(release))["bytecode"]["initCodeHash"]
fixture = {
    "$comment": f"Runtime code of the PayLinkV2 release artifact (initCodeHash {init_code_hash[:10]}...{init_code_hash[-4:]}, protocol/deployments/release.json) as deployed by anvil 1.8.5 (chain 31337) from its default account 0 at nonce 0, and the raw return data of eip712Domain(). Regenerate with packages/sdk/scripts/capture-runtime-fixture.sh after the contract changes.",
    "chainId": 31337,
    "address": address,
    "runtimeCode": code,
    "eip712DomainReturnData": domain,
}
with open(out, "w") as f:
    f.write(json.dumps(fixture, indent=2) + "\n")
PY
echo "wrote ${OUT} (${ADDRESS})"
