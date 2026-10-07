# @paylink/chains

The PayLink chain registry: the client's **root of trust for addresses**. A payer client never reads a contract address from a link; it resolves `verifyingContract` here, by chain ID ([invoice spec §4.2](../../docs/spec/paylink-invoice-v2.md#42-resolving-verifyingcontract)). The registry also holds the token allowlist, RPC fallbacks, explorers, the gas-limit bounds that clients and the relayer clamp to, and the relay margin a relayer applies to every time bound it forwards.

Isomorphic TypeScript (browser, Cloudflare Worker, Node). Depends only on viem.

## What is in it

| Chain | ID | Status | Protocol | Tokens (decimals, capabilities) | Gas bounds |
|---|---|---|---|---|---|
| Monad testnet | 10143 | enabled, T0 | v2 | AUSD (6, EIP-3009 + EIP-2612) default; Circle USDC (6, EIP-3009, domain `USDC`/`2`) hidden; one impostor address denied | Monad emulation |
| Monad mainnet | 143 | disabled, T2 | v2 | AUSD, USDC: addresses only; decimals and capabilities flagged as unverified | Monad emulation |
| Base Sepolia | 84532 | enabled, T0 | v2 | USDC (6, EIP-3009 + EIP-2612) | snapshot |
| Arbitrum Sepolia | 421614 | enabled, T1 | v2 | USDC (6; capabilities not stated by the spec, so approve + pay only) | snapshot |
| Mezo testnet | 31611 | disabled until the Oct 16 go/no-go | v2 | MUSD (18, EIP-2612 only) default; native BTC (18) | snapshot |
| Arc mainnet | 5042 | enabled | **v1 only** | native USDC (18) and its 6-decimal ERC-20 view (EIP-3009, `USDC`/`2`) | none (v1) |

Every fact carries the confidence tag it has in PAYLINK-V2-SPEC §3.4 (`UV`, `C`, `L`, `U`). Facts the spec does not state are not invented: unstated capabilities are `false`, an unstated EIP-712 domain is `null` (read from the chain), and assumed values are listed in `pendingVerification`, which `createRegistry` refuses on an enabled chain.

No chain has a recorded PayLinkV2 deployment yet, so `registry.v2Target(chainId)` is `undefined` everywhere and no link can be paid until a deployment is recorded.

## Guarantees, enforced by tests

- **EIP-55.** Every address passes `getAddress(a) === a`. The `…dCF7c` typo from Base's docs is shown to fail.
- **Allowlist parity.** Every registry address is in [`docs/tools/address-allowlist.json`](../../docs/tools/address-allowlist.json) with the same chain, use and confidence, and every spec address of a covered chain is in the registry.
- **Spec facts restated independently** in `test/registry.test.ts`, so a typo in either place fails.
- **Deploy-script parity.** Chain names and explorer origins equal the table that `protocol/script/utils/PayLinkRelease.sol` writes into deployment records.
- **Validation of any registry.** `createRegistry` rejects mis-checksummed addresses, non-HTTPS endpoints (except `local` anvil chains), endpoints with credentials or queries, more than one default token, native tokens with a non-zero address, a token equal to the deployment, denied tokens on the allowlist, invalid gas bounds, a v2 chain without relay timing (or a margin outside [1, 300] s), and unverified facts on an enabled chain. Registries are deeply frozen.
- **Coverage: 100 %** statements, branches, functions and lines (spec §4.1).

## Generated data

`src/generated/*` is written by `scripts/generate.ts` from the protocol's own records, never by hand; `test/generated.test.ts` fails when a file is stale.

| File | Source |
|---|---|
| `gas.ts` | `protocol/snapshots/PayLinkV2.json` (Foundry, Ethereum gas prices) and `data/gas-measurements.json` (anvil, per network) |
| `release.ts` | `protocol/deployments/release.json`: init-code hash, masked runtime hash, immutable ranges |
| `deployments.ts` | `protocol/deployments/<chainId>.json`, each validated against the release (refused if it is not the audited artifact) |
| `v1.ts` | `web/config.js` of the frozen v1 app |

```bash
pnpm --filter @paylink/chains run generate         # rewrite src/generated
pnpm --filter @paylink/chains run generate:check   # exit 1 if stale
```

A deployment's lifecycle (`active`, `deprecated`, `revoked`) is set in `src/deployment-status.ts`; it defaults to `active`.

## Gas bounds (spec §3.3.6)

Clients send `gasLimit = clamp(eth_estimateGas × 1.10, floor, ceiling)` (`gasLimitFor` in `@paylink/sdk`). Rule: floor = the largest EOA-payee measurement of the function, ceiling = 1.5 × floor, both rounded up to 1,000; each ERC-1271-payee measurement plus the 10 % margin must fit under the ceiling.

| Function | Snapshot (Base, Arbitrum, Mezo) | Monad (emulated) |
|---|---|---|
| `payWithAuthorization` | 143,000 – 215,000 | 224,000 – 336,000 |
| `pay` | 102,000 – 153,000 | 159,000 – 239,000 |
| `payWithPermit` | 136,000 – 204,000 | 217,000 – 326,000 |
| `payNative` | 98,000 – 147,000 | 125,000 – 188,000 |
| `cancel` | 54,000 – 81,000 | 70,000 – 105,000 |
| `cancelBySig` | 62,000 – 93,000 | 89,000 – 134,000 |

**Why Monad has its own table.** anvil 1.8.5 runs chain 10143 as network `monad` (hardfork `MonadTen`), with Monad's prices: in a trace, `ecrecover` costs 6,000 and a cold `balanceOf` about 8,570. There, a first gasless payment needs `eth_estimateGas` = 223,327, above the snapshot ceiling of 215,000: with snapshot bounds the relayer would refuse every first `payWithAuthorization`, `payWithPermit`, `pay` and `cancelBySig` on Monad. `packages/sdk/scripts/measure-gas.ts` measures every entry point as real transactions on four anvil profiles (Ethereum, Monad, Base, London for Mezo) and writes `data/gas-measurements.json`. The generator refuses the snapshot table unless every Ethereum-priced estimate fits under it.

All tables are **provisional**: re-measure on each testnet with cold slots and the real tokens (AUSD and USDC are proxies with more storage reads than the mocks). On Arbitrum, `eth_estimateGas` also includes the L1 posting cost (L), which the execution-based ceilings do not cover; re-measure before relaying there. The snapshot cancelBySig bounds (62,000 – 93,000) differ from the 67,000 – 101,000 in `protocol/audit/gas.md` §3, which applied the rule to the ERC-1271 measurement for this one function only.

## Deployment gas

`deployGasFor(chainId)` returns the measured gas of the PayLinkV2 deployment on the chain's anvil profile, for both methods of `Deploy.s.sol` (CREATE2 through the proxy, plain CREATE), and the bounds a deployer clamps to: floor = the estimate, ceiling = 1.5 × floor, both rounded up to 1,000 (`DEPLOY_GAS`, generated from the `deploy_create` and `deploy_create2` entries of `data/gas-measurements.json`; informational for the entry-point tables). The deploy page (`web/v2/deploy`) sends `clamp(eth_estimateGas × 1.10, floor, ceiling)` and refuses an estimate above the ceiling, because Monad charges the whole limit.

| Profile (chains) | CREATE2 estimate → bounds | CREATE estimate → bounds |
|---|---|---|
| monad (10143, 143) | 2,720,773 → 2,721,000 – 4,082,000 | 2,677,645 → 2,678,000 – 4,017,000 |
| base (84532) | 2,717,457 → 2,718,000 – 4,077,000 | 2,673,065 → 2,674,000 – 4,011,000 |
| ethereum (421614) | 2,717,457 → 2,718,000 – 4,077,000 | 2,673,065 → 2,674,000 – 4,011,000 |
| london (31611) | 2,716,645 → 2,717,000 – 4,076,000 | 2,673,065 → 2,674,000 – 4,011,000 |

On the live testnets (2026-10-07, `eth_estimateGas` from the owner's address through the registry RPCs) the CREATE2 deployment estimated 2,727,004 gas on Monad testnet and 2,723,708 on Base Sepolia and Arbitrum Sepolia: geth-style estimators stop within 1.5 % of the minimum, so they read slightly above anvil's exact search, well inside the bounds.

## Relay timing (invoice spec §13.3, audit finding A-04)

`chain.relay.minRemainingSeconds` is the minimum remaining validity a relayer requires at admission: every time bound of a relayed call (the payer's EIP-3009 `validBefore`, the invoice's `validUntil`, a cancellation's `deadline`) must still hold in a block stamped `now + minRemainingSeconds`, where `now` is the timestamp of the block it simulated against. A bound that ends one second after that block passes `eth_call` and reverts in any later block, at the relayer's expense, without a transaction from whoever chose it. `checkRelayPayRequest` and `checkRelayCancelRequest` in `@paylink/sdk` apply it.

Every v2 chain uses `DEFAULT_RELAY_TIMING` for now: **120 s**, four times the relayer's 30 s stuck-transaction replacement interval (PAYLINK-V2-SPEC §3.7), which covers the pre-broadcast re-simulation, the broadcast and up to three fee bumps on chains whose blocks take seconds or less. It leaves 480 s of the recommended 600 s authorization window for the request to reach the relayer. The value is **provisional**: replace it per chain with the measured worst-case inclusion latency (plus the replacement cycles) once relays run on that chain. v1 chains have no relay timing (`null`).

## Usage

```ts
import { registry, scopeToEdition, rpcTransport, toViemChain } from "@paylink/chains";
import { createPublicClient } from "viem";

const monadEdition = scopeToEdition(registry, "monad");      // links for other chains read as unknown
const chain = monadEdition.getOrThrow(10143);
const client = createPublicClient({ chain: toViemChain(chain), transport: rpcTransport(chain) }); // fallback() over the registry RPCs
const target = monadEdition.v2Target(10143);                 // { chain, deployment } once a deployment is recorded
```

For tests, e2e and demo recording, `defineLocalChain({ chainId, rpcUrl, tokens, deployment })` builds an anvil chain that `createRegistry` accepts with an `http://127.0.0.1` RPC.

## Gates

```bash
pnpm --filter @paylink/chains run typecheck   # tsc --noEmit: src/ alone (no Node types) and everything
pnpm --filter @paylink/chains run lint        # ESLint, typescript-eslint strictTypeChecked
pnpm --filter @paylink/chains run test:coverage
```
