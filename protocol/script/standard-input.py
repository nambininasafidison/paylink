#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
Writes the Solidity standard JSON input of the PayLinkV2 2.0.0 release, for source verification on a block explorer
(Blockscout or Etherscan: "Solidity (Standard JSON input)"), and checks it first: solc 0.8.30 must compile it to exactly
the release's creation code (`initCode` of web/v2/deploy/data/release.json, whose keccak256 is the release's
initCodeHash). Nothing is sent anywhere.

The input holds PayLinkV2.sol and the 25 OpenZeppelin files it imports (the closure its own metadata lists), with the
release's settings (paris, optimizer 10,000 runs, ipfs metadata, the two remappings), taken from the build info that
`forge build --build-info` writes.

Usage, in protocol/ (FOUNDRY_SOLC, or ~/.svm/0.8.30/solc-0.8.30, is the pinned solc):

    forge build --build-info
    python3 script/standard-input.py > PayLinkV2-2.0.0.standard-input.json

Exit status 1, with nothing on stdout, if no build info holds the release settings or the compiled code differs.
"""
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROTOCOL = os.path.dirname(HERE)
RELEASE = os.path.join(PROTOCOL, "..", "web", "v2", "deploy", "data", "release.json")
SOURCE, NAME = "src/PayLinkV2.sol", "PayLinkV2"


def release_input(build_info: dict) -> dict | None:
    """The minimal standard input for PayLinkV2 from one build info, or None when it is not a release build."""
    settings = build_info.get("input", {}).get("settings", {})
    contract = build_info.get("output", {}).get("contracts", {}).get(SOURCE, {}).get(NAME)
    if contract is None or settings.get("evmVersion") != "paris" or settings.get("optimizer") != {"enabled": True, "runs": 10000} or settings.get("viaIR", False):
        return None
    closure = sorted(json.loads(contract["metadata"])["sources"])
    sources = build_info["input"]["sources"]
    return {
        "language": "Solidity",
        "sources": {path: {"content": sources[path]["content"]} for path in closure},
        "settings": {
            "remappings": settings["remappings"],
            "optimizer": settings["optimizer"],
            "metadata": settings["metadata"],
            "evmVersion": "paris",
            "viaIR": False,
            "libraries": {},
            "outputSelection": {"*": {"*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"]}},
        },
    }


def compiled_creation_code(standard_input: dict) -> str:
    solc = os.environ.get("FOUNDRY_SOLC") or os.path.expanduser("~/.svm/0.8.30/solc-0.8.30")
    result = subprocess.run([solc, "--standard-json"], input=json.dumps(standard_input), capture_output=True, text=True, check=True)
    output = json.loads(result.stdout)
    errors = [e["formattedMessage"] for e in output.get("errors", []) if e["severity"] == "error"]
    if errors:
        raise SystemExit("solc: " + "\n".join(errors))
    return "0x" + output["contracts"][SOURCE][NAME]["evm"]["bytecode"]["object"]


def main() -> int:
    with open(RELEASE, encoding="utf-8") as f:
        release = json.load(f)
    for path in sorted(glob.glob(os.path.join(PROTOCOL, "out", "build-info", "*.json"))):
        with open(path, encoding="utf-8") as f:
            candidate = release_input(json.load(f))
        if candidate is None:
            continue
        if compiled_creation_code(candidate).lower() != release["initCode"].lower():
            print(f"standard-input: {os.path.basename(path)} compiles to other code than the release", file=sys.stderr)
            return 1
        json.dump(candidate, sys.stdout, indent=1, sort_keys=True)
        sys.stdout.write("\n")
        print(f"standard-input: {len(candidate['sources'])} sources, compiles to the release init code ({release['release']['bytecode']['initCodeHash']})", file=sys.stderr)
        return 0
    print("standard-input: no build info with the release settings: run `forge build --build-info` first", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
