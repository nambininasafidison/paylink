# Mezo testnet, MUSD and the Mezo Buildathon: verified facts

| | |
|---|---|
| **Date** | 2026-10-13 |
| **Purpose** | Facts needed to build the Mezo edition of PayLink ([ADR 0008](../adr/0008-editions.md)): MUSD invoices on Mezo testnet with the same PayLinkV2 2.0.0 contract |
| **Method** | Live JSON-RPC against `https://rpc.test.mezo.org` (blocks 16,140,049 to 16,140,210), an anvil 1.8.5 fork of that RPC, and primary sources read at a fixed commit or version (§13) |
| **Legend** | **C** confirmed (on chain, or primary source read); **L** likely (indirect evidence); **UNVERIFIED** (third-party only, or not reachable from the build machine; the reason is given) |

Nothing here was sent to Mezo testnet: every transaction ran on a local fork, with throwaway keys that were never saved.

## 1. Summary

- Mezo testnet is chain **31611** (`0x7b7b`). Its gas coin is **BTC with 18 decimals**. Blocks come every **4.5 to 4.9 s**. The chain charges **at least 50 % of the gas limit** (**C**).
- Its public RPC answers **`null` to about one lookup by hash in two** for transactions that are mined (`eth_getTransactionReceipt`, `eth_getTransactionByHash`): a `null` there means "ask again", not "absent" (**C**, §2; added 2026-10-14).
- MUSD on testnet is `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`, named "Mezo USD", with 18 decimals. Its EIP-712 domain is name `Mezo USD`, version `1`. It supports **EIP-2612 permit** and **not EIP-3009**. It charges no fee and has no transfer hook (**C**).
- The canonical CREATE2 factory is on Mezo testnet with the canonical runtime. **PayLinkV2 is not deployed there yet.** The factory would put it at `0x448eCce9711860502806A3d5B021a4f9Ba715082`. On a fork, PayLinkV2 settled MUSD through both `payWithPermit` and approve + `pay` (**C**).
- Payment routes for MUSD: **`payWithPermit`** first (1 signature + 1 transaction), then **approve (exact amount) + `pay`**. **`payWithAuthorization` cannot be used**, because MUSD has no EIP-3009. **Our relayer cannot make MUSD payments gasless** with the deployed contract (§11).
- Test MUSD has no faucet: it is **borrowed against test BTC**, with a minimum debt of 2,000 MUSD (about 0.0265 BTC of collateral at the testnet price) (§8).
- Mezo Passport is a **React** package built on RainbowKit, wagmi and Mezo's OrangeKit (§9). Mezo's docs call it optional. It does not fit PayLink's vanilla-TypeScript app without adding React.
- The buildathon rules (rubric, wave dates) come from third-party pages only. AKINDO cannot be reached from here, so they are **UNVERIFIED** (§10).

## 2. Network

| Fact | Value | Source | Tag |
|---|---|---|---|
| Name | "Mezo Testnet" in Mezo's docs; "matsnet" in the MUSD repo's Hardhat network and in Passport's README ("Mezo Matsnet") | docs `configure-environment.md`; musd `solidity/hardhat.config.ts`; Passport README | C |
| Chain ID | 31611: `eth_chainId` returns `0x7b7b`, `net_version` returns `"31611"` | live RPC | C |
| CAIP-2 | `eip155:31611` | x402 overview in Mezo's docs | C |
| HTTPS RPC | `https://rpc.test.mezo.org` | docs; live | C |
| WSS RPC | `wss://rpc-ws.test.mezo.org` | docs; OrangeKit chain definition | UNVERIFIED (blocked by the egress proxy here) |
| Node client | `Mezod/13.0.0/amd64/go1.24.0` (`web3_clientVersion`). mezod is an Evmos fork on Cosmos SDK and CometBFT, and runs a go-ethereum 1.16.9 fork | live; docs; mezod `go.mod` | C |
| Explorer | `https://explorer.test.mezo.org`, with an Etherscan-compatible verification API at `https://api.explorer.test.mezo.org/api` | docs; musd `hardhat.config.ts` (`customChains`) | C (source); UNVERIFIED live (blocked here) |
| Gas coin | BTC, 18 decimals. The BTC ERC-20 precompile at `0x7b7C000000000000000000000000000000000000` returns `decimals() = 18`, and its `balanceOf` equals the native balance (one sampled address) | docs; live | C |
| Block time | 4.85 s average over the last 1,000 and 10,000 blocks, 4.53 s over 100,000 blocks (block 16,040,053 to 16,140,053) | live block timestamps | C |
| Finality | CometBFT consensus, so a block is final once committed | docs (developer getting started §1.1) | L |
| Block gas limit | 10,000,000 | live | C |
| Gas price | `baseFeePerGas` was 130 wei on every sampled block. `eth_gasPrice` returned 146, `eth_maxPriorityFeePerGas` 16. Observed legacy transactions paid 292 wei | live | C |
| Gas charged | **max(gas used, 50 % × gas limit).** Sample transaction `0x2beb4b8f144569018e0f3aff8d703cb2504faa9f8db3dcfd0c81817669d67ff5`: limit 300,000, `eth_estimateGas` 57,052, receipt `gasUsed` 150,000. mezod applies `MinGasMultiplier`, which defaults to 0.5 | live; mezod `x/evm/keeper/state_transition.go`, `x/feemarket/types/params.go` | C |
| EVM opcodes | PUSH0, MCOPY, TSTORE/TLOAD, BLOBHASH and BLOBBASEFEE all execute in `eth_call` (Cancun level). Mezo's docs still tell you to compile with `evm_version = london`. PayLink's `paris` artefact runs either way | live probes; docs | C |
| Transaction types | EIP-1559 is supported (base fee in blocks; mezod `x/evm/types/dynamic_fee_tx.go`). For EIP-7702, mezod `main` has `set_code_tx.go`, and the testnet's `eth_estimateGas` adds 25,000 gas per authorization (46,000 with one instead of 21,000) | live; mezod source | L; inclusion of a type-4 transaction UNVERIFIED |
| `eth_getLogs` | At most 10,000 blocks per request ("maximum [from, to] blocks distance: 10000") | live | C |
| Lookups by hash | **`eth_getTransactionReceipt` and `eth_getTransactionByHash` answer `null` for mined transactions about one request in two**, while the same request answers a moment later. On 2026-10-14 (block 16,145,186), 20 requests each on fresh connections for the sample transaction `0x2beb4b8f…7ff5` above: the receipt was `null` 9 times, the transaction 11 times. A review of 2026-10-13 saw the same on transactions 0 to 200,000 blocks old (`null` in 4 to 7 of 12 requests), with `eth_blockNumber` identical across the requests and `eth_getLogs` returning identical counts, so it is not lag; runs of `null` can stick to one connection (viem in Node: 4 of 8 processes got `null` on all 20 requests). Answers come through Cloudflare and a Google load balancer (`server: cloudflare`, `via: 1.1 google`); that some nodes behind it keep no transaction index is a likely cause (**L**). Clients must treat a `null` as "ask again" (ADR 0017 decision 7) | live (curl, Python, viem) | C (behaviour); cause L |
| Mainnet | Chain 31612. MUSD there is `0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186` | musd `solidity/artifacts/deployments/mainnet/MUSD.json`; docs | C (source); not checked on chain (mainnet RPCs are blocked here) |

## 3. CREATE2 factory and PayLinkV2 on Mezo testnet

| Check | Result | Tag |
|---|---|---|
| Factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` | 69-byte runtime, keccak `0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989`, the same as on Base Sepolia and Monad testnet (the canonical deterministic-deployment proxy). Nonce 106, so it has been used before | C |
| `0x448eCce9711860502806A3d5B021a4f9Ba715082` | `eth_getCode` is `0x`, nonce 0, balance 0: **PayLinkV2 is not deployed yet** | C |
| Address prediction | `eth_call` to the factory with salt `keccak256("paylink.v2.0.0")` and the release init code (`initCode` in `web/v2/deploy/data/release.json`, keccak `0x289dcd6477a467fcd8cc185bb4fb6c3cd58c06132d08fa11822f21f824627ac5`) returns `0x448ecce9…5082`. `cast create2` gives the same address | C |
| Deploy gas | Mezo testnet's `eth_estimateGas` returns **2,717,457**, equal to the CREATE2 estimate the registry measured for Base and Ethereum (`packages/chains/data/gas-measurements.json`). On the fork the deployment used 2,678,851 gas. The block gas limit and the 50 % rule leave room | C |
| Deployed domain (fork) | ERC-5267 `eip712Domain()` returns fields `0x0f`, `PayLink`, `2`, 31611, `0x448e…5082`. Runtime size 12,045 bytes, as in `release.json` | C |

## 4. MUSD on Mezo testnet

**Address:** `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` (**C**). Four sources agree:

- the musd repository's `solidity/artifacts/deployments/matsnet/MUSD.json` (deploy transaction `0xc8a7da3f5e76cfc8499648700ead8fdb5b73bedd7be5cde0a1dab1c75ffa4071`, block 4,518,688);
- Mezo's docs ("Contracts reference", "How to Borrow & Mint MUSD", the x402 overview);
- `@x402/evm` 2.28.0, which also reads "no EIP-3009, supports EIP-2612";
- the chain itself: `BorrowerOperations.musd()` returns this address.

| Property | Value (read on chain unless stated) | Tag |
|---|---|---|
| `name()`, `symbol()`, `decimals()` | `Mezo USD`, `MUSD`, 18 | C |
| `totalSupply()` | 523,655,338.57 MUSD at check time | C |
| EIP-712 domain (ERC-5267 `eip712Domain()`) | fields `0x0f`, name `Mezo USD`, version `1`, chain ID 31611, `verifyingContract` = MUSD, no salt, no extensions | C |
| `DOMAIN_SEPARATOR()` | `0x6f9f5c5d441374bdc3939f5da85a145469d7ffbc96bfe0cce59e5de7d8f1474f`, which matches a recomputation from the domain above | C |
| **EIP-2612** | **Yes.** The dispatcher has `permit` `0xd505accf`, `nonces(address)` `0x7ecebe00` and `DOMAIN_SEPARATOR()` `0x3644e515`. A bad signature reverts with `ECDSAInvalidSignature()` (`0xf645eedf`), an expired deadline with `ERC2612ExpiredSignature(uint256)` (`0x62791302`). The token is OpenZeppelin 5 `ERC20Permit`, which checks with **ECDSA only, never ERC-1271**, so a smart account cannot sign a permit | C |
| **EIP-3009** | **No.** `transferWithAuthorization` (`0xe3ee160e`, bytes form `0xcf092995`), `receiveWithAuthorization` (`0xef55bec6`, bytes form `0x88b7ab63`), `authorizationState` (`0xe94a0102`) and `cancelAuthorization` (`0x5a049a70`) are all missing from the dispatcher, and `authorizationState` reverts with empty data | C |
| Transfers | A plain OpenZeppelin ERC-20: no fee, no hook, no pause, no blocklist. `transfer` and `transferFrom` revert when `to` is the zero address or the MUSD contract itself | C (source `solidity/contracts/token/MUSD.sol`, code identical, see the next row) |
| Upgradeability | The token is **not a proxy**: its EIP-1967 implementation slot is zero. Its 6,437-byte runtime equals the matsnet artifact's `deployedBytecode`, except for the seven OpenZeppelin `EIP712` immutables (address, chain ID, cached separator, hashed name and version, two short strings). It was built with solc 0.8.24, `evmVersion` london, 100 optimizer runs. The MUSD system contracts (BorrowerOperations, TroveManager, …) have proxy-sized code (about 1.16 KB) | C; system contracts as proxies L |
| Admin powers | `Ownable`. On testnet the owner `0x1236…4cAf` is an EOA. The owner can add any address to `mintList` or `burnList`, and a `burnList` member can `burn(account, amount)` from **any** account. This is issuer risk worth disclosing to users | C |

MUSD system parameters on testnet (**C**, on chain): `minNetDebt` 1,800 MUSD; `MUSD_GAS_COMPENSATION` 200 MUSD; MCR 110 %; `borrowingRate` 0.1 %; `interestRate` 100 bps (1 % a year); `PriceFeed.fetchPrice()` 83,161.76 USD per BTC at check time. Addresses are in the musd repository under `solidity/artifacts/deployments/matsnet/`.

## 5. PayLinkV2 with MUSD on a fork (smoke test)

Setup: anvil 1.8.5, forked from Mezo testnet at block 16,140,203, with fresh throwaway keys. PayLinkV2 was deployed through the factory exactly as the deploy kit does. 100 MUSD was minted to each payer by impersonating BorrowerOperations, which is on MUSD's `mintList`. The invoice was a one-off for 12.5 MUSD.

| Route | Result | Gas used |
|---|---|---|
| `payWithPermit` (permit domain `Mezo USD`/`1`, spender PayLinkV2, value = amount) | Success. The payee received exactly 12.5 MUSD. PayLink's MUSD balance stayed 0, the payer's permit nonce went to 1, and the allowance left was 0 | 135,733 |
| `approve` (exact amount), then `pay` | Success. The payee received exactly 12.5 MUSD | 46,394 + 84,908 |
| `payWithAuthorization` | Reverts with empty data, because MUSD has no `receiveWithAuthorization` | — |

Anvil uses Ethereum's gas schedule. mezod runs a go-ethereum 1.16.9 fork, so the numbers should match (**L**); its estimate for the deployment did match exactly (§3). At the observed 146 to 292 wei, a `payWithPermit` costs about 2 to 4 × 10⁻¹¹ BTC. That is negligible, but the payer still needs **some** BTC.

## 6. BTC and MEZO tokens (precompiles)

| Token | Address | Facts | Tag |
|---|---|---|---|
| BTC (ERC-20 view of the gas coin) | `0x7b7C000000000000000000000000000000000000` | name and symbol `BTC`, 18 decimals. Supports EIP-2612: `DOMAIN_SEPARATOR` `0xeabbeb8b…8662` matches name `BTC`, version `1`; `nonces`; standard `PERMIT_TYPEHASH`. No `eip712Domain()`, no EIP-3009. Same balance as the native coin | C (live; mezod `precompile/btctoken`, `precompile/erc20/permit.go`) |
| MEZO | `0x7b7c…0001`, the BTC precompile address + 1 (in full in mezod `precompile/mezotoken`) | name and symbol `MEZO`, 18 decimals, total supply about 1.213 × 10⁹. Supports EIP-2612: `DOMAIN_SEPARATOR` `0xf427a251…c9db` matches name `MEZO`, version `1`. No EIP-3009, no ERC-5267 | C |

The buildathon asks for MUSD or MEZO. MEZO could be a second, `listed` token on the permit path. Anvil cannot run Mezo's Go precompiles, though, so **paying in MEZO through PayLinkV2 is untested (UNVERIFIED)**. Paying in native BTC with `payNative` is a plain value transfer (**L**, not run on the fork).

## 7. Other contracts present on Mezo testnet

Each address was checked with `eth_getCode`.

| Contract | Present | Note |
|---|---|---|
| Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` | yes | Code hash equal to Base Sepolia's (**C**) |
| Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` | yes | Its runtime differs per chain because of immutables. PayLinkV2 does not use it |
| ERC-4337 EntryPoint v0.7 (`0x0000000071727De2…a032`) | yes | Code hash equal to Base Sepolia's. v0.6 and v0.8 are absent, and so is CreateX |
| x402 settlement proxy (`0x402085c2…0001`) | yes (2,913 bytes) | Used by Mezo's x402 facilitator, not by PayLink |

## 8. How a tester gets test BTC and MUSD

1. **Test BTC:** use the faucet at https://faucet.test.mezo.org (captcha). The developer guide and the x402 quickstart point there, and the `@x402/paywall` 2.28.0 faucet map links `eip155:31611` to it. You can also ask in the `#testnet` channel of the Mezo Discord, https://discord.com/invite/mezo. Drip size and cooldown: **UNVERIFIED** (the faucet cannot be reached from here).
2. **Test MUSD:** there is **no MUSD faucet**. The x402 quickstart says "MUSD on testnet is minted, not faucet-dispensed". You borrow it against test BTC:
   - Sign in at https://testnet.mezo.org, then open https://testnet.mezo.org/feature/borrow: **the testnet borrow page (C)**. Mezo's user guide "How to Borrow & Mint MUSD" (`src/content/docs/docs/users/borrow/mint-musd.mdx` at commit 8713c16a, line 32) says: "This guide walks through the **Testnet** flow, so every link below points to `testnet.mezo.org`. When you're ready to borrow and mint real MUSD, go to mezo.org/feature/borrow on **Mainnet** instead."
   - https://mezo.org/feature/borrow is **the Mainnet app (C)**, where real BTC backs real MUSD: the same guide, line 47, "(or mezo.org/feature/borrow if you're on Mainnet)". The x402 quickstart is the only source that pairs it with a wallet on Mezo Testnet. The app and the runbooks link the testnet page only, never the Mainnet one (corrected 2026-10-14, after a review: this section said which of the two works was UNVERIFIED).
   - The minimum debt is **1,800 MUSD plus the 200 MUSD gas deposit**, and the borrowing fee (0.1 %, 1.8 MUSD) is added on top. At 110 % that needs at least (2,001.8 × 1.1) / 83,161.76 ≈ **0.0265 test BTC** of collateral. Plan on ≥ 0.04 BTC to stay clear of liquidation (150 % ≈ 0.036 BTC).
3. **Payer wallets:** the borrower sends MUSD to test payers with a plain transfer. A payer also needs a few wei of BTC for gas: the faucet, or another tester.
4. **Get Gas:** Mezo's app documents a gasless swap of MUSD or MEZO for exactly 0.0001 BTC (permit, then relay). It appears below 0.000001 BTC (users guide "Gasless Swaps"). Whether it exists on testnet is **UNVERIFIED**.

## 9. Mezo Passport

- **What it is:** `@mezo-org/passport` on npm. The latest version is 0.17.2 (2026-01-27). A 0.17.3-dev line also ships `-no-ui` prereleases, which drop the account dropdown. The licence is **GPL-3.0-only**. It is a wallet-connection kit built **on RainbowKit**. It adds Bitcoin wallets (Unisat, OKX, Xverse) next to EVM wallets: each Bitcoin wallet gets an OrangeKit **Safe smart account** on Mezo, which validates the Bitcoin wallet's signatures. Its transactions go through Mezo's relayer (testnet: `POST https://test.mezo.org/api/v2/relay/transactions`). That relayer only accepts Safe `execTransaction` calls that **refund it from the Safe**, so the Safe pays the gas in BTC. Passport also talks to Mezo's account APIs (`api.test.mezo.org`: sign in with wallet, Mezo ID, Discord, rewards). (**C**, from the npm tarballs of passport 0.17.2, orangekit 1.0.0-beta.40 and orangekit-smart-account 1.0.0-beta.24.)
- **API (from its `.d.ts` files):**
  - `getConfig({ appName, walletConnectProjectId, mezoNetwork?: "mainnet" | "testnet", …wagmi options })` returns a wagmi `Config`. The types mark `walletConnectProjectId` as required, although the README leaves it out.
  - `getDefaultWallets(network)`, and `unisatWalletMezoTestnet`, `okxWalletMezoTestnet`, `xverseWalletMezoTestnet`, with `…Mainnet` variants.
  - The chains `mezoTestnet` and `mezoMainnet`, plus `CHAIN_ID` and `RPC_BY_NETWORK`.
  - `PassportProvider` (environment and API URLs) and the `Dropdown` component.
  - Hooks: `useBitcoinAccount`, `useSendBitcoin` and `useSendTransaction` (re-exported from OrangeKit), `useTokensBalances`, `useSignInWithWallet`, `useWalletAccount`, and others.
  - Wallet errors and `OrangeKitConnector`.
  - EVM wallets use the standard wagmi `useConnect` or RainbowKit's `ConnectButton`.
- **Without React: no.** The peer dependencies are `react` ^18.2.0, `wagmi` ^2.5.12, `viem` ^2.22.8, `@rainbow-me/rainbowkit` ^2.0.2 and `@tanstack/react-query` ^5.28.4. OrangeKit also needs `react` ≥ 18 and RainbowKit, and the `-no-ui` builds keep the same peers (**C**). Only `@mezo-org/orangekit-smart-account` has viem as its sole peer dependency (no React; it bundles the Safe and Gelato SDKs), so a framework-free Safe path might exist, but it is undocumented (**UNVERIFIED**). The source repository `github.com/mezo-org/passport` could not be cloned anonymously (**UNVERIFIED** whether it is public).
- **Optional:** Mezo's developer guide (§3.2) says "Integration is optional and not required to build on Mezo" (**C**).
- **What it would mean for PayLink:**
  - The web app is vanilla TypeScript with EIP-6963 wallets ([ADR 0006](../adr/0006-vanilla-typescript-port-at-parity.md)), so Passport would bring in React, wagmi and RainbowKit, and GPL-3.0 code in an MIT app (a licensing question to settle before shipping it).
  - Passport's Bitcoin-wallet accounts are smart accounts. They **cannot sign an MUSD permit** (ECDSA only), so they would pay with approve + `pay` through the Safe.
  - As payees, they would sign invoices that PayLinkV2 checks through ERC-1271 on the Safe (**UNVERIFIED** that OrangeKit's Safe validates an EIP-712 digest that way).
  - Recommendation: wave 1 uses EIP-6963 wallets (MetaMask and others) on chain 31611. Revisit Passport for wave 2 if "Mezo Integration" judging rewards it.

## 10. Mezo Buildathon on AKINDO

`app.akindo.io` and `akindo.io` cannot be reached from the build machine (DNS or egress policy), so nothing below was read on AKINDO itself.

| Fact | Source | Tag |
|---|---|---|
| An MUSD integration is mandatory | Owner, recorded in [ADR 0008](../adr/0008-editions.md) | UV |
| Participants must join the Mezo Discord | Owner, recorded in the [faucets runbook](../runbooks/faucets.md) | UV |
| Wave 1 closes 2026-10-26; testnet accepted | The orchestrating brief | UNVERIFIED here |
| "Build with MUSD and MEZO: Bitcoin's Economic Layer", by Mezo / Supernormal Foundation. $7,000 in MEZO. **Wave 1**: build Oct 16–26, judging Oct 27–Nov 1, $2,000. **Wave 2**: build Nov 2–15, judging Nov 16–22, $5,000. Winners Nov 23. Chains: Mezo, Ethereum, Base, BNB Chain | `thirdbase1/buildathon-radar` `data/mezo.json`, a scrape of AKINDO's public API on 2026-09-23; the dates match two participants' repositories | UNVERIFIED (third-party) |
| Tracks: **1 DeFi** (borrowing, lending, looping, yield with MUSD/MEZO); **2 Access & Distribution** (tools, bots, interfaces for MUSD/MEZO users). PayLink belongs in Track 2 | same | UNVERIFIED |
| **Judging rubric:** Mezo Integration 30, Product & Business Viability 30, Technical Implementation 20, User Experience 10, Submission Materials 10 | same | UNVERIFIED |
| Registration fields: full name, Telegram, Discord, email, GitHub, experience level, focus area, existing product?, location, plans after the hackathon | same | UNVERIFIED |
| Payout: in MEZO, dollar share ÷ the 14-day TWAP on the day KYB completes. KYB needs a W-9 or W-8BEN, ID, proof of address and the receiving wallet | same | UNVERIFIED |
| **A wave submission**, according to participants: an AKINDO project page with pitch, repository, deployed address and demo video. Form fields: name, category, TL;DR, how it works, target group, tech stack, track, chain, new or existing, readiness, future milestones, team. Waves are judged on progress | `Hoang130203/mezoloop` `SUBMISSION.md`; `anikeaty08/thaw` (THAW_SYSTEM_DESIGN.md §21) | UNVERIFIED |
| To be *featured* in the Mezo Market (not a buildathon rule), a dApp needs MUSD, a third-party audit report submitted to the Supernormal Foundation, and mainnet. PayLink is not audited and must not claim otherwise | docs `dapp-requirements.md` | C |

## 11. Payment routes and gasless relaying

**Routes for MUSD with PayLinkV2:**

| Payer | Route | Payer does | Gas |
|---|---|---|---|
| Code-less EOA (MetaMask and others) | **`payWithPermit`**, one EIP-2612 permit for exactly the amount with PayLinkV2 as spender, under domain `Mezo USD`/`1` | 1 signature + 1 transaction | BTC, paid by the payer |
| Same, fallback (permit refused by the wallet, or a stale nonce) | **approve (exact amount) + `pay`** | 2 transactions | BTC, paid by the payer |
| Smart account (a Passport Safe, an EIP-7702-delegated EOA) | approve + `pay`, or an EIP-5792 batch where the wallet offers one | 1 or 2 approvals | BTC, paid by the account |
| Anyone | `payWithAuthorization`: **impossible**, MUSD has no EIP-3009 (it reverts on the fork) | — | — |

Without any change, `selectPaymentPath` in `packages/sdk/src/router.ts` already produces this order from the registry flags `{ eip3009: false, eip2612: true }`. The wallet rail in `apps/web/src/rails/wallet.ts` implements `permit` and `approve-pay`.

**Can our relayer make it gasless? No, not with the deployed PayLinkV2 (C):**

- `payWithPermit` and `pay` both take the payer from `msg.sender` (`protocol/src/PayLinkV2.sol`): the permit is `permit(msg.sender, …)` and the pull is `transferFrom(msg.sender, …)`. A relayer that sends them would pay with its own funds.
- The only relayable payment, `payWithAuthorization`, needs EIP-3009.
- The relayer may sign only `payWithAuthorization`, `cancelBySig`, the faucet's `requestFunds` and zero-value self-transfers, and it **never sends value** (`apps/relayer/src/core/chains.ts`). So it cannot top up BTC either.
- On Mezo, the relayer can still offer **gasless `cancelBySig`** to merchants, once the chain is enabled in the registry.

Ways to reduce payer friction without changing the contract:

- **Wave 1:**
  - Tell payers the true cost: about 3 × 10⁻¹¹ BTC per payment.
  - Link the faucet, and Mezo's "Get Gas" if it exists on testnet (§8).
- **Wave 2 options, each needing its own decision:**
  - EIP-7702 sponsored execution: the payer's EOA delegates to an executor and the relayer sends the call to the payer's own address, so `msg.sender` is still the payer. This needs a new relayer allowlist and wallet support. Mezo's support for it is **L**.
  - ERC-4337 with a paymaster. EntryPoint v0.7 is present, but no Mezo bundler or paymaster is known (**UNVERIFIED**).
  - A new `PayIntent` contract ([spec](../spec/paylink-invoice-v2.md) §9, option a). That is a new deployment, outside this edition.
- **Not a PayLink route:** Mezo's x402 facilitator (`facilitator.vativ.io`) settles MUSD without gas for the buyer, through Permit2 and its own proxy. It pays `payTo` directly, so there is no invoice key, no `Paid` event and no PayLink receipt.

## 12. Corrections for the registry draft

These concern `packages/chains/src/chains/mezo-testnet.ts`. They are proposals only; this document does not apply them.

- **EVM level.** The note "EVM level reported as london (L)" is wrong for the running chain: Cancun opcodes execute (§2). The `paris` artefact is fine either way.
- **Gas model.** `gasModel.chargesGasLimit: false` is incomplete: Mezo charges at least 50 % of the limit. The existing `clamp(estimate × 1.10, …)` keeps the overcharge at zero.
- **RPC limits.** Add `rpcLimits.maxLogBlockRange: 10000` (C).
- **MUSD domain.** `eip712Domain` can be stated as `{ name: "Mezo USD", version: "1" }` (C). The capabilities `eip3009: false, eip2612: true` are confirmed (C).
- **MEZO.** If MEZO is listed, add it to `docs/tools/address-allowlist.json` with use `registry` and tag C in the same change. The address-parity test requires it.
- **Runbooks.** The [faucets runbook](../runbooks/faucets.md) and the [deploy runbook](../runbooks/deploy.md) should name `testnet.mezo.org/feature/borrow` (§8).

## 13. Sources

| Source | Version read |
|---|---|
| `https://rpc.test.mezo.org` (live), anvil 1.8.5 fork, cast 1.8.5 | 2026-10-13, blocks 16,140,049 to 16,140,210 |
| github.com/mezo-org/musd: `solidity/contracts/token/MUSD.sol`, `solidity/artifacts/deployments/{matsnet,mainnet}/`, `solidity/hardhat.config.ts` | commit aa25fd6defbe6c1385940e183ea7a0a3df4533d8 (2026-09-23) |
| github.com/mezo-org/mezod: `precompile/btctoken`, `precompile/mezotoken`, `precompile/erc20/permit.go`, `x/evm/keeper/state_transition.go`, `x/feemarket/types/params.go`, `x/evm/types/set_code_tx.go`, `go.mod` | commit e577c4ee3dab5c114f6c29f346d8c5222c47f0a5 (2026-10-12) |
| github.com/mezo-org/documentation (the source of mezo.org/docs): developer getting started, configure environment, Passport setup, MUSD guide, x402 overview and quickstart, dApp requirements, contracts reference, How to Borrow & Mint MUSD, Gasless Swaps | commit 8713c16a39a67c225d1fd10380edaa5e2e678042 (2026-10-13) |
| npm `@mezo-org/passport` 0.17.2 and 0.17.3-dev.3.no-ui, `@mezo-org/orangekit` 1.0.0-beta.40, `@mezo-org/orangekit-smart-account` 1.0.0-beta.24, `@x402/evm` 2.28.0, `@x402/paywall` 2.28.0 | registry tarballs, 2026-10-13 |
| Third-party (UNVERIFIED): github.com/thirdbase1/buildathon-radar `data/mezo.json`; github.com/Hoang130203/mezoloop `SUBMISSION.md`; github.com/anikeaty08/thaw THAW_SYSTEM_DESIGN.md | commits f46ece68a998b57dd73e9c7c778de92eb1bcef24, 65efec66c6b5aefcdcdab5383a931cec198f6f32, 86ca1c4e63fcac9b914acb6476b0e5e22cc4674a |
