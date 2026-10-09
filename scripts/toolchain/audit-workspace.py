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
pnpm before the JSON report, so each must carry its justification there. That
list is global. A narrower exception lives in ACCEPTED below: one GHSA on one
exact dependency path, with its evidence and a review date. The same GHSA
reached through any other path still fails the gate, and so does an exception
past its review date.

Usage: python3 scripts/toolchain/audit-workspace.py [--audit-level high] [--prod]
Exit codes: 0 gate passed, 1 v2 advisory at or above the level, 2 audit could not run.
"""

from __future__ import annotations

import argparse
import datetime
import json
import subprocess
import sys
from pathlib import Path

SEVERITY = {"info": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}
V1_IMPORTER = "."

# ------------------------------------------------------------------ accepted v2 advisories (narrow exceptions)
#
# apps/indexer: Envio HyperIndex 3.12.1 (envio), the history indexer that runs on Envio Cloud only. Decision of
# 2026-10-09, docs/adr/0011-workspace-layout.md "Known audit item for the indexer":
# - envio is a build-and-run dependency of a hosted service. Nothing from apps/indexer is bundled into the web app
#   or the relayer, and PayLink users only ever reach the indexer's Hasura GraphQL endpoint, never this process.
# - express 4.19.2 serves envio's internal health and metrics port (ENVIO_INDEXER_PORT, default 9898): GET /healthz,
#   /console/state, /metrics, /metrics/runtime and POST /console/syncCache (envio src/Main.res startServer). The
#   routes are static, so path-to-regexp builds no backtracking pattern for them, and no body parser is mounted, so
#   body-parser never reads a request body.
# - ws 8.20.1 (envio's own viem) opens a socket only for an RPC configured with a `ws:` URL (envio
#   src/sources/EvmRpcWs.res); apps/indexer/config.yaml configures none (HTTP RPCs and HyperSync only).
# - A pnpm override would not change what Envio Cloud installs, which may resolve the package on its own; the gate
#   would then report a fix that does not run anywhere.
# Review on every envio bump, and by the date below at the latest; drop the entries once envio ships patched versions.
_ENVIO_REVIEW_BY = datetime.date(2026, 12, 31)
_ENVIO_SERVER = (
    "envio's internal health/metrics server: static routes, no body parser mounted, port internal to Envio Cloud "
    "(docs/adr/0011-workspace-layout.md)"
)
_ENVIO_WS = "envio's viem WebSocket client: only used for a ws: RPC, and apps/indexer/config.yaml configures none"
ACCEPTED: dict[tuple[str, str], tuple[str, datetime.date]] = {
    ("GHSA-qwcr-r2fm-qrc7", "apps__indexer>envio>express>body-parser"): (_ENVIO_SERVER, _ENVIO_REVIEW_BY),
    ("GHSA-9wv6-86v2-598j", "apps__indexer>envio>express>path-to-regexp"): (_ENVIO_SERVER, _ENVIO_REVIEW_BY),
    ("GHSA-rhx6-c78j-4q9w", "apps__indexer>envio>express>path-to-regexp"): (_ENVIO_SERVER, _ENVIO_REVIEW_BY),
    ("GHSA-37ch-88jc-xwx2", "apps__indexer>envio>express>path-to-regexp"): (_ENVIO_SERVER, _ENVIO_REVIEW_BY),
    ("GHSA-96hv-2xvq-fx4p", "apps__indexer>envio>viem>ws"): (_ENVIO_WS, _ENVIO_REVIEW_BY),
}


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
    today = datetime.datetime.now(datetime.timezone.utc).date()
    accepted_label = "v2 accepted (narrow exceptions, see ACCEPTED)"
    rows: dict[str, list[tuple[str, str, str, str]]] = {"v1 (frozen, not gating)": [], "v2": [], accepted_label: []}
    gate_failures = 0
    used: set[tuple[str, str]] = set()
    for advisory in report.get("advisories", {}).values():
        severity = advisory.get("severity", "info")
        ghsa = advisory.get("github_advisory_id") or str(advisory.get("id"))
        module = advisory.get("module_name", "?")
        paths = sorted({p for f in advisory.get("findings", []) for p in f.get("paths", [])})
        v1_paths = [p for p in paths if p.split(">", 1)[0] == V1_IMPORTER]
        v2_paths = [p for p in paths if p.split(">", 1)[0] != V1_IMPORTER]
        if v1_paths:
            rows["v1 (frozen, not gating)"].append((severity, module, ghsa, v1_paths[0]))
        # An exception covers one GHSA on one exact path, until its review date; any other path still counts.
        covered = [p for p in v2_paths if (ghsa, p) in ACCEPTED and ACCEPTED[(ghsa, p)][1] >= today]
        expired = [p for p in v2_paths if (ghsa, p) in ACCEPTED and ACCEPTED[(ghsa, p)][1] < today]
        used.update((ghsa, p) for p in covered + expired)
        open_paths = [p for p in v2_paths if p not in covered]
        for path in covered:
            rows[accepted_label].append((severity, module, ghsa, f"{path} (until {ACCEPTED[(ghsa, path)][1]}: {ACCEPTED[(ghsa, path)][0]})"))
        for path in expired:
            print(f"audit-workspace: exception for {ghsa} on {path} passed its review date {ACCEPTED[(ghsa, path)][1]}", file=sys.stderr)
        if open_paths:
            rows["v2"].append((severity, module, ghsa, open_paths[0]))
            if SEVERITY.get(severity, 0) >= threshold:
                gate_failures += 1

    for scope, items in rows.items():
        print(f"{scope}: {len(items)} advisor{'y' if len(items) == 1 else 'ies'}")
        for severity, module, ghsa, path in sorted(items, key=lambda r: (-SEVERITY.get(r[0], 0), r[1])):
            print(f"  {severity:<9} {module:<28} {ghsa:<22} {path}")
    for ghsa, path in sorted(set(ACCEPTED) - used):
        print(f"note: the exception for {ghsa} on {path} matched nothing; remove it from ACCEPTED")

    if gate_failures:
        print(f"audit-workspace: FAIL: {gate_failures} v2 advisory(ies) at or above '{args.audit_level}'", file=sys.stderr)
        return 1
    print(f"audit-workspace: ok: no v2 advisory at or above '{args.audit_level}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
