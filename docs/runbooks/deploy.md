# Runbook: deploying PayLink

Step-by-step instructions for the owner: what to do in the wallet, in GitHub and in Cloudflare. The background is in [ARCHITECTURE §6](../ARCHITECTURE.md#6-deployments-and-code-integrity) and [ADR 0002](../adr/0002-one-paris-bytecode-oz-5-3-0.md).

> **Golden rule.** A private key goes only into a wallet, a GitHub **environment** secret or a Cloudflare secret. **Never** into the chat, an issue, a commit or the Claude Code sandbox. Testnet keys are throwaway, and must never hold mainnet funds.

## Contents

1. [Wallets](#1-wallets)
2. [One-time account and secret setup](#2-one-time-account-and-secret-setup)
3. [Contract go/no-go and release](#3-contract-gono-go-and-release)
4. [Deploying v2 to a testnet](#4-deploying-v2-to-a-testnet)
5. [After every deployment](#5-after-every-deployment)
6. [Arc v1 on mainnet](#6-arc-v1-on-mainnet)
7. [Monad mainnet 143 (conditional)](#7-monad-mainnet-143-conditional)
8. [Mezo testnet (from Oct 13)](#8-mezo-testnet-from-oct-13)
9. [Web app, relayer and indexer](#9-web-app-relayer-and-indexer)
10. [Rollback](#10-rollback)

---

## 1. Wallets

| Wallet | Use | Where the key lives |
|---|---|---|
| **W-pay**: your browser wallet (for example MetaMask or Rabby) | Payee and payer demos on Base and Arbitrum; Arc v1 on mainnet | The wallet |
| **W-deploy**: a fresh EOA, testnets only | Deploys v2 | The wallet. For route A, also the GitHub secret `TESTNET_DEPLOYER_PK` in the environment `testnet` |
| **W-relay**: a fresh key made for the relayer alone, testnets only ([relayer runbook §4](relayer.md#4-create-the-relayer-key-and-store-it-yourself)) | Relayer gas | Only the Cloudflare Worker secret `RELAYER_PK`. It is generated straight into the clipboard and pasted there; no wallet or person keeps a copy |
| **Mera passkeys**: merchant on your phone, payer on a second device or browser profile | Monad demo | The platform passkey store (Google Password Manager or iCloud Keychain) |

Create W-deploy and W-relay as new accounts, never as an existing wallet with history. Fund them only from faucets ([faucets runbook](faucets.md)).

## 2. One-time account and secret setup

### 2.1 Cloudflare (free plan, no card)

1. Create the Pages project `<app>`. The recommended name is `paylink-mg`; its availability is unknown until you try. The name fixes the passkey **rpId** `<app>.pages.dev` for good ([ADR 0005](../adr/0005-dedicated-origin-and-rpid.md)). **Decide it before creating any passkey.**
2. In the project's settings, **disable preview deployments.** Production branch: `main` only.
3. Create an API token with exactly two permissions: "Cloudflare Pages: Edit" and "Workers Scripts: Edit". No other scopes.
4. In GitHub → Settings → Secrets and variables → Actions, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. The relayer Worker `paylink-relayer`, its secret `RELAYER_PK` (the W-relay key, generated for the relayer alone and never displayed) and its funding: follow the [relayer runbook](relayer.md). It is deployed by Cloudflare's Git integration from `apps/relayer/deploy` and needs no API token in GitHub.
6. Durable Objects: the relayer uses the SQLite-backed kind, which the free plan offers (**L**); the first deploy shows whether Cloudflare accepts it ([relayer runbook §10](relayer.md#10-troubleshooting)). If not, the relayer uses its stateless fallback ([ADR 0007](../adr/0007-relayer-durable-object-per-chain.md)).

**If Cloudflare sign-up fails without a card:** use the fallback in [ADR 0005](../adr/0005-dedicated-origin-and-rpid.md): a new free GitHub organisation whose `<org>.github.io` hosts only PayLink. Tell Claude, so the build switches to the meta-CSP variant.

### 2.2 GitHub repository settings

1. Actions: enabled. Default workflow permissions: **read**.
2. Environments → create `testnet`:
   - required reviewer: **you**;
   - deployment branches: `main` only;
   - secret `TESTNET_DEPLOYER_PK` (route A only).
3. Branch protection for `main`: required status checks (the blocking gates in [CONTRIBUTING.md](../../CONTRIBUTING.md#5-quality-gates)); no force pushes.
4. Security → enable **Private vulnerability reporting** ([SECURITY.md](../../SECURITY.md)).
5. Turn on phishing-resistant two-factor authentication on the GitHub and Cloudflare accounts.

### 2.3 Envio

Sign in at envio.dev and create an API token. Add the GitHub secret `ENVIO_API_TOKEN`. Connect the repository in Envio Cloud (development plan) for `apps/indexer`.

## 3. Contract go/no-go and release

**Oct 7, 12:00 UTC (15:00 EAT).** Go only if all of these hold:

- [ ] Invariants I1–I11 green in CI (`FOUNDRY_PROFILE=ci`).
- [ ] Slither: no untriaged medium-or-higher finding (`protocol/audit/triage.md`).
- [ ] Coverage ≥ 95 % of lines and ≥ 90 % of branches on `src/`.
- [ ] Golden vectors reproduced by the SDK.
- [ ] The [self-review](../security/self-review.md) "Verify" items checked.

**GO:** tag `contracts-v2.0.0`. The release identity is the machine-readable file `protocol/deployments/release.json` (schema `paylink.release/1`) at that tag: the **`initCodeHash`**, the masked runtime hash, the compiler settings hash and the CREATE2 address. `forge script script/Predict.s.sol --sig 'writeRelease()'` generates it, and `test/script/Scripts.t.sol::test_ReleaseLockMatchesBuild` fails until it matches the build. The tag's release notes repeat the `initCodeHash`. These are the values you compare against before signing any deployment. The record formats are specified in `protocol/deployments/README.md`.

**NO-GO:** ship the reduced contract (`payWithAuthorization`, `pay`, `cancel`, `cancelBySig`). Permit and native payments move to v2.1.

## 4. Deploying v2 to a testnet

**Order:** Monad testnet **10143** → Base Sepolia **84532** → Arbitrum Sepolia **421614** (optional, only if Sepolia ETH reaches W-deploy by Oct 9).

**Hard deploy deadline:** Oct 8, 18:00 UTC. **No redeploys after Oct 8**, except for a security fix ([incident response](../security/incident-response.md)).

**Budget.** On Monad, about 3.0M gas × about 105 gwei ≈ **0.32 MON**; keep **0.5 MON** in W-deploy. The minimum base fee is 100 MON-gwei (**C**), and about 105 gwei was observed (**L**). On Base Sepolia, keep at least 0.02 ETH.

**Every route runs the same three steps** with the scripts in `protocol/script/`:

1. **Predict (read-only).** `forge script script/Predict.s.sol --rpc-url <rpc> --sig 'run(address)' <W-deploy address>` prints the method (CREATE2 through `0x4e59b44847b379578588920cA78FbF26c0B4956C` with the salt `keccak256("paylink.v2.0.0")` when `eth_getCode` shows that deterministic deployer on the chain, CREATE otherwise), the target address, the `initCodeHash`, the masked runtime hash and the settings hash. **Stop if the `initCodeHash` differs from `release.json` at the tag.**
2. **Deploy.** `forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast …`. The script refuses any build that is not the release build, checks the address it lands on against the prediction, then checks the deployed code and its ERC-5267 domain. On a chain that already has a record, it only verifies the existing contract.
3. **Record.** `PAYLINK_GIT_COMMIT=$(git rev-parse HEAD) forge script script/Deploy.s.sol --rpc-url <rpc> --sig 'record()'` re-verifies the live code and writes `protocol/deployments/<chainId>.json`.

### Route A: GitHub Actions (preferred)

No manual RPC or bytecode handling.

1. Claude triggers `deploy-testnet.yml` with the chain ID.
2. In GitHub, open Actions → the run → **Review deployments** → approve `testnet`.
3. The job runs the three steps above with `TESTNET_DEPLOYER_PK` from the `testnet` environment, prints the prediction before broadcasting, verifies the source on Sourcify or Blockscout, and opens a pull request with `protocol/deployments/<chainId>.json`.
4. Claude checks the logs and the pull request. You merge it.

### Route B: browser, `https://paylink-mg.pages.dev/v2/deploy/` (available now)

The deploy page ([ADR 0013](../adr/0013-browser-deploy-page.md), [tools/deploy-page](../../tools/deploy-page/README.md)) is served by the current Cloudflare Pages configuration (root `web`, no build) as soon as it is on `main`. It runs the same three steps in the browser, with your wallet signing the one transaction.

1. Open `https://paylink-mg.pages.dev/v2/deploy/` (on the phone: in MetaMask's own browser). `?chain=monad`, `?chain=base` or `?chain=arb` preselects a network; any other chain is refused.
2. **Release identity, before any prompt:** check that the `initCodeHash` on the page equals `release.json` (`0x289dcd64…7ac5` for 2.0.0) and that the CREATE2 address is `0x448eCce9711860502806A3d5B021a4f9Ba715082`. If either differs, stop.
3. **Wallet:** pick your wallet (EIP-6963 list). **Network:** pick MONAD, BASE or ARB; if the wallet is elsewhere, press *Switch wallet*. A wallet that does not know the chain is asked to add it with the registry's RPC and explorers.
4. **Review:** the display window shows the method (CREATE2 through `0x4e59b44847b379578588920cA78FbF26c0B4956C` on all three testnets as of 2026-10-07), the contract address, the gas limit (`clamp(estimate × 1.10, floor, ceiling)` from the measured table), the cost and your balance after. On Monad the whole limit is charged: about 3.0M gas × ~102 gwei ≈ **0.31 MON**. Every lamp must be green (amber "Route" only on a chain without the proxy). The key stays locked if the balance does not cover the cost.
5. **Deploy**, then confirm in the wallet. The wallet must show the same target and gas limit. Do not edit the gas limit in the wallet.
6. The page waits for the receipt, verifies the contract (code, masked runtime hash, CBOR metadata, EIP-712 immutables, `eip712Domain()`) and the transaction, and prints `protocol/deployments/<chainId>.json`. **Download** it (or **Copy**) and send it to Claude, or paste it in a GitHub issue.
7. Claude re-verifies independently and commits the record:

   ```bash
   node tools/verify-deployment/verify-deployment.mjs --chain <chainId> --address <address> --tx <txHash> --compare <the downloaded file>
   pnpm --filter @paylink/chains run generate && pnpm --filter @paylink/deploy-page run generate
   ```

   then adds the deployment to [`docs/tools/address-allowlist.json`](../tools/address-allowlist.json) (`"use": "registry"`, the chain id) and runs the gates. The page and the CLI write the same bytes as `Deploy.s.sol record()` (`e2e/specs/record-parity.spec.ts`).

If the page reloads or the phone browser restarts after you signed, open it again on the same network: it offers *Check that transaction* instead of a second deployment. If the CREATE2 address is already occupied (deployed by another route), the page only verifies it; paste the deployment transaction hash to print the record.

### Route C: your own computer, with a Foundry keystore

Only on your own machine, **never in the Claude Code sandbox**. Import W-deploy once into an encrypted keystore (`cast wallet import w-deploy --interactive`; the key is typed, never pasted into a file or a shell history), then run the three steps with `--account w-deploy --sender <W-deploy address>` on step 2. Send Claude the resulting `protocol/deployments/<chainId>.json` in a pull request.

### Deployment record

`protocol/deployments/<chainId>.json` (schema `paylink.deployment/1`, specified in `protocol/deployments/README.md`) contains:

- the address in EIP-55 and CAIP-10 form, the chain ID and its CAIP-2 identifier;
- the method (`CREATE2` or `CREATE`), the deployer, the transaction hash and the block; the factory, salt and salt preimage, or `null` for CREATE;
- the `initCodeHash` and masked runtime hash (equal to `release.json`), plus the hash and size of the runtime code actually on that chain;
- the compiler settings, the OpenZeppelin and forge-std versions, and the git commit;
- the ERC-5267 domain as verified on-chain, and explorer links.

`@paylink/chains` is generated from these files and adds `status: "active"`.

## 5. After every deployment

- [ ] `node tools/verify-deployment/verify-deployment.mjs --chain <chainId> --address <address> --tx <txHash> --check` exits 0 (every reachable registry RPC agrees with the committed record).
- [ ] `deployments-check.yml` is green: the `initCodeHash`, the masked runtime code, the seven EIP-712 immutables and the ERC-5267 domain all match ([ARCHITECTURE §6](../ARCHITECTURE.md#6-deployments-and-code-integrity)).
- [ ] The source is verified on the explorer: `testnet.monadvision.com` for Monad, `base-sepolia.blockscout.com` or `sepolia.basescan.org` for Base.
- [ ] `/status/` shows the deployment green.
- [ ] Smoke test on the real testnet: create an invoice with W-pay, pay it from a second account, open the receipt, check the ledger. Note both transaction hashes for the submission.
- [ ] The gas floor and ceiling in `@paylink/chains` are re-measured with cold slots on this chain (Monad charges the gas limit).
- [ ] The relayer's registry entry is updated, and `/v1/health` reports the chain.

## 6. Arc v1 on mainnet

As soon as **at least 0.1 USDC** is on Arc mainnet in W-pay; plan for 1–2 USDC, which leaves margin for retries and the demo payment (owner's estimate, 2026-10-06). **Go/no-go: Oct 14, 18:00 UTC.** Never submit testnet-only: Arc rejects such entries (**UV**). There is nothing to register before the mainnet deployment; the entry is submitted on DoraHacks before **2026-10-15 03:59 UTC** (**UV**, 2026-10-06).

1. Open `https://nambininasafidison.github.io/paylink/web/deploy.html`, connect **W-pay** on Arc mainnet (chain ID 5042) and deploy. It costs about 0.02 USDC (live estimate 920,964 gas, about 0.018 USDC at a 2e10 wei base fee, **C**). Note the address and the transaction hash.
2. Send the address and the hash to Claude. Claude then:
   - commits `web/config.js` (the address only, the single allowed v1 change) and `deployments/arc-mainnet.json`;
   - tags `arc-microgrants-v1.1`;
   - verifies the code, events and balances from the sandbox through `rpc.mainnet.arc.io` (reachable, **C**).
3. In the app, create one link for a small amount and pay it. v1 allows self-payment, so one wallet is enough.
4. Submit on DoraHacks with the repository, the live URL, the contract address and both transaction hashes. Review is rolling, so submit as soon as step 3 is done.

**If USDC on Arc is hard to get** (all unverified): a contact sends USDC on Arc, or bridges it with Circle CCTP; or ask in the Arc or Circle community channels. v1 has no owner, so a third party can broadcast the deploy without needing your trust. Your own wallet still needs about 0.01 USDC to `create()` a link.

## 7. Monad mainnet 143 (conditional)

Testnet is the intended path: the Metropolis dashboard provides a MON testnet faucet (**UV**, 2026-10-06). Deploy to mainnet only if an organiser says it is required ([forum questions](../submissions/monad-forum.md), Q1), or if about 0.5 MON becomes available:

- Deploy the **same artefact** through route A or B, and send **at most one tiny transaction**.
- The demo stays on testnet, because mainnet AUSD and USDC are real money.
- The contract has no owner, so a third party can broadcast the deploy.
- Registry: AUSD `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (**C**). The deployment stays disabled in the UI unless you decide otherwise.

## 8. Mezo testnet (from Oct 13)

1. Claim test BTC at `faucet.test.mezo.org` (captcha) ([faucets runbook](faucets.md)).
2. Borrow at least 2,000 MUSD (1,800 plus a 200 gas deposit) at ≥ 110 % collateral at `mezo.org/feature/borrow` on testnet.
3. Optional and informational only: deploy the PUSH0 probe (init code `0x5f5ff3`) to see whether the chain supports Shanghai. The `paris` artefact does not need PUSH0.
4. Deploy v2 to 31611 through route A or B.

## 9. Web app, relayer and indexer

| Component | How it is deployed | Your part |
|---|---|---|
| Web app (editions) | `site.yml` on push to `main`: builds every edition, then `wrangler pages deploy` (action pinned by SHA) | None, once the secrets exist. Check `https://<app>.pages.dev/status/` |
| Relayer | Cloudflare's Git integration (Workers Builds) on push to `main` when `apps/relayer/deploy/` changes: `npx wrangler@4.148.0 deploy` of the committed bundle. No GitHub secret; the key is a Worker secret only ([relayer runbook](relayer.md)) | One-time setup, key and funding ([relayer runbook](relayer.md)); keep W-relay at about 1–2 MON at most |
| Indexer | Envio Cloud (development plan), connected to the repository | Redeploy before each judging window (Monad Oct 14–27). A deployment lives at most 30 days and its URL changes on every push (**L**); Claude updates `/config.json` |

## 10. Rollback

- **Web app:** Cloudflare → Pages project → Deployments → the previous production deployment → **Rollback**.
- **Relayer:** Cloudflare → Worker `paylink-relayer` → Deployments → the previous version → **Rollback**; to stop relaying at once, delete the secret `RELAYER_PK` ([relayer runbook §8](relayer.md#8-operations-refill-update-rotate-stop-roll-back)).
- **Contract:** there is no rollback or pause. Mark the deployment `revoked` in the registry and follow [incident response PB-1](../security/incident-response.md#pb-1-contract-vulnerability-sev-1-or-sev-2).
