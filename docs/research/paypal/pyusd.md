# PYUSD (PayPal USD) on-chain, and what it means for PayLinkV2

> Copied into the repository on 2026-10-21 from the planning notes of 2026-10-13, unchanged. The owner's decisions of 2026-10-21 ([docs/paypal/SPEC.md](../../paypal/SPEC.md), [ADR 0018](../../adr/0018-paypal-edition.md)) chose Ethereum Sepolia, this note's fallback; what the chain says there, read on 2026-10-21, is [sepolia.md](sepolia.md).

Research date: 2026-10-13. Scope: where PYUSD is issued, its contract surface (decimals, EIP-2612, EIP-3009, freeze, pause, wipe), faucets, and whether PayLinkV2 (`0x448eCce9711860502806A3d5B021a4f9Ba715082`, immutable) can settle PYUSD on its existing paths without a contract change.

How sure each fact is:
- **ON-CHAIN**: read or simulated live from this sandbox (Arbitrum Sepolia and Base Sepolia RPCs, block ~318.83M on Arbitrum Sepolia).
- **SOURCE**: read from Paxos's public Solidity source or README on GitHub (raw files fetched).
- **OFFICIAL (snippet)**: on docs.paxos.com, paypal.com or developer.paypal.com, but those hosts are blocked here, so the fact comes from the search-engine excerpt of the official page. Re-check in a browser before shipping.
- **UNVERIFIED**: secondary sources only, or nothing found.

---

## 1. Verdict per chain

| Chain | PYUSD there? | PayLinkV2 there? | Verdict for the PayPal edition |
|---|---|---|---|
| **Arbitrum Sepolia (421614)** | **Yes.** `0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1`: `name()`="PayPal USD", `symbol()`="PYUSD", 6 decimals, Paxos SupplyControl. **ON-CHAIN** + OFFICIAL (snippet) | **Not yet** (no code at the address). The CREATE2 factory `0x4e59…956C` is present. A simulated deploy returns exactly `0x448eCce9…5082`. **ON-CHAIN** | **GO, recommended testnet.** All three ERC-20 paths settle against the live token in simulation (§4). The contract needs no change. Remaining work: one CREATE2 deploy tx plus off-chain registry, SDK and relayer changes (§5). The chain is already `enabled` in `packages/chains/src/chains/arbitrum-sepolia.ts` |
| **Ethereum Sepolia (11155111)** | **Yes.** `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9`, OFFICIAL (snippet). Paxos page also gives SupplyControl `0xE288F41c4bdA3Cb5C75156E263CB8ecbB8eF60E2`. Contract surface not verified here (no Sepolia RPC reachable) | No. Chain not in the `@paylink/chains` registry | **Fallback.** Probably the same `PaxosTokenV2` (UNVERIFIED on-chain). It has the best-documented faucet (Google Cloud and Paxos). It costs a new chain entry plus L1-priced gas |
| Base Sepolia (84532) | **No.** The same address `0x637A…B1B1` holds **Paxos Gold (PAXG, 18 decimals, supply 0)**, not PYUSD. **ON-CHAIN**. No PYUSD address found in any official source | Yes | **NO-GO for PYUSD.** Do not register `0x637A…` here as PYUSD |
| Monad testnet (10143) | **No.** No code at any of the known PYUSD addresses. **ON-CHAIN**. No official source mentions Monad | Yes | **NO-GO for PYUSD** |
| Ethereum mainnet (1) | Yes. `0x6c3ea9036406852006290770BEdFcAbA0e23A0e8` (proxy). **SOURCE** (pyusd-contract README) + OFFICIAL (snippet) | No | Same code family as the testnets (README documents EIP-3009 and EIP-2612). Not needed for a testnet demo. Mainnet is outside v2's scope |
| Arbitrum One (42161) | Yes, issued natively by Paxos. `0x46850aD61C2B7d64d08c9C754F45254596696984`. OFFICIAL (snippet, docs.paxos.com mainnet page and PayPal Help Center) | No | Implementation not verified on-chain (RPC blocked). Expected to match the Arbitrum Sepolia token: UNVERIFIED |
| Polygon PoS (137) | Native issuance announced 2026-07-09 (news only). Address UNVERIFIED | No | Out of scope. No testnet address found |
| Solana | Yes. Mint `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo`; Devnet `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM`. OFFICIAL (snippet) | n/a (not EVM) | **Not applicable** to PayLinkV2 |
| Stellar | Yes (live 2025-09-18). Issuer `GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5`. OFFICIAL (snippet) | n/a | **Not applicable** |
| PYUSD0 (LayerZero OFT) on Abstract, Aptos, Avalanche, Ink, Sei, Stable, Tron, Flow… | A separate bridged token, "PYUSD0", not issued by Paxos. Flow EVM: `0x99af3eea856556646c98c8b9b2548fe815240750` (Flow docs, snippet) | No | **UNVERIFIED.** EIP-3009 and EIP-2612 support of the OFT contract was not checked. Do not assume it. None of these chains is Base or Monad |

Do not mix PYUSD up with **PYUSDx** (M0 platform, `0xeBDB0942cE16386Ab90718C7BD10C91CDb66b14d` on Ethereum, Arbitrum and their Sepolias). It is a different token.

---

## 2. Addresses and sources

| Network | Token (proxy) | Extra | Source |
|---|---|---|---|
| Ethereum mainnet | `0x6c3ea9036406852006290770BEdFcAbA0e23A0e8` | AdminUpgradeabilityProxy | https://github.com/paxosglobal/pyusd-contract (README, fetched raw); https://docs.paxos.com/guides/stablecoin/pyusd/mainnet (snippet) |
| Arbitrum One | `0x46850aD61C2B7d64d08c9C754F45254596696984` | — | https://docs.paxos.com/guides/stablecoin/pyusd/mainnet (snippet); https://www.paypal.com/sg/cshelp/article/what-is-paypal-usd-pyusd-help1005 (snippet); launch: https://developer.paypal.com/community/blog/pyusd-on-arbitrum/ (2025-07-31, snippet), https://www.theblock.co/post/362843/paypal-stablecoin-arbitrum-support |
| Solana | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | SPL | PayPal Help Center HELP1005 (snippet) |
| Stellar | `GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5` | — | PayPal Help Center HELP1005 (snippet); https://stellar.org/press/paypal-pyusd-is-now-available-on-stellar |
| Ethereum Sepolia | `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9` | SupplyControl `0xE288F41c4bdA3Cb5C75156E263CB8ecbB8eF60E2` | https://docs.paxos.com/guides/stablecoin/pyusd/testnet (snippet) |
| **Arbitrum Sepolia** | **`0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1`** | SupplyControl `0x7Bc02856903Bd5D848892014283Ea2eDE8d4cEDf`; implementation `0xe0abc37950e526a23763f8f2d968e7dd9aa12d27`; proxy admin `0x482c5a130ef1b196aece22a2025fd502ebd6e50c`; owner `0xc7aa9798be85ad3b628ee71519b38d7057f8cd7e` | docs.paxos.com testnet page (snippet). **Cross-checked ON-CHAIN:** `supplyControl()` returns exactly the SupplyControl address on the Paxos page |
| Solana Devnet | `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM` | — | docs.paxos.com testnet page (snippet) |
| Polygon PoS | UNVERIFIED | native since 2026-07-09 | https://www.theblock.co/amp/post/407719/paypal-seeks-increase-pyusd-stablecoin-native-issuance-on-polygon ; https://thedefiant.io/news/tradfi-and-fintech/paypal-s-pyusd-goes-native-on-polygon-joins-open-money-stack |
| PYUSD0 chains | Flow EVM `0x99af3eea856556646c98c8b9b2548fe815240750`; others UNVERIFIED | LayerZero OFT | https://developers.flow.com/defi/pyusd0-integration-guide (snippet); https://www.theblock.co/post/371321/paypal-pyusd-stablecoin-expands-blockchains-layerzero ; https://developer.paypal.com/community/blog/pyusd-layerzero |

Search excerpts disagree on whether the Paxos testnet page lists Arbitrum Sepolia (the sandbox mirror may be older). The on-chain checks settle it: name, symbol and SupplyControl all match.

---

## 3. Token surface (`PaxosTokenV2`)

Source code: https://github.com/paxosglobal/paxos-token-contracts. Files read raw: `contracts/PaxosTokenV2.sol`, `contracts/lib/EIP3009.sol`, `contracts/lib/EIP2612.sol`, `contracts/lib/EIP712.sol`, `README.md`. PYUSD README: https://github.com/paxosglobal/pyusd-contract (the "Delegate Transfer" section says *"we have implemented EIP-3009 and EIP-2612"*).

| Feature | Fact | Evidence |
|---|---|---|
| Decimals | **6** | ON-CHAIN `decimals()` on Arbitrum Sepolia |
| EIP-712 domain | `name = "PayPal USD"`, `version = "1"` (hard-coded in `DOMAIN_SEPARATOR()`: `EIP712._makeDomainSeparator(name(), "1")`), chainId, verifyingContract = proxy | SOURCE. ON-CHAIN: recomputed separator `0xf3ecc5ae…acb2` equals `DOMAIN_SEPARATOR()` on 421614 |
| `eip712Domain()` (ERC-5267) | **Not implemented** (reverts) | ON-CHAIN |
| `version()` | **Not implemented** (reverts) | ON-CHAIN. This breaks PayLink's SDK domain read (§5) |
| EIP-2612 `permit(owner,spender,value,deadline,v,r,s)` | Yes. Also a `bytes signature` overload (ERC-1271 via OZ `SignatureChecker`). `nonces(owner)`, `cancelPermits(count)`. Permit typehash matches the standard | SOURCE + ON-CHAIN (selector `d505accf` in implementation, typehash `0x6e71edae…`) |
| EIP-3009 `transferWithAuthorization` | Yes, `v,r,s` and `bytes` overloads, plus `transferWithAuthorizationBatch` | SOURCE + ON-CHAIN (`e3ee160e`) |
| EIP-3009 **`receiveWithAuthorization`** | **Yes**, with `if (to != msg.sender) revert CallerMustBePayee()`. This is the call PayLinkV2 makes | SOURCE + ON-CHAIN (`ef55bec6`, typehash `0xd099cc98…` matches the EIP) |
| `cancelAuthorization`, `authorizationState` | Yes | SOURCE + ON-CHAIN |
| **Used-nonce behaviour (differs from USDC)** | On an already-used nonce, `_transferWithAuthorization` **emits `AuthorizationAlreadyUsed` and returns without reverting and without transferring**. USDC reverts instead | SOURCE (`EIP3009.sol`). ON-CHAIN simulation: PayLinkV2 then reverts `ReceivedMismatch(amount, 0)`, so it stays safe |
| Pause | `owner` / pauser role can pause. `whenNotPaused` covers `transfer`, `transferFrom`, `approve`, `permit`, `transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization` → `ContractPaused()` | SOURCE + simulated |
| Freeze | `ASSET_PROTECTION_ROLE` can `freeze` / `freezeBatch` any address. `_transfer` reverts `AddressFrozen()` if `from` or `to` is frozen. `transferFrom` also checks `msg.sender`. `permit` and `approve` check owner and spender. `isFrozen(addr)` is public | SOURCE + simulated |
| Wipe | `wipeFrozenAddress(addr)` burns a frozen address's balance | SOURCE |
| Upgradeable | `AdminUpgradeabilityProxy`. Paxos can replace the logic at any time | SOURCE + ON-CHAIN (ZeppelinOS implementation slot set) |
| Fee-on-transfer / rebasing | None in the code read (plain balance moves) | SOURCE |
| Signature types | `SignatureChecker.isValidSignatureNow`: EOA ECDSA or ERC-1271 | SOURCE |

---

## 4. On-chain proof: PayLinkV2 × live PYUSD on Arbitrum Sepolia

Method: read-only `eth_call` with state overrides. No transaction was sent.
- PayLinkV2's runtime (12,045 bytes) was copied from Base Sepolia and placed at its CREATE2 address `0x448eCce9…5082` on Arbitrum Sepolia. OZ `EIP712` rebuilds the domain for chain 421614.
- Fresh secp256k1 keys acted as payee, payer and relayer.
- The payer's PYUSD balance (mapping slot 1) and, for `pay`, the allowance (slot 3) were injected. Frozen is slot 6, `_authorizationStates` slot 50, paused is bit 160 of slot 4.
- Real EIP-712 signatures were used throughout: the invoice under the "PayLink"/"2" domain, and ReceiveWithAuthorization and Permit under the "PayPal USD"/"1" domain.
- Amount: 12.34 PYUSD.

| Scenario | Result |
|---|---|
| `payWithAuthorization` (relayer submits payer's `ReceiveWithAuthorization` with the bound `paymentNonce`) | **SUCCESS** (returns index 0) |
| `payWithPermit` (payer submits, permit then `transferFrom`) | **SUCCESS** |
| `pay` after approve (allowance = amount) | **SUCCESS** |
| `pay` without allowance | revert `InsufficientAllowance()` |
| Unfunded payer | revert `InsufficientFunds()` |
| Payer signed a different amount | revert `InvalidSignature()` |
| Payee frozen | revert `AddressFrozen()` |
| **PayLinkV2 address frozen** | revert `AddressFrozen()` |
| Token paused (3009 path and `pay`) | revert `ContractPaused()` |
| 3009 nonce already used (Paxos returns silently) | PayLinkV2 reverts `ReceivedMismatch(12340000, 0)`. The exact-delta check catches the silent no-op |
| CREATE2 deploy of the release initcode through `0x4e59…956C` on 421614 (`eth_call`) | returns `0x448ecce9711860502806a3d5b021a4f9ba715082`. initCodeHash matches `release.json` |

Smallest gas limit that succeeds (binary search with `eth_call`, execution only, first payment to a payee with a zero balance):

| Path | PYUSD needs | Registry snapshot ceiling (`SNAPSHOT_GAS_LIMITS`) | Margin |
|---|---|---|---|
| payWithAuthorization | 206,713 | 215,000 | ~4% |
| payWithPermit | 197,391 | 204,000 | ~3% |
| pay | 146,482 | 153,000 | ~4% |

The margins are thin. An ERC-1271 payee adds about 5k gas (Base measurements), which would break the ceiling. On Arbitrum, `eth_estimateGas` also adds the L1 posting cost (the registry already notes this). Give PYUSD on 421614 its own measured gas table, or raise the ceilings.

Reproduce with `python3 -I tools/sim.py` and `python3 -I tools/gas.py`. Outputs are in `sim-arbitrum-sepolia.txt` and `gas-arbitrum-sepolia.txt`. The tools are pure Python: their own keccak and secp256k1, no dependencies.

---

## 5. Does PayLinkV2 work with PYUSD unchanged?

**Contract: yes, all three ERC-20 paths, with no change** (proven on 421614, §4).
- `payWithAuthorization` calls `receiveWithAuthorization(v,r,s)`, which PYUSD implements with the standard typehash and the `to == msg.sender` rule.
- `payWithPermit` calls the standard `permit`.
- `pay` uses `transferFrom`.
- 6 decimals fits `uint128`.
- PYUSD has no fee-on-transfer or rebasing, so the exact-delta checks pass.
- `payNative` does not apply.

**Off-chain changes needed** (registry, SDK and relayer, not the contract):
1. **SDK domain read fails on PYUSD.** `packages/sdk/src/token-domain.ts` `readTokenDomain()` tries `eip712Domain()` (reverts on PYUSD) and then falls back to `name()` and **`version()`**. PYUSD has no `version()` (ON-CHAIN), so the call throws. `resolveTokenDomain()` is reached from `issue.ts`, `relayer.ts`, `attempts.ts` and `permit.ts`, so both gasless paths break when a client is passed. Fix: when `version()` reverts, use the registry's stated version and accept it only if `keccak(EIP712Domain, name, version, chainId, token)` equals the token's `DOMAIN_SEPARATOR()`. For PYUSD that is name "PayPal USD", version "1", verified above.
2. **Registry entry** in `packages/chains/src/chains/arbitrum-sepolia.ts`:
   - `symbol: "PYUSD"`, `address: 0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1`, `decimals: 6`
   - `capabilities: { eip3009: true, eip2612: true, native: false }`
   - `eip712Domain: { name: "PayPal USD", version: "1" }`
   - a PYUSD gas table
   
   Also add the token to the relayer's allowlist.
3. **Error decoder** (`packages/sdk/src/error-decoder.ts`) only knows the USDC revert string. Add the Paxos custom errors so users get readable messages: `AddressFrozen()` 0x1fd1cc44, `ContractPaused()` 0xab35696f, `InsufficientFunds()` 0x356680b7, `InsufficientAllowance()` 0x13be252b, `CallerMustBePayee()`, `AuthorizationExpired()`, `AuthorizationInvalid()`, `PermitExpired()`. `InvalidSignature()` 0x8baa579f has the same selector as PayLinkV2's own error. Detecting a consumed authorization through `authorizationState(payer, nonce)` already works with PYUSD.
4. **Deploy PayLinkV2 on Arbitrum Sepolia**: one CREATE2 tx, same address, about 2.72M gas (registry measurement, 2026-10-07). It needs Sepolia ETH on Arbitrum.
5. Smart-account payers: PayLinkV2's `Authorization` carries `v,r,s` only, so passkey or ERC-1271 payers cannot use the 3009 path. This is the same as with USDC. They use approve+pay (EIP-5792 batch), which works.

---

## 6. Compliance controls and the non-custodial contract

- **No funds at rest in PayLinkV2.** Pull paths go payer → payee directly. The 3009 path passes through and is checked for conservation. A freeze or wipe of PayLinkV2 can therefore seize nothing.
- **Liveness risk:** if Paxos froze `0x448e…5082` on a chain, **every PYUSD payment through PayLink there would revert** (`AddressFrozen`). The contract is immutable and ownerless, so the only remedy is a new deployment at a new address (new salt). Payments in other tokens are unaffected. Paxos says freezing is *"something that Paxos will not do on its own accord"* (pyusd-contract README).
- A frozen payee or payer makes that payment revert cleanly. The UI can check `isFrozen(payee)` before showing a link, and `paused()` before signing.
- Pause blocks all three paths (`ContractPaused`). EIP-3009 authorizations and permits signed during a pause stay valid until `validBefore` or `deadline` (Paxos NatSpec warns that failed-tx data can be replayed after unpause). PayLinkV2's bound nonce limits any replay to the same payment.
- Upgradeability: Paxos can change token semantics. PayLinkV2's exact-delta and conservation checks make a semantic change fail closed (revert) rather than misroute funds.

---

## 7. Test tokens (faucets)

- **Paxos faucet**: https://faucet.paxos.com/ (linked from the pyusd-contract README, *"to get PYUSD on testnet"*). Which networks it serves (Arbitrum Sepolia?) is UNVERIFIED (host blocked here).
- **Google Cloud Web3 faucet**: https://cloud.google.com/application/web3/faucet (reachable). The PayPal developer blog (https://developer.paypal.com/community/blog/testnet-pyusd, snippet) says it gives PYUSD on **Ethereum Sepolia and Solana Devnet**, up to 100 PYUSD per Google account per day. Arbitrum Sepolia is not mentioned (UNVERIFIED).
- On-chain hint (Arbitrum Sepolia, last ~15M blocks): EOA `0xcc9644ec26a647de0b9b86f1560d5180232f70a3` (nonce 11,515) holds 7,412,273 of the 7,480,000 PYUSD supply. It sent 553 transfers, many of exactly 100 PYUSD or 0.001 PYUSD, which looks like a faucet drip. Whether this is Paxos's faucet is UNVERIFIED. Transfers were active until 2026-10-09.
- Arbitrum Sepolia ETH for gas: Alchemy, Chainlink and Blast faucets (from search results; amounts not verified).
- Plan B if no Arbitrum Sepolia drip works: use Ethereum Sepolia (the Google faucet is documented there) and add chain 11155111 to the registry.

---

## 8. Sources

Primary (fetched):
- https://raw.githubusercontent.com/paxosglobal/pyusd-contract/master/README.md
- https://raw.githubusercontent.com/paxosglobal/paxos-token-contracts/master/README.md
- https://raw.githubusercontent.com/paxosglobal/paxos-token-contracts/master/contracts/PaxosTokenV2.sol
- https://raw.githubusercontent.com/paxosglobal/paxos-token-contracts/master/contracts/lib/EIP3009.sol
- https://raw.githubusercontent.com/paxosglobal/paxos-token-contracts/master/contracts/lib/EIP2612.sol
- https://raw.githubusercontent.com/paxosglobal/paxos-token-contracts/master/contracts/lib/EIP712.sol
- JSON-RPC: https://sepolia-rollup.arbitrum.io/rpc , https://sepolia.base.org , https://testnet-rpc.monad.xyz

Official pages seen only as search excerpts (blocked here):
- https://docs.paxos.com/guides/stablecoin/pyusd/testnet
- https://docs.paxos.com/guides/stablecoin/pyusd/mainnet
- https://www.paypal.com/sg/cshelp/article/what-is-paypal-usd-pyusd-help1005
- https://developer.paypal.com/community/blog/pyusd-on-arbitrum/
- https://developer.paypal.com/community/blog/testnet-pyusd
- https://developer.paypal.com/community/blog/pyusd-layerzero
- https://developers.flow.com/defi/pyusd0-integration-guide
- https://stellar.org/press/paypal-pyusd-is-now-available-on-stellar

Secondary:
- https://www.theblock.co/post/362843/paypal-stablecoin-arbitrum-support
- https://www.theblock.co/post/371321/paypal-pyusd-stablecoin-expands-blockchains-layerzero
- https://www.theblock.co/amp/post/407719/paypal-seeks-increase-pyusd-stablecoin-native-issuance-on-polygon
- https://docs.m0.org/resources/addresses/pyusdx-platform (PYUSDx, a different token)

Not established here: whether PYUSD by itself satisfies the hackathon's "PayPal technology" requirement (UNVERIFIED; check the Devpost rules).
