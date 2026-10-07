#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Supply-chain audit gate for the v2 workspace, scoped by importer.

`pnpm audit` covers the whole lockfile and cannot be filtered by project. The
lockfile's root importer "." is the frozen v1 app (docs/adr/0011-workspace-layout.md).
Its Node dependencies (ethers, solc-js, ganache) are build and test tooling
only, because the deployed v1 site loads a vendored ethers.umd.min.js. Their
advisories are reported here but cannot be fixed without breaking the
byte-identical freeze. This script runs `pnpm audit --json`, splits the
advisories by importer, prints both groups, and fails only on v2 importers
(protocol, packages/*, apps/*, e2e) at or above the threshold.

GHSAs listed in pnpm-workspace.yaml auditConfig.ignoreGhsas are dropped by
pnpm before the JSON report, so each must carry its justification there.

Usage: python3 scripts/toolchain/audit-workspace.py [--audit-level high] [--prod]
Exit codes: 0 gate passed, 1 v2 advisory at or above the level, 2 audit could not run.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

SEVERITY = {"info": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}
V1_IMPORTER = "."


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--audit-level", choices=list(SEVERITY), default="high")
    parser.add_argument("--prod", action="store_true", help="only production dependencies (pnpm audit --prod)")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    cmd = ["pnpm", "audit", "--json"] + (["--prod"] if args.prod else [])
    proc = subprocess.run(cmd, cwd=repo_root, capture_output=True, text=True, check=False)
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(proc.stderr or proc.stdout)
        print("audit-workspace: pnpm audit did not return JSON (registry unreachable?)", file=sys.stderr)
        return 2
    if "error" in report:
        print(f"audit-workspace: pnpm audit error: {report['error']}", file=sys.stderr)
        return 2

    threshold = SEVERITY[args.audit_level]
    rows: dict[str, list[tuple[str, str, str, str]]] = {"v1 (frozen, not gating)": [], "v2": []}
    gate_failures = 0
    for advisory in report.get("advisories", {}).values():
        severity = advisory.get("severity", "info")
        ghsa = advisory.get("github_advisory_id") or str(advisory.get("id"))
        module = advisory.get("module_name", "?")
        paths = sorted({p for f in advisory.get("findings", []) for p in f.get("paths", [])})
        v1_paths = [p for p in paths if p.split(">", 1)[0] == V1_IMPORTER]
        v2_paths = [p for p in paths if p.split(">", 1)[0] != V1_IMPORTER]
        if v1_paths:
            rows["v1 (frozen, not gating)"].append((severity, module, ghsa, v1_paths[0]))
        if v2_paths:
            rows["v2"].append((severity, module, ghsa, v2_paths[0]))
            if SEVERITY.get(severity, 0) >= threshold:
                gate_failures += 1

    for scope, items in rows.items():
        print(f"{scope}: {len(items)} advisor{'y' if len(items) == 1 else 'ies'}")
        for severity, module, ghsa, path in sorted(items, key=lambda r: (-SEVERITY.get(r[0], 0), r[1])):
            print(f"  {severity:<9} {module:<28} {ghsa:<22} {path}")

    if gate_failures:
        print(f"audit-workspace: FAIL: {gate_failures} v2 advisory(ies) at or above '{args.audit_level}'", file=sys.stderr)
        return 1
    print(f"audit-workspace: ok: no v2 advisory at or above '{args.audit_level}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
