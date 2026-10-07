---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering); prototype secproto (relayer-redirect test, 5/5 green)
informed: contributors, reviewers, relayer operators
---

# ADR 0003: Bind the EIP-3009 nonce to the payment

## Context and problem statement

Gasless payment is a headline feature: the payer signs, and a relayer pays the gas. USDC and AUSD implement [EIP-3009], whose `receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` moves tokens on the strength of the holder's signature. The `nonce` is any 32-byte value the signer chooses; the token only checks that it has not been used before.

If `PayLinkV2.payWithAuthorization` accepted an authorisation with an arbitrary nonce, the submitter could take a payer's authorisation for invoice X and settle it against invoice Y, for example the relayer operator's own receive card, with the same token, amount and `to`. The funds would be redirected, and the payer's signature would still be "valid".

How can the payer's single signature be bound to exactly one invoice, amount and reference, with no second signature and no trusted relayer?

## Decision drivers

- A relayer must be trusted for **availability only**: it may delay, never redirect (PAYLINK-V2-SPEC §3.7).
- One payer signature, so the UX stays "one fingerprint".
- Works with unmodified, deployed EIP-3009 tokens (FiatToken USDC, AUSD).
- No extra on-chain state per payment beyond the per-key slot.
- Anyone, not only our relayer, can submit.

## Considered options

- **A.** The token nonce must equal `paymentNonce(key, payer, amount, payerRef, payerSalt)`, recomputed on-chain.
- **B.** Accept any nonce and trust the relayer.
- **C.** A separate payer EIP-712 `PayIntent` signature verified by PayLink, plus an EIP-3009 authorisation with a free nonce.
- **D.** The payer authorises a transfer straight to the payee (`transferWithAuthorization`, `to = payee`), and the contract only records it.
- **E.** Permit2 signature transfers with a witness.

## Decision outcome

Chosen option: **A**, because it closes the redirect attack with no additional signature, no additional storage and no change to the tokens.

```text
PAYMENT_BINDING_TYPEHASH = keccak256("PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)")
nonce = keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payer, amount, payerRef, payerSalt))
```

- `key` already commits to `chainId` and `verifyingContract` ([ADR 0001](0001-signed-invoices-no-onchain-create.md)), so the binding covers the chain and the deployment as well.
- `payerSalt` is drawn once per **intended payment**, never for a retry. It makes two intended payments of the same amount and reference by the same payer distinct. A retry resubmits the same signed authorisation; a new `payerSalt` (a new signature) for the same invoice is allowed only once the earlier authorisation is cancelled on the token (`cancelAuthorization` mined) or has expired unused ([spec §8.6](../spec/paylink-invoice-v2.md#86-retries-and-outstanding-authorisations)).
- `to` is the PayLinkV2 deployment, and EIP-3009 requires `msg.sender == to` for `receiveWithAuthorization`. Only PayLinkV2 can consume the authorisation, and only after recomputing the nonce.

Normative text: [spec §8](../spec/paylink-invoice-v2.md#8-payment-binding-for-eip-3009-authorisations), retries in [§8.6](../spec/paylink-invoice-v2.md#86-retries-and-outstanding-authorisations).

Amended on 2026-10-07 (re-audit; the decision, option A, is unchanged). The accepted text asked for a new `payerSalt` on every attempt, on the grounds that a retry would then never collide with a consumed nonce. That rule was wrong: PayLinkV2 keeps no record of authorisations, only of payments, so an authorisation re-signed with a fresh `payerSalt` is a **second payment**, and the first one is still valid until its `validBefore`. On a link with `maxPayments != 1` (receive card, open-amount till, N seats) a relayer that is slow rather than down could land both, charging the payer twice with no on-chain refund ([THREAT_MODEL T-45](../security/THREAT_MODEL.md#t-45)). The spec revised the rule on the same day (§8.2, §8.6, history in §19); this amendment aligns the ADR with it. The rule above replaces the old bullet, and the consequences below gained the matching entry.

### Consequences

- Good, because a relayer, or anyone else, can delay or withhold an authorisation until `validBefore`, but cannot change the invoice, the amount or the reference (invariant I8).
- Good, because "anyone may submit": the payer can self-submit the same authorisation when the relayer is down ([THREAT_MODEL T-02](../security/THREAT_MODEL.md#t-02)).
- Good, because `payerRef` is authenticated on the gasless path.
- Bad, because wallets display the nonce as an opaque `bytes32`. The SigningDisplay must explain in plain words what is approved (amount, payee, expiry, network).
- Bad, because only tokens with EIP-3009 get gasless payments in v2.0. MUSD (EIP-2612 only) does not; a relayed `PayIntent` path is a v2.1 candidate (PAYLINK-V2-SPEC §9).
- Bad, because only the `v, r, s` form of `receiveWithAuthorization` is used, so smart-account payers use the allowance path (EIP-5792 batching) instead.
- Bad, because the binding identifies a payment, not an attempt: the contract cannot tell a retry from a second payment. Clients must therefore persist each signed authorisation before sending it, retry only by resubmitting it, and sign again or switch to permit or approve-and-pay only after it is cancelled on the token or has expired; a consumed one is a payment that went through (spec §8.6, [T-45](../security/THREAT_MODEL.md#t-45); amended 2026-10-07). The SDK enforces this in `packages/sdk/src/attempts.ts` and in the payment router.

### Confirmation

- Invariant **I8** (binding): a handler tries to settle authorisations against altered tuples, and every attempt fails at the token.
- A relayer-redirect unit test, ported from the prototype, submits an authorisation for invoice X against invoice Y and expects a token-side signature failure.
- Golden vectors `protocol/test/vectors/nonce.json` are reproduced by the SDK.
- `fork-nightly.yml` checks each real token's `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` and domain separator.
- The relayer recomputes the nonce locally before simulating, and rejects mismatches.
- Retries (amended 2026-10-07): `protocol/test/audit/A01_RetryDoublePay.t.sol` shows that a fresh-salt or permit retry pays a receive card twice when the client breaks spec §8.6 (`test_NoDedupe_FreshSaltRetryChargesReceiveCardTwice`, `test_NoDedupe_PermitFallbackChargesReceiveCardTwice`) and that resubmission, cancel-then-fallback and expiry are safe (`test_Fix_ResubmitSameAuthorizationIsIdempotent`, `test_Fix_CancelAuthorizationBeforeFallback`, `test_Fix_ExpiredAuthorizationNeverLands`); `packages/sdk/test/attempts.test.ts` and the anvil suite ("relayer slow, then lands") check the SDK's enforcement.

## Pros and cons of the options

### A. Nonce bound to the payment (chosen)

- Good, because it needs one signature and no extra state, works with deployed tokens, and makes redirection impossible.
- Bad, because the nonce is opaque in wallets, and only EIP-3009 tokens are covered.

### B. Any nonce, trusted relayer

- Good, because it is the simplest.
- Bad, because the relayer can redirect funds. That violates the core trust model and makes the operator's hot key a theft vector.

### C. Separate PayIntent signature

- Good, because the binding is explicit and readable in wallets, and it generalises to tokens without EIP-3009 (with permit).
- Bad, because it needs two signatures per payment (worse UX) and more contract code and tests. It is kept as the v2.1 design for MUSD.

### D. Direct transfer to the payee

- Good, because funds never touch PayLink.
- Bad, because the contract cannot enforce the invoice rules (cancellation, `maxPayments`, window) atomically with the transfer. `transferWithAuthorization` can also be front-run and executed outside PayLink, leaving the invoice state inconsistent.

### E. Permit2 witness transfers

- Good, because it is a general, audited pattern with typed witnesses.
- Bad, because every payer needs a one-time Permit2 approval, which is a transaction and needs gas, defeating "gasless first payment". It also adds a dependency, and Permit2 is explicitly out of scope before Oct 12 (PAYLINK-V2-SPEC §2.7).

## More information

- PAYLINK-V2-SPEC §0 decision 5, §3.3.2, §3.7, §5 threat 1.
- [EIP-3009]: <https://eips.ethereum.org/EIPS/eip-3009>.
- Related: [ADR 0007](0007-relayer-durable-object-per-chain.md) (relayer); [THREAT_MODEL T-45](../security/THREAT_MODEL.md#t-45) (retry double charge).

[EIP-3009]: https://eips.ethereum.org/EIPS/eip-3009
