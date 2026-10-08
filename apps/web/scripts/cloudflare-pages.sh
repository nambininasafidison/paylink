#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Cloudflare Pages build command for the whole site (docs/runbooks/cloudflare-pages.md):
#
#   Root directory          (empty: the repository root)
#   Build command           bash apps/web/scripts/cloudflare-pages.sh
#   Build output directory  apps/web/dist
#   Environment variables   NODE_VERSION=22.22.0  PNPM_VERSION=10.28.0  SKIP_DEPENDENCY_INSTALL=1
#
# It installs exactly the web app and the workspace packages it uses from pnpm-lock.yaml (frozen: a lockfile that
# does not match package.json fails the build instead of resolving new versions), then runs the production build,
# which builds the editions, copies the frozen v1 app (web/) to /arc/ and the deploy kit to /deploy/ and /v2/deploy/,
# writes _headers and checks the pay route's size budget. Nothing else in the repository is installed or built:
# no Foundry, no relayer, no browsers.
#
# SKIP_DEPENDENCY_INSTALL=1 stops Pages from installing dependencies on its own before this script: the repository
# root also holds the frozen v1 app's package-lock.json, which must not be installed for the v2 site.
#
# Run the same command locally from a clean clone to reproduce a Pages build: bash apps/web/scripts/cloudflare-pages.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

readonly NODE_MIN="22.18.0"
readonly PNPM_PINNED="10.28.0"

node_version="$(node --version | sed 's/^v//')"
if [ "$(printf '%s\n%s\n' "$NODE_MIN" "$node_version" | sort -V | head -n 1)" != "$NODE_MIN" ]; then
  echo "Node $node_version is too old: the build needs Node >= $NODE_MIN (set NODE_VERSION=22.22.0, as in .nvmrc)." >&2
  exit 1
fi

# The pinned pnpm: the one on PATH when it is the right version (Pages installs PNPM_VERSION), otherwise the same
# version through Corepack, otherwise from the npm registry.
if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version)" = "$PNPM_PINNED" ]; then
  pnpm=(pnpm)
elif command -v corepack >/dev/null 2>&1 && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack "pnpm@$PNPM_PINNED" --version >/dev/null 2>&1; then
  pnpm=(env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack "pnpm@$PNPM_PINNED")
else
  pnpm=(npx --yes "pnpm@$PNPM_PINNED")
fi

echo "node $node_version, pnpm $("${pnpm[@]}" --version), commit ${CF_PAGES_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"

"${pnpm[@]}" install --frozen-lockfile --filter "@paylink/web..."
"${pnpm[@]}" --filter @paylink/web run build

test -f apps/web/dist/index.html
test -f apps/web/dist/_headers
test -f apps/web/dist/arc/index.html
test -f apps/web/dist/deploy/index.html
echo "Cloudflare Pages output: apps/web/dist"
