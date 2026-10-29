# Ethereum Sepolia for the PayPal edition: what the chain says

Read on chain on 2026-10-21 for decision D-CHAIN ([docs/paypal/SPEC.md](../../paypal/SPEC.md), [ADR 0018](../../adr/0018-paypal-edition.md)), through the registry's RPC `https://ethereum-sepolia-rpc.publicnode.com` with Foundry's `cast` 1.8.5 at block 11,959,099 (2026-10-21 01:17 UTC). The registry entry built from it is `packages/chains/src/chains/ethereum-sepolia.ts`; the fork rehearsal is `tools/deploy-page/scripts/sepolia-fork.ts`. Tags: **C** read on chain here; **S** a search snippet or a participant's copy; **UNVERIFIED** not confirmed.

Why Sepolia and not Arbitrum Sepolia (the specification's first choice, [pyusd.md](pyusd.md) §1): the owner holds Sepolia ETH and 20 test USDC there (a USDC `Transfer` of 20,000,000 base units to the owner's demo wallet in transaction `0xd734e1ba…2759bb`, block 11,958,688 on 2026-10-20, status 1: read here, C), and could not get test PYUSD anywhere (faucet.paxos.com is geo-blocked from Madagascar; the Google Cloud faucet's transfer failed for lack of gas). USDC is therefore the token the demo pays with; PayPal USD is listed and supported, and the fork rehearsal pays it too.

## 1. Chain and helpers

| Item | Fact | Tag |
|---|---|---|
| Chain ID | 11155111 (`eth_chainId`) | C |
| RPC | `https://ethereum-sepolia-rpc.publicnode.com` answers from the build machine; other public Sepolia RPCs tried did not (UNVERIFIED for browsers elsewhere) | C |
| CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` | 69 bytes of code, the canonical runtime | C |
| Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` | 3,808 bytes of code | C |
| PayLinkV2 `0x448eCce9711860502806A3d5B021a4f9Ba715082` | **no code** on 2026-10-21: not deployed then. The owner deployed it with the deploy kit at that CREATE2 address on 2026-10-29 (transaction `0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3`, block 12,017,054); its record `protocol/deployments/11155111.json` was re-verified on chain by `tools/verify-deployment` the same day | C |
| Explorer | `https://sepolia.etherscan.io` | C |

## 2. Tokens

| | USDC (Circle) | PayPal USD (Paxos) |
|---|---|---|
| Address | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9` |
| Proxy code / implementation | 1,798 bytes; implementation `0xda31…9068` (ZeppelinOS slot `keccak("org.zeppelinos.proxy.implementation")`), 23,464 bytes | 1,506 bytes; implementation `0xc804…9a59` (same slot), 18,334 bytes |
| `name()` / `symbol()` / `decimals()` | "USDC" / "USDC" / 6 | "PayPal USD" / "PYUSD" / 6 |
| `version()` | "2" | **reverts** |
| `eip712Domain()` (ERC-5267) | reverts | reverts |
| `DOMAIN_SEPARATOR()` | `0xb90e5057db141a932946e64d09ccb7ffc9b00bd79fec26f698d29af0c83320a6`, equal to the recomputation for {USDC, 2, 11155111, token} | `0x299bc5624e503ead448a8620a85ecf64a3be318a90c1a987563385c582d4e6cd`, equal to the recomputation for {PayPal USD, **1**, 11155111, token} |
| Selectors in the implementation (PUSH4 search) | `receiveWithAuthorization(…,v,r,s)` 0xef55bec6, bytes form 0x88b7ab63, `permit` 0xd505accf, `nonces` 0x7ecebe00, `authorizationState` 0xe94a0102, `cancelAuthorization` 0x5a049a70, `version` 0x54fd4d50 | the same, **without** `version` 0x54fd4d50; `eip712Domain` 0x84b0196e absent from both |
| Supply control | — | `supplyControl()` = `0xE288F41c4bdA3Cb5C75156E263CB8ecbB8eF60E2`, the SupplyControl the Paxos testnet page names (S, [pyusd.md](pyusd.md) §2) |
| Registry | default token | listed token |

Consequences:

- **PYUSD's EIP-712 version** cannot be read from the token. The SDK accepts the registry's stated domain only when `DOMAIN_SEPARATOR()` proves it (`packages/sdk/src/token-domain.ts`, commit 828b9ff; error `E_TOKEN_DOMAIN_UNKNOWN` otherwise), so no hard-coded version is ever trusted without the chain's word.
- **PYUSD is Paxos-controlled**: Paxos can pause the token and freeze any address, PayLinkV2's included; an already-used EIP-3009 nonce returns without a transfer, which PayLinkV2 turns into `ReceivedMismatch` ([pyusd.md](pyusd.md) §3, rehearsed on the fork below).
- Both tokens offer EIP-3009 and EIP-2612, so the router's path for a payer without code is the payer's own `receiveWithAuthorization` (one signature, one transaction), then permit; no relayer serves Sepolia (D-SCOPE).

## 3. Logs (what the reconciler and the ledger can read)

| Probe (address USDC, block 11,959,099) | Answer | Tag |
|---|---|---|
| `eth_getLogs` over 60,000 blocks | `exceed maximum block range: 50000` (registry `rpcLimits.maxLogBlockRange`) | C |
| over 5,000 blocks ending 4,000 blocks back | `query exceeds max results 20000`: a cap on results as well as on range | C |
| 1,500 blocks ending 10,500 blocks back, asked twice | 8,820 logs once, `pruned history unavailable` (code 4444) the other time | C |
| 5,000 blocks ending 15,000 blocks back, asked twice | 21,206 logs once, `pruned history unavailable` the other time | C |
| 5,000 blocks ending 25,000 blocks back, asked three times | `pruned history unavailable` each time | C |

The public endpoint is a pool: some backends keep only recent history (about 10,000 blocks, about 33 hours at 12 s a block). Readers should filter by the contract's indexed topics (payee, invoice key) so results stay far below 20,000, read a payment from its transaction receipt when they know the hash, and retry a pruned answer rather than treat it as "no payment". The registry's note says the same; the reconciler workstream owns the chain reads (`apps/api/src/chain/`).

## 4. Rehearsal on a fork

`tools/deploy-page/test/sepolia-fork.test.ts` (run with `PAYLINK_FORK_SEPOLIA=1`, commit c574923) forks Sepolia with anvil and: deploys PayLinkV2 through the canonical factory exactly as the deploy kit does, at `0x448e…5082`, verified by the kit and by `tools/verify-deployment`; checks that both tokens match the registry and that the SDK resolves PYUSD's domain without `version()`; routes a code-less payer to self-authorisation, then permit, with no relayer; pays USDC and PYUSD by authorisation and by permit (exact amounts, verified receipts, gas within the registry's bounds); and fails closed on PYUSD's silent no-op for a used nonce. Test balances come from `anvil_dealERC20` on the fork only: nothing is sent to Sepolia.

## 5. Gas: Sepolia runs Amsterdam (read 2026-10-22)

Ethereum Sepolia's blocks carry `blockAccessListHash` (EIP-7928) and its node answers `reth/v2.8.0`; anvil forking it reports the hardfork **Amsterdam** (`anvil_nodeInfo`, block 11,968,576). Amsterdam includes EIP-8037 (state creation gas: `CPSB` = 1,530 gas per new state byte; a new storage slot costs 64 × 1,530 = 97,920 gas, a new account 120 × 1,530; code deposit 1,530 gas per byte; the EIP-7825 cap of 2^24 applies to execution gas only, and `tx.gas` may reach 2^32 − 1: ethereum/EIPs `EIPS/eip-8037.md`, read 2026-10-22, status Last Call). So, on the chain itself (C, read here):

| What | Sepolia today | Ethereum's schedule before Amsterdam (the registry's first table) |
|---|---|---|
| CREATE2 deployment of PayLinkV2, `eth_estimateGas` of `ethereum-sepolia-rpc.publicnode.com` | **19,249,557** (an `eth_call` with 16,777,216 gas reverts; with 19,922,944 it returns the release address) | 2,717,457 |
| The same on an anvil fork of Sepolia | 19,240,803 | — |
| `payWithAuthorization`, first payment (USDC, fork) | 457,705 | 166,954 (ceiling 215,000) |
| `cancel` (fork) | 146,812 | 57,628 (ceiling 81,000) |
| The owner's CREATE2 deployment on Sepolia, 2026-10-29 (transaction `0x9a5ade11…b0e5b3`): gas used by its receipt | **18,946,483** under a limit of 21,174,513, at 1.5 gwei a gas: 0.0284 Sepolia ETH | — |

The first gas table and the deploy kit's bounds (Ethereum's anvil profile, Bpo1) would therefore have refused the deployment (`E_GAS_ABOVE_CEILING`, ceiling 4,077,000), every payment and every cancellation on the real chain; the first rehearsals pinned the fork to Prague and could not see it. Since 2026-10-22 the registry's Ethereum Sepolia gas table and the kit's deployment bounds come from `tools/deploy-page/scripts/sepolia-fork.ts --measure` on a fork under the chain's own rules (`packages/chains/data/fork-gas-measurements.json`, profile `sepolia`), and every fork test runs unpinned. Fees stay negligible on Sepolia (base fee 14 wei at block 11,968,600), but the owner's wallet must accept a deployment limit near 21 million gas.

## 6. Not checked here

- Whether a payer's wallet (MetaMask and others) shows PYUSD's permit and authorisation readably: owner's capture run (UNVERIFIED).
- Faucets: which faucet sent the owner's 20 USDC is not recorded here; Circle's faucet lists Ethereum Sepolia (S). PYUSD faucets did not work for the owner (the owner's report, UNVERIFIED elsewhere).
