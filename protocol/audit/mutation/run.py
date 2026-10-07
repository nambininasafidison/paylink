#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Mutation testing of PayLinkV2 (protocol/audit/README.md#mutation-testing).

Usage, from anywhere (needs Foundry on PATH and FOUNDRY_SOLC for the sandbox, as in ~/.paylink-toolchain/env.sh):

    python3 protocol/audit/mutation/run.py full [ids|all] [--workers N] [--work DIR] [--out results.json]
    python3 protocol/audit/mutation/run.py campaign M11,M13          # the invariant campaign alone, CI profile

`full` runs `forge test` without the script and gas suites against each mutant; `campaign` runs only
`FOUNDRY_PROFILE=ci forge test --match-contract InvariantsTest`. Each mutant is applied to a copy of protocol/
(symlinked dependencies dereferenced) in a temporary work directory; the repository is never modified. A mutant is
KILLED when at least one test fails; the result lists the killing tests. Exit status 1 when any mutant survives.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROTOCOL = HERE.parents[1]
sys.path.insert(0, str(HERE))
os.environ.setdefault("PAYLINK_SRC", str(PROTOCOL / "src" / "PayLinkV2.sol"))
from mutants import MUTANTS  # noqa: E402

SOURCE = (PROTOCOL / "src" / "PayLinkV2.sol").read_text()


def run_one(mutant: tuple[str, str, str, str], mode: str, work_root: Path) -> tuple[str, dict]:
    mid, desc, old, new = mutant
    if SOURCE.count(old) != 1:
        return mid, {"desc": desc, "error": f"pattern occurs {SOURCE.count(old)} times"}
    work = work_root / mid
    shutil.rmtree(work, ignore_errors=True)
    subprocess.run(
        ["rsync", "-aL", "--exclude", "out", "--exclude", "cache", "--exclude", "broadcast", "--exclude", "lcov.info",
         f"{PROTOCOL}/", f"{work}/"],
        check=True,
    )
    (work / "src" / "PayLinkV2.sol").write_text(SOURCE.replace(old, new))
    env = dict(os.environ, FOUNDRY_DENY="never", FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT="0")
    if mode == "campaign":
        env["FOUNDRY_PROFILE"] = "ci"
        cmd = ["forge", "test", "--json", "--match-contract", "InvariantsTest"]
    else:
        cmd = ["forge", "test", "--json", "--no-match-path", "test/{script,gas}/*"]
    started = time.time()
    proc = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True, timeout=3600)
    result: dict = {"desc": desc, "seconds": round(time.time() - started)}
    try:
        data = json.loads(proc.stdout[proc.stdout.index("{"):])
        failed = [
            f"{suite.split(':')[-1]}::{name.split('(')[0]}"
            for suite, s in data.items()
            for name, r in s["test_results"].items()
            if r["status"] == "Failure"
        ]
        passed = sum(1 for s in data.values() for r in s["test_results"].values() if r["status"] != "Failure")
        result.update({"killed": bool(failed), "failed": sorted(failed), "passed": passed})
    except (ValueError, KeyError) as exc:  # compilation failure or unexpected output
        result.update({"error": f"{type(exc).__name__}: {exc}", "stderr": proc.stderr[-2000:]})
    shutil.rmtree(work, ignore_errors=True)
    status = "KILLED" if result.get("killed") else ("ERROR" if "error" in result else "SURVIVED")
    print(f"{mid} {status:8} {desc}", flush=True)
    return mid, result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=["full", "campaign"])
    parser.add_argument("ids", nargs="?", default="all")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--work", type=Path, default=None, help="work directory (default: a new temporary one)")
    parser.add_argument("--out", type=Path, default=None, help="write the results as JSON")
    args = parser.parse_args(argv)
    todo = [m for m in MUTANTS if args.ids == "all" or m[0] in args.ids.split(",")]
    work_root = args.work or Path(tempfile.mkdtemp(prefix="paylink-mutants-"))
    work_root.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = dict(pool.map(lambda m: run_one(m, args.mode, work_root), todo))
    if args.out:
        args.out.write_text(json.dumps(results, indent=1, sort_keys=True) + "\n")
    survived = [mid for mid, r in results.items() if not r.get("killed")]
    print(f"{len(results) - len(survived)}/{len(results)} killed" + (f"; not killed: {', '.join(survived)}" if survived else ""))
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
