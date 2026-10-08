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

## Amendment 1 (2026-10-08): CREATE2 reached inside a relayed transaction

### Context

- PayLinkV2 2.0.0 was deployed on Base Sepolia from this page with MetaMask in its smart-account mode (EIP-7702). MetaMask did not send the page's `eth_sendTransaction` from the account. Its relayer `0xC066…8B8c` submitted a type-4 transaction to MetaMask's delegation manager `0xdb9B…7dB3`. That transaction carried the account's authorization (delegate `0x63c0…E32B`, chain 84532, nonce 0), and inside it the account called the proxy with `salt ‖ initCode` (tx `0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed`, block 47859253, status 1). The contract is at `0x448eCce9711860502806A3d5B021a4f9Ba715082` with the release code. The transaction check of decision 4 refused the transaction ("a call to 0xdb9B…, neither the CREATE2 factory nor a contract creation"), so no record was printed.
- A CREATE2 deployment's integrity does not depend on who sends the transaction. The address commits to the factory, the salt and keccak256 of the init code, and the code checks bind the immutables to the chain and the address. The transaction check adds provenance: it shows that this transaction, in this block, created the contract (the record's `txHash`, `blockNumber` and `deployer`).

### Decision

4a. **Relayed route.** A transaction that neither calls the proxy nor creates a contract is a relayed candidate when its input carries `salt ‖ initCode` contiguously, on a byte boundary. Without that payload it is refused, as before. It is accepted as method CREATE2 only if all of these hold:
- it is on this chain and succeeded;
- the payload is in its input;
- the address is the CREATE2 prediction;
- `eth_getCode` at the address is empty at block N − 1 and present at block N (N is the transaction's block);
- when the RPC serves a trace (`debug_traceTransaction` with callTracer, or `trace_transaction`), the trace shows a CREATE2 of the release by the proxy, called with the payload, with no reverted frame around it. Otherwise the transaction is refused.

Archive-free fallback: when the RPC keeps no state at N − 1, the check accepts on the code present at N, or at the latest block when N is not served either, and its detail says that absence before N is not proven.

4b. **Deployer.** The deployer is the account that called the proxy, determined in this order:
1. the caller in the trace;
2. otherwise, the one EIP-7702 authority of the transaction that the transaction names (its `to`, or 20 bytes of its input) and whose code at block N is `0xef0100 ‖` the authorization's address. The authority is recovered from the authorization's signature: secp256k1 over `keccak256(0x05 ‖ rlp([chainId, address, nonce]))`, low-s only, in plain JavaScript (`web/v2/deploy/lib/eip7702.js`, checked against viem);
3. otherwise `null`, with the reason shown.

4c. **Direct routes unchanged.** A call to the proxy must carry exactly `salt ‖ initCode`, and a creation exactly the init code. Their checks, the number of checks and their records are as before.

4d. **Record.** The schema stays `paylink.deployment/1`. A relayed record appends three keys to `deployment`, after the forge keys:
- `route`: `"relayed"`;
- `submitter`: the relayer;
- `authorization`: the type-4 authorizations as `{chainId, address, nonce, authority}`, or `null`.

A direct record has no `route` key (absence means direct), so for direct deployments the page, the CLI and `Deploy.s.sol record()` still write the same bytes. Forge broadcasts directly and has no relayed route. `deployer` may be `null` only in a relayed record.

4e. **The page.** Before deploying, the page says that MetaMask's smart-account mode may relay the transaction and that this is supported for CREATE2: a line under "Before you start" and a "Smart account" lamp in the review. A relayed plain CREATE is not recognised; that route needs a standard account.

### Consequences

- One corner is weaker than the direct route when no trace is available. Say a second relayed transaction in the same block N also carries the payload, and its inner creation fails but the failure is swallowed. It cannot be told apart from the creating transaction, because both show code absent at N − 1 and present at N. The direct route has no such gap, because the proxy reverts when CREATE2 fails. A trace closes the gap, and the person who submits a record names their own transaction.
- Readers of the records:
  - a missing `route` means direct;
  - `@paylink/chains` reads records by key and accepts the relayed one;
  - `@paylink/chains` requires a non-null `deployer`, so a relayed record without one needs a registry decision before it can be generated.
- `verify-deployment --check` of a relayed record keeps passing after the RPC prunes block N − 1: it falls back and says so. The record's bytes do not depend on which evidence the RPC served.

### Confirmation

- `tools/deploy-page/test/core.test.ts`, the relayed route:
  - accepted with evidence;
  - refused without the payload, with the wrong init code or salt, with code before the block, with no code at the block, without evidence or with evidence for other blocks, and with a trace that shows no standing CREATE2;
  - the archive-free fallback, traces in both formats, and the cases with a null deployer;
  - the record layout, and every shipped record re-rendered byte for byte from its facts.
- `tools/deploy-page/test/eip7702.test.ts` (hash and recovery checked against viem, including the Base Sepolia authorization) and `tools/deploy-page/test/rpc.test.ts` (type-4 decoding, historical reads, refused tracers, evidence fallback).
- `tools/verify-deployment/test/cli.test.ts`: a real EIP-7702 relayed deployment on anvil, through a manager contract that swallows failures, recorded with the trace's confirmation. A relayed transaction that created nothing, and one sent after the contract existed, are refused.
