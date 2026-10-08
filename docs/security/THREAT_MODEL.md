# PayLink v2 threat model

| | |
|---|---|
| **Version** | 1.3 (baseline for v2.0) |
| **Date** | 2026-10-07 |
| **Owner** | nambininasafidison. Drafted with Claude Code; see [AI_DISCLOSURE.md](../../AI_DISCLOSURE.md). |
| **Method** | STRIDE per component over the data-flow model in [ARCHITECTURE.md](../ARCHITECTURE.md), with qualitative residual ratings |
| **Status** | Living document. Re-reviewed at every trigger in [§10](#10-review-triggers) |
| **Audit status** | **Not audited by a third party.** See [self-review.md](self-review.md), which is a self-review and not an audit. |

Related: [invoice specification §14–§15](../spec/paylink-invoice-v2.md#14-security-considerations), [incident response](incident-response.md), [SECURITY.md](../../SECURITY.md), and the [invariant catalogue](invariants.md) (I1–I11 from PAYLINK-V2-SPEC §3.3.4, with the tests that enforce each one).

## Contents

1. [Scope and method](#1-scope-and-method)
2. [Assets](#2-assets)
3. [Actors](#3-actors)
4. [Trust boundaries and assumptions](#4-trust-boundaries-and-assumptions)
5. [STRIDE coverage matrix](#5-stride-coverage-matrix)
6. [Threat register](#6-threat-register)
7. [Abuser stories and their tests](#7-abuser-stories-and-their-tests)
8. [Residual risks](#8-residual-risks)
9. [Out of scope](#9-out-of-scope)
10. [Review triggers](#10-review-triggers)

---

## 1. Scope and method

**In scope**, with eleven components:

1. the `PayLinkV2` contract;
2. signatures and the URL codec;
3. the web client (PWA);
4. the passkey account (Mera);
5. the relayer;
6. the indexer;
7. configuration and hosting;
8. the deploy pipeline;
9. the supply chain;
10. CI secrets;
11. AI agents.

**Out of scope:** PayLink v1 on Arc, which is covered only where it shares hosting ([ADR 0010](../adr/0010-arc-stays-on-v1.md)), and the items in [§9](#9-out-of-scope).

**Method.** Each component is analysed against the six STRIDE categories: **S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure, **D**enial of service and **E**levation of privilege. Each threat records its mitigations, the evidence that the mitigation works (a test, a CI gate or a review step), and a **residual** rating after mitigation:

| Rating | Meaning |
|---|---|
| **Low** | An exploit is implausible, or its impact is negligible or bounded to the attacker's own assets |
| **Medium** | An exploit is plausible but bounded: testnet funds, availability, or a single user who ignores a warning |
| **High** | A plausible exploit with material impact on users who follow the UI. None is accepted for v2.0 |

Threats T-01 to T-22 keep the numbering of PAYLINK-V2-SPEC §5, so that the two documents stay traceable. T-23 onwards were added during this review.

## 2. Assets

| ID | Asset | Property needed | Where it lives |
|---|---|---|---|
| A1 | Payer funds in transit (token balances, allowances, EIP-3009 authorisations) | Integrity | Payer account; PayLinkV2 only within one call |
| A2 | The payee's right to be paid exactly the invoiced amount | Integrity | Invoice fields and payee signature |
| A3 | Payee signing key: a Mera passkey-derived secp256k1 key, or a wallet key | Confidentiality, integrity | Platform passkey store and page memory (Mera); the wallet |
| A4 | Invoice integrity: payee, token, amount, window, salt, memo | Integrity | URL fragment, device store |
| A5 | Invoice state: payments, total, cancelled | Integrity | PayLinkV2 storage, one slot per key |
| A6 | Device books: invoices, memos, contacts, receipts | Confidentiality, availability | The device's IndexedDB |
| A7 | Relayer hot key and gas budget (testnet only, at most about 2 MON) | Confidentiality, availability | Cloudflare Worker secret `RELAYER_PK` |
| A8 | Deployer key (testnets) | Confidentiality | Wallet; GitHub environment secret `TESTNET_DEPLOYER_PK` (route A) |
| A9 | Web origin integrity: code, `_headers`, `/config.json`, registry | Integrity | Cloudflare Pages project, built by Actions |
| A10 | CI and cloud credentials: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ENVIO_API_TOKEN` | Confidentiality | GitHub secrets |
| A11 | Release artefacts: bytecode, `initCodeHash`, deployment records | Integrity | Repository, tags, `protocol/deployments/` |
| A12 | User privacy: memos, contacts, payment history linkage | Confidentiality | Device; public chain data |
| A13 | Service availability: PWA, relayer, indexer, RPCs | Availability | Cloudflare, Envio Cloud, public RPCs |
| A14 | Project reputation and the honesty of submissions | Integrity | README, `docs/submissions/`, videos |

## 3. Actors

| Actor | Capabilities | Typical motivation |
|---|---|---|
| Anonymous internet attacker | Sends links and messages; calls public contracts; calls relayer endpoints | Theft, griefing |
| Phisher or impersonator | Crafts look-alike invoices and addresses; clones the site on another domain; swaps printed QR codes | Theft by misdirection |
| Malicious or compromised relayer | Sees, delays, reorders or drops authorisations; submits arbitrary transactions | Redirect funds, censor |
| MEV searcher or front-runner | Observes the mempool; front-runs permits and authorisations | Griefing, extraction |
| Malicious token or token issuer | Fee-on-transfer, rebasing, reentrant hooks; blocklists and pauses | Break exactness, freeze |
| Malicious ERC-1271 payee | Arbitrary `isValidSignature` behaviour; gas burning; revert data bombs | Grief relayers and payers |
| Malicious RPC or indexer provider | Returns false data; withholds data | Mislead the UI |
| Compromised dependency maintainer | Publishes a malicious package version | Code execution in the build or on the origin |
| Malicious contributor | Opens pull requests touching CI or code | Secret theft, backdoor |
| Prompt injector | Plants instructions in memos, issues, pull requests or validator output read by AI agents | Make an agent act against the owner |
| Device thief or malware | Physical or OS-level access to a user's device | Key theft, data theft |
| Sybil payer | Many cheap addresses | Inflate trust signals |

## 4. Trust boundaries and assumptions

The trust boundaries TB1 to TB9 are defined in [ARCHITECTURE §5](../ARCHITECTURE.md#5-trust-boundaries). The analysis assumes:

- **AS1.** The target chains follow their consensus rules, and transactions are final after the chain's finality period. Reorganisations deeper than the finality period are out of scope.
- **AS2.** Allowlisted tokens (Circle USDC, AUSD, MUSD) implement ERC-20, and EIP-2612 or EIP-3009 where the registry says so. The `fork-nightly.yml` job checks their domains, type hashes and decimals.
- **AS3.** OpenZeppelin Contracts 5.3.0 modules behave as documented. The single advisory, GHSA-9rcw-c2f9-2j55, is unreachable ([ADR 0002](../adr/0002-one-paris-bytecode-oz-5-3-0.md)).
- **AS4.** The browser enforces the same-origin policy, CSP and WebAuthn rpId binding. The platform authenticator protects passkeys.
- **AS5.** The owner's GitHub and Cloudflare accounts are protected with strong, phishing-resistant multi-factor authentication. This is an operational requirement; see [incident response](incident-response.md).
- **AS6.** Testnet only: v2 deployments hold no real value. Arc v1 handles small amounts on mainnet.

## 5. STRIDE coverage matrix

| Component | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| 6.1 Contract | T-07 | T-08, T-26, T-30, T-34 | T-37 | T-24 | T-09, T-10, T-13, T-14, T-31 | T-26, T-27 |
| 6.2 Signatures and URL codec | T-04, T-07, T-43 | T-01, T-11, T-35 | — | — | T-12, T-23, T-35 | T-01 |
| 6.3 Web client | T-04, T-25, T-40, T-44 | T-06, T-28, T-29, T-45 | — | T-05, T-22 | — | T-05 |
| 6.4 Passkey account | T-40 | — | — | T-05 | T-19 | T-05 |
| 6.5 Relayer | T-46 | T-01, T-47 | — | T-38 | T-02, T-03, T-13, T-33, T-46, T-48 | T-47 |
| 6.6 Indexer | T-15, T-36 | T-15 | — | — | T-15 | — |
| 6.7 Configuration and hosting | T-16 | T-39 | — | — | T-16 | — |
| 6.8 Deploy pipeline | — | T-20, T-32 | — | — | — | — |
| 6.9 Supply chain | — | T-17, T-42 | — | — | — | T-17 |
| 6.10 CI secrets | — | T-41 | — | T-18 | — | T-18 |
| 6.11 AI agents | — | T-21 | — | T-21 | — | T-21 |

## 6. Threat register

The evidence column names the test or gate that demonstrates each mitigation. Contract tests live under `protocol/test/`, SDK tests under `packages/sdk/test/` (including the anvil suite `packages/sdk/test/integration/anvil.test.ts`, which runs the release build).

**Evidence status.** Evidence that does not exist yet is marked *planned (Tn)*, with the delivery tier of PAYLINK-V2-SPEC §10: the web client's e2e specs (`e2e/`), the web client (`apps/web`), the indexer and the CI workflows (`.github/workflows/`) have not been built. The relayer (`apps/relayer`) has, with its unit, anvil and workerd suites (2026-10-08). Everything not marked exists in the working tree; `docs/tools/check-docs.py` verifies cited Foundry tests, cited file paths and the markers. A residual rating that rests on planned evidence is provisional until that evidence lands.

### 6.1 Contract (`PayLinkV2`)

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-07"></a>T-07 | S | Cross-chain or cross-contract replay of a payee or cancel signature | EIP-712 domain includes `chainId` and `verifyingContract`; OpenZeppelin `EIP712` recomputes the separator after a fork | Invariant I7, fuzzed over `vm.chainId` and alternate deployments; `Views.t.sol::test_Eip712DomainFollowsChainId`; `Cancel.t.sol::test_RevertWhen_CancelSigFromOtherDeployment`; golden vectors | Low |
| <a id="t-08"></a>T-08 | T | A fee-on-transfer or rebasing token shortchanges the payee, or a non-standard token moves *more* than asked so that PayLink keeps a surplus or the payee is over-credited | Receive-delta and payee-delta checks and the post-call conservation check, all equalities; registry allowlist in the UI | `Pay.t.sol::test_RevertWhen_FeeOnTransfer`; `PayWithAuthorization.t.sol::test_RevertWhen_TokenTakesFeeOnForward`; `PayWithPermit.t.sol::test_RevertWhen_RebasingRoundsDown`; `Pay.t.sol::test_RevertWhen_PayeeOverCredited`; `PayWithAuthorization.t.sol::test_RevertWhen_PayLinkBalanceWouldGrow`; invariants I1 and I6 (`OverCreditToken` in the campaign) | Low |
| <a id="t-09"></a>T-09 | D | Donation griefing: a stray transfer breaks a `balance == 0` assumption | No zero-balance requirement; relative conservation; donations are inert | `Donations.t.sol::test_EveryPathWorksWithDonationsPresent`, `test_DonationCannotFundAPayment`; invariant I1 with a `Donor` handler | Low |
| <a id="t-10"></a>T-10 | D | A front-run EIP-2612 permit makes `payWithPermit` revert | `try permit {} catch {}`, then the allowance path; the permit runs after the effects | `PayWithPermit.t.sol::test_PayWithPermit_FrontRunPermitIsHarmless`, `test_PayWithPermit_PermitRunsAfterEffects` | Low |
| <a id="t-13"></a>T-13 | D | A malicious ERC-1271 payee burns gas, returns a data bomb or reverts. **For the relayer** it can also answer `isValidSignature` differently at simulation and at inclusion (block-dependent logic at no cost per grief, or one storage write that reverts every relay queued for it), and even an EOA payee can `cancel` a receive card under queued relays: the relay passes `eth_call`, reverts on inclusion, and on Monad the relayer pays the full gas limit; the authorisations stay unconsumed and replayable | On-chain the effect stays with that payee's own payments (gas is bounded by the caller's limit; return data is not copied). The relayer bounds what one payee action can revert: at most 1 relay in flight per invoice key and per payee, 4 per token. A post-simulation revert is attributed by its cause from chain evidence (`attributeRelayRevert`), and only the party it names is banned for a day: a cancelled invoice, an `InvalidSignature` or a changed payee code bans the payee and the key; a payer-side failure bans the payer only, never the payee; the same authorisation landing first elsewhere bans nobody (revised 2026-10-07, A-04: the rule "ban the key, the payee and the payer" let a sybil payer get an honest payee banned). Requesters, counted per IPv4 address or IPv6 /64, collect strikes for attributable reverts. Payees with code are relayed only from an allowlist of known wallet code hashes, others fall back to self-submission; the relayer re-simulates against the pending block right before broadcast, without relying on it ([spec §13.3](../spec/paylink-invoice-v2.md#133-relayers)) | `Signatures.t.sol::test_Erc1271ReturnBombOnlyCostsItsOwnPayers`, `test_RevertWhen_Erc1271BurnsAllGas`; `Wallet1271Gas` mock; `A02_RelayerGriefing.t.sol::test_SimulationDoesNotBind_FlakyPayeeRevertsOnInclusion`, `test_SimulationDoesNotBind_OneToggleRevertsEveryQueuedRelay`, `test_SimulationDoesNotBind_OneCancelRevertsEveryRelayQueuedForTheCard`, `test_SimulationDoesNotBind_FlakyPayeeCancelBySig` (the behaviour the relayer must assume); `packages/sdk/test/relay-admission.test.ts` (bounds, penalties per cause, code policy); `packages/sdk/test/relay-attribution.test.ts` (every cause from chain evidence); `packages/sdk/test/integration/anvil.test.ts` (one cancel reverts one admitted relay, the evidence names the payee, and the card and payee are banned; a payer's cancelled authorisation bans the payer only; a superseding resubmission bans nobody); `A04_TimeBoundaryBan.t.sol::test_SameAuthorizationLandedElsewhere_IsRecognisableFromTheSettlingLogs`, `test_PayerCancelledAuthorization_LeavesNoPaidBeforeTheNonceLog`; `apps/relayer/test/integration/relay.test.ts` (the relayer itself, on anvil: a payee who cancels under a queued relay is banned with the card and struck; a payment that lands first by the payer's own submission bans nobody; one relay in flight per card) | Medium: availability. The daily gas budget caps the loss. A payee whose answer can change without a transaction needs code, and code outside the allowlist is not relayed; any other grief by a payee costs it an on-chain action (a `cancel`, a delegation) and that payee identity for a day, and reverts at most one relay per payee at a time. A party that changes and restores state around the relay within one block leaves no evidence: that revert is unattributed, bans the key (and only parties with code) and strikes the requester |
| <a id="t-14"></a>T-14 | D (economic) | Monad charges the gas limit, so an over-estimate overcharges and an under-estimate fails | `clamp(estimate × 1.10, floor, ceiling)` per function and chain, from `forge snapshot`; validated with cold slots on testnet | The gas table in `@paylink/chains` (`packages/chains/data/gas-measurements.json`, from anvil receipts); `pnpm --filter @paylink/protocol run snapshot:check`; testnet validation with cold slots *planned (T0)* | Low |
| <a id="t-26"></a>T-26 | T, E | Reentrancy through token hooks, ERC-1271 checks or the payee's `receive` | `nonReentrant` on every state-changing entry point; checks-effects-interactions (state and `Paid` are written before any transfer); the only earlier external call is the ERC-1271 `staticcall` | `Reentrancy.t.sol::test_RevertWhen_TokenHookReentersDuringPay`, `test_RevertWhen_TokenHookReentersDuringPayWithAuthorization`; read-only re-entry sees the post-payment state on all four settlement paths: `Reentrancy.t.sol::test_ReadOnlyReentrySeesPostEffectsState` (`pay`), `test_ReadOnlyReentrySeesPostEffectsState_PayWithAuthorization`, `PayWithPermit.t.sol::test_PayWithPermit_PermitRunsAfterEffects`, `PayNative.t.sol::test_PayNative_ReadOnlyReentrySeesPostEffectsState` (the payee's own `receive`; added 2026-10-07 after a re-audit showed that deferring the state write past the interaction on `payNative` or `payWithAuthorization` survived the suite; mutants M46–M49 in `protocol/audit/mutation/mutants.py`); `PayNative.t.sol::test_RevertWhen_PayeeReentersPayNative` | Low |
| <a id="t-27"></a>T-27 | E | A contract bug lets an attacker spend a victim's standing allowance to PayLinkV2 | `pay` and `payWithPermit` only pull from `msg.sender`; clients request exact-amount allowances, never unlimited ([spec §13.2](../spec/paylink-invoice-v2.md#132-payer-clients)) | `Pay.t.sol::test_Pay_ExactAllowanceIsEnough`; Slither `arbitrary-send-erc20` clean; client review | Low |
| <a id="t-30"></a>T-30 | T | Decimal confusion (6 vs 18 decimals; Arc's dual-decimal USDC) makes someone pay 10^12 times too much or too little | Registry decimals per token; `fork-nightly.yml` checks `decimals()`; SDK amount math property-tested at 6 and 18 decimals; fixed invoices settle exactly `inv.amount` | fast-check property tests in `@paylink/sdk`; invariant I6 | Low |
| <a id="t-31"></a>T-31 | D | The token issuer blocklists the payer or payee, or pauses the token | A blocked transfer reverts the whole payment, so no funds are lost; the UI shows the decoded error | Token-error decoding tests | Low (accepted) |
| <a id="t-34"></a>T-34 | T | A block producer shifts the timestamp at a window edge | Inclusive bounds; second-level drift only matters at the edge; clients use chain time; relayers keep a margin on every bound they forward ([T-03](#t-03)) | `PayWithAuthorization.t.sol::test_PayWithAuthorization_WindowBoundariesAreInclusive`; invariant I5 | Low (accepted) |
| <a id="t-37"></a>T-37 | R | A payee denies being paid, or a payer claims to have paid | Every settlement emits `Paid` with key, payee, payer, amount, index and reference; receipts verify on RPC ([spec §12](../spec/paylink-invoice-v2.md#12-receipt-verification)) | Receipt-verifier tests; invariant I3 | Low |

### 6.2 Signatures and URL codec

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-01"></a>T-01 | T, E | A relayer redirects a payment to another link, amount or reference | The EIP-3009 nonce is recomputed on-chain from `(key, payer, amount, payerRef, payerSalt)`; `to` is PayLinkV2, and only it can call `receiveWithAuthorization` ([ADR 0003](../adr/0003-bind-3009-nonce-to-payment.md)) | Invariant I8; `PayWithAuthorization.t.sol::test_RelayerCannotRedirectAuthorization`; `Views.t.sol::test_PaymentNonceMatchesSpecFormula` | Low |
| <a id="t-04"></a>T-04 | S | A phishing invoice or look-alike payee address | The contract address comes from the registry only; unknown chains and tokens are rejected; strict decoding; first-payment warning; address-book labels; addresses shown in full, grouped by four; bidirectional and control characters stripped; memo labelled untrusted | SDK codec property tests (`packages/sdk/test/properties/fragment.property.test.ts`); e2e tampered-URL suite (fields, memo, trailing bytes, oversize) *planned (T0)* | Medium: depends on the user heeding the warning |
| <a id="t-11"></a>T-11 | T | A leaked or stale signed invoice is paid later than intended | Default `validUntil` of 7 days; receive cards need explicit confirmation; `cancel` and gasless `cancelBySig`; 32-byte CSPRNG salt | `Cancel.t.sol::test_Cancel_BlocksEveryPaymentPath`; e2e cancel and cancelBySig *planned (T0)* | Low |
| <a id="t-12"></a>T-12 | D | Counterfactual smart-account payee: the signature cannot be verified on-chain | Undeployed smart accounts are blocked as payees at creation; ERC-1271 is checked on every payment, never skipped | `Signatures.t.sol::test_RevertWhen_PayeeIsUndeployedSmartAccount`; `Wallet1271` tests | Low |
| <a id="t-23"></a>T-23 | D | **EIP-7702-delegated payee.** Once an EOA delegates, OpenZeppelin 5.3.0 `SignatureChecker` verifies it only through ERC-1271 (**C**, source read), so earlier ECDSA-signed invoices stop verifying unless the delegate accepts them | The issuer reads `eth_getCode(payee)` and warns on the `0xef0100` designator, and verifies through `isValidSignature` before sharing; payer clients use the contract's dispatch ([spec §6.4](../spec/paylink-invoice-v2.md#64-eip-7702-delegated-payees)) | `Signatures.t.sol::test_RevertWhen_EcdsaSignatureOfAnEoaForContractPayee`; SDK verifier tests | Low: affects only the delegating payee |
| <a id="t-35"></a>T-35 | T, D | Malformed or oversized links: decoder bombs, non-canonical encodings, trailing data | 1,200-character cap checked first; fixed lengths; canonical base64url; no compression; no network access during decoding | SDK fast-check round-trip and rejection tests; e2e tampered-URL suite *planned (T0)* | Low |
| <a id="t-43"></a>T-43 | S | **Forged or borrowed receipt.** A payer shows the merchant a receipt link for a different payment: another invoice, another payee, a smaller amount, a reverted transaction, or a look-alike contract | Receipts verify on RPC only, against the registry deployment: `status = 1`, log address, `Paid` topic, decoded payee, token and amount, and the invoice key when the invoice is attached ([spec §12](../spec/paylink-invoice-v2.md#12-receipt-verification)); receipts are keyed by `(chainId, txHash, logIndex)`, never by `payerRef`; the verifier shows payee, amount and invoice, never a bare "valid" | SDK receipt-verifier tests (wrong contract, topic, status, payee, amount, key) | Low |

### 6.3 Web client (PWA)

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-05"></a>T-05 | I, E | XSS steals the passkey-derived key (Mera keys live in page memory) | Dedicated origin ([ADR 0005](../adr/0005-dedicated-origin-and-rpid.md)); strict CSP; Trusted Types at T1; no `innerHTML`-family sinks (ESLint bans); no third-party scripts or CDNs; no URL-configurable endpoints; preview deployments disabled | ESLint sink-ban gate (`packages/eslint-config/test/dom-sinks.test.js`: dot, computed, object-literal, `Reflect`/`defineProperty`, `setAttribute` and HTML-parsing-method forms); production-CSP e2e spec with Trusted Types *planned (T0)* | Medium: an XSS would be critical, but several independent layers stand in the way. Provisional until the CSP spec lands |
| <a id="t-06"></a>T-06 | T | Clickjacking the Pay key | `frame-ancestors 'none'`; the JavaScript frame lock keeps Pay disabled when `top !== self` | e2e framed-page spec *planned (T0)* | Low (provisional) |
| <a id="t-22"></a>T-22 | I | Privacy leakage | No personal data on-chain; the memo lives only in the fragment; no server database; no analytics; `Referrer-Policy: no-referrer` | Header test *planned (T0)*; review | Low |
| <a id="t-25"></a>T-25 | S | A printed receive card's QR code is overlaid with an attacker's | The payer's client shows the full address and any saved label, and the first-payment warning; printed cards also show the address grouped by four and the payee name | e2e first-payee warning *planned (T1)* | Medium: physical fraud, partly a user-education problem |
| <a id="t-28"></a>T-28 | T | A stale or poisoned service-worker cache serves old code | The service worker precaches only same-origin build output; RPC, relayer and indexer are network-only; update prompt; the Trusted Types policy allows only the fixed `/sw.js` URL | PWA e2e *planned (T0)*; production-CSP spec *planned (T0)* | Low (provisional) |
| <a id="t-29"></a>T-29 | T | Clipboard or DOM tampering swaps the address the user copies | Copies come from canonical state, never from the DOM; the SigningDisplay shows what is signed before the passkey or wallet prompt | Unit tests for the copy helpers *planned (T0)* | Low |
| <a id="t-44"></a>T-44 | S | **Till false positive.** A customer pays a tiny amount to the merchant's open receive card, or to another of the merchant's invoices, so that the till lights green while the customer claims to have paid the full invoice | When an invoice is armed on the till, the green LED and chime fire only for a verified `Paid` with that invoice's key and amount; for receive cards the till shows the received amount in large digits next to the LED; every event is receipt-verified before the LED changes ([spec §13.4](../spec/paylink-invoice-v2.md#134-payment-arrival-displays)) | SDK `isPaymentForArmedInvoice` and receipt-verifier tests (`packages/sdk/test/receipt.test.ts`); e2e till specs (lights for the armed key; stays dark for another key or a smaller open-amount payment) *planned (T1)* | Medium: for receive cards, the merchant must read the amount |
| <a id="t-45"></a>T-45 | T | **Retry double charge.** A payer whose relayed payment is slow retries by signing again with a fresh `payerSalt`, or by falling back to permit or approve-and-pay, while the first authorisation is still valid (up to `validBefore`). PayLinkV2 does not deduplicate across authorisations, so on any link with `maxPayments != 1` (receive card, open-amount till, N seats) both settle and the payer is charged twice, with no on-chain refund; the relayer only has to delay rather than refuse | [Spec §8.6](../spec/paylink-invoice-v2.md#86-retries-and-outstanding-authorisations): the signed body is persisted on the device before it is sent; a retry resubmits it; a new signature or another path only once the authorisation is cancelled on the token (`cancelAuthorization` mined) or expired unused; a consumed authorisation is treated as paid. The SDK enforces it: `authorizePayment` requires the outstanding assessment and refuses while one is live, and the router offers only resubmission and withholds permit and approve-and-pay | `A01_RetryDoublePay.t.sol::test_NoDedupe_FreshSaltRetryChargesReceiveCardTwice` and its siblings (what the contract does not prevent); `test_Fix_ResubmitSameAuthorizationIsIdempotent`, `test_Fix_CancelAuthorizationBeforeFallback`, `test_Fix_ExpiredAuthorizationNeverLands`; `packages/sdk/test/attempts.test.ts`; `packages/sdk/test/integration/anvil.test.ts` (relayer slow, then lands; cancel, then permit); `apps/relayer/test/integration/relay.test.ts` (a resubmitted body is answered with the transaction already sent, never relayed twice); e2e "relayer slow, then lands" in the web client *planned (T0)* | Low: one-off invoices are immune (`SoldOut`); for the others it rests on clients following §8.6 |
| <a id="t-40"></a>T-40 | S | A clone of the PWA on a look-alike domain, with a modified registry | Passkeys are bound to the rpId, so a clone cannot use them (phishing-resistant); wallets show the requesting origin; receipts verify against the canonical deployment; the canonical origin is published in the README and the submissions | Review | Medium for injected-wallet users; Low for passkey users |

### 6.4 Passkey account (Mera)

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| T-05 | I, E | See [§6.3](#63-web-client-pwa). The passkey-derived key in memory is the critical asset | Same as above; `@category-labs/mera` lazy-loaded only in the Monad edition | — | Medium |
| <a id="t-19"></a>T-19 | D | Passkey loss: a Mera-derived EOA has no recovery | Testnet only; capped balances; clearly documented. T2: an encrypted backup of the books (books, not keys) with a separate PRF salt `"paylink.books.v1"` and HKDF-SHA-256 to AES-256-GCM; key export only behind strong warnings | Documentation; PRF virtual-authenticator e2e *planned (T0)* | Medium (accepted for testnet) |
| T-40 | S | Phishing for passkeys | WebAuthn binds the credential to the rpId, so cross-origin assertions are impossible | — | Low |

### 6.5 Relayer

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| T-01 | T, E | Redirection | See [§6.2](#62-signatures-and-url-codec); the relayer also recomputes the nonce locally and simulates before sending | `packages/sdk/test/relayer.test.ts` (the shared relayer checks); `apps/relayer/test/integration/relay.test.ts` (a tampered amount, reference or invoice is refused before any gas is spent; every relayer transaction has value 0 and targets PayLinkV2, the faucet or the relayer itself); `apps/relayer/test/unit/core.test.ts` (the signing choke point `assertSendable`) | Low |
| <a id="t-02"></a>T-02 | D | The relayer censors or delays a payment | The payer self-submits **the same** authorisation; `validBefore` (600 s by default) bounds the delay. Permit or approve-and-pay are offered only after that authorisation is cancelled on the token or has expired, because a second, independent payment would settle alongside a late relay ([T-45](#t-45), [spec §8.6](../spec/paylink-invoice-v2.md#86-retries-and-outstanding-authorisations)) | `PayWithAuthorization.t.sol::test_PayWithAuthorization_PayerCanSelfSubmit`; `A01_RetryDoublePay.t.sol::test_Fix_ResubmitSameAuthorizationIsIdempotent`; `packages/sdk/test/integration/anvil.test.ts` (relayer slow, then lands); `apps/relayer/test/integration/relay.test.ts` (a resubmission while the relay is pending is answered with the pending transaction and sends nothing; after it settled, with the settled one; the payer's own submission landing first is charged once); every refusal carries `fallback: self-submit` (`apps/relayer/README.md`, problem codes); e2e "relayer down" and "relayer slow, then lands" in the web client *planned (T0)* | Low |
| <a id="t-03"></a>T-03 | D | Gas drain: spam of valid-looking requests, and requests that pass simulation but revert on inclusion (payee code, payee `cancel`, payer EIP-7702 delegation; [T-13](#t-13), [T-46](#t-46)), which cost the full gas limit on Monad and can be replayed with sybil payers holding one base unit each. **Time bounds** need no transaction at all: a payer-chosen `validBefore = now + 1`, a relay requested in an invoice's last second, or a throwaway cancellation with `deadline = now` passes `eth_call` and reverts one block later (A-04: 224k gas per pay relay, 89k per cancel on Monad, about 0.022 and 0.009 MON at the 100-gwei minimum base fee). Without a bound, the daily budget turns this into an outage, and on Monad the relayer is the only path for 0-MON passkey payers | Only valid, simulated payments are sent; minimum amount; per-IP, per-payer and daily caps; daily gas budget; serialisation in the Durable Object; testnet key with at most about 2 MON. Against time bounds (revised 2026-10-07, A-04): every bound a relayed call carries must still hold `relay.minRemainingSeconds` (120 s, per chain in the registry) after the simulated block, checked by `checkRelayPayRequest` and `checkRelayCancelRequest`, again at admission and again before broadcast; an admitted relay can then only expire through the relayer's own latency, which is reported and bans nobody. Against post-simulation reverts: `RelayAdmissionLedger` (1 relay in flight per key, per payee and per payer, 4 per token; day-long bans of the party a revert is attributed to, never of a payee for a payer's failure; requester strikes per IPv4 address or IPv6 /64; at most 20 relays an hour per requester, successful ones included; code policy) | `A04_TimeBoundaryBan.t.sol::test_SimulationDoesNotBind_PayerChosenValidBefore`, `test_SimulationDoesNotBind_InvoiceLastSecond`, `test_SimulationDoesNotBind_CancelDeadlineNow` (the behaviour the relayer must assume), `test_Margin_PaymentAdmittedAtTheEdgeSettlesAfterMarginLatency` and its invoice and cancel siblings (the margin is exact at the second); `packages/sdk/test/audit/A04-time-boundary-ban.test.ts`; `packages/sdk/test/relayer.test.ts` (margin boundaries); `packages/sdk/test/relay-admission.test.ts`; `packages/sdk/test/requester.test.ts`; `packages/sdk/test/integration/anvil.test.ts` (a 1-second authorisation refused; a relay mined past its margin bans nobody); `A02_RelayerGriefing.t.sol`; `apps/relayer/test/integration/relay.test.ts` (a cancellation inside the margin and amounts below one cent refused; the daily gas budget, the per-requester rate, the gas ceiling and a missing key stop sending; a stuck relay past its bounds is voided with a zero-value self-transfer instead of a paid revert; a revert attributed to the payee bans the card and the payee only); `apps/relayer/test/integration/faults.test.ts` (per-payer daily cap, fee cap, unfunded or delegated relayer account, broadcast refusals) | Medium: availability, bounded per attacker action and by the daily budget. Griefs that remain cost the attacker an on-chain action of comparable gas (a `cancel`, a delegation, a self-submission, a competing payment): none is free, and none can shut out a party the attacker does not control |
| <a id="t-33"></a>T-33 | D | Abuse of the onboarding faucet endpoint | Testnet only: the registry's AUSD faucet on Monad testnet, `requestFunds(address)` only; at most 100 drips a day on the chain, 1 per address and 3 per requester (IPv4 address or IPv6 /64); the faucet's own global 60 s cooldown; the same gas budget and signing choke point as relays. No inventory fallback: the relayer never transfers tokens of its own (revised 2026-10-08) | `apps/relayer/test/integration/relay.test.ts` (onboarding within the registry's gas bounds, the faucet's cooldown, the per-address cap, no self-funding); `apps/relayer/test/integration/faults.test.ts` (no onboarding where the registry lists no faucet, mis-checksummed addresses refused) | Low |
| <a id="t-38"></a>T-38 | I | Relayer logs link IP addresses with payer addresses | Logs never carry an IP address, a request body or a signature: requesters appear only as `requesterTag`, a truncated SHA-256 under a random per-isolate salt that is never stored; the logger scrubs the relayer key from every line and drops fields named like key material. The Durable Object stores requester identities (IPv4 address or IPv6 /64) only in the admission ledger's counters, strikes and bans and the day's onboarding counters, all pruned within a day; no personal data beyond public addresses. Workers Logs keep events for a few days (**L**) | `apps/relayer/test/unit/core.test.ts` (scrubbing with and without `0x`, requester tags); `apps/relayer/test/integration/relay.test.ts` and `apps/relayer/test/integration/worker.test.ts` (the logs of a full run, in Node and in workerd, contain no key, signature or client address); `apps/relayer/src/core/log.ts`, `apps/relayer/src/core/state.ts` (`prune`) | Low |
| <a id="t-46"></a>T-46 | S, D | **Payer-side signature dispatch.** Circle FiatToken v2.2 checks the EIP-3009 `r ‖ s ‖ v` with ECDSA when the payer has no code and through ERC-1271 when it has code, including an EIP-7702 designator (**C**: `contracts/v2/EIP3009.sol` and `contracts/util/SignatureChecker.sol` read on 2026-10-07). A relayer that verifies with local ECDSA only accepts requests that can never settle, and a payer that delegates between simulation and inclusion reverts the relay at the relayer's expense; one type-4 transaction can carry many authorisation tuples | `checkRelayPayRequest` verifies the payer with the token's dispatch (`eth_getCode`, then ERC-1271 for any code) and reports the payer's code; the relayer does not relay for payers with code; payers with code (smart accounts, delegated EOAs) are classified `smart-account` and routed to the allowance path ([spec §8.3](../spec/paylink-invoice-v2.md#83-the-authorisation-the-payer-signs)); per-payer and per-token in-flight bounds and bans cover a delegation made after admission | `packages/sdk/test/relayer.test.ts` (a delegated payer whose delegate rejects is refused although `ecrecover` accepts); `packages/sdk/test/payments.test.ts` (`payerAccountKind`); `A02_RelayerGriefing.t.sol::test_SimulationDoesNotBind_Delegated7702PayerRevertsOnInclusion`; fork-nightly observation of the dispatch on real USDC *planned (T0)* | Medium: availability, bounded like T-03 |
| <a id="t-47"></a>T-47 | T, E | **Relayer code substitution or key exposure.** A modified Worker is deployed (a compromised dependency, a malicious commit on `main`, an edit in the dashboard), or `RELAYER_PK` leaks (a log line, the repository, a chat, a reused wallet key) | The Worker is bundled from the lockfile's exact packages into `apps/relayer/deploy/worker.js` (not minified; each region named `package@version/path`; only seven allowlisted MIT packages), committed and reviewed, and uploaded byte for byte by Cloudflare's Git integration from `main` (`no_bundle`; no build runs on Cloudflare); a rebuild must equal it and `SHA256SUMS` lists it. The key is a throwaway testnet key made for the relayer alone, generated without being displayed and stored only as a Worker secret, never in `[vars]`, CI, the repository or a chat ([runbook](../runbooks/relayer.md#4-create-the-relayer-key-and-store-it-yourself)); the logger scrubs it. Every signature passes `assertSendable`: value 0, testnets only, only `payWithAuthorization` and `cancelBySig` on the canonical deployment, the registry faucet's `requestFunds(address)`, or a zero-value self-transfer; never from an account with code. The balance stays at most about 2 MON | `apps/relayer/test/unit/deploy.test.ts` (the bundle equals a rebuild; wrangler 4.148.0 uploads exactly it; the configuration has no variables and no key); `apps/relayer/test/unit/core.test.ts` (the choke point refuses value, other selectors, token transfers, mainnets and revoked deployments); `apps/relayer/test/integration/relay.test.ts` (every transaction the relayer signed on anvil) | Low: a substituted relayer or a stolen key can spend the relayer's gas balance and censor; it cannot redirect a payment ([T-01](#t-01)) |
| <a id="t-48"></a>T-48 | D | A look-alike site drives the relayer from its visitors' browsers, or scripts call it directly | CORS answers only `https://paylink-mg.pages.dev` and its one-label preview subdomains; a request with any other `Origin` (preflight included, `null` included) is refused with 403 before anything is processed. CORS is not access control: requests without an `Origin` are served and bounded by the pipeline like any other ([T-03](#t-03)) | `apps/relayer/test/unit/app.test.ts` (look-alike hosts, nested and malformed labels, `http`, `null` refused; previews allowed); `apps/relayer/test/integration/worker.test.ts` (the same policy in workerd) | Low |

### 6.6 Indexer

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-15"></a>T-15 | S, T, D | Indexer spoofing, staleness or outage | Never authoritative ([ADR 0009](../adr/0009-read-model-chain-device-indexer.md)); receipts verified on RPC; URL from same-origin config only; "history unavailable" fallback | Receipt-verifier tests; e2e indexer-down *planned (T1)* | Low |
| <a id="t-36"></a>T-36 | S | **Sybil inflation of the trust line.** A scammer pays their own payee address from many fresh addresses to fake "N payments received since …" (`SelfPayment` only blocks the same address) | The trust line shows unique payers and volume, not only a count; it is labelled as information from the history service and never gates payment; it never replaces the first-payment warning | Indexer handler tests *planned (T1)*; UI copy review | Medium: a soft signal that can be gamed cheaply on testnet |

### 6.7 Configuration and hosting

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-16"></a>T-16 | D, S | An RPC outage, or an RPC that lies | viem `fallback()` across the registry RPCs; at T2, receipts cross-checked on two RPCs | Status LEDs *planned (T0)*; review | Medium until T2 |
| <a id="t-39"></a>T-39 | T | `/config.json` or `_headers` is modified to inject endpoints or remove protections | Served from the same origin, deployed only by `site.yml` from `main`; the API token is scoped; the CSP `connect-src` limits endpoints to the registry list | Production-CSP e2e *planned (T0)*; required checks on `main` *planned (T0)* | Low (provisional) |

### 6.8 Deploy pipeline

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-20"></a>T-20 | T | Deploy substitution: wrong bytecode or a malicious deployer | `initCodeHash` shown before signing and matched to the release artefact; masked runtime comparison; environment `testnet` with the owner as required reviewer | `Surface.t.sol::test_ConstructorTakesNoArgumentsSoInitCodeIsChainIndependent`; `Scripts.t.sol` (release lock, code verification); `deployments-check.yml` *planned (T0)* | Low |
| <a id="t-32"></a>T-32 | T | After an incident, the old deployment stays callable and its open invoices stay payable | The registry flags the old deployment so clients refuse it; banner through `/config.json`; payees cancel open invoices there; disclosure ([incident response](incident-response.md)) | Incident drill *planned (T1)* | Medium: third-party clients can ignore the flag |

### 6.9 Supply chain

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-17"></a>T-17 | T, E | A malicious dependency version: npm, PyPI or a GitHub Action | Exact pins and lockfile integrity; `strictDepBuilds` with reviewed build scripts; `blockExoticSubdeps`; `trustPolicy: no-downgrade`; SHA-pinned Actions; gitleaks; Dependabot; review of the Mera lockfile diff ([ADR 0011](../adr/0011-workspace-layout.md)) | `scripts/toolchain/audit-workspace.py`; CI *planned (T0)* | Medium: preview SDKs (Mera 0.2.0) remain a trust dependency |
| <a id="t-42"></a>T-42 | T | Tampered toolchain binaries (Foundry, solc) | Digests pinned in `scripts/toolchain/pins.env`; solc digest equal to the official solc-bin list; HTTPS-only downloads; vendored forge-std checked by manifest ([ADR 0012](../adr/0012-toolchain-pinning-and-vendoring.md)) | `bootstrap-sandbox.sh --check` | Low |

### 6.10 CI secrets

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-18"></a>T-18 | I, E | CI secret exfiltration through a pull request or a compromised action | Environments with a required reviewer; no secrets on pull-request runs; no `pull_request_target`; least-privilege `permissions:`; SHA-pinned actions; `RELAYER_PK` lives only in Cloudflare | Workflow review and OpenSSF Scorecard *planned (T0)* | Low |
| <a id="t-41"></a>T-41 | T | A malicious contribution changes CI or code | Required status checks on `main`; owner review; CODEOWNERS; the PR template's security checklist | Branch protection settings *planned (T0)* | Low |

### 6.11 AI agents

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-21"></a>T-21 | T, I, E | Prompt injection of an AI agent: Claude Code in development; later the GitLab Duo flows and the PayPal copilot | Tool allowlists; agents cannot merge or push the default branch and never hold private keys; a person approves anything that moves money; memos, merge-request text and validator output are treated as hostile ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)) | Owner review of every commit; injection test fixtures (GitLab, PayPal) *planned (T2: those editions)* | Medium |

### 6.12 Privacy-specific threats

| ID | STRIDE | Threat | Mitigations | Evidence | Residual |
|---|---|---|---|---|---|
| <a id="t-24"></a>T-24 | I | `memoHash` is an unsalted hash published in calldata on payment, so anyone can confirm a guessed low-entropy memo | Documented ([spec §15](../spec/paylink-invoice-v2.md#15-privacy-considerations)); UI copy discourages personal data in memos; a salted commitment is a candidate for a future format version | Documentation | Medium (accepted, documented) |

## 7. Abuser stories and their tests

| Abuser story | Blocked by | Test |
|---|---|---|
| As a relayer, I submit Alice's authorisation against my own receive card. | Nonce binding (I8) | `test_RelayerCannotRedirectAuthorization` |
| As a relayer, I change the amount or the reference. | Nonce binding (I8) | invariant I8 handler |
| As anyone, I replay a Base Sepolia invoice signature on Monad. | Domain separation (I7) | I7 fuzz; `test_Eip712DomainFollowsChainId` |
| As anyone, I reuse a payee's invoice signature as a cancellation. | Distinct type hashes | `test_RevertWhen_InvoiceSignatureReusedAsCancel` |
| As anyone, I replay a cancellation signature. | Cancellation is one-way; a second one reverts with `Cancelled` | `test_RevertWhen_CancelSigReplayed` |
| As anyone, I submit a high-`s` or compact signature. | OpenZeppelin ECDSA rules | `test_RevertWhen_HighS`, `test_RevertWhen_CompactSignature` |
| As a donor, I send 1 wei or 1 token to block payments. | Relative conservation (I1) | `test_EveryPathWorksWithDonationsPresent` |
| As a griefer, I front-run the payer's permit. | `try/catch` permit | `test_PayWithPermit_FrontRunPermitIsHarmless` |
| As a token, I re-enter PayLink during a transfer. | `nonReentrant`, checks-effects-interactions | `test_RevertWhen_TokenHookReentersDuringPay` |
| As a fee-on-transfer token, I deliver less than the amount. | Delta checks (I6) | `test_RevertWhen_FeeOnTransfer` |
| As a payee, I pay myself to fake volume. | `SelfPayment` | `test_RevertWhen_PayerIsPayee` |
| As anyone, I pay a cancelled, expired or sold-out invoice. | State and window checks (I2, I4, I5) | `test_Cancel_BlocksEveryPaymentPath`; the `SoldOut` and `Expired` tests |
| As anyone, I send native coin directly, or pay a native invoice with ERC-20. | Path separation (I10) | `test_RevertWhen_PlainNativeTransfer`; `test_RevertWhen_InvoiceIsNative` |
| As an admin, I upgrade, pause or sweep. | There is no admin surface | `test_NoAdminSurface` |
| As a phisher, I send a link that names my own contract. | The contract address is never in the URL | SDK codec tests; e2e foreign-contract spec *planned (T0)* |
| As a phisher, I frame the pay page and overlay it. | `frame-ancestors 'none'`; JavaScript lock | e2e framed-page spec *planned (T0)* |
| As a payer, I show the merchant a receipt for someone else's payment, or for a reverted transaction. | Receipt verification on RPC, with payee, amount and key shown (T-43) | SDK receipt-verifier tests |
| As a customer, I send 0.01 to the merchant's receive card so that the till lights up. | The till fires only for the armed invoice's key and amount, and shows the amount (T-44) | e2e till specs *planned (T1)* |
| As a relayer, I sit on a payer's authorisation until the payer retries, then land it, so a receive card is paid twice. | Retries resubmit the same authorisation; other paths only after a cancel or expiry (T-45) | `test_NoDedupe_FreshSaltRetryChargesReceiveCardTwice` (the attack, client rule broken); `test_Fix_ResubmitSameAuthorizationIsIdempotent`; SDK `attempts.test.ts` and the anvil suite |
| As a payee, I let relays simulate and then flip my `isValidSignature`, or cancel my card, so that every queued relay reverts at the relayer's expense. | In-flight bounds per key and payee, bans after a post-simulation revert, payee-code allowlist (T-13, T-03) | `test_SimulationDoesNotBind_OneToggleRevertsEveryQueuedRelay`; SDK `relay-admission.test.ts` and the anvil suite |
| As a payer, I delegate my EOA with EIP-7702 after the relayer simulated my payment. | Payer verified with the token's dispatch; payers with code not relayed; per-payer and per-token bounds (T-46) | `test_SimulationDoesNotBind_Delegated7702PayerRevertsOnInclusion`; SDK `relayer.test.ts` |
| As a sybil payer holding one base unit, I sign `validBefore = now + 1` for an honest merchant's receive card, so that the relay passes simulation, reverts one block later and gets the merchant banned. | Relay margin on every time bound; attribution by cause, which never bans a payee for a payer's failure (T-03, T-13) | `test_SimulationDoesNotBind_PayerChosenValidBefore`; SDK `audit/A04-time-boundary-ban.test.ts` and the anvil suite |
| As a requester, I ask for a relay in an invoice's last second, or relay a throwaway cancellation with `deadline = now`. | Relay margin (T-03) | `test_SimulationDoesNotBind_InvoiceLastSecond`, `test_SimulationDoesNotBind_CancelDeadlineNow`; SDK `relayer.test.ts` |
| As a payer, I resubmit my own authorisation (or anyone copies the relayer's calldata) while the relay is pending. | The payment settles once; the relay's revert is recognised as superseded and bans nobody (T-13) | `test_SameAuthorizationLandedElsewhere_IsRecognisableFromTheSettlingLogs`; SDK `relay-attribution.test.ts` and the anvil suite |
| As a payee wallet, I read PayLink's state for my link while I am being paid in native coin. | Checks-effects-interactions on every path: the payment is already recorded (T-26) | `test_PayNative_ReadOnlyReentrySeesPostEffectsState`; `test_ReadOnlyReentrySeesPostEffectsState_PayWithAuthorization` |
| As a phisher, I lure a payee, or a payer who left PayLink a standing allowance, into calling my contract, which calls `cancel` on the payee's links or `pay` on my invoice while their address is `tx.origin` (SWC-115). | PayLinkV2 never reads `tx.origin`: the payee is `msg.sender` or a signer, the payer is `msg.sender` or `auth.payer` | `test_RevertWhen_LuredPayeeWouldCancel`; `test_RevertWhen_LuredPayerAllowanceWouldBeSpent`; `test_RevertWhen_PermitSignedByTxOriginOnly`; invariant I9 (origins seeded in the campaign) |

## 8. Residual risks

| Risk | Rating | Treatment |
|---|---|---|
| The contracts are **unaudited** | Medium | Testnets only (plus small-amount Arc v1); [self-review](self-review.md) published and labelled "not a third-party audit"; hand-written mutants of the contract, all killed (`protocol/audit/mutation/`); Halmos checks of conservation and the state machine, and an Echidna/Medusa property contract for I1–I11, with their first runs recorded in `protocol/audit/properties.md` (the nightly hour-long runs are *planned (T1)*). None of this replaces an external audit |
| Mera is a 0.2.0 **preview** SDK | Medium | Exact pin; lockfile diff review; lazy loading in one edition only; Oct 9 go/no-go with an injected-wallet fallback |
| The relayer is a single point of **availability** | Low | Self-submission of the same authorisation is always offered |
| Relayer griefing by post-simulation reverts (T-03, T-13, T-46) | Medium | Relay margin on every time bound; bounded in-flight relays; day-long bans of the party a revert is attributed to; requester strikes and rate limits per IPv4 address or IPv6 /64; code policy; daily gas budget. What remains costs the attacker an on-chain action per grief and cannot shut out an uninvolved payee. A holder of many IPv6 /64s (a /48) multiplies requester identities, so the daily budget stays the backstop; for a 0-MON passkey payer on Monad an outage means waiting, not losing funds |
| Testnet faucets are fragile | Low | Claim on every cadence; pre-funded demo payers (the relayer has no token inventory, by design: T-33); small demo amounts |
| Sybil inflation of the trust line (T-36) | Medium | Soft signal only; unique payers shown |
| Till false positive on receive cards (T-44) | Medium | Amount shown next to the LED; arm a specific invoice for counter sales |
| Unsalted `memoHash` (T-24) | Medium | Documented; future format version |
| Old deployments stay callable after a redeploy (T-32) | Medium | Registry flag, banner, cancellations, disclosure |
| solc 0.8.30 has seven known bugs, none applicable ([ADR 0002](../adr/0002-one-paris-bytecode-oz-5-3-0.md)) | Low | Re-checked at every release; upgrade planned for v2.1 |
| No on-chain pause (SCSVS G1.5 deviation) | Low | Non-custodial design; client-side kill switch |

## 9. Out of scope

- A compromised operating system, browser, browser extension or authenticator on the user's device.
- Chain-level failures: consensus faults, censorship by block producers beyond `validBefore`, reorganisations deeper than finality.
- Failures in token issuers' own contracts beyond the documented behaviours (blocklists, pauses).
- Legal, regulatory and tax questions, including FX display, which is an estimate only.
- PayLink v1 on Arc, except for shared hosting concerns.

## 10. Review triggers

This model is reviewed and versioned:

- when any ADR is added or superseded;
- before every contract deployment and at the `contracts-v2.0.0` tag;
- at each tier freeze: T0 (Oct 8), T1 (Oct 10 18:00 UTC);
- after every incident, as part of the post-mortem ([incident response](incident-response.md));
- when a new edition, account layer, token or chain is added;
- when a dependency with code on the origin (Mera, Base Account, viem) is bumped.

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-05 | Baseline: spec threats 1–22 expanded per component; T-23 to T-42 added (EIP-7702 payees, unsalted memo hash, QR overlay, reentrancy, allowance scope, service worker, clipboard, decimals, token blocklists, old deployments, faucet abuse, timestamps, decoding, sybil trust line, repudiation, relayer logs, config tampering, clone sites, malicious contributions, toolchain binaries) |
| 1.1 | 2026-10-07 | Evidence re-checked: every cited test exists in the file named (`docs/tools/check-docs.py`); invariants linked to their [catalogue](invariants.md). Added T-43 (forged or borrowed receipts) and T-44 (till false positives), both merchant-side spoofing found while reviewing the till and receipt flows; no existing rating changed |
| 1.2 | 2026-10-07 | Pre-freeze audit. Added T-45 (retry double charge: a re-signed or permit retry plus a late relay pays a multi-payment link twice; fixed by spec §8.6 and the SDK) and T-46 (payer-side FiatToken dispatch and EIP-7702 delegation griefing). Corrected T-13: a payee, with or without code, can make relays revert after simulation at the relayer's expense, so its effect is not limited to its own payments; residual raised to Medium. T-03 extended to post-simulation reverts and raised to Medium; T-02 now requires self-submission of the same authorisation. Added the evidence-status markers: 1.1's re-check covered Foundry tests only, while several rows cited e2e, relayer and CI evidence that is not built yet; `check-docs.py` now checks cited paths and markers |
| 1.3 | 2026-10-07 | Re-audit (A-04 and a test-coverage finding). T-03: time-bound griefing added (a bound one second ahead passes simulation and reverts on inclusion with no attacker transaction); mitigated by a per-chain relay margin. T-13: its residual claimed that bans made each grief cost the attacker a fresh payee, payer and card, which was false while a revert banned key, payee and payer whoever caused it (a sybil payer could get an honest payee banned); bans now follow the cause, a superseding settlement bans nobody, requesters are counted per IPv6 /64, and the residual is restated. T-26: read-only re-entry is now pinned on all four settlement paths. T-34 notes the relay margin. Four abuser stories added |
