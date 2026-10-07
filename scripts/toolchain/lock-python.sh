#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Regenerates scripts/toolchain/requirements-slither.txt, the hash-locked
# closure of requirements-slither.in, with pip-tools in a throwaway venv.
# Run it after changing a top-level pin, review the diff, then re-run
# scripts/bootstrap-sandbox.sh (its venv stamp follows the lock's sha256).
#
# Lock on CPython 3.11 (the sandbox interpreter) so environment markers match.
# --generate-hashes records every wheel and sdist digest for each pinned
# version, so the lock still verifies on other platforms.

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly PIP_TOOLS_VERSION=7.6.1

work="$(mktemp -d)"
trap 'rm -rf -- "${work}"' EXIT

python3 -m venv "${work}/venv"
"${work}/venv/bin/python" -m pip install --quiet --disable-pip-version-check "pip-tools==${PIP_TOOLS_VERSION}"
cd -- "${SCRIPT_DIR}"
"${work}/venv/bin/pip-compile" --quiet --generate-hashes --allow-unsafe --strip-extras \
  --resolver=backtracking --no-emit-index-url \
  --output-file=requirements-slither.txt requirements-slither.in
printf 'lock-python: wrote %s/requirements-slither.txt\n' "${SCRIPT_DIR}"
