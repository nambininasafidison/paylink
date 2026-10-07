# PayLinkV2 gas

PAYLINK-V2-SPEC §3.3.6 asks for v2.0 to be re-measured on Oct 7 and for the per-function gas floors and ceilings of `packages/chains` to be derived from the measurement. Monad charges the **gas limit**, not the gas used, so these limits matter.

- **Date:** 2026-10-07. Release build (solc 0.8.30, paris, 10,000 optimizer runs; `initCodeHash` `0x289dcd64…7ac5`; the figures are unchanged from the earlier `0xb58f06f4…34ce` build, which differed only in NatSpec and therefore in the CBOR metadata hash).
- **Tokens:** the test mocks (`Mock3009` for the EIP-3009 path, `MockPermit` for allowance and permit). Real FiatToken (USDC) and AUSD are upgradeable proxies with extra checks, so each call to them costs more. **These are not the final limits; re-measure on each testnet with cold slots** (spec §3.3.6, runbook "After every deployment").

## 1. Transaction gas on anvil (ground truth)

`script/dev/LocalSmoke.s.sol` sends every entry point as a real transaction to a local anvil node (Foundry 1.8.5, default hardfork, chain 31337). `gasUsed` from the receipts, confirmed with `cast receipt` and `cast run`; it includes the 21,000 intrinsic gas and calldata, after EIP-3529 refunds.

| Transaction | `gasUsed` | Calldata | Situation |
|---|---|---|---|
| Deploy through the CREATE2 factory (`Deploy.s.sol`) | 2,678,851 | 13,011 B | Factory present (84532 id) |
| Deploy with CREATE (`Deploy.s.sol`) | 2,677,645 | 12,979 B | Factory absent (10143 id) |
| `payWithAuthorization`, first payment | 141,884 | 708 B | Relayer sends; link slot 0 → non-zero; payee's first USDC |
| `payWithAuthorization`, later payment | 107,684 | 708 B | Unlimited open link; payee already funded |
| `pay`, first payment | 101,896–101,908 | 484 B | Fixed one-off link; payee's first MUSD |
| `pay`, later payment | 67,278 | 484 B | Unlimited open link |
| `payWithPermit`, first payment of the link | 117,938 | 612 B | Payee already held MUSD; permit nonce 0 → 1 |
| `payNative`, first payment | 72,031–72,043 | 452 B | Payee is a funded account |
| `payNative`, later payment | 54,931–54,943 | 452 B | |
| `cancel` | 53,043 | 260 B | Never-paid link: slot 0 → non-zero |
| `cancelBySig` (relayed) | 61,974 | 452 B | Same |

`cast run` on the `cancel` transaction: 32,351 gas executed in the PayLinkV2 frame, 53,043 for the transaction (21,000 + 2,492 calldata + 32,351 − 2,800 reentrancy-guard refund).

The spec's prototype estimates (deploy ≈ 2.71M, `payNative` ≈ 100k, `pay` ≈ 110k, `payWithAuthorization` ≈ 160k) were upper bounds; v2.0 is at or below each.

## 2. Foundry in-test figures (regression baseline)

`test/gas/Gas.t.sol` writes [`../snapshots/PayLinkV2.json`](../snapshots/PayLinkV2.json); with `FORGE_SNAPSHOT_CHECK=true` it compares instead, and fails when any figure moves. `.gas-snapshot` holds the unit and gas suites only (197 entries). The gate is `pnpm --filter @paylink/protocol run snapshot:check`, which is `FORGE_SNAPSHOT_CHECK=true forge snapshot --match-path 'test/{unit,gas}/*.t.sol' --check --tolerance 3`. A bare `forge snapshot --check --tolerance 3` exits 1 on this tree, because every fuzz, invariant, vector, script, toolchain and audit test is reported missing from the file, and without `FORGE_SNAPSHOT_CHECK=true` it would rewrite `snapshots/PayLinkV2.json`.

| Name | In-test gas | Anvil `gasUsed` (§1) |
|---|---|---|
| `deploy` | 2,707,059 | 2,677,645 (CREATE) |
| `payWithAuthorization_first` | 142,326 | 141,884 |
| `payWithAuthorization_repeat` | 107,732 | 107,684 |
| `payWithAuthorization_erc1271Payee` | 146,886 | — |
| `pay_first` | 101,896 | 101,896 |
| `pay_repeat` | 67,266 | 67,278 |
| `payWithPermit_first` | 135,444 | (117,938: payee already funded there) |
| `payNative_first` | 97,449 | (72,031: payee is a funded account there; an empty payee adds the 25,000 new-account charge) |
| `payNative_repeat` | 54,931 | 54,931 |
| `cancel` | 53,031 | 53,043 |
| `cancelBySig` | 61,950 | 61,974 |
| `cancelBySig_erc1271Payee` | 66,528 | — |
| `statesOf_256` (256 cold keys, read-only) | 764,461 | — |

**How to read the in-test figures.** They are not transaction gas. Inside a Foundry test, the PayLinkV2 frame costs about 20k more than the same frame on a chain (`cancel`: 52,995 in the test frame, 32,351 on anvil). The likely cause is that Foundry prices storage writes against the state before `setUp` rather than committed state, so the reentrancy guard's first write is priced as a fresh one. By coincidence the excess roughly equals the 21,000 intrinsic plus calldata minus refunds, so like-for-like rows agree with the receipts within 0.5k. Use the receipts (§1) for limits and the in-test figures to detect regressions.

## 3. Provisional limits for `packages/chains`

Spec rule: `gasLimit = clamp(eth_estimateGas × 1.10, floor, ceiling)`, with floor = the measurement and ceiling = 1.5 × the measurement (the ceiling also covers ERC-1271 payees, which add one cold account and the wallet's own check: +4.6k for the minimal `Wallet1271`). Starting values from §1, worst case per function, rounded up to the next 1,000:

| Function | Floor | Ceiling |
|---|---|---|
| `payWithAuthorization` | 143,000 | 215,000 |
| `pay` | 102,000 | 153,000 |
| `payWithPermit` | 136,000 | 204,000 |
| `payNative` | 98,000 | 147,000 |
| `cancel` | 54,000 | 81,000 |
| `cancelBySig` | 67,000 | 101,000 |

`payWithPermit` and `payNative` use the in-test worst case (payee holding no token yet; empty payee account for native). **Replace every value with the cold-slot measurement on each testnet** before the relayer uses them: real token proxies add their own overhead, and Monad's cold-access prices differ from Ethereum's (spec §3.3.6: SLOAD and SSTORE 8,100, account access 10,100, L).

## 4. Deployment budget

About 2.68M gas. At the spec's Monad estimate of ~105 gwei that is ~0.28 MON, inside the 0.5 MON budget (spec §3.3.6 assumed 3.0M, 0.32 MON).

## Reproduce

```bash
cd protocol
forge test --match-path 'test/gas/*'                              # in-test figures -> snapshots/PayLinkV2.json
anvil &                                                            # chain 31337
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil test key 0>
PAYLINK_ADDRESS=<address printed> pnpm run smoke:local             # receipts in broadcast/LocalSmoke.s.sol/31337/run-latest.json
```
