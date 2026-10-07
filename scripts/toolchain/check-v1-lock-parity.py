#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Check that pnpm installs the frozen v1 app with exactly the versions npm locked.

The root package.json is the frozen v1 app and also the pnpm workspace root
project (docs/adr/0011-workspace-layout.md), so two lockfiles describe v1:
package-lock.json (npm, frozen) and the "." importer of pnpm-lock.yaml. The
check fails when
  1. the "." importer specifiers differ from the root package.json, or
  2. any package that pnpm resolves for "." (its transitive closure) has a
     name@version that package-lock.json does not contain.

No third-party modules are needed: pnpm-lock.yaml v9 is scanned with simple
line rules that rely only on its stable indentation.

Usage: python3 scripts/toolchain/check-v1-lock-parity.py [repo_root]
Exit codes: 0 parity holds, 1 parity violated, 2 unexpected input.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEP_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies")


def fail(code: int, message: str) -> None:
    print(f"check-v1-lock-parity: {message}", file=sys.stderr)
    sys.exit(code)


def unquote(token: str) -> str:
    return token.strip().strip("'\"")


def strip_peer_suffix(version: str) -> str:
    # "6.17.0(bufferutil@4.0.7)(utf-8-validate@6.0.3)" -> "6.17.0"
    return version.split("(", 1)[0]


def split_name_version(key: str) -> tuple[str, str]:
    key = strip_peer_suffix(unquote(key))
    at = key.rfind("@")
    if at <= 0:
        fail(2, f"cannot parse package key {key!r}")
    return key[:at], key[at + 1 :]


def parse_pnpm_lock(text: str) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    """Returns (root importer {section: {name: version}}, snapshots {name@version: {dep: version}})."""
    if not re.search(r"^lockfileVersion: '9\.\d+'", text, re.M):
        fail(2, "pnpm-lock.yaml is not lockfile v9; update this checker")

    importer: dict[str, dict[str, str]] = {}
    snapshots: dict[str, dict[str, str]] = {}
    top = None
    importer_name = None
    section = None
    pending_name = None
    snapshot_key = None

    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        if indent == 0:
            top = line.rstrip(":")
            importer_name = section = pending_name = snapshot_key = None
            continue
        if top == "importers":
            if indent == 2:
                importer_name = unquote(line.rstrip(":"))
                section = None
            elif importer_name == "." and indent == 4:
                section = line.rstrip(":")
                importer.setdefault(section, {})
            elif importer_name == "." and indent == 6 and section in DEP_SECTIONS:
                pending_name = unquote(line.rstrip(":"))
            elif importer_name == "." and indent == 8 and pending_name and line.startswith("version:"):
                importer[section][pending_name] = strip_peer_suffix(unquote(line.split(":", 1)[1]))
        elif top == "snapshots":
            if indent == 2:
                snapshot_key = "@".join(split_name_version(line.removesuffix(" {}").rstrip(":")))
                snapshots.setdefault(snapshot_key, {})
                section = None
            elif indent == 4:
                # Only edges that install something; transitivePeerDependencies is a list of names.
                section = line.rstrip(":") if line.rstrip(":") in ("dependencies", "optionalDependencies") else None
            elif indent == 6 and snapshot_key and section:
                name, _, version = line.partition(":")
                snapshots[snapshot_key][unquote(name)] = strip_peer_suffix(unquote(version))
    return importer, snapshots


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
    try:
        manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
        npm_lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
        pnpm_text = (root / "pnpm-lock.yaml").read_text(encoding="utf-8")
    except (OSError, ValueError) as exc:
        fail(2, f"cannot read lockfiles: {exc}")

    npm_versions = {
        f"{path.rsplit('node_modules/', 1)[-1]}@{meta['version']}"
        for path, meta in npm_lock.get("packages", {}).items()
        if path and "version" in meta
    }
    importer, snapshots = parse_pnpm_lock(pnpm_text)

    errors: list[str] = []
    for section in DEP_SECTIONS:
        declared = set((manifest.get(section) or {}).keys())
        locked = set((importer.get(section) or {}).keys())
        if declared != locked:
            errors.append(f'{section}: package.json has {sorted(declared)}, pnpm "." importer has {sorted(locked)}')

    # Transitive closure of the root importer through the snapshots section.
    queue = [f"{name}@{version}" for deps in importer.values() for name, version in deps.items()]
    closure: set[str] = set()
    while queue:
        key = queue.pop()
        if key in closure:
            continue
        closure.add(key)
        for dep, version in snapshots.get(key, {}).items():
            queue.append(f"{dep}@{version}")

    missing = sorted(closure - npm_versions)
    if missing:
        errors.append("resolved by pnpm for v1 but absent from package-lock.json: " + ", ".join(missing))
    if errors:
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        fail(1, "v1 lockfile parity violated (re-seed with `pnpm import`, see docs/adr/0011)")
    print(f"check-v1-lock-parity: ok ({len(closure)} v1 packages resolved by pnpm, all pinned in package-lock.json)")


if __name__ == "__main__":
    main()
