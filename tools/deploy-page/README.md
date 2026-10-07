# @paylink/deploy-page

Build tooling and tests of the **browser deploy page**, [`web/v2/deploy/`](../../web/v2/deploy/), served at `https://paylink-mg.pages.dev/v2/deploy/` by the current Cloudflare Pages configuration (root `web`, no build step). The page itself is plain JavaScript that runs as written; this package generates its data, vendors its one library, and type-checks, lints and tests it. Decision record: [ADR 0013](../../docs/adr/0013-browser-deploy-page.md).

## What the page does

1. Discovers wallets with EIP-6963 (falls back to `window.ethereum`), connects one account.
2. Offers exactly the registry's deploy targets: **Monad testnet 10143, Base Sepolia 84532, Arbitrum Sepolia 421614**. Any other chain, from the wallet or from `?chain=`, is refused. Switches the wallet with EIP-3326 and adds the chain with EIP-3085 (registry RPC and explorers) when the wallet answers 4902.
3. Reads the chain through the **registry's RPC** (falling back to the wallet's RPC, labelled, if the registry endpoints are unreachable) and plans the deployment exactly as [`protocol/script/Deploy.s.sol`](../../protocol/script/Deploy.s.sol) `run()` does:
   - a recorded deployment (`protocol/deployments/<chainId>.json`, here through `@paylink/chains`) is only verified;
   - with code at `0x4e59b44847b379578588920cA78FbF26c0B4956C`: CREATE2 with `salt ++ initCode`, salt `keccak256("paylink.v2.0.0")`; an occupied CREATE2 address is only verified. One strengthening: code there that is not the proxy's canonical runtime is refused instead of called;
   - otherwise CREATE from the account, at `getCreateAddress(account, nonce)`.
4. Sets the gas limit itself: `clamp(eth_estimateGas × 1.10, floor, ceiling)` with the **measured deployment bounds** of `@paylink/chains` (`deployGasFor`), refusing an estimate above the ceiling (same rule as `@paylink/sdk` `clampGasLimit`). Monad charges the gas **limit**, so the cost shown there is `limit × (base fee + tip)`; elsewhere it is the estimate's. Shows balance, expected cost and the upper bound at twice the base fee, and locks the key when the balance does not cover the expected cost.
5. After the receipt, verifies on-chain (the four checks of `PayLinkRelease._verifyDeployed` plus code size and CBOR metadata): code present, masked runtime hash (spec §3.3.7), the seven EIP-712 immutables bound to this chain and address, `eip712Domain()` = `{fields 0x0f, "PayLink", "2", chainId, address, no salt, no extensions}`; and the transaction: this chain, success, the factory call with `salt ++ initCode` landing on the CREATE2 address, or a creation whose address follows from sender and nonce.
6. Prints `protocol/deployments/<chainId>.json` **byte for byte as `Deploy.s.sol record()` writes it**, with Copy and Download. A deployment sent from the browser is remembered in `localStorage`, so a reload resumes it instead of inviting a second one.

The release identity (`initCodeHash`, CREATE2 address, salt, compiler, source commit) is on screen before any wallet prompt, and the page refuses to run when its own init code does not hash to `initCodeHash`.

## Files

| Path | Role |
|---|---|
| `web/v2/deploy/index.html`, `deploy.css`, `app.js` | The page: v1's `../../paylink.css` (Precision Terminal tokens and components, fonts) plus the v2 pieces (band selector, review window, pre-flight lamps, verification LEDs, slip, record window) |
| `web/v2/deploy/lib/core.js` | Pure rules shared with the CLI: data validation, planning, gas clamp, cost, masked hash, immutables, domain decoding, transaction checks, the record writer |
| `web/v2/deploy/lib/rpc.js`, `verify.js` | JSON-RPC over EIP-1193 or HTTPS with fallback; on-chain verification and record |
| `web/v2/deploy/lib/wallet.js`, `dom.js`, `format.js` | EIP-6963 discovery, chain switching; a `textContent`-only DOM builder; display formatting |
| `web/v2/deploy/data/chains.json`, `release.json` | **Generated** by `scripts/generate.ts` (below) |
| `web/v2/deploy/vendor/` | **Generated** by `scripts/vendor.ts`: the viem subset, its type surface, licences and checksums |
| `web/v2/package.json` | `"type": "module"` for `web/v2` (Node and TypeScript read the page's `.js` as ES modules) |
| `web/_headers` | Cloudflare Pages headers for `/v2/*` only: CSP (`connect-src` = the registry RPCs), `frame-ancestors 'none'`, nosniff, no-referrer, COOP |

## Generated data

```bash
pnpm --filter @paylink/deploy-page run generate         # rewrite web/v2/deploy/data/*.json
pnpm --filter @paylink/deploy-page run generate:check   # exit 1 if stale (no forge build needed)
```

- `chains.json`: from `@paylink/chains` (names, RPCs, explorers, gas model, `deployGasFor`, recorded deployments) for the three targets. Run it after recording a deployment, after `pnpm --filter @paylink/chains run generate`.
- `release.json`: `protocol/deployments/release.json` verbatim; the init code from `protocol/out` (refused unless its keccak256 is `initCodeHash`); `sourceCommit`, the last commit that changed `protocol/deployments/release.json` or `protocol/src` (a commit whose sources compile to the release); and the proxy runtime, **recovered from the canonical presigned transaction** of the deterministic-deployment proxy rather than typed in.

`source.commit` in the records the page and the CLI write is that `sourceCommit`, so the two agree byte for byte. `forge script … record()` writes `PAYLINK_GIT_COMMIT`; set it to the same value for byte equality (the e2e parity test does).

## Vendored viem subset

The page needs keccak-256, ABI coding, EIP-55 and CREATE/CREATE2 addresses. Rather than load ethers or a CDN, `scripts/vendor.ts` bundles exactly the functions listed in [`src/viem-subset.js`](src/viem-subset.js) from the workspace's pinned **viem 2.57.3** (plus abitype 1.2.3 and @noble/hashes 1.8.0, all MIT) with rolldown 1.2.12, **unminified** (about 80 kB; every `//#region` names its upstream file), and writes:

| File | Content |
|---|---|
| `vendor/viem.js` | the ES module, with a provenance header |
| `vendor/viem.d.ts` | the type surface for `tsc --checkJs` |
| `vendor/LICENSES.txt` | the licence of each bundled package |
| `vendor/SHA256SUMS` | `sha256sum -c SHA256SUMS` from `web/v2/deploy/vendor/` |

The build refuses any package that is not in its allowlist or not MIT. `vendor:check` (and `test/data.test.ts`) rebuilds in memory and requires identical bytes, so the committed bundle provably comes from the lockfile's viem.

```bash
pnpm --filter @paylink/deploy-page run vendor         # after a viem bump or a change to src/viem-subset.js
pnpm --filter @paylink/deploy-page run vendor:check
```

## Gates

```bash
pnpm --filter @paylink/deploy-page run typecheck   # tsc: tooling, and the page's JavaScript under the strict base options
pnpm --filter @paylink/deploy-page run lint        # ESLint: tooling, and web/v2/deploy with the DOM-sink bans
pnpm --filter @paylink/deploy-page run test        # core rules vs @paylink/chains, @paylink/sdk and forge-written records;
                                                   # generated data, vendor bundle and CSP up to date
```

`test/fixtures/forge-records.json` holds two records written by Foundry itself (CREATE2 and CREATE); `scripts/capture-forge-records.sh` regenerates it on anvil after a release or format change. The browser flows are in [`e2e/`](../../e2e/).
