# @paylink/e2e

Playwright end-to-end tests (PAYLINK-V2-SPEC §4.2). Today they cover the browser deploy page, `web/v2/deploy/` ([ADR 0013](../docs/adr/0013-browser-deploy-page.md)); the app flows of §4.2 join them when `apps/web` lands.

| Spec | What it proves |
|---|---|
| `specs/deploy.spec.ts` | Monad testnet 10143 (anvil's Monad emulation, 100 gwei base fee, 5 MON): CREATE2 through the proxy installed by its canonical presigned transaction; the one transaction the wallet receives is Deploy.s.sol's, with the clamped gas limit; reads go to the registry RPC; the record equals `tools/verify-deployment`'s; copy and download. Base Sepolia 84532: the wallet does not know the chain and adds it from the registry (proxy via `anvil_setCode`). Arbitrum Sepolia 421614 without the proxy: CREATE at the predicted address, then resume after a reload. Refusals: unknown chain, tampered release data, foreign code at the proxy address, empty wallet, declined signature. Phone (390 px, dark): no horizontal scroll. axe-core WCAG 2.2 AA: zero violations, light and dark |
| `specs/record-parity.spec.ts` | Foundry deploys and writes the record; the page (verify-only, then with the transaction hash) and the CLI print the same bytes |

The page is served from `web/` with the response headers of `web/_headers` (production CSP). The registry's RPC URLs are routed to the anvil running that chain id; the mock wallet (`fixtures/wallet.ts`) is announced through EIP-6963 and forwards to anvil, whose default accounts are unlocked. No real key is used.

```bash
source ~/.paylink-toolchain/env.sh                     # sandbox: anvil/forge on PATH, browsers in /opt/pw-browsers
pnpm --filter @paylink/e2e test                         # needs a release build in protocol/out for the parity spec
```

Screenshots of the review and done states (1280 px light, 390 px dark) are written to `e2e/test-results/` (git-ignored).
