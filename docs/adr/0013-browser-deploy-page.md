# ADR 0013: Browser deploy page on the current Pages root, sharing one verifier with a CLI

- **Status:** accepted
- **Date:** 2026-10-07
- **Deciders:** nambininasafidison (owner), Claude Code (engineering)
- **Related:** PAYLINK-V2-SPEC §3.3.6, §3.3.7, §3.6 (`/deploy/` route), §3.11, §6.4 route B; ADR 0002 (one paris bytecode); ADR 0005 (dedicated origin); ADR 0010 (Arc stays on v1); ADR 0012 (toolchain pinning and vendoring)

## Context

- PayLinkV2 2.0.0 is frozen (`protocol/deployments/release.json`, `initCodeHash` `0x289dcd64…7ac5`) and must reach Monad testnet 10143, Base Sepolia 84532 and Arbitrum Sepolia 421614 now (spec §6.4: one deployment per chain, deadline Oct 8).
- Route A (GitHub Actions with `TESTNET_DEPLOYER_PK`) needs repository secrets and workflows that do not exist yet. The owner signs in MetaMask, on a phone or a laptop, and holds 5 MON on Monad testnet (**UV**).
- Cloudflare Pages already serves the repository with root `web`, no build command, auto-deploy on push to `main`, at `https://paylink-mg.pages.dev` (**UV**). Changing its build settings needs the owner's browser; the sandbox cannot reach `api.cloudflare.com` (**C**).
- `web/` holds the frozen v1 app: its files must stay byte-identical (ADR 0010), but new files are allowed.
- The three testnets' public RPCs answer CORS for that origin (**C**, preflight checked 2026-10-07), and all three already host the deterministic-deployment proxy `0x4e59…956C` with the canonical 69-byte runtime (**C**, `eth_getCode` 2026-10-07).
- Monad charges the gas **limit** (spec §3.3.6), so the deployer must set it, from measured bounds, rather than accept a wallet default.

Question: how does the owner deploy the release today, in the wallet, with the guarantees of `Deploy.s.sol`, and how do the records reach the repository unaltered?

## Options

- **A.** Wait for the Vite app (`apps/web`, `/deploy/` route) and a Pages build-settings change.
- **B.** Route C only (Foundry keystore on the owner's computer).
- **C.** A self-contained page in a new folder `web/v2/deploy/`, served by the current Pages configuration: plain ES modules, no build step, one vendored library; its decision logic in modules that a command-line verifier (`tools/verify-deployment`) imports unchanged.

## Decision

Option **C**.

1. **Location and serving.** `web/v2/deploy/` (index, stylesheet, modules, generated data, vendored bundle) plus `web/_headers` scoped to `/v2/*` and `web/v2/package.json` (`"type": "module"`). No v1 file changes; v1 paths get no new headers. URL: `https://paylink-mg.pages.dev/v2/deploy/` (and, harmlessly, the same path under GitHub Pages).
2. **No hand-written facts.** `data/chains.json` is generated from `@paylink/chains`, including new **measured deployment gas** (`deployGasFor`, from `measure-gas.ts` on the anvil profiles, Monad's MonadTen emulation included). `data/release.json` is `release.json` verbatim plus the init code (accepted only by its keccak256) and the proxy runtime recovered from the canonical presigned transaction. Both have `--check` gates.
3. **Exactly Deploy.s.sol.** Recorded deployment → verify only; proxy present → CREATE2 with `salt ++ initCode`, occupied address → verify only; else CREATE. Strengthened: foreign code at the proxy address is refused before any transaction. Gas limit `clamp(estimate × 1.10, floor, ceiling)` with an estimate above the ceiling refused, as `@paylink/sdk` `clampGasLimit`.
4. **Verification and record.** After the receipt: the four checks of `PayLinkRelease._verifyDeployed` plus code size and CBOR metadata, and the transaction's chain, status, calldata and address. The record is rendered by a port of `Json.sol`; `source.commit` is the last commit that changed the release source, so the page and the CLI agree.
5. **One library, vendored.** A rolldown bundle of 18 viem 2.57.3 functions (hashing, ABI, addresses, units), unminified, with `SHA256SUMS` and licences, rebuilt byte for byte by `vendor:check`. The page speaks JSON-RPC itself and reads through the registry's RPCs, falling back (labelled) to the wallet's.
6. **Security posture.** CSP `default-src 'none'`, `script-src 'self'`, `connect-src` = exactly the registry RPCs, `frame-ancestors 'none'` (header) plus a JS frame lock; no inline script or style; DOM built with `textContent` only (ESLint sink bans apply to the page).

## Consequences

- The owner deploys from MetaMask on any device, with the transaction shown before the prompt and the result verified on-chain by code that tests prove equal to Foundry's record writer.
- `tools/verify-deployment` gives Claude (or CI) the same verification from a shell, against every reachable registry RPC, and writes the canonical file; it refuses chains outside the deploy list and non-loopback RPC overrides.
- Cost: a second implementation of the record format (JavaScript next to `Json.sol`). Contained by `test/fixtures/forge-records.json` (records written by forge, re-rendered byte for byte) and the e2e three-way parity spec.
- When `apps/web` ships its `/deploy/` route (spec §3.6), it should import `web/v2/deploy/lib/core.js`'s rules from the SDK instead, and this page can be retired; until then `/v2/deploy/` is the supported route B.

## Confirmation

- `pnpm --filter @paylink/deploy-page test`: rules against `@paylink/chains`, `@paylink/sdk` and forge-written records; data, vendor bundle and CSP freshness.
- `pnpm --filter @paylink/verify-deployment test` and `pnpm --filter @paylink/e2e test` (Playwright on anvil 10143, 84532 and 421614 with a mock EIP-1193 wallet; axe; forge, page and CLI parity).
- v1 files byte-identical: `git diff --stat 93ed4e3 -- contracts web/*.* web/fonts scripts/compile.js scripts/deploy.js test verify package.json package-lock.json` lists nothing.
