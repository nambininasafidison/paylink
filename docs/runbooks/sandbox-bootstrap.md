# Runbook: sandbox toolchain bootstrap

Restores the PayLink v2 toolchain after a sandbox restart. Decisions and provenance: [ADR 0012](../adr/0012-toolchain-pinning-and-vendoring.md). Workspace layout: [ADR 0011](../adr/0011-workspace-layout.md).

## Run

```bash
cd /home/user/paylink
scripts/bootstrap-sandbox.sh            # about 25 s on a cold container, about 2 s when already installed
source ~/.paylink-toolchain/env.sh      # PATH, FOUNDRY_SOLC, FOUNDRY_OFFLINE=true, PLAYWRIGHT_* (when /opt/pw-browsers exists)
```

| Flag | Effect |
|---|---|
| `--check` | Verify only: no network, no writes. Exits 1 and names each drifted component. |
| `--print-env` | Print the exports, for `eval "$(scripts/bootstrap-sandbox.sh --print-env)"`. |
| `--skip-node-deps` | Skip `pnpm install --frozen-lockfile`. |
| `--quiet` | Print only warnings, errors and the version summary. |

Steps, each skipped when already correct:

1. Foundry 1.8.5 → `~/.foundry/bin`.
2. solc 0.8.30 → `~/.svm/0.8.30/solc-0.8.30`.
3. Slither venv → `~/.paylink-toolchain/venv`.
4. solc-select and the analysis shims.
5. forge-std manifest check.
6. v1 lockfile parity check.
7. `pnpm install --frozen-lockfile`.
8. Write `env.sh`.

The final summary prints every version.

## Optional: run it on every session start

The owner can add a Claude Code SessionStart hook. The script appends its exports to `$CLAUDE_ENV_FILE` when that variable is set, so later commands in the session see `forge`, `slither` and `FOUNDRY_SOLC` without a manual `source`. This is a settings change; make it only if you want it.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/bootstrap-sandbox.sh --quiet", "timeout": 600 } ] }
    ]
  }
}
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `sha256 mismatch for …` | The download was altered, or upstream replaced the asset. Do not override the pin. Re-download; if it persists, investigate before updating `pins.env`. |
| `forge build` tries to download solc | `FOUNDRY_OFFLINE`/`FOUNDRY_SOLC` are not set. Run `source ~/.paylink-toolchain/env.sh`. |
| `ERR_PNPM_IGNORED_BUILDS` after adding a dependency | `strictDepBuilds` caught an unreviewed build script. Decide, then add the package to `onlyBuiltDependencies` or `ignoredBuiltDependencies` in `pnpm-workspace.yaml`, with a reason. |
| `ERR_PNPM_TRUST_DOWNGRADE` | A version younger than 30 days lost provenance compared with an earlier release. Review the package diff, then add an exact `name@version` to `trustPolicyExclude`, with the evidence. |
| `check-v1-lock-parity: … violated` | The `"."` importer drifted from `package-lock.json`. Run `pnpm import && pnpm install`, then re-run the check. |
| v1 `npm test` fails after `npm install`/`npm ci` | npm replaced pnpm's `node_modules`. Run `pnpm install` (or the bootstrap) again. |
| `vendor-forge-std: … differs from its manifest` | `protocol/lib/forge-std` was edited. Run `scripts/toolchain/vendor-forge-std.sh --sync`. |
| `slither` cannot find build-info | `src/` has no contract yet, and the default config skips tests. Add `--foundry-compile-all` for a smoke run. |
