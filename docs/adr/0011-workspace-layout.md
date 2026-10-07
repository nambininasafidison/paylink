# ADR 0011: pnpm workspace at the repository root, with the frozen v1 manifest as the root project

- **Status:** accepted
- **Date:** 2026-10-05
- **Deciders:** nambininasafidison (owner), Claude Code (engineering)
- **Related:** PAYLINK-V2-SPEC §0 decision 6, §3.2, §4.5, §5 threat #17; ADR 0010 (Arc stays on v1); ADR 0012 (toolchain pinning)

## Context

PayLink v1 is the Arc Microgrants entry. Its files on `main` must stay byte-identical (tag `arc-microgrants-v1` = `93ed4e3`), because GitHub Pages serves `/paylink/web/` from `main` and the submission links point there. v1 is an **npm** project, and its root `package.json` is part of the freeze:

- `name: arc-paylink`;
- scripts `compile`, `test` and `deploy`;
- `ethers ^6.13.0`, `solc 0.8.26`, `ganache ^7.9.2`;
- `package-lock.json` (lockfile v3).

`npm test` compiles `contracts/PayLink.sol` with solc-js and rewrites the tracked `web/abi.js`, `web/bytecode.js` and `verify/PayLink.standard-input.json`. Those files only stay identical when solc 0.8.26 is the version that runs.

The spec wants v2 in a **pnpm 10.28.0 workspace** (`protocol/`, `packages/*`, `apps/*`, `e2e/`). Two pnpm facts constrain the layout:

1. pnpm finds the workspace by walking up from the current directory to the first `pnpm-workspace.yaml`. Top-level folders can therefore only belong to a workspace rooted at the repository root.
2. The directory that holds `pnpm-workspace.yaml` is **always** a workspace project. `@pnpm/workspace.find-packages` calls `findPackages` with `includeRoot: true`. The root `package.json`, here v1's, is installed by `pnpm install` whatever the `packages:` globs say.

npm reads a root `.npmrc` and the `workspaces` field of the root `package.json`.

## Options considered

| Option | Verdict |
|---|---|
| A. Workspace at the root; v1's unchanged `package.json` is the root project; all pnpm settings in `pnpm-workspace.yaml` | **Chosen** |
| B. Add `workspaces`, `packageManager`, scripts or devDependencies to the root `package.json` | Rejected: breaks the byte-identical freeze |
| C. Move v1 into `v1/` | Rejected: breaks the Pages URL `/paylink/web/` and the submitted links, and breaks the freeze |
| D. Nest v2 under a subfolder (`v2/protocol`, …) with its own workspace root | Rejected: contradicts the spec layout and adds a prefix to every path and CI filter. It also does not isolate anything, since `node_modules/` resolution still walks up to the root |
| E. Keep v1 on npm and v2 on pnpm in separate `node_modules` trees | Not possible: the root project's `node_modules/` is the repository's `node_modules/` for both tools |

## Decision

1. **`pnpm-workspace.yaml` at the root** lists only v2 folders: `protocol`, `packages/*`, `apps/*`, `e2e`. The unchanged v1 `package.json` is the root project `"."`, so `pnpm install` also installs v1's three dependencies.
2. **v1 resolves to exactly the versions npm locked.** The `"."` importer of `pnpm-lock.yaml` was seeded with `pnpm import` from `package-lock.json`: ethers 6.17.0, solc 0.8.26, ganache 7.9.2, ws 8.21.0, and so on. `scripts/toolchain/check-v1-lock-parity.py` enforces it. Every package in the transitive closure that pnpm resolves for `"."` must appear with the same `name@version` in `package-lock.json`, and the importer's specifiers must match `package.json`. The checker runs in `scripts/bootstrap-sandbox.sh` and is meant for CI (`contracts.yml`/`ci.yml`).
3. **pnpm owns `node_modules/`.** v1's `npm test` runs unchanged against the pnpm-installed tree. This was verified both on the converted sandbox tree and on a fresh clone bootstrapped from scratch. `npm ci` still works for v1 on its own; afterwards, run `pnpm install` to restore the v2 links.
4. **All workspace settings live in `pnpm-workspace.yaml`** (pnpm 10 reads settings there). There is **no root `.npmrc`**, because npm would also read it while running v1.
5. **No root scripts or root devDependencies.** Each package declares its own tools. Shared versions come from the pnpm **catalog** (`catalog:` specifiers, `catalogMode: prefer`), which holds the spec's exact pins. Recursive commands use `pnpm -r …`, which leaves out the root (v1) project by default.
6. **Version pins without the root manifest.** `packageManager` cannot be added to the root `package.json`, so:
   - pnpm 10.28.0 is pinned in `scripts/toolchain/pins.env`. The bootstrap uses the `pnpm` on PATH only when it matches, and otherwise falls back to `corepack pnpm@10.28.0`. CI pins it with `pnpm/action-setup` `version: 10.28.0`.
   - Node is pinned by `.nvmrc` (22.22.0, used by `actions/setup-node` `node-version-file`) and by `engines.node >= 22.18.0` in every v2 package, which `PAYLINK_NODE_MIN_VERSION` in `pins.env` mirrors for the bootstrap check. The floor is 22.18.0, not the 22.12 of PAYLINK-V2-SPEC §3.2: the packages' own scripts (`generate`, `generate:check`, `measure:gas`) run TypeScript sources directly, which needs type stripping without a flag, and Node only has that from 22.18.0. On 22.12 to 22.17 the ABI and registry drift checks would crash with `ERR_UNKNOWN_FILE_EXTENSION` instead of running (2026-10-07 review).
7. **Supply-chain policy** in `pnpm-workspace.yaml` (spec §4.5, threat #17):
   - `savePrefix: ''` (exact pins).
   - `strictDepBuilds: true` with an empty `onlyBuiltDependencies`. Every build script is either allowed or explicitly ignored, with a reason.
   - Reviewed `ignoredBuiltDependencies`:
     - `bufferutil` and `utf-8-validate`: v1 ganache, optional;
     - `esbuild` and `workerd`: verified to work without their postinstall.
   - `blockExoticSubdeps: true`.
   - `trustPolicy: no-downgrade` limited to versions published in the last 30 days (`trustPolicyIgnoreAfter: 43200`). The check is meant to catch account takeovers, which are live in that window. Without the limit, old maintenance backports such as `semver@6.3.1` fail.
   - `auditConfig.ignoreGhsas: [GHSA-9rcw-c2f9-2j55]`, the documented OZ 5.3.0 `Bytes.sol` exception from spec §3.3.5.

## Consequences

**Positive**
- v1 stays byte-identical, Pages is unaffected, and `npm test` stays green.
- One `pnpm install` sets up v1 and v2. There is one v2 lockfile, with sha512 integrity for every package, OpenZeppelin included.
- Build scripts, exotic sources and trust downgrades fail closed.

**Negative and mitigations**
- **Two lockfiles describe v1:** `package-lock.json` and the `"."` importer. They cannot drift silently, because `package.json` is frozen and the parity check fails on any difference. To re-seed: `pnpm import && pnpm install`.
- **v1's dependencies are in the v2 lockfile** (46 packages, including ganache). `pnpm audit` reports them too, attributed to the `"."` importer, and it cannot be filtered by project. The spec's gate `pnpm audit --prod --audit-level high` would therefore fail on frozen v1 tooling: `solc` (solc-js 0.8.26) → `tmp` (GHSA-ph9p-34f9-6g65, high). v1's Node dependencies are only compile, test and deploy tooling; the deployed site loads the vendored `web/ethers.umd.min.js`. The CI gate is therefore `python3 scripts/toolchain/audit-workspace.py --prod --audit-level high`. It runs `pnpm audit --json`, prints the v1 and v2 advisories separately, and fails only on v2 importers. The GHSA is deliberately **not** added to `ignoreGhsas`, because that list is global and would also hide a future v2 path to `tmp`.
- **Mixing package managers is a footgun.** `npm install` or `npm ci` at the root replaces pnpm's layout; `pnpm install` restores it. The first `pnpm install` over an npm-built tree moves the npm-installed packages to `node_modules/.ignored_*`. This is one-time and harmless.
- **No `packageManager` field**, so Corepack cannot auto-select pnpm at the root. The bootstrap and CI pin it instead.

## Deferred

- **`minimumReleaseAge` (for example 1440 min).** The spec deliberately pins releases younger than a day: typescript-eslint 8.71.1 (published 2026-10-05T17:08Z) and viem 2.57.3 (2026-10-04T21:40Z). The setting would refuse them. Enable it after the Oct 12 submissions, once the dependency set is stable.

## Known review item for the web edition

`vite-plugin-pwa@2.0.0 → workbox-build@7.4.1 → @trickfilm400/rollup-plugin-off-main-thread@3.0.0-pre1` (published 2025-12-02) has no provenance, while the earlier 2.5.0 had SLSA provenance. The trust policy lets it through only because it is older than 30 days.

Reviewed on 2026-10-05: its runtime files are identical to 2.5.0 apart from line endings. The diff is limited to devDependency bumps in `package.json` and committed test-fixture build outputs, and it has no install scripts. Re-review it if workbox bumps the dependency.

## Known audit item for the indexer

A dry-run resolution of the whole planned stack, under the policy above, on 2026-10-05 found **high** advisories under `envio@3.12.1`, all in production dependencies:

- `express` → `body-parser` GHSA-qwcr-r2fm-qrc7;
- `express` → `path-to-regexp` GHSA-9wv6-86v2-598j, GHSA-rhx6-c78j-4q9w and GHSA-37ch-88jc-xwx2;
- envio's own `viem` → `ws` GHSA-96hv-2xvq-fx4p.

`audit-workspace.py` will fail when `apps/indexer` is added. Decide then, with evidence: a scoped `overrides` entry if a patched version is compatible, or a reasoned `ignoreGhsas` entry. The indexer runs on Envio Cloud and is never authoritative (spec §3.8).

## Verification (2026-10-05, sandbox)

```bash
scripts/bootstrap-sandbox.sh                          # includes pnpm install --frozen-lockfile
python3 scripts/toolchain/check-v1-lock-parity.py     # ok (46 v1 packages …)
python3 scripts/toolchain/audit-workspace.py --prod --audit-level high   # v1: 2 (not gating), v2: 0 → ok
npm test                                              # 7/7 pass on the pnpm-installed tree
git status --porcelain -- contracts web verify scripts/compile.js scripts/deploy.js test package.json package-lock.json   # empty
```
