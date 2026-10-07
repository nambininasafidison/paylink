#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# scripts/bootstrap-sandbox.sh: reproducible PayLink v2 toolchain for linux-amd64
# sandboxes (the Claude Code cloud container) where foundryup, svm and
# solc-select downloads are blocked but GitHub release assets, PyPI, the npm
# registry and git over HTTPS are reachable.
#
# Every version and digest comes from scripts/toolchain/pins.env. Each step
# checks the current state first and only downloads what is missing or wrong,
# so the script is idempotent and safe to run on every session start.
#
#   Foundry      ~/.foundry/bin/{forge,cast,anvil,chisel,solar}   sha256-pinned release tarball
#   solc         ~/.svm/<v>/solc-<v>                              sha256-pinned static build (svm layout,
#                                                                 so forge also resolves it offline)
#   Slither      $PAYLINK_TOOLCHAIN_HOME/venv                     hash-locked pip closure
#   solc-select  artifacts point at the same solc binary (in ~ and inside the venv)
#   forge-std    protocol/lib/forge-std                           vendored; offline integrity check only
#   JS deps      pnpm install --frozen-lockfile                   OpenZeppelin 5.3.0 for protocol/
#   env          $PAYLINK_TOOLCHAIN_HOME/env.sh                   PATH, FOUNDRY_SOLC, FOUNDRY_OFFLINE, ...
#
# Usage:
#   scripts/bootstrap-sandbox.sh                install or repair, verify, print versions
#   scripts/bootstrap-sandbox.sh --check        verify only: no network, no writes; exit 1 on drift
#   scripts/bootstrap-sandbox.sh --print-env    print the env exports, for: eval "$(scripts/bootstrap-sandbox.sh --print-env)"
#   Options: --skip-node-deps (do not run pnpm install), --quiet (only warnings, errors and the summary)
#
# Environment:
#   PAYLINK_TOOLCHAIN_HOME   default ~/.paylink-toolchain (venv, shims, env.sh)
#   FOUNDRY_DIR              default ~/.foundry (same variable foundryup honours)
#   CLAUDE_ENV_FILE          set by Claude Code for SessionStart hooks; when present the env
#                            exports are appended to it so later commands in the session see them
#
# Exit codes: 0 ok, 1 verification failed or a step failed, 2 usage error.

set -Eeuo pipefail
IFS=$'\n\t'
umask 022

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly SCRIPT_DIR REPO_ROOT
readonly PINS_FILE="${SCRIPT_DIR}/toolchain/pins.env"
readonly PY_LOCK="${SCRIPT_DIR}/toolchain/requirements-slither.txt"

# shellcheck source-path=SCRIPTDIR source=toolchain/pins.env
source "${PINS_FILE}"

readonly TOOLCHAIN_HOME="${PAYLINK_TOOLCHAIN_HOME:-${HOME}/.paylink-toolchain}"
readonly FOUNDRY_BIN_DIR="${FOUNDRY_DIR:-${HOME}/.foundry}/bin"
readonly SVM_DIR="${HOME}/.svm"
readonly SOLC_BIN="${SVM_DIR}/${PAYLINK_SOLC_VERSION}/solc-${PAYLINK_SOLC_VERSION}"
readonly VENV_DIR="${TOOLCHAIN_HOME}/venv"
readonly SHIM_DIR="${TOOLCHAIN_HOME}/bin"
readonly ENV_FILE="${TOOLCHAIN_HOME}/env.sh"
readonly VENV_STAMP="${VENV_DIR}/.paylink-lock.sha256"
readonly PW_BROWSERS_DIR="/opt/pw-browsers"
readonly -a FOUNDRY_TOOLS=(forge cast anvil chisel)
readonly -a VENV_SHIMS=(slither slither-check-erc slither-read-storage slither-mutate crytic-compile solc-select solc)

MODE="install"
SKIP_NODE_DEPS=0
QUIET=0

# ---------------------------------------------------------------- output

if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  C_RED=$'\e[31m' C_GRN=$'\e[32m' C_YLW=$'\e[33m' C_DIM=$'\e[2m' C_RST=$'\e[0m'
else
  C_RED="" C_GRN="" C_YLW="" C_DIM="" C_RST=""
fi
log() { ((QUIET)) || printf '%s[bootstrap]%s %s\n' "${C_DIM}" "${C_RST}" "$*" >&2; }
ok() { ((QUIET)) || printf '%s[bootstrap] ok%s   %s\n' "${C_GRN}" "${C_RST}" "$*" >&2; }
warn() { printf '%s[bootstrap] warn%s %s\n' "${C_YLW}" "${C_RST}" "$*" >&2; }
err() { printf '%s[bootstrap] FAIL%s %s\n' "${C_RED}" "${C_RST}" "$*" >&2; }
die() {
  err "$*"
  exit 1
}

on_error() {
  local status=$? line="${BASH_LINENO[0]:-?}"
  err "aborted (exit ${status}) at line ${line}: ${BASH_COMMAND}"
  exit "${status}"
}
trap on_error ERR

CLEANUP=()
cleanup() {
  local path
  for path in ${CLEANUP[@]+"${CLEANUP[@]}"}; do rm -rf -- "${path}"; done
}
trap cleanup EXIT

usage() {
  sed -n '4,/^$/{s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}" >&2
  exit 2
}

# ---------------------------------------------------------------- helpers

have() { command -v "$1" >/dev/null 2>&1; }

sha256_file() { sha256sum -- "$1" | cut -d' ' -f1; }

# version_ge A B: true when dotted version A >= B.
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

# download URL DEST SHA256: HTTPS-only fetch with retries; DEST appears only
# after the digest matched.
download() {
  local url="$1" dest="$2" want="$3" got
  log "downloading ${url}"
  curl --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 5 --retry-delay 2 --retry-all-errors \
    --connect-timeout 20 --max-time 900 \
    --output "${dest}.part" -- "${url}"
  got="$(sha256_file "${dest}.part")"
  if [[ "${got}" != "${want}" ]]; then
    rm -f -- "${dest}.part"
    die "sha256 mismatch for ${url}: expected ${want}, got ${got}"
  fi
  mv -f -- "${dest}.part" "${dest}"
}

# Atomically installs SRC as DEST with mode 0755 (same-directory rename).
install_exe() {
  local src="$1" dest="$2"
  install -m 0755 -- "${src}" "${dest}.new.$$"
  mv -f -- "${dest}.new.$$" "${dest}"
}

# Creates a scratch directory that is removed on exit and stores its path in
# TMP_DIR. It sets a global rather than printing the path: a $(...) caller runs
# in a subshell and would lose the CLEANUP registration.
TMP_DIR=""
new_tmp_dir() {
  mkdir -p -- "${TOOLCHAIN_HOME}"
  TMP_DIR="$(mktemp -d "${TOOLCHAIN_HOME}/.tmp.XXXXXX")"
  CLEANUP+=("${TMP_DIR}")
}

# ---------------------------------------------------------------- preflight

preflight() {
  [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] ||
    die "only linux-amd64 is pinned here; on other platforms use foundryup --install ${PAYLINK_FOUNDRY_VERSION} and pip install -r ${PY_LOCK#"${REPO_ROOT}/"}"
  local tool missing=()
  for tool in curl tar sha256sum install mktemp sort git python3 flock; do
    have "${tool}" || missing+=("${tool}")
  done
  ((${#missing[@]} == 0)) || die "missing required tools: ${missing[*]}"
  local py
  py="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  version_ge "${py}" "${PAYLINK_PYTHON_MIN_VERSION}" ||
    die "python3 ${py} is too old; need >= ${PAYLINK_PYTHON_MIN_VERSION}"
  [[ "${py}" == "3.11" ]] ||
    warn "python3 is ${py}; ${PY_LOCK#"${REPO_ROOT}/"} was locked on CPython 3.11 (hashes cover all wheels, markers may differ)"
}

# ---------------------------------------------------------------- Foundry

foundry_ok() {
  local tool out
  for tool in "${FOUNDRY_TOOLS[@]}"; do
    [[ -x "${FOUNDRY_BIN_DIR}/${tool}" ]] || return 1
    out="$("${FOUNDRY_BIN_DIR}/${tool}" --version 2>/dev/null)" || return 1
    [[ "${out}" == *"Version: ${PAYLINK_FOUNDRY_VERSION}"$'\n'* ]] || return 1
    [[ "${out}" == *"Commit SHA: ${PAYLINK_FOUNDRY_COMMIT}"* ]] || return 1
  done
}

install_foundry() {
  if foundry_ok; then
    ok "foundry ${PAYLINK_FOUNDRY_VERSION} already installed in ${FOUNDRY_BIN_DIR}"
    return
  fi
  local tmp tarball entry
  new_tmp_dir
  tmp="${TMP_DIR}"
  tarball="${tmp}/foundry.tar.gz"
  download "${PAYLINK_FOUNDRY_LINUX_AMD64_URL}" "${tarball}" "${PAYLINK_FOUNDRY_LINUX_AMD64_SHA256}"
  # Refuse archives with paths, links or traversal: the release holds flat binaries only.
  while IFS= read -r entry; do
    [[ "${entry}" =~ ^[A-Za-z0-9._-]+$ && "${entry}" != "." && "${entry}" != ".." ]] ||
      die "unexpected entry in Foundry tarball: ${entry}"
  done < <(tar -tzf "${tarball}")
  mkdir -p -- "${tmp}/x" "${FOUNDRY_BIN_DIR}"
  tar -xzf "${tarball}" -C "${tmp}/x" --no-same-owner --no-same-permissions
  for entry in "${tmp}/x"/*; do
    [[ -f "${entry}" && ! -L "${entry}" ]] || die "unexpected non-regular file in Foundry tarball: ${entry##*/}"
    install_exe "${entry}" "${FOUNDRY_BIN_DIR}/${entry##*/}"
  done
  foundry_ok || die "foundry binaries in ${FOUNDRY_BIN_DIR} do not report ${PAYLINK_FOUNDRY_VERSION} (${PAYLINK_FOUNDRY_COMMIT})"
  ok "foundry ${PAYLINK_FOUNDRY_VERSION} installed in ${FOUNDRY_BIN_DIR}"
}

# ---------------------------------------------------------------- solc

solc_ok() {
  [[ -x "${SOLC_BIN}" && ! -L "${SOLC_BIN}" ]] || return 1
  [[ "$(sha256_file "${SOLC_BIN}")" == "${PAYLINK_SOLC_LINUX_AMD64_SHA256}" ]] || return 1
  [[ "$("${SOLC_BIN}" --version 2>/dev/null)" == *"Version: ${PAYLINK_SOLC_LONG_VERSION}."* ]]
}

install_solc() {
  if solc_ok; then
    ok "solc ${PAYLINK_SOLC_LONG_VERSION} already installed at ${SOLC_BIN}"
    return
  fi
  local tmp
  new_tmp_dir
  tmp="${TMP_DIR}"
  download "${PAYLINK_SOLC_LINUX_AMD64_URL}" "${tmp}/solc" "${PAYLINK_SOLC_LINUX_AMD64_SHA256}"
  mkdir -p -- "${SOLC_BIN%/*}"
  install_exe "${tmp}/solc" "${SOLC_BIN}"
  solc_ok || die "solc at ${SOLC_BIN} does not report ${PAYLINK_SOLC_LONG_VERSION}"
  ok "solc ${PAYLINK_SOLC_LONG_VERSION} installed at ${SOLC_BIN}"
}

# ---------------------------------------------------------------- Slither venv

venv_ok() {
  [[ -x "${VENV_DIR}/bin/python" && -f "${VENV_STAMP}" ]] || return 1
  [[ "$(<"${VENV_STAMP}")" == "$(sha256_file "${PY_LOCK}")" ]] || return 1
  [[ -x "${VENV_DIR}/bin/slither" ]] || return 1
  [[ "$("${VENV_DIR}/bin/slither" --version 2>/dev/null)" == "${PAYLINK_SLITHER_VERSION}" ]]
}

install_venv() {
  if venv_ok; then
    ok "slither ${PAYLINK_SLITHER_VERSION} venv already matches the lock (${VENV_DIR})"
    return
  fi
  log "creating venv ${VENV_DIR} from ${PY_LOCK#"${REPO_ROOT}/"}"
  rm -rf -- "${VENV_DIR}"
  python3 -m venv "${VENV_DIR}"
  # --require-hashes: every artifact must match the lock; --no-deps: nothing outside the
  # lock can be pulled in; --only-binary: no sdist build scripts run at install time.
  if ! PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "${VENV_DIR}/bin/python" -m pip install \
    --quiet --require-hashes --no-deps --only-binary=:all: -r "${PY_LOCK}"; then
    rm -rf -- "${VENV_DIR}"
    die "pip install from ${PY_LOCK#"${REPO_ROOT}/"} failed; the venv was removed"
  fi
  "${VENV_DIR}/bin/python" -m pip check --quiet >/dev/null ||
    die "pip check reports broken requirements in ${VENV_DIR}"
  sha256_file "${PY_LOCK}" >"${VENV_STAMP}"
  venv_ok || die "slither in ${VENV_DIR} does not report ${PAYLINK_SLITHER_VERSION}"
  ok "slither ${PAYLINK_SLITHER_VERSION} installed in ${VENV_DIR}"
}

# solc-select keeps its state in $VIRTUAL_ENV/.solc-select when a venv is
# active and in ~/.solc-select otherwise; both point at the pinned binary.
solc_select_dirs() { printf '%s\n' "${HOME}/.solc-select" "${VENV_DIR}/.solc-select"; }

solc_select_ok() {
  local dir artifact
  while IFS= read -r dir; do
    artifact="${dir}/artifacts/solc-${PAYLINK_SOLC_VERSION}/solc-${PAYLINK_SOLC_VERSION}"
    [[ "$(readlink -- "${artifact}" 2>/dev/null)" == "${SOLC_BIN}" ]] || return 1
    [[ -f "${dir}/global-version" && "$(<"${dir}/global-version")" == "${PAYLINK_SOLC_VERSION}" ]] || return 1
  done < <(solc_select_dirs)
  [[ -x "${SHIM_DIR}/solc" ]] || return 1
  [[ "$(env -u VIRTUAL_ENV -u SOLC_VERSION "${SHIM_DIR}/solc" --version 2>/dev/null)" == *"${PAYLINK_SOLC_LONG_VERSION}"* ]]
}

configure_solc_select() {
  local dir artifact_dir
  while IFS= read -r dir; do
    artifact_dir="${dir}/artifacts/solc-${PAYLINK_SOLC_VERSION}"
    mkdir -p -- "${artifact_dir}"
    ln -sfn -- "${SOLC_BIN}" "${artifact_dir}/solc-${PAYLINK_SOLC_VERSION}"
  done < <(solc_select_dirs)
  # `use` is offline when the version is already installed.
  env -u VIRTUAL_ENV -u SOLC_VERSION "${VENV_DIR}/bin/solc-select" use "${PAYLINK_SOLC_VERSION}" >/dev/null
  env -u SOLC_VERSION VIRTUAL_ENV="${VENV_DIR}" "${VENV_DIR}/bin/solc-select" use "${PAYLINK_SOLC_VERSION}" >/dev/null
}

# Exposes only the analysis entry points, so the venv's python does not shadow
# the system python on PATH.
shims_ok() {
  local name
  for name in "${VENV_SHIMS[@]}"; do
    [[ "$(readlink -- "${SHIM_DIR}/${name}" 2>/dev/null)" == "${VENV_DIR}/bin/${name}" ]] || return 1
  done
}

install_shims() {
  mkdir -p -- "${SHIM_DIR}"
  local name
  for name in "${VENV_SHIMS[@]}"; do
    [[ -x "${VENV_DIR}/bin/${name}" ]] || die "venv entry point missing: ${VENV_DIR}/bin/${name}"
    ln -sfn -- "${VENV_DIR}/bin/${name}" "${SHIM_DIR}/${name}"
  done
}

configure_analysis() {
  if shims_ok && solc_select_ok; then
    ok "solc-select ${PAYLINK_SOLC_SELECT_VERSION} already points at ${SOLC_BIN}"
    return
  fi
  install_shims
  configure_solc_select
  solc_select_ok || die "solc-select does not resolve ${PAYLINK_SOLC_VERSION} to ${SOLC_BIN}"
  ok "solc-select ${PAYLINK_SOLC_SELECT_VERSION} uses ${SOLC_BIN}; shims in ${SHIM_DIR}"
}

# ---------------------------------------------------------------- Node workspace

# Sets PNPM to the pinned pnpm: the one on PATH when it matches, otherwise
# corepack (bundled with Node), which fetches that exact version from npm.
PNPM=()
resolve_pnpm() {
  if have pnpm && [[ "$(pnpm --version 2>/dev/null || true)" == "${PAYLINK_PNPM_VERSION}" ]]; then
    PNPM=(pnpm)
  elif have corepack; then
    PNPM=(corepack "pnpm@${PAYLINK_PNPM_VERSION}")
  else
    return 1
  fi
}

node_ok() {
  have node || return 1
  local node_version
  node_version="$(node --version)"
  node_version="${node_version#v}"
  version_ge "${node_version}" "${PAYLINK_NODE_MIN_VERSION}" || return 1
  [[ "${node_version}" == "${PAYLINK_NODE_VERSION}" ]] ||
    warn "node ${node_version} differs from .nvmrc ${PAYLINK_NODE_VERSION} (>= ${PAYLINK_NODE_MIN_VERSION} is accepted)"
}

oz_ok() {
  local manifest="${REPO_ROOT}/protocol/node_modules/@openzeppelin/contracts/package.json"
  [[ -f "${manifest}" ]] || return 1
  [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${manifest}")" == \
    "${PAYLINK_OPENZEPPELIN_CONTRACTS_VERSION}" ]]
}

install_node_deps() {
  node_ok || die "node >= ${PAYLINK_NODE_MIN_VERSION} is required (pinned: ${PAYLINK_NODE_VERSION}, see .nvmrc)"
  if ((SKIP_NODE_DEPS)); then
    log "skipping pnpm install (--skip-node-deps)"
    return
  fi
  [[ -f "${REPO_ROOT}/pnpm-lock.yaml" ]] || die "pnpm-lock.yaml is missing in ${REPO_ROOT}"
  resolve_pnpm || die "pnpm ${PAYLINK_PNPM_VERSION} is unavailable (no matching pnpm on PATH and no corepack)"
  log "pnpm install --frozen-lockfile (via: ${PNPM[*]})"
  (cd -- "${REPO_ROOT}" && "${PNPM[@]}" install --frozen-lockfile --prefer-offline --reporter=append-only) |
    { if ((QUIET)); then cat >/dev/null; else sed 's/^/[pnpm] /' >&2; fi; }
  oz_ok || die "protocol/node_modules does not provide @openzeppelin/contracts ${PAYLINK_OPENZEPPELIN_CONTRACTS_VERSION}"
  ok "workspace dependencies installed (OpenZeppelin Contracts ${PAYLINK_OPENZEPPELIN_CONTRACTS_VERSION})"
}

# ---------------------------------------------------------------- env

render_env() {
  cat <<EOF
# Generated by scripts/bootstrap-sandbox.sh from scripts/toolchain/pins.env. Do not edit.
case ":\${PATH}:" in *":${SHIM_DIR}:"*) ;; *) export PATH="${SHIM_DIR}:\${PATH}" ;; esac
case ":\${PATH}:" in *":${FOUNDRY_BIN_DIR}:"*) ;; *) export PATH="${FOUNDRY_BIN_DIR}:\${PATH}" ;; esac
export FOUNDRY_SOLC="${SOLC_BIN}"
export FOUNDRY_OFFLINE=true
EOF
  if [[ -d "${PW_BROWSERS_DIR}" ]]; then
    cat <<EOF
export PLAYWRIGHT_BROWSERS_PATH="${PW_BROWSERS_DIR}"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
EOF
  fi
}

write_env() {
  mkdir -p -- "${TOOLCHAIN_HOME}"
  render_env >"${ENV_FILE}.tmp"
  mv -f -- "${ENV_FILE}.tmp" "${ENV_FILE}"
  if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
    render_env >>"${CLAUDE_ENV_FILE}"
    log "appended env exports to CLAUDE_ENV_FILE"
  fi
  ok "env written to ${ENV_FILE}"
}

env_ok() { [[ -f "${ENV_FILE}" && "$(<"${ENV_FILE}")" == "$(render_env)" ]]; }

# ---------------------------------------------------------------- summary

first_line() { "$@" 2>/dev/null | head -n1 || true; }

print_versions() {
  local pnpm_version="not found"
  if resolve_pnpm; then pnpm_version="$(first_line "${PNPM[@]}" --version)"; fi
  {
    printf '\nPayLink v2 toolchain (pins: %s)\n' "${PINS_FILE#"${REPO_ROOT}/"}"
    printf '  %-15s %s\n' \
      forge "$(first_line "${FOUNDRY_BIN_DIR}/forge" --version)" \
      cast "$(first_line "${FOUNDRY_BIN_DIR}/cast" --version)" \
      anvil "$(first_line "${FOUNDRY_BIN_DIR}/anvil" --version)" \
      chisel "$(first_line "${FOUNDRY_BIN_DIR}/chisel" --version)" \
      solc "$("${SOLC_BIN}" --version 2>/dev/null | sed -n 's/^Version: //p' || true)" \
      slither "$(first_line "${SHIM_DIR}/slither" --version)" \
      crytic-compile "$(first_line "${VENV_DIR}/bin/python" -c 'from importlib.metadata import version as v; print(v("crytic-compile"))')" \
      solc-select "$(first_line "${VENV_DIR}/bin/python" -c 'from importlib.metadata import version as v; print(v("solc-select"))') -> $(cat "${HOME}/.solc-select/global-version" 2>/dev/null || true)" \
      python "$(first_line "${VENV_DIR}/bin/python" --version)" \
      node "$(first_line node --version)" \
      pnpm "${pnpm_version}" \
      forge-std "${PAYLINK_FORGE_STD_TAG} (${PAYLINK_FORGE_STD_COMMIT:0:12}, vendored)" \
      openzeppelin "$(oz_ok && printf '%s' "${PAYLINK_OPENZEPPELIN_CONTRACTS_VERSION}" || printf 'not installed')"
    printf '\nActivate in this shell:  source %s\n' "${ENV_FILE}"
  } >&2
}

# ---------------------------------------------------------------- modes

analysis_ok() { shims_ok && solc_select_ok; }
forge_std_ok() { "${SCRIPT_DIR}/toolchain/vendor-forge-std.sh" --check 2>/dev/null; }
v1_lock_parity_ok() { python3 "${SCRIPT_DIR}/toolchain/check-v1-lock-parity.py" "${REPO_ROOT}" >/dev/null; }

run_check() {
  local failed=0
  check() {
    local label="$1"
    shift
    if "$@"; then ok "${label}"; else
      err "${label}"
      failed=1
    fi
  }
  check "foundry ${PAYLINK_FOUNDRY_VERSION} (${PAYLINK_FOUNDRY_COMMIT:0:12}) in ${FOUNDRY_BIN_DIR}" foundry_ok
  check "solc ${PAYLINK_SOLC_LONG_VERSION} at ${SOLC_BIN} (sha256 pinned)" solc_ok
  check "slither ${PAYLINK_SLITHER_VERSION} venv matches ${PY_LOCK#"${REPO_ROOT}/"}" venv_ok
  check "solc-select and shims resolve ${PAYLINK_SOLC_VERSION}" analysis_ok
  check "forge-std ${PAYLINK_FORGE_STD_TAG} vendored tree matches its pinned manifest" forge_std_ok
  check "node >= ${PAYLINK_NODE_MIN_VERSION}" node_ok
  check "OpenZeppelin Contracts ${PAYLINK_OPENZEPPELIN_CONTRACTS_VERSION} in protocol/node_modules" oz_ok
  check "pnpm resolves v1 to the package-lock.json versions" v1_lock_parity_ok
  check "env file ${ENV_FILE} is current" env_ok
  ((failed == 0)) || die "toolchain drift detected; run scripts/bootstrap-sandbox.sh to repair"
  ok "toolchain verified"
}

run_install() {
  preflight
  mkdir -p -- "${TOOLCHAIN_HOME}"
  # Serialise concurrent runs (e.g. a SessionStart hook racing a manual run).
  exec 9>"${TOOLCHAIN_HOME}/.bootstrap.lock"
  flock -w 900 9 || die "timed out waiting for another bootstrap run (${TOOLCHAIN_HOME}/.bootstrap.lock)"
  # Scratch left by an interrupted run (SIGKILL skips the EXIT trap); safe while holding the lock.
  rm -rf -- "${TOOLCHAIN_HOME}"/.tmp.*

  install_foundry
  install_solc
  install_venv
  configure_analysis
  "${SCRIPT_DIR}/toolchain/vendor-forge-std.sh" --check
  python3 "${SCRIPT_DIR}/toolchain/check-v1-lock-parity.py" "${REPO_ROOT}" >&2
  install_node_deps
  write_env
  print_versions
}

main() {
  while (($#)); do
    case "$1" in
      --check) MODE="check" ;;
      --print-env) MODE="print-env" ;;
      --skip-node-deps) SKIP_NODE_DEPS=1 ;;
      --quiet) QUIET=1 ;;
      -h | --help) usage ;;
      *)
        err "unknown argument: $1"
        usage
        ;;
    esac
    shift
  done
  case "${MODE}" in
    install) run_install ;;
    check) run_check ;;
    print-env) render_env ;;
    *) die "internal error: unknown mode ${MODE}" ;;
  esac
}

main "$@"
