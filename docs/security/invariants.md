# PayLinkV2 invariants

| | |
|---|---|
| **Version** | 1.2 |
| **Date** | 2026-10-07 |
| **Status** | Baseline for `contracts-v2.0.0`. Test names were checked against the working tree on 2026-10-07 by [`docs/tools/check-docs.py`](../tools/check-docs.py), which fails (locally now, in CI once the workflows land, planned for T0) if a cited test disappears |
| **Source of the properties** | PAYLINK-V2-SPEC §3.3.4 (I1–I11) |
| **Suite** | `protocol/test/invariant/` (`Invariants.t.sol`, `Handler.sol`, `GhostLedger.sol`), plus the unit and fuzz suites under `protocol/test/unit/` and `protocol/test/fuzz/`; beyond the blocking gates, the Echidna and Medusa property contract `protocol/test/properties/PayLinkProperties.sol` and the Halmos checks `protocol/test/symbolic/PayLinkSymbolic.t.sol` ([§4](#4-beyond-the-blocking-gates)) |
| **Run evidence** | Per-release campaign statistics and results live next to the contract, under `protocol/audit/`. This document is the catalogue: what each property means, why it matters and which tests enforce it |
| **Related** | [THREAT_MODEL.md](THREAT_MODEL.md) · [self-review.md](self-review.md) · [specification §7–§9](../spec/paylink-invoice-v2.md#7-payment-semantics) · [ADR 0003](../adr/0003-bind-3009-nonce-to-payment.md) · [ADR 0004](../adr/0004-immutable-ownerless-feeless.md) |

An invariant is a property that must hold after **every** sequence of calls, whoever makes them. PayLinkV2's invariants are the formal core of its security claims: the [threat model](THREAT_MODEL.md) cites them as evidence, and the [invoice specification](../spec/paylink-invoice-v2.md) states the same rules normatively.

## 1. How the invariants are tested

Three layers test each property, from the most targeted to the most exploratory:

1. **Unit tests** pin each rule to a concrete scenario, including the exact custom error and its arguments.
2. **Fuzz tests** (`protocol/test/fuzz/`) check the rule over random inputs: 1,000 runs locally and 10,000 in CI (`FOUNDRY_PROFILE=ci`).
3. **The stateful invariant campaign** (`protocol/test/invariant/`) runs random sequences of actions against one deployment and checks every property after each call.

The campaign is **model-based**:

- **Actors:** three accounts that act as both payers and payees, a deployed ERC-1271 wallet payee, a relayer, and a donor that makes stray transfers.
- **Assets:** `Mock3009` (6 decimals, EIP-3009 and EIP-2612, like USDC and AUSD), `MockPermit` (18 decimals, EIP-2612 only, like MUSD), two `FeeOnTransfer` tokens, an `OverCreditToken`, and the native coin. The two fee tokens reach different guards. `fee` charges 1 % on every transfer, so an EIP-3009 attempt with it stops at the receive-delta check. `fwdFee` exempts PayLink as a recipient, so an EIP-3009 attempt receives in full and reaches the forward leg; there it either deducts the fee from the payee's credit (the `_pushExact` payee-delta check, `PayeeShortPaid`) or charges PayLink the fee on top, which only stray donations could pay (the conservation post-check, `ReceivedMismatch(balanceBefore, balanceBefore − fee)`, or the token's own insufficient-balance error when donations do not cover it). The handler seeds a stray `fwdFee` balance so that the post-check is reachable from the first run. Fee tokens only ever make a balance come up short, while I1 and I6 are equalities; `OverCreditToken` covers the other direction. The `reconfigureOverCredit` action arms one leg to move more than the amount, by 1 to 10^6 base units: PayLink credited extra on the EIP-3009 receive (the receive check), the payee credited extra by `transferFrom` (`_pullExact`) or by the forward transfer (`_pushExact`), or PayLink debited less on the forward leg, which would leave its balance above where it started (the conservation post-check).
- **A second, alternate PayLinkV2 deployment**, used to check domain separation.
- **Actions** (handler selectors): `createInvoice`, `warp`, `payWithAuthorization`, `pay`, `payWithPermit`, `payNative`, `cancel`, `cancelBySig`, `donate`, `relayerRedirect`, `crossDomainReplay`, `wrongPath`, `reconfigureFee` (switches `fwdFee` between deducting from the amount and charging the sender) and `reconfigureOverCredit`.
- **Transaction origin.** Payments, `cancel` and `cancelBySig` run with `vm.prank(sender, origin)`, the origin seeded independently of the caller: one time in three the caller itself, one time in three the invoice's payee (its owner for the wallet payee), otherwise the relayer or another actor. A check that trusted `tx.origin` (SWC-115) would show up as an I9 violation or a model disagreement.
- **Prediction before every call.** The handler predicts each call's outcome with an independent model of the contract: either success, or the **exact revert data**. It then makes the call with a low-level `call`, so the handler itself never reverts. `fail_on_revert` is on, so an unexpected revert anywhere fails the campaign.
- **Ghost ledger.** Emitted logs are decoded into a ghost ledger, and per-call properties are checked immediately. Violations are recorded per invariant ID, and the first offending call is printed as the assertion message.
- **Depth.** 64 runs × depth 128 locally; **256 runs × depth 128 in CI**.
- **Model agreement.** `invariant_ModelAgreesWithContract` asserts that the model predicted every outcome and the final state of every key. It catches divergences that no single property names.
- **Mutation evidence.** The campaign alone, at the CI profile, kills a mutant that deletes the EIP-3009 conservation post-check (reported under I1 and model agreement) and one that deletes the forward-leg payee-delta check (reported under I6 and model agreement). Before `fwdFee` existed it killed neither: every EIP-3009 attempt with the only fee token stopped at the receive-delta check, so donations were never at risk inside the campaign (2026-10-07 audit; `protocol/audit/invariants.md`). It also kills, alone, the ten mutants of the 2026-10-07 test-quality review: each exactness check made one-sided (`!=` to `<`, so that PayLink could keep a surplus or the payee be over-credited, M50–M54), and `tx.origin` standing in for `msg.sender` or for the payee's signature (M55–M59). Before `OverCreditToken` and the seeded origins, all of them survived the campaign and the whole suite.

Run it with statistics:

```bash
cd protocol
FOUNDRY_PROFILE=ci forge test --match-contract InvariantsTest -vv   # -vv prints per-action and per-outcome counts
```

## 2. Catalogue

Notation: `bal_a(X)` is the balance of asset `a` held by `X`; `st(k)` is `stateOf(k)`; `Paid(k)` is the set of `Paid` events for key `k`. "Standard token" means an ERC-20 without transfer fees, rebasing or hooks; PayLink's clients only offer allowlisted standard tokens.

### I1. Relative conservation

> For every asset `a` (each token and the native coin) and every call `c`: `bal_a(PayLink)` after `c` equals `bal_a(PayLink)` before `c`, unless `c` is a stray transfer to PayLink, which adds exactly its own amount. PayLink's balance is never required to be zero. It is an equality: a balance that ends higher (PayLink silently keeping value) breaks it as much as one that ends lower.

- **Why:** PayLinkV2 is non-custodial. Funds pass through within one call (EIP-3009 and native) or never touch it (allowance and permit). A zero-balance requirement would let a 1-wei donation block every payment ([ADR 0004](../adr/0004-immutable-ownerless-feeless.md)).
- **Threats:** [T-09](THREAT_MODEL.md#t-09) (donation griefing), [T-08](THREAT_MODEL.md#t-08).
- **Invariant:** `invariant_I1_relativeConservation` also checks the absolute form: PayLink holds exactly what was donated, and the alternate deployment holds nothing.
- **Campaign:** the `fwdFee` token in its charge-the-sender mode is the action that puts donations at risk; the `donate` action and the constructor seed provide them. `OverCreditToken` armed on the receive leg or as an under-debit of the forward leg is the action that would make PayLink's balance grow; the handler compares every balance before and after every call, in both directions.
- **Symbolic (Halmos):** `check_payWithAuthorization_conservesAndCreditsExactly`, `check_pay_conservesAndCreditsExactly`, `check_payWithPermit_conservesAndCreditsExactly`, `check_payNative_conservesAndCreditsExactly`: for every amount, stray balance and token behaviour in which each leg moves any amount more or less than asked, a payment that succeeds leaves PayLink's balance unchanged.
- **Unit:** `Donations.t.sol::test_EveryPathWorksWithDonationsPresent`, `Donations.t.sol::test_DonationCannotFundAPayment`, `PayWithAuthorization.t.sol::test_RevertWhen_TokenWouldSpendDonations`, `PayWithAuthorization.t.sol::test_RevertWhen_PayLinkBalanceDecreasesOnReceive`, `PayNative.t.sol::test_PayNative_DonatedBalanceIsUntouched`; in the growth direction, `PayWithAuthorization.t.sol::test_RevertWhen_PayLinkReceivesMoreThanAuthorized` (`ReceivedMismatch(amount, amount + 1)` from the receive check), `PayWithAuthorization.t.sol::test_RevertWhen_PayLinkBalanceWouldGrow` and `PayWithAuthorization.t.sol::test_RevertWhen_PayLinkBalanceWouldGrowFromZero` (`ReceivedMismatch(before, before + 1)` from the post-check).

### I2. Payment cap

> If `inv.maxPayments > 0`, then `st(key).payments ≤ inv.maxPayments`.

- **Why:** a one-off invoice must be payable once, and N seats N times. A third party paying first uses the invoice up, which is bearer semantics ([spec §14.3](../spec/paylink-invoice-v2.md#143-bearer-semantics)).
- **Invariant:** `invariant_I2_paymentsNeverExceedMax`.
- **Fuzz:** `Window.t.sol::testFuzz_CapIsEnforced`.
- **Unit:** `Pay.t.sol::test_RevertWhen_SoldOut`, `PayWithAuthorization.t.sol::test_RevertWhen_SoldOut`, `PayWithPermit.t.sol::test_RevertWhen_SoldOut`, `PayNative.t.sol::test_RevertWhen_SoldOut`.

### I3. Accounting matches events

> `st(k).total = Σ amount over Paid(k)` and `st(k).payments = |Paid(k)|`. The `index` of each `Paid` is its zero-based ordinal.

- **Why:** the ledger, the receipts and the indexer all rebuild state from `Paid` events. On-chain state and events must never disagree ([ADR 0009](../adr/0009-read-model-chain-device-indexer.md)).
- **Threats:** [T-37](THREAT_MODEL.md#t-37) (repudiation).
- **Invariant:** `invariant_I3_totalsMatchPaidEvents`.
- **Fuzz:** `Amount.t.sol::testFuzz_TotalIsTheSumOfPayments`, `Amount.t.sol::testFuzz_TotalNeverWraps`, and `Amount.t.sol::test_PaymentsCounterNeverWraps` (on every path, an unlimited link at 2^32 − 2 payments takes exactly one more and then reverts instead of wrapping `payments` to 0, which would repeat `Paid.index`; `forge coverage` does not count overflow checks as branches, so only such a test notices an `unchecked` block).
- **Unit:** `PayWithAuthorization.t.sol::test_PayWithAuthorization_SequentialIndexesAndTotal`.

### I4. Cancellation is final

> Once `InvoiceCancelled(k)` is emitted, no later `Paid(k)` exists, and `st(k).cancelled` agrees with the events.

- **Why:** cancellation is the payee's only revocation tool for a leaked or mistaken invoice.
- **Threats:** [T-11](THREAT_MODEL.md#t-11).
- **Invariant:** `invariant_I4_noPaymentAfterCancel`.
- **Unit:** `Cancel.t.sol::test_Cancel_BlocksEveryPaymentPath`, `Cancel.t.sol::test_RevertWhen_CancelledTwice`, `Cancel.t.sol::test_RevertWhen_CancelBySigAfterCancel`.

### I5. Payment window

> Every `Paid(k)` happens at a block time `t` with `inv.validAfter ≤ t`, and `t ≤ inv.validUntil` when `inv.validUntil ≠ 0`. Both bounds are inclusive.

- **Threats:** [T-34](THREAT_MODEL.md#t-34) (timestamp drift at the edges), [T-11](THREAT_MODEL.md#t-11).
- **Invariant:** `invariant_I5_paymentsInsideWindow`.
- **Fuzz:** `Window.t.sol::testFuzz_WindowMatchesModel`, `Window.t.sol::testFuzz_WindowEdgesAreInclusive`.
- **Unit:** `PayWithAuthorization.t.sol::test_PayWithAuthorization_WindowBoundariesAreInclusive`, `PayWithAuthorization.t.sol::test_PayWithAuthorization_ZeroValidUntilNeverExpires`.

### I6. Exactness

> For each `Paid(k, payee, payer, token, amount)` on a standard token, the payee's balance rises by exactly `amount` and the payer's falls by exactly `amount`. A fixed invoice (`inv.amount ≠ 0`) settles exactly `inv.amount`. A token that delivers less than `amount`, or credits the payee more, never settles.

- **Why:** the payee's right to the exact invoiced amount is asset A2 of the threat model.
- **Threats:** [T-08](THREAT_MODEL.md#t-08) (fee-on-transfer, rebasing), [T-30](THREAT_MODEL.md#t-30) (decimals).
- **Invariant:** `invariant_I6_exactDeltas`, with both fee tokens: `fee` fails the receive leg, `fwdFee` the forward leg (EIP-3009) or the payee credit (allowance paths). A token that charges the sender on top may settle through the allowance paths, where the payee still receives exactly `amount` and only the payer pays the token's fee; the handler checks that per call. `OverCreditToken` credits the payee more than `amount` on the pull or the forward leg, which must fail the same checks.
- **Symbolic (Halmos):** the four conservation checks of I1 also prove the payee side: a payment that succeeds credits the payee exactly `amount`, whatever each leg moves.
- **Fuzz:** `Amount.t.sol::testFuzz_FixedAmountSettlesOnlyExactly`, `Amount.t.sol::testFuzz_OpenAmountAcceptsAnyPositive`.
- **Unit:**
  - `Pay.t.sol::test_RevertWhen_FeeOnTransfer`, `Pay.t.sol::test_RevertWhen_TokenCreditsNothing`;
  - `PayWithAuthorization.t.sol::test_RevertWhen_TokenTakesFeeOnReceive`, `PayWithAuthorization.t.sol::test_RevertWhen_TokenTakesFeeOnForward`, `PayWithAuthorization.t.sol::test_RevertWhen_TokenDeliversNothing`;
  - a balance that *falls* is reported as a zero credit, not as an arithmetic panic: `Pay.t.sol::test_RevertWhen_PayeeBalanceDecreases`, `PayWithPermit.t.sol::test_RevertWhen_PayeeBalanceDecreases`, `PayWithAuthorization.t.sol::test_RevertWhen_PayeeBalanceDecreasesOnForward`;
  - `PayWithPermit.t.sol::test_RevertWhen_RebasingRoundsDown`;
  - a payee credited one unit *more* is refused with the same documented error, `PayeeShortPaid(amount, amount + 1)`: `Pay.t.sol::test_RevertWhen_PayeeOverCredited`, `PayWithPermit.t.sol::test_RevertWhen_PayeeOverCredited`, `PayWithAuthorization.t.sol::test_RevertWhen_PayeeOverCreditedOnForward`, and `A05_OverCreditExactness.t.sol`.

### I7. Domain separation

> A payee or cancel signature produced for `(chainId, verifyingContract) = A` never verifies under any `B ≠ A`. State is per deployment: the alternate deployment never records a payment or cancellation for an invoice signed for the first.

- **Why:** the key commits to the chain and the deployment ([spec §5.2](../spec/paylink-invoice-v2.md#52-properties)). This is what makes a redeploy an effective incident response ([ADR 0004](../adr/0004-immutable-ownerless-feeless.md)).
- **Threats:** [T-07](THREAT_MODEL.md#t-07).
- **Invariant:** `invariant_I7_domainSeparation`, with the `crossDomainReplay` handler action.
- **Fuzz:** `Domain.t.sol::testFuzz_I7_InvoiceSignatureBoundToChainId`, `Domain.t.sol::testFuzz_I7_InvoiceSignatureBoundToDeployment`, `Domain.t.sol::testFuzz_I7_CancelSignatureBoundToDomain`, `Domain.t.sol::testFuzz_I7_StateIsPerDomain`, `Domain.t.sol::testFuzz_I7_KeyMatchesReferenceAnywhere`.
- **Unit:** `Views.t.sol::test_Eip712DomainFollowsChainId`, `Cancel.t.sol::test_RevertWhen_CancelSigFromOtherDeployment`.

### I8. Authorisation binding

> An EIP-3009 authorisation signed for the tuple `(key, payer, amount, payerRef, payerSalt)` never settles any other tuple. A submitter that changes the invoice, the amount or the reference gets a token-side signature failure.

- **Why:** the relayer is trusted for availability only. It can delay a payment, but never redirect it ([ADR 0003](../adr/0003-bind-3009-nonce-to-payment.md)).
- **Threats:** [T-01](THREAT_MODEL.md#t-01).
- **Invariant:** `invariant_I8_authorizationBinding`, with the `relayerRedirect` handler action.
- **Fuzz:** `Binding.t.sol::testFuzz_I8_MutatedTupleNeverSettles`, `Binding.t.sol::testFuzz_I8_NonceIsInjective`.
- **Unit:** `PayWithAuthorization.t.sol::test_RelayerCannotRedirectAuthorization`, `Views.t.sol::test_PaymentNonceMatchesSpecFormula`.

### I9. Only the payee cancels

> `InvoiceCancelled(k, payee)` is emitted only by a call from `inv.payee` (`msg.sender`), or with a valid payee signature over `Cancel(k, deadline)` before `deadline`. A transaction the payee originated (`tx.origin`) authorizes neither.

- **Threats:** a griefer cancelling someone else's invoice; signature reuse across types; a payee lured into calling a malicious contract that cancels its links (SWC-115).
- **Invariant:** `invariant_I9_onlyPayeeCancels`, with the transaction origin seeded independently of the caller.
- **Fuzz:** `Window.t.sol::testFuzz_CancelDeadline`.
- **Unit:** `Cancel.t.sol::test_RevertWhen_CancelByStranger`, `Cancel.t.sol::test_RevertWhen_CancelByPayer`, `Cancel.t.sol::test_RevertWhen_CancelSigByStranger`, `Cancel.t.sol::test_RevertWhen_InvoiceSignatureReusedAsCancel`, `Cancel.t.sol::test_RevertWhen_CancelSigExpired`, `Cancel.t.sol::test_CancelBySig_RelayedForPayee`; against `tx.origin`: `Cancel.t.sol::test_RevertWhen_CancelByStrangerWithPayeeAsTxOrigin`, `Cancel.t.sol::test_RevertWhen_LuredPayeeWouldCancel` (`TxOriginLure` mock), `Cancel.t.sol::test_RevertWhen_CancelThroughPayeeOwnedAccount`, `Cancel.t.sol::test_RevertWhen_CancelBySigWithPayeeAsTxOriginButForeignSignature`.
- **Symbolic (Halmos):** `check_cancel_stateMachine` (success if and only if the payee calls and the link is live; the payee as mere origin authorizes nothing).

### I10. Path separation

> A native invoice (`token = address(0)`) is payable only through `payNative`, and an ERC-20 invoice never through it. `receive()` and `fallback()` always revert with `WrongPaymentPath`.

- **Why:** this stops value from being stranded or credited against the wrong asset.
- **Invariant:** `invariant_I10_pathSeparation`, with the `wrongPath` handler action.
- **Unit:**
  - `Surface.t.sol::test_RevertWhen_PlainNativeTransfer`, `Surface.t.sol::test_RevertWhen_NativeTransferViaTransfer`, `Surface.t.sol::test_RevertWhen_UnknownSelectorWithValue`, `Surface.t.sol::test_PayableEntryPointIsOnlyPayNative`;
  - `PayNative.t.sol::test_RevertWhen_InvoiceIsErc20`, `Pay.t.sol::test_RevertWhen_InvoiceIsNative`.

### I11. Monotonic state

> For every key, `payments`, `total` and `lastPaidAt` never decrease, and `cancelled` never goes from `true` back to `false`. A reverted call writes nothing.

- **Invariant:** `invariant_I11_monotonicState`.
- **Unit:** `Cancel.t.sol::test_Cancel_KeepsPaymentHistory`, `Storage.t.sol::test_RevertedPaymentWritesNothing`.

## 3. Structural properties

These are not stateful invariants, but the security argument relies on them. Each one has a dedicated test.

| Property | Test |
|---|---|
| One packed storage slot per key, written lazily; a payment or a cancellation writes exactly one slot | `Storage.t.sol::test_StateLivesInOnePackedSlot`, `Storage.t.sol::test_PaymentWritesOneSlot`, `Storage.t.sol::test_CancelWritesOneSlot` |
| No admin surface: no owner, pause, upgrade or sweep | `Surface.t.sol::test_NoAdminSurface` |
| The init code is chain-independent: the constructor takes no arguments | `Surface.t.sol::test_ConstructorTakesNoArgumentsSoInitCodeIsChainIndependent` |
| The `paris` target holds: no PUSH0, MCOPY, TLOAD, TSTORE or later opcodes | `Surface.t.sol::test_RuntimeHasNoPostParisOpcodes`, `Surface.t.sol::test_InitCodeHasNoPostParisOpcodes`; `protocol/test/toolchain/EvmTarget.t.sol` |
| Reentrancy is refused on every path; a view read during an interaction sees the post-payment state on all four settlement paths (checks-effects-interactions; mutants M46–M49 in `protocol/audit/mutation/mutants.py`) | `Reentrancy.t.sol::test_RevertWhen_TokenHookReentersDuringPay`, `Reentrancy.t.sol::test_RevertWhen_TokenHookReentersDuringPayWithAuthorization`, `Reentrancy.t.sol::test_SwallowedReentryDoesNotDoubleSpend`; read-only re-entry: `Reentrancy.t.sol::test_ReadOnlyReentrySeesPostEffectsState` (`pay`), `Reentrancy.t.sol::test_ReadOnlyReentrySeesPostEffectsState_PayWithAuthorization`, `PayWithPermit.t.sol::test_PayWithPermit_PermitRunsAfterEffects`, `PayNative.t.sol::test_PayNative_ReadOnlyReentrySeesPostEffectsState` (the payee's `receive`) |
| The published format matches the contract: type hashes, selectors, error selectors and every worked example of the specification | `SpecExamples.t.sol::test_Section17_3_ExampleInvoice`, `SpecExamples.t.sol::test_Section7_6_ErrorSelectors` and the rest of `SpecExamples.t.sol` |
| Error precedence: when several checks fail at once, the first in the documented order is reported (IPayLinkV2 NatSpec, [spec §7.2](../spec/paylink-invoice-v2.md#72-payability-predicate), §9.2), on every path | `Precedence.t.sol::test_Precedence_AllPairs_PayWithAuthorization` and its three siblings (every pair of checks), `Precedence.t.sol::test_Precedence_CancelledBeforeInvalidSignature`, `Precedence.t.sol::test_Precedence_Cancel`, `Precedence.t.sol::test_Precedence_CancelBySig`; `Precedence.t.sol::testFuzz_FirstFailingCheckIsReported` (any subset) |

## 4. Beyond the blocking gates

PAYLINK-V2-SPEC §4.1 adds non-blocking evidence from three more tools. The harnesses exist and their first runs are recorded in `protocol/audit/properties.md`; the nightly workflow that would repeat them for an hour each is not built yet (*planned (T1)*: `fuzz-nightly.yml`).

- **Halmos 0.3.3**, `protocol/test/symbolic/PayLinkSymbolic.t.sol`, covers **only** conservation (I1, with the payee side of I6) and the state machine (`payments`, `total`, `cancelled`, `lastPaidAt`): bounded proofs over symbolic amounts, stored states, invoice terms, times and token behaviours. It is never presented as a proof about signatures: the payee is an ERC-1271 stub that accepts every hash and the token checks no EIP-3009 signature, because symbolic execution of ECDSA is out of its reach.
- **Echidna 2.2.7 and Medusa 1.3.1** run against the same property contract, `protocol/test/properties/PayLinkProperties.sol`: one `echidna_*` property per invariant I1–I11. It uses no cheatcode, so both fuzzers run it unchanged: actor contracts are the payers and ERC-1271 payees, EIP-3009 authorizations are the payer's on-chain approval of the exact tuple, and one token's legs can be skewed in both directions. `PayLinkProperties.t.sol` keeps the harness live on every `forge test` (every path settles; every refusal the properties rely on happens).

## 5. Changing an invariant

An invariant changes only with an ADR, because it changes what the contract promises. The same pull request updates:

- PAYLINK-V2-SPEC §3.3.4, or the ADR that supersedes it;
- this catalogue;
- the [threat model](THREAT_MODEL.md) rows that cite it;
- the [specification](../spec/paylink-invoice-v2.md), if the rule is normative there.

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-07 | Catalogue of I1–I11 with properties, rationale, threats and named tests; structural properties; nightly scope |
| 1.1 | 2026-10-07 | Pre-freeze audit: the campaign gains the forward-fee token and `reconfigureFee`, so the conservation post-check and the forward-leg payee check are exercised by the campaign itself; I3 adds the `payments` counter bound; I6 adds decreasing balances; error precedence becomes a structural property with deterministic and fuzz tests |
| 1.2 | 2026-10-07 | Test-quality review: I1 and I6 are tested as equalities (`OverCreditToken`, unit tests one unit over, `reconfigureOverCredit`); I9 is tested against `tx.origin` (unit tests, a lure contract, seeded origins in the campaign); the Halmos checks and the Echidna/Medusa property contract exist and their first runs are recorded, replacing the *planned* note of §4 |
