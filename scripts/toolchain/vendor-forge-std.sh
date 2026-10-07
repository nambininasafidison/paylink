#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Vendors forge-std into protocol/lib/forge-std from a pinned git commit and
# verifies the vendored tree. Rationale: docs/adr/0012-toolchain-pinning-and-vendoring.md.
#
# Usage:
#   scripts/toolchain/vendor-forge-std.sh --check           Offline gate (CI, bootstrap). Recomputes the
#                                                           manifest of protocol/lib/forge-std and requires it
#                                                           to equal protocol/lib/forge-std.manifest, whose
#                                                           sha256 must equal PAYLINK_FORGE_STD_MANIFEST_SHA256.
#   scripts/toolchain/vendor-forge-std.sh --check-upstream  Fetches the pinned commit and compares the export
#                                                           with the vendored tree. Writes nothing.
#   scripts/toolchain/vendor-forge-std.sh --sync            Fetches the pinned commit, verifies it, and replaces
#                                                           protocol/lib/forge-std plus its manifest.
#   scripts/toolchain/vendor-forge-std.sh --print-digest    Fetches and prints the manifest digest. Use it when
#                                                           bumping: update pins.env, then run --sync.
#
# Trust chain: tag -> commit hash (pinned) -> tree hash (pinned) -> exported
# subset -> per-file sha256 manifest (committed) -> manifest sha256 (pinned).
# Git checks every fetched object against its hash, and the manifest digest
# makes the vendored tree verifiable offline.
#
# Requires GNU coreutils and findutils (Linux sandbox, GitHub-hosted runners).

set -Eeuo pipefail
IFS=$'\n\t'
umask 022

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
readonly SCRIPT_DIR REPO_ROOT

# shellcheck source-path=SCRIPTDIR source=pins.env
source "${SCRIPT_DIR}/pins.env"

readonly LIB_DIR="${REPO_ROOT}/protocol/lib"
readonly VENDOR_DIR="${LIB_DIR}/forge-std"
readonly MANIFEST="${LIB_DIR}/forge-std.manifest"
# Upstream paths that are vendored. Everything else (tests, CI, scripts) stays upstream.
readonly -a VENDOR_PATHS=(src LICENSE-APACHE LICENSE-MIT package.json)

die() { printf 'vendor-forge-std: error: %s\n' "$*" >&2; exit 1; }
info() { printf 'vendor-forge-std: %s\n' "$*" >&2; }

# Temporary paths are removed on every exit path, including errors.
CLEANUP=()
cleanup() {
  local path
  for path in ${CLEANUP[@]+"${CLEANUP[@]}"}; do rm -rf -- "${path}"; done
}
trap cleanup EXIT

for tool in git tar sha256sum find sort xargs diff mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || die "missing required tool: ${tool}"
done

# Prints a deterministic "sha256  ./relative/path" manifest of regular files.
# Fails on anything that is not a regular file or directory (symlinks, devices).
manifest_of() {
  local dir="$1" odd
  odd="$(find "${dir}" -mindepth 1 ! -type f ! -type d -print -quit)"
  [[ -z "${odd}" ]] || die "unexpected non-regular file in ${dir}: ${odd}"
  (cd -- "${dir}" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 --no-run-if-empty sha256sum)
}

sha256_of_stdin() { sha256sum | cut -d' ' -f1; }

# Fetches the pinned tag, checks the commit and tree hashes, and exports
# VENDOR_PATHS into the (empty) directory given as $1.
fetch_export() {
  local dest="$1" work commit tree
  work="$(mktemp -d)"
  CLEANUP+=("${work}")
  git -C "${work}" init --quiet
  GIT_TERMINAL_PROMPT=0 git -C "${work}" -c transfer.fsckObjects=true \
    fetch --quiet --depth=1 --no-tags "${PAYLINK_FORGE_STD_REPO}" \
    "refs/tags/${PAYLINK_FORGE_STD_TAG}"
  commit="$(git -C "${work}" rev-parse --verify 'FETCH_HEAD^{commit}')"
  tree="$(git -C "${work}" rev-parse --verify 'FETCH_HEAD^{tree}')"
  [[ "${commit}" == "${PAYLINK_FORGE_STD_COMMIT}" ]] ||
    die "tag ${PAYLINK_FORGE_STD_TAG} resolves to ${commit}, expected ${PAYLINK_FORGE_STD_COMMIT} (retagged upstream?)"
  [[ "${tree}" == "${PAYLINK_FORGE_STD_TREE}" ]] ||
    die "commit ${commit} has tree ${tree}, expected ${PAYLINK_FORGE_STD_TREE}"
  git -C "${work}" archive --format=tar "${commit}" -- "${VENDOR_PATHS[@]}" |
    tar -x --no-same-owner --no-same-permissions -C "${dest}"
  info "fetched ${PAYLINK_FORGE_STD_TAG} = ${commit} (tree ${tree})"
}

check_offline() {
  [[ -d "${VENDOR_DIR}" ]] || die "${VENDOR_DIR} is missing; run --sync"
  [[ -f "${MANIFEST}" ]] || die "${MANIFEST} is missing; run --sync"
  local pinned="${PAYLINK_FORGE_STD_MANIFEST_SHA256}" committed actual
  committed="$(sha256_of_stdin <"${MANIFEST}")"
  [[ "${committed}" == "${pinned}" ]] ||
    die "manifest digest ${committed} does not match the pin ${pinned} in scripts/toolchain/pins.env"
  if ! actual="$(manifest_of "${VENDOR_DIR}" | diff -u "${MANIFEST}" - 2>&1)"; then
    printf '%s\n' "${actual}" >&2
    die "protocol/lib/forge-std differs from its manifest (local edits are not allowed; run --sync)"
  fi
  info "ok: forge-std ${PAYLINK_FORGE_STD_TAG} (${PAYLINK_FORGE_STD_COMMIT:0:12}), manifest ${pinned:0:16}..."
}

check_upstream() {
  local stage
  stage="$(mktemp -d)"
  CLEANUP+=("${stage}")
  fetch_export "${stage}"
  if ! diff -r -q "${stage}" "${VENDOR_DIR}" >&2; then
    die "vendored tree differs from upstream ${PAYLINK_FORGE_STD_COMMIT}"
  fi
  manifest_of "${stage}" | diff -u "${MANIFEST}" - >&2 || die "committed manifest differs from upstream export"
  info "ok: vendored tree is identical to upstream ${PAYLINK_FORGE_STD_TAG}"
}

print_digest() {
  local stage
  stage="$(mktemp -d)"
  CLEANUP+=("${stage}")
  fetch_export "${stage}"
  manifest_of "${stage}" | sha256_of_stdin
}

sync_vendor() {
  mkdir -p -- "${LIB_DIR}"
  local stage digest
  # Stage next to the destination so the final swap is a same-filesystem rename.
  stage="$(mktemp -d "${LIB_DIR}/.forge-std.stage.XXXXXX")"
  CLEANUP+=("${stage}" "${VENDOR_DIR}.old" "${MANIFEST}.tmp")
  fetch_export "${stage}"
  digest="$(manifest_of "${stage}" | sha256_of_stdin)"
  if [[ "${digest}" != "${PAYLINK_FORGE_STD_MANIFEST_SHA256}" ]]; then
    die "export digest ${digest} does not match the pin ${PAYLINK_FORGE_STD_MANIFEST_SHA256};" \
      "if this is an intentional bump, set PAYLINK_FORGE_STD_MANIFEST_SHA256=${digest} in pins.env and re-run"
  fi
  chmod 0755 "${stage}"
  manifest_of "${stage}" >"${MANIFEST}.tmp"
  rm -rf -- "${VENDOR_DIR}.old"
  if [[ -e "${VENDOR_DIR}" ]]; then mv -- "${VENDOR_DIR}" "${VENDOR_DIR}.old"; fi
  mv -- "${stage}" "${VENDOR_DIR}"
  mv -f -- "${MANIFEST}.tmp" "${MANIFEST}"
  info "vendored forge-std ${PAYLINK_FORGE_STD_TAG} into protocol/lib/forge-std"
  check_offline
}

case "${1:-}" in
  --check) check_offline ;;
  --check-upstream) check_upstream ;;
  --sync) sync_vendor ;;
  --print-digest) print_digest ;;
  -h | --help) sed -n '4,/^$/{s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}" ;;
  *) die "usage: $(basename -- "$0") --check | --check-upstream | --sync | --print-digest" ;;
esac
