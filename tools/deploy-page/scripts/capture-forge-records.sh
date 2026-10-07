#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Regenerates test/fixtures/forge-records.json: two deployment records written by Foundry itself
# (`forge script script/Deploy.s.sol` then `--sig 'record()'`), one CREATE2 and one CREATE, with the on-chain facts
# they were written from. test/record.test.ts re-renders both with web/v2/deploy/lib/core.js and requires the same
# bytes, so the deploy page and tools/verify-deployment can never drift from the repository's record format.
#
# Needs Foundry (anvil, forge, cast) and a release build in protocol/out. Uses anvil's public test account 0 (its
# well-known key is printed by every anvil); no real key. Refuses to run if protocol/deployments already holds a
# record for either chain id, and removes everything it creates there and in protocol/broadcast.
# Usage (from tools/deploy-page): scripts/capture-forge-records.sh
set -Eeuo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd -- "${HERE}/../../.." && pwd -P)"
PROTOCOL="${REPO}/protocol"
OUT="${HERE}/../test/fixtures/forge-records.json"
COMMIT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceCommit"])' "${REPO}/web/v2/deploy/data/release.json")"
SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" # anvil account 0 (public test account)

# Two chain ids of the deploy targets: one with the deterministic-deployment proxy (anvil's default predeploy), one
# without it (CREATE fallback).
CREATE2_CHAIN=84532
CREATE_CHAIN=421614
for id in "${CREATE2_CHAIN}" "${CREATE_CHAIN}"; do
  if [[ -e "${PROTOCOL}/deployments/${id}.json" ]]; then
    echo "protocol/deployments/${id}.json exists (a real record): refusing to overwrite it" >&2
    exit 1
  fi
done

PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "${pid}" 2>/dev/null || true; done
  rm -f "${PROTOCOL}/deployments/${CREATE2_CHAIN}.json" "${PROTOCOL}/deployments/${CREATE_CHAIN}.json"
  rm -rf "${PROTOCOL}/broadcast/Deploy.s.sol/${CREATE2_CHAIN}" "${PROTOCOL}/broadcast/Deploy.s.sol/${CREATE_CHAIN}"
}
trap cleanup EXIT

anvil --port 18711 --chain-id "${CREATE2_CHAIN}" --silent &
PIDS+=($!)
anvil --port 18712 --chain-id "${CREATE_CHAIN}" --disable-default-create2-deployer --silent &
PIDS+=($!)
for port in 18711 18712; do
  for _ in $(seq 1 50); do cast chain-id --rpc-url "http://127.0.0.1:${port}" >/dev/null 2>&1 && break; sleep 0.1; done
done

capture() { # <port> <chainId>
  local rpc="http://127.0.0.1:$1"
  (cd "${PROTOCOL}" && forge script script/Deploy.s.sol --rpc-url "${rpc}" --broadcast --unlocked --sender "${SENDER}" >/dev/null)
  (cd "${PROTOCOL}" && PAYLINK_GIT_COMMIT="${COMMIT}" forge script script/Deploy.s.sol --rpc-url "${rpc}" --sig 'record()' >/dev/null)
  local record="${PROTOCOL}/deployments/$2.json"
  local address
  address="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["address"])' "${record}")"
  python3 - "$2" "${record}" "$(cast code --rpc-url "${rpc}" "${address}")" <<'PY'
import json, sys
chain_id, record_path, code = sys.argv[1:4]
record = open(record_path).read()
r = json.loads(record)
print(json.dumps({
    "chainId": int(chain_id),
    "address": r["address"],
    "method": r["deployment"]["method"],
    "deployer": r["deployment"]["deployer"],
    "txHash": r["deployment"]["txHash"],
    "blockNumber": r["deployment"]["blockNumber"],
    "commit": r["source"]["commit"],
    "runtimeCode": code,
    "record": record,
}))
PY
}

python3 - "${OUT}" "$(capture 18711 "${CREATE2_CHAIN}")" "$(capture 18712 "${CREATE_CHAIN}")" <<'PY'
import json, sys
out, *items = sys.argv[1:]
fixture = {
    "$comment": "Deployment records written by forge (protocol/script/Deploy.s.sol run() then record()) on anvil 1.8.5 from its public test account 0, with the facts each was written from. Regenerate with tools/deploy-page/scripts/capture-forge-records.sh after the release or the record format changes.",
    "records": [json.loads(i) for i in items],
}
open(out, "w").write(json.dumps(fixture, indent=2) + "\n")
PY
echo "wrote tools/deploy-page/test/fixtures/forge-records.json"
