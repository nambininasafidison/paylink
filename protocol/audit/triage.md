# Static-analysis triage: PayLinkV2

> Self-review evidence, **not a third-party audit**. Scope: `protocol/src/` (PayLinkV2 and its two interfaces).

| | |
|---|---|
| **Tree** | `main` at `93ed4e3` plus the uncommitted v2 tree, 2026-10-07 |
| **Tools** | Slither 0.11.6 (crytic-compile 0.4.2), 102 detectors; `forge lint` (Foundry 1.8.5) |
| **Command** | `cd protocol && slither . --config-file slither.config.json` |
| **Config** | `filter_paths: (lib/\|node_modules/\|test/\|script/)`, `exclude_dependencies: true`, `fail_on: medium` |
| **Result** | **0 results** (exit 0). With `--show-ignored-findings`: 3 results in 2 detectors, all triaged below. Raw output: [slither.txt](slither.txt) |
| **Gate** | No untriaged finding of any severity. Every inline suppression in `src/` names its entry here; an unnamed suppression is a review failure |

## Summary

| ID | Detector | Slither impact / confidence | Results | Disposition |
|---|---|---|---|---|
| [S-1](#s-1-reentrancy-balance-in-_receiveandforward) | `reentrancy-balance` | High / Medium | 1 | **False positive.** The before/after reading is the intended exact-delta and conservation measurement; suppressed inline with a pointer here |
| [S-2](#s-2-timestamp-in-_record-and-cancelbysig) | `timestamp` | Low / Medium | 2 | **Accepted by design.** Second-granularity business windows and deadlines; suppressed inline with a pointer here |
| [L-1](#l-1-forge-lint-suppressions) | `forge lint` (5 rules, 7 sites) | — | 7 | Each justified below |

Manual-review observations that no tool reports are in [§ Observations](#observations-manual-review).

---

## S-1 `reentrancy-balance` in `_receiveAndForward`

**Report** (`src/PayLinkV2.sol` #242–261): `balanceBefore = token.balanceOf(address(this))` is read before the external call `IERC3009(token).receiveWithAuthorization(...)`, then compared after it (`received != auth.amount` through `_increase(balanceBefore, …)`, and `balanceAfter != balanceBefore`). Slither flags the pre-call balance as possibly stale.

**Disposition: false positive.** Reading the balance before the call is the point: the difference *is* the measurement (PAYLINK-V2-SPEC §3.3.3 step 5; invoice spec §7.5). A stale value cannot mislead it:

1. **No re-entry.** Every state-changing entry point is `nonReentrant`, so the token (or a hook it calls) cannot re-enter PayLink and move PayLink's balance mid-call. PayLink grants no allowance and holds no approval, so nothing else can pull tokens out of it either. The balance can only *increase* during the call, by a third party transferring to PayLink.
2. **An increase fails safe.** If the token delivers the full `amount` and someone also sends `X` to PayLink inside the call, `received = amount + X ≠ amount` and the call reverts `ReceivedMismatch`.
3. **A compensating token cannot spend donations.** If a non-standard token delivers only `amount − X` while a hook sends `X` to PayLink, the receive check passes, but the payee-delta check still requires the payee to gain exactly `amount`, and the conservation post-check requires PayLink to end at `balanceBefore`. Pre-existing stray balances are never spent; only whoever chose to send `X` paid it.
4. **Allowlisted tokens have no hooks.** Circle USDC (FiatToken v2.2) and AUSD implement EIP-3009 without transfer callbacks.

**Evidence:** `Reentrancy.t.sol::test_RevertWhen_TokenHookReentersDuringPayWithAuthorization` (HookReentrant mock re-enters from inside the transfer and is refused with `ReentrancyGuardReentrantCall`), `PayWithAuthorization.t.sol::test_RevertWhen_TokenTakesFeeOnReceive`, `test_RevertWhen_TokenTakesFeeOnForward`, `test_RevertWhen_TokenWouldSpendDonations`, `Donations.t.sol::test_DonationCannotFundAPayment`, invariant I1 (`invariant_I1_relativeConservation`, per-call balance check in the handler, `Donor` actions).

**Suppression:** `// slither-disable-next-line reentrancy-balance` at `src/PayLinkV2.sol:246`, with the comment "(audit/triage.md, S-1)". Same conclusion as `docs/security/self-review.md` SR-01.

## S-2 `timestamp` in `_record` and `cancelBySig`

**Report:** `block.timestamp < inv.validAfter` and `inv.validUntil != 0 && block.timestamp > inv.validUntil` (`_record`, #208–209); `block.timestamp > deadline` (`cancelBySig`, #142).

**Disposition: accepted by design.** These are human-scale validity windows (an invoice valid for 7 days; a cancel signature valid for an hour), compared at second granularity with inclusive bounds. A block producer's timestamp latitude (seconds) only matters exactly at an edge, and moving a payment across an edge only lets it be accepted or refused a few seconds early or late; no funds move differently. There is no randomness or ordering derived from time. Threat model T-34 (Low, accepted); SWC-116.

**Evidence:** `PayWithAuthorization.t.sol::test_PayWithAuthorization_WindowBoundariesAreInclusive`, `test_PayWithAuthorization_ZeroValidUntilNeverExpires`, `Cancel.t.sol::test_CancelBySig_DeadlineIsInclusive`, `Window.t.sol::testFuzz_WindowMatchesModel`, `testFuzz_WindowEdgesAreInclusive`, `testFuzz_CancelDeadline`, invariant I5.

**Suppression:** `// slither-disable-next-line timestamp` at `src/PayLinkV2.sol:141` and `:207`, each citing S-2.

## L-1 `forge lint` suppressions

`forge lint` (blocking, `severity = ["high", "medium", "low"]`) reports nothing on the tree. These are the seven sites where a rule is disabled in `src/PayLinkV2.sol`, and why:

| Line | Rule | Why it is safe |
|---|---|---|
| 117 | `unsafe-typecast` (`uint128(msg.value)`) | The line before reverts `WrongAmount` when `msg.value > type(uint128).max`, so the cast is exact. `testFuzz_NativeValueAboveUint128IsRejected`, `test_RevertWhen_ValueExceedsUint128` |
| 120 | `arbitrary-send-eth` (`Address.sendValue(payee, msg.value)`) | The destination is the payee whose signature `_record` verified in the same call, and the value is the caller's own `msg.value`, forwarded in full. PayLink never sends its own balance (I1) |
| 140–143 | `block-timestamp` | S-2 |
| 206–210 | `block-timestamp` | S-2 |
| 220 | `unsafe-typecast` (`uint64(block.timestamp)`) | Exact for the next 584 billion years (2^64 seconds) |
| 226 | `reentrancy-events` (`Paid` emitted after an external call) | The only earlier external call is the ERC-1271 `STATICCALL` inside `SignatureChecker`, which cannot change state. Every token or value transfer happens after the event (checks-effects-interactions) |
| 235 | `reentrancy-events` (`InvoiceCancelled`) | Same: the only earlier external call is `cancelBySig`'s ERC-1271 `STATICCALL` |

---

## Observations (manual review)

Not reported by any tool. None is a defect in the contract as specified; each is recorded so that the owning workstream can act.

### O-1 Open-amount links with a seat limit can be used up by dust (Informational)

An invoice with `amount = 0` and `maxPayments = N > 0` (the spec's "open-amount, single use" kind) accepts any positive amount. Anyone holding the link can pay 1 base unit N times and sell it out; the payee then receives only that dust. This follows from bearer semantics (invoice spec §14.3) and costs the griefer gas plus the dust, so it is a nuisance, not a loss of funds. **Recommendation (web/SDK):** issue open-amount links as receive cards (`maxPayments = 0`), or warn the payee that a single-use open link can be consumed by any amount; the payee can always reissue. No contract change: a minimum amount would need a new signed field and a new release.

### O-2 `payWithPermit` replaces an existing allowance (Informational)

`permit` sets the allowance to exactly `amount`, which overwrites any larger allowance the payer had given PayLink; after the payment it is 0. This is the payer's own signature and the standard EIP-2612 semantics. It cannot be abused by a third party: PayLink only ever pulls from `msg.sender` (`pay`, `payWithPermit`) or from an EIP-3009 signer with a nonce bound to the payment, so an allowance to PayLink is not spendable by anyone but its owner.

### O-3 `Paid` events from unlisted tokens are not evidence of value (Informational)

`inv.token` is chosen by the payee, so a payee can settle invoices in a worthless token and emit genuine-looking `Paid` events. This only affects that payee's own links. **Recommendation (indexer, receipt verifier):** count or display a payment only when `token` is in the chain's registry allowlist (`packages/chains`), as the spec's read model already requires.
