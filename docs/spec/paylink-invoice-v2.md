# PayLink Signed Invoice Format, version 2

| | |
|---|---|
| **Document version** | 2.0.0 |
| **Wire-format version** | `2` (EIP-712 domain version `"2"`) |
| **Status** | Draft. The normative content freezes with the `contracts-v2.0.0` tag (contract go/no-go, 2026-10-07 12:00 UTC). |
| **Date** | 2026-10-05 |
| **Editor** | nambininasafidison |
| **Machine-readable schema** | [`paylink-invoice-v2.schema.json`](paylink-invoice-v2.schema.json) (JSON Schema 2020-12) |
| **Reference implementation** | `protocol/src/PayLinkV2.sol` (contract), `packages/sdk` (`@paylink/sdk`, client codec and verifier) |
| **Licence** | MIT, like the rest of the repository. Anyone may implement this format without asking. |

## Abstract

A PayLink invoice is a payment request that the payee signs off-chain with [EIP-712]. The signature costs no gas and works offline. The invoice travels as the fragment of a URL or a QR code. Anyone can verify it and pay it through the immutable `PayLinkV2` contract, which forwards the funds to the payee in the same transaction and records one storage slot per invoice. This document specifies the invoice data model, the EIP-712 domain and types, how the invoice key is derived, the payee signature rules, the binding between an [EIP-3009] payment authorisation and one specific payment, signed cancellations, the URL encodings for invoices and receipts, and the algorithm that verifies a receipt.

## Contents

1. [Introduction](#1-introduction)
2. [Conventions and terminology](#2-conventions-and-terminology)
3. [Invoice data model](#3-invoice-data-model)
4. [EIP-712 domain](#4-eip-712-domain)
5. [Invoice key](#5-invoice-key)
6. [Payee signature](#6-payee-signature)
7. [Payment semantics](#7-payment-semantics)
8. [Payment binding for EIP-3009 authorisations](#8-payment-binding-for-eip-3009-authorisations)
9. [Cancellation](#9-cancellation)
10. [URL encodings](#10-url-encodings)
11. [JSON representation](#11-json-representation)
12. [Receipt verification](#12-receipt-verification)
13. [Client requirements](#13-client-requirements)
14. [Security considerations](#14-security-considerations)
15. [Privacy considerations](#15-privacy-considerations)
16. [Versioning and extensibility](#16-versioning-and-extensibility)
17. [Test vectors (informative)](#17-test-vectors-informative)
18. [References](#18-references)
19. [Document history](#19-document-history)

---

## 1. Introduction

### 1.1 Goals

- **The link is the invoice.** Creating a payment request needs no transaction, no gas token and no network connection.
- **Non-custodial settlement.** Funds go from the payer to the payee within one transaction. The contract's balance is the same after every call as before it.
- **Redirect-proof gasless payments.** A third party (a relayer) can submit a payer's signed EIP-3009 authorisation, but it cannot apply that authorisation to a different invoice, amount or reference.
- **Self-verifying artefacts.** An invoice link and a receipt link each carry enough data for any client to verify them against a public chain, without trusting the server that served the page.
- **Strict, bounded decoding.** Every encoded field has a fixed or capped length, so decoders do bounded work and reject malformed input.

### 1.2 Non-goals

- Payee identity. A valid signature proves only that the payee **address** signed. Binding an address to a person or business is out of scope; see [§14.4](#144-phishing-and-look-alike-addresses).
- Privacy of the invoice terms once paid. Settlement calldata is public; see [§15](#15-privacy-considerations).
- On-chain invoice registration. v2 has no `create` or `publish` function ([ADR 0001](../adr/0001-signed-invoices-no-onchain-create.md)).
- Fees, escrow, refunds, subscriptions and split payouts.
- Counterfactual smart-account payees ([ERC-6492]); see [§6.3](#63-contract-payees-erc-1271).

### 1.3 Relationship to the PayLink v1 contract

PayLink v1 (`contracts/PayLink.sol`, the Arc Microgrants entry) uses on-chain link registration and is **not** covered by this document. v1 and v2 links are not interchangeable ([ADR 0010](../adr/0010-arc-stays-on-v1.md)).

---

## 2. Conventions and terminology

### 2.1 Requirement keywords

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

### 2.2 Conformance classes

| Class | Who | Sections that bind it |
|---|---|---|
| **Settlement contract** | An implementation of the `PayLinkV2` interface | §3–§9 |
| **Issuer** | Software that creates and signs invoices | §3–§6, §9, §10, §11, §13.1 |
| **Payer client** | Software that decodes, verifies and pays invoices | §4–§8, §10, §13.2 |
| **Payee display** | Software that tells a payee a payment arrived (a till) | §12, §13.4 |
| **Receipt verifier** | Software that checks a receipt | §10.6, §12 |
| **Relayer** | A service that submits signed authorisations or cancellations | §8, §9, §13.3 |

### 2.3 Notation

- `‖` is byte concatenation. `0x…` is hexadecimal. All integers are unsigned and big-endian when serialised to bytes.
- `keccak256` is the Ethereum Keccak-256 hash. `abi.encode` is the Solidity ABI encoding, in which every static value takes one 32-byte word.
- `hashStruct`, `encodeType` and `domainSeparator` are as defined in [EIP-712].
- **base64url** is the "URL and Filename safe" alphabet of [RFC 4648] §5, **without padding**.
- `uintN` is an unsigned integer of N bits. **uint53** means an integer in `[0, 2^53 − 1]`, the range that every JavaScript number represents exactly.
- `now` is the `timestamp` of the block in which a transaction executes. Clients that need "now" before submitting SHOULD use the latest block's timestamp, not the device clock.

### 2.4 Terms

| Term | Meaning |
|---|---|
| **Payee** | The address that signs an invoice and receives its payments: an EOA, or a deployed [ERC-1271] contract account. |
| **Payer** | The address whose funds settle a payment. |
| **Invoice** | The eight-field `Invoice` struct of [§3](#3-invoice-data-model). |
| **Signed invoice** | An invoice plus the payee's signature over its key, the `chainId`, and optionally the memo text. |
| **Key** | The EIP-712 digest of an invoice under a deployment's domain ([§5](#5-invoice-key)). It is the invoice's identifier on-chain and in every index. |
| **Deployment** | One `PayLinkV2` contract at one address on one chain. |
| **Registry** | The client's authoritative list of chains, canonical deployments and allowed tokens (`@paylink/chains` in the reference implementation). |
| **Receive card** | An invoice with `amount = 0`, `maxPayments = 0` and usually `validUntil = 0`: a reusable "pay me any amount" card. |
| **Relayer** | Any party that submits a transaction on someone else's behalf. It is trusted for availability only. |

---

## 3. Invoice data model

### 3.1 Fields

```solidity
struct Invoice {
    address payee;       // receives funds; EOA or deployed ERC-1271 account
    address token;       // ERC-20 token; address(0) = the chain's native coin
    uint128 amount;      // base units; 0 = open amount (payer chooses, > 0)
    uint64  validAfter;  // unix seconds, inclusive
    uint64  validUntil;  // unix seconds, inclusive; 0 = no expiry
    uint32  maxPayments; // 1 = one-off; N = N payments; 0 = unlimited
    bytes32 salt;        // 32 random bytes
    bytes32 memoHash;    // keccak256(UTF-8 memo) or 0x00…00 when there is no memo
}
```

| Field | Type | Rules |
|---|---|---|
| `payee` | `address` | MUST NOT be `address(0)`. MUST NOT be the deployment's own address. |
| `token` | `address` | `address(0)` selects the native-coin path. Otherwise an ERC-20 token. MUST NOT be the deployment's own address. Payer clients MUST refuse tokens that are not in the registry's allowlist for that chain. |
| `amount` | `uint128` | Base units of `token` (for example 6 decimals for USDC and AUSD, 18 for MUSD). `0` means an open amount: the payer chooses any amount greater than 0. |
| `validAfter` | `uint64` | Earliest payable time, inclusive. `0` means payable immediately. |
| `validUntil` | `uint64` | Latest payable time, inclusive. `0` means no expiry. When non-zero it MUST be greater than or equal to `validAfter`. |
| `maxPayments` | `uint32` | Maximum number of successful payments. `0` means unlimited. |
| `salt` | `bytes32` | Issuers MUST draw it from a cryptographically secure random generator (for example `crypto.getRandomValues`) for every new invoice ([§14.6](#146-salt-quality-and-key-collisions)). |
| `memoHash` | `bytes32` | `keccak256` of the exact UTF-8 bytes of the memo, or `0x00…00` when there is no memo. An empty memo MUST be encoded as `0x00…00`, never as `keccak256("")`. |

**uint53 rule.** Issuers MUST NOT produce `validAfter` or `validUntil` values above `2^53 − 1`, and payer clients MUST reject such invoices. The contract accepts the full `uint64` range; the rule exists so that every conforming value is exact in JavaScript and in the JSON form of [§11](#11-json-representation).

### 3.2 Invoice kinds

The fields combine into the following kinds. The kind is not encoded; it follows from the values.

| Kind | `amount` | `maxPayments` | `validUntil` | Typical use |
|---|---|---|---|---|
| One-off invoice | > 0 | 1 | set (issuers SHOULD default to 7 days) | a freelancer's invoice |
| Open-amount, single use | 0 | 1 | set | "pay what you owe" |
| Seats or batch | > 0 | N > 1 | set | N identical tickets |
| Receive card | 0 | 0 | 0 (explicit confirmation required, [§13.1](#131-issuers)) | a printed counter card, "Send" contacts |

### 3.3 Memo

The memo is free text from the payee, at most **280 bytes** of UTF-8. It never appears on-chain; only `memoHash` does, and only once the invoice is paid or cancelled. Issuers SHOULD normalise the memo to Unicode NFC before hashing. Verifiers MUST hash the exact received bytes and MUST NOT normalise before comparing. Display rules are in [§13.2](#132-payer-clients).

---

## 4. EIP-712 domain

### 4.1 Domain

Every deployment uses this [EIP-712] domain:

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)

name              = "PayLink"
version           = "2"
chainId           = the chain's EIP-155 chain ID
verifyingContract = the deployment's address
```

There is no `salt` field. The domain type hash is

```text
keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
  = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f
```

and the domain separator is

```text
domainSeparator = keccak256(abi.encode(
    0x8b73c3c6…2b39400f,
    keccak256("PayLink"),
    keccak256("2"),
    chainId,
    verifyingContract))
```

A settlement contract MUST expose the domain through [ERC-5267] `eip712Domain()`, returning `fields = 0x0f` (name, version, chainId, verifyingContract), `salt = 0x00…00` and an empty `extensions` array. The reference implementation inherits OpenZeppelin Contracts 5.3.0 `EIP712`, which recomputes the separator if the chain ID changes after deployment (fork protection).

### 4.2 Resolving `verifyingContract`

The contract address is **never** carried in an invoice or a URL. A payer client MUST take `verifyingContract` from its registry, looked up by `chainId` alone. It MUST reject an invoice whose `chainId` has no canonical deployment in the registry. A client SHOULD call `eip712Domain()` on the deployment once and compare every returned field with the registry entry. A client SHOULD also compare the deployment's runtime code, with its immutable ranges masked and its CBOR metadata stripped, against the release artefact before enabling payments ([ADR 0002](../adr/0002-one-paris-bytecode-oz-5-3-0.md), [ARCHITECTURE §6](../ARCHITECTURE.md#6-deployments-and-code-integrity)).

Each registry deployment carries a status: `active`, `deprecated` (a newer deployment exists; existing invoices remain payable) or `revoked` (an incident; see the [incident response](../security/incident-response.md)). A payer client MUST NOT enable payment to a `revoked` deployment and SHOULD warn before paying a `deprecated` one. Issuers MUST sign new invoices only for `active` deployments.

Rationale: a phishing link cannot name a look-alike contract. A link for an unknown chain cannot be paid at all.

---

## 5. Invoice key

### 5.1 Derivation

```text
INVOICE_TYPEHASH = keccak256("Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)")
                 = 0x8b0d4e92e431b40f1455755e745c6d48d699d52b9a141b56f0a079793050708e

structHash = keccak256(abi.encode(INVOICE_TYPEHASH,
                 payee, token, amount, validAfter, validUntil, maxPayments, salt, memoHash))

key = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ structHash)
```

`key` is exactly the EIP-712 digest that a wallet signs for `eth_signTypedData_v4` with `primaryType = "Invoice"`. A settlement contract MUST expose it as `invoiceKey(Invoice) returns (bytes32)` and MUST expose `INVOICE_TYPEHASH` as a public constant.

### 5.2 Properties

- **The key commits to the chain and the deployment.** The same eight fields produce a different key on another chain or under another contract address ([§17.4](#174-cross-chain-key)).
- **The key is the identifier everywhere:** on-chain state, the `Paid` and `InvoiceCancelled` event topics, the indexer's `LinkAgg` entity and the device store.
- **The key does not depend on the signature.** Several valid signatures over the same key (for example from an ERC-1271 wallet) all refer to the same invoice state.

---

## 6. Payee signature

### 6.1 What is signed

The payee signs `key` ([§5](#5-invoice-key)) as EIP-712 typed data. Wallets SHOULD therefore display the eight `Invoice` fields and the domain. Passkey-derived accounts that show no wallet prompt MUST be preceded by an equivalent application-level confirmation ([§13.1](#131-issuers)).

### 6.2 EOA payees

When the payee address has **no code** at verification time:

- The signature MUST be exactly 65 bytes: `r (32) ‖ s (32) ‖ v (1)`.
- `v` MUST be 27 or 28. Issuers that obtain `v ∈ {0, 1}` from a signer MUST add 27 before encoding.
- `s` MUST be in the lower half of the curve order, `s ≤ 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0`. High-`s` signatures are rejected.
- Compact 64-byte [EIP-2098] signatures are **not** accepted.
- The signature is valid when `ecrecover(key, v, r, s) == payee` and the recovered address is not zero.

### 6.3 Contract payees (ERC-1271)

When the payee address **has code** at verification time, the signature is opaque bytes, and it is valid exactly when `payee.isValidSignature(key, signature)` returns the magic value `0x1626ba7e` within a `staticcall` ([ERC-1271]).

- The payee contract MUST be deployed when the payment executes. Counterfactual signatures ([ERC-6492]) are not supported on-chain. Issuers MUST NOT create invoices for a payee address without code when the signing account is a smart account ([§13.1](#131-issuers)).
- The signature is checked on **every** payment, not only the first. An ERC-1271 wallet that changes its owners or policy can therefore invalidate invoices it signed earlier. This is intended: the payee stays in control.
- Signatures longer than 512 bytes cannot be carried in a URL ([§10.2](#102-invoice-url)).

This dispatch, ECDSA only when the signer has no code and ERC-1271 only when it has code, is the behaviour of OpenZeppelin Contracts 5.3.0 `SignatureChecker.isValidSignatureNow` (**C**: source read on 2026-10-05). A settlement contract MUST behave identically.

### 6.4 EIP-7702 delegated payees

An EOA that has an active [EIP-7702] delegation has code (the delegation designator `0xef0100 ‖ address`). Under [§6.3](#63-contract-payees-erc-1271) its invoices therefore verify **only** through the delegate's `isValidSignature`. Consequences:

- Invoices that such an EOA signed before it delegated stop being payable, unless the delegate implements ERC-1271 and accepts the EOA's own ECDSA signature.
- Issuers SHOULD read `eth_getCode(payee)` before signing. If the code starts with `0xef0100`, they SHOULD warn the payee and SHOULD verify the signature through `isValidSignature` by `eth_call` before sharing the link.
- Payer clients MUST verify through the same dispatch as the contract. Otherwise the verification strip could show "Signature valid" for an invoice that the contract would reject.

---

## 7. Payment semantics

This section is normative for settlement contracts and informative for clients, which use it to predict whether a payment will succeed.

### 7.1 Per-key state

```solidity
struct LinkState {     // exactly one storage slot (32 + 8 + 64 + 128 = 232 bits)
    uint32  payments;    // number of successful payments
    bool    cancelled;   // set once, never cleared
    uint64  lastPaidAt;  // timestamp of the latest payment, 0 if none
    uint128 total;       // sum of all paid amounts, in token base units
}
```

The state of a key that has never been paid or cancelled is all zeros. A settlement contract MUST expose `stateOf(bytes32)` and `statesOf(bytes32[])`. The batch view MUST accept at most 256 keys and MUST revert with `BatchTooLarge(256)` above that.

### 7.2 Payability predicate

A payment of `amount` by `payer` against invoice `inv` with signature `sig` succeeds only if **all** of the following hold. A settlement contract MUST evaluate the conditions in this order and MUST revert with the listed error at the first one that fails, so that clients can predict exactly which error a request triggers. The reference implementation documents the same order in the NatSpec of `IPayLinkV2`.

| # | Condition | Error on failure |
|---|---|---|
| 1 | `payee ≠ 0`, `payee ≠ this`, `token ≠ this`, and `validUntil = 0 ∨ validUntil ≥ validAfter` | `InvalidInvoice()` |
| 2 | the entry point matches the token kind ([§7.4](#74-entry-points)) | `WrongPaymentPath()` |
| 3 | `stateOf(key).cancelled = false` | `Cancelled()` |
| 4 | `sig` is valid for `payee` over `key` ([§6](#6-payee-signature)) | `InvalidSignature()` |
| 5 | `now ≥ validAfter` | `NotYetValid(validAfter)` |
| 6 | `validUntil = 0 ∨ now ≤ validUntil` | `Expired(validUntil)` |
| 7 | `maxPayments = 0 ∨ payments < maxPayments` | `SoldOut(maxPayments)` |
| 8 | `inv.amount ≠ 0 ⇒ amount = inv.amount`; `inv.amount = 0 ⇒ amount > 0` | `WrongAmount(inv.amount, amount)` |
| 9 | `payer ≠ payee` | `SelfPayment()` |

Token-side checks follow the effects ([§7.5](#75-exactness-and-conservation)): `ReceivedMismatch`, then `PayeeShortPaid`. For `payNative`, a `msg.value` above `2^128 − 1` reverts with `WrongAmount(inv.amount, 2^128 − 1)` before condition 1; this is unreachable with real balances.

### 7.3 Effects

When the predicate holds, the contract MUST, before any external call:

1. set `index = payments` (the zero-based ordinal of this payment), then `payments = payments + 1`;
2. set `total = total + amount` and `lastPaidAt = now`;
3. write the slot and emit
   `Paid(bytes32 indexed key, address indexed payee, address indexed payer, address token, uint128 amount, uint32 index, bytes32 payerRef)`.

The entry point returns `index`.

### 7.4 Entry points

| Function | Token kind | Payer | Funds movement |
|---|---|---|---|
| `payWithAuthorization(inv, payeeSig, auth)` | ERC-20 with EIP-3009 | `auth.payer` (anyone may submit) | `receiveWithAuthorization(payer → contract)`, then `transfer(contract → payee)`, in the same call |
| `pay(inv, payeeSig, amount, payerRef)` | ERC-20 | `msg.sender` | `transferFrom(payer → payee)` using an allowance |
| `payWithPermit(inv, payeeSig, amount, payerRef, permit)` | ERC-20 with EIP-2612 | `msg.sender` | `permit` inside `try/catch`, then as `pay` |
| `payNative(inv, payeeSig, payerRef)` | native (`token = address(0)`) | `msg.sender` | forwards `msg.value` to the payee; `amount = msg.value` |

An ERC-20 invoice MUST NOT be payable through `payNative`, and a native invoice MUST NOT be payable through the ERC-20 entry points. `receive()` and `fallback()` MUST revert with `WrongPaymentPath()`.

### 7.5 Exactness and conservation

- **Payee exactness.** For every ERC-20 path the payee's balance MUST increase by exactly `amount`, or the call reverts with `PayeeShortPaid(expected, received)`.
- **Receive exactness (EIP-3009 path).** The contract's balance MUST increase by exactly `amount` after `receiveWithAuthorization`, or the call reverts with `ReceivedMismatch(expected, received)`.
- **Relative conservation.** The contract's balance of every token, and of the native coin, after a call MUST equal its balance before the call. On the EIP-3009 path the reference implementation checks this explicitly after forwarding and reverts with `ReceivedMismatch(balanceBefore, balanceAfter)` otherwise. A contract MUST NOT require its balance to be zero, because a donation would then block every payment. Tokens sent to the contract outside a payment stay there, inert; there is no sweep function.
- **Unsupported tokens.** Fee-on-transfer tokens fail the exactness checks. Rebasing tokens are unsupported. Payer clients MUST offer only registry-allowlisted tokens.

### 7.6 Error catalogue

Selectors are derived from the interface in PAYLINK-V2-SPEC §3.3.2 and were checked against the compiled ABI of `protocol/src/PayLinkV2.sol` on 2026-10-07 (**C**). `protocol/test/vectors/SpecExamples.t.sol` asserts every selector in this table on every `forge test` run (and in CI once `contracts.yml` lands, planned for T0). The compiled ABI is authoritative if the two ever differ.

| Error | Selector | Raised when |
|---|---|---|
| `InvalidInvoice()` | `0x93fe191e` | shape check ([§7.2](#72-payability-predicate) #1) |
| `InvalidSignature()` | `0x8baa579f` | payee or cancel signature invalid |
| `SignatureExpired(uint256 deadline)` | `0xcd21db4f` | `cancelBySig` after its deadline |
| `NotPayee()` | `0x56cab67b` | `cancel` from an address other than the payee |
| `Cancelled()` | `0x63b95884` | payment or cancellation of a cancelled key |
| `NotYetValid(uint64 validAfter)` | `0x2d5d879e` | before `validAfter` |
| `Expired(uint64 validUntil)` | `0x95693653` | after `validUntil` |
| `SoldOut(uint32 maxPayments)` | `0x1166dd6e` | `maxPayments` reached |
| `WrongAmount(uint128 expected, uint128 sent)` | `0x96eb4103` | amount rule violated |
| `WrongPaymentPath()` | `0x99c891ea` | path does not match the token kind; direct transfers of the native coin |
| `SelfPayment()` | `0x82987a24` | payer equals payee |
| `ReceivedMismatch(uint256 expected, uint256 received)` | `0x53ee4726` | EIP-3009 receive delta differs from `amount` |
| `PayeeShortPaid(uint256 expected, uint256 received)` | `0x9de8f254` | payee delta differs from `amount` |
| `BatchTooLarge(uint256 max)` | `0xa67b9f9e` | `statesOf` with more than 256 keys |

The OpenZeppelin errors `ReentrancyGuardReentrantCall()` (`0x3ee5aeb5`), `SafeERC20FailedOperation(address)` (`0x5274afe7`), `Errors.InsufficientBalance(uint256,uint256)` (`0xcf479181`) and `Errors.FailedCall()` (`0xd6bda275`) can also surface. The compiled ABI also lists `InvalidShortString()` (`0xb3512b0c`), `StringTooLong(string)` (`0x305a27a9`) and the event `EIP712DomainChanged()`, inherited from OpenZeppelin `EIP712`; none of them can occur after construction, because the name and version are short constants and the domain never changes. Token-specific revert data, such as an EIP-3009 "invalid signature", is bubbled up unchanged. A payee contract that rejects native coin also bubbles up its own revert data.

---

## 8. Payment binding for EIP-3009 authorisations

### 8.1 Problem

An [EIP-3009] authorisation lets a token move funds on the strength of the holder's signature, with a holder-chosen 32-byte `nonce`. If the contract accepted any nonce, the party submitting the authorisation (a relayer) could attach it to a different invoice, for example its own receive card, and redirect the funds.

### 8.2 Binding nonce

The nonce of every authorisation used with `payWithAuthorization` MUST be the **payment binding**:

```text
PAYMENT_BINDING_TYPEHASH = keccak256("PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)")
                         = 0x1522042427c11deedb016d62cb8d2ed977e5ba802ccb926d4a8fa50abd9af353

nonce = keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payer, amount, payerRef, payerSalt))
```

- `key` is the invoice key ([§5](#5-invoice-key)), which already commits to `chainId` and `verifyingContract`.
- `payerRef` is a payer-chosen 32-byte reference, for example an order number. It is public and **not** unique: two payments may carry the same reference. On the EIP-3009 path the payer's signature authenticates it through the nonce; on the allowance, permit and native paths the payer sets it directly as `msg.sender`. Receipts are keyed by `(chainId, txHash, logIndex)`, never by `payerRef`. Payer clients SHOULD use `0x00…00` or a value without personal data ([§15](#15-privacy-considerations)).
- `payerSalt` is 32 random bytes (CSPRNG) that the payer client draws once per **intended payment**. It makes two intended payments of the same amount and reference by the same payer distinct. It MUST NOT be drawn again to retry the same payment: a retry resubmits the authorisation already signed ([§8.6](#86-retries-and-outstanding-authorisations)).

The value is a struct hash, not a full EIP-712 digest: it carries no `0x1901` prefix and no domain separator of its own. A settlement contract MUST expose it as `paymentNonce(key, payer, amount, payerRef, payerSalt)` (a `pure` function) and expose `PAYMENT_BINDING_TYPEHASH` as a public constant.

### 8.3 The authorisation the payer signs

The payer signs the **token's** `ReceiveWithAuthorization` typed data under the **token's** EIP-712 domain:

```text
ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)
  typehash = 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8

from        = payer
to          = verifyingContract (the PayLinkV2 deployment)
value       = amount
validAfter  = chosen by the payer client (RECOMMENDED: 0)
validBefore = chosen by the payer client (RECOMMENDED: now + 600 s)
nonce       = the payment binding (§8.2)
```

The token's domain (name, version, chainId, verifyingContract) MUST come from the token's `eip712Domain()` where implemented, otherwise from `name()` and `version()`. It MUST match the registry entry. The `fork-nightly.yml` job checks every registry token's domain, `DOMAIN_SEPARATOR` and `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` against the live chain (PAYLINK-V2-SPEC §4.3). Examples: Circle USDC on Monad testnet uses the domain name `"USDC"` and version `"2"` (**C**), and so does the ERC-20 interface of native USDC on Arc mainnet (**C**, both PAYLINK-V2-SPEC §3.4). For any other token, the domain is read from the chain, never assumed.

Only the v, r, s form of `receiveWithAuthorization` is used. Smart-account payers therefore use the allowance path, for example through [EIP-5792] `wallet_sendCalls([approve, pay])`.

**How the token checks the payer's signature.** Circle FiatToken v2.2 packs the v, r, s form as `abi.encodePacked(r, s, v)` and verifies it with its `SignatureChecker`: ECDSA when `from` has no code, ERC-1271 `isValidSignature` when it has code, including an [EIP-7702] delegation designator (**C**: circlefin/stablecoin-evm `contracts/v2/EIP3009.sol` and `contracts/util/SignatureChecker.sol`, read on 2026-10-07). This is the dispatch of [§6.3](#63-contract-payees-erc-1271) applied to the payer. Consequently:

- an EOA with an active EIP-7702 delegation is a smart-account payer for this purpose: its authorisation settles only if its delegate accepts the raw ECDSA signature over the digest, which delegates that wrap the hash in their own domain do not. Payer clients MUST classify a payer whose code is non-empty, including code starting with `0xef0100`, as a smart account and route it to the allowance path;
- relayers MUST verify the payer's signature with the same dispatch (`eth_getCode(payer)`, then ERC-1271 for any code), never with local ECDSA alone ([§13.3](#133-relayers));
- the `fork-nightly.yml` job SHOULD record the dispatch observed on every registry token as a behaviour check (planned).

### 8.4 What the contract enforces

`payWithAuthorization(inv, payeeSig, auth)` MUST:

1. apply the predicate of [§7.2](#72-payability-predicate) with `payer = auth.payer` and `amount = auth.amount`;
2. recompute `nonce = paymentNonce(key, auth.payer, auth.amount, auth.payerRef, auth.payerSalt)` on-chain;
3. call `token.receiveWithAuthorization(auth.payer, address(this), auth.amount, auth.validAfter, auth.validBefore, nonce, auth.v, auth.r, auth.s)`;
4. apply the exactness checks of [§7.5](#75-exactness-and-conservation) and forward exactly `amount` to `inv.payee`.

### 8.5 Resulting guarantees

- **No redirect.** If anything in `(key, payer, amount, payerRef, payerSalt)` differs from what the payer signed, the recomputed nonce differs, and the token rejects the signature. Changing the invoice changes `key`, and changing the chain or the contract changes `key` too.
- **No bypass through the token.** EIP-3009 `receiveWithAuthorization` requires the caller to equal `to`. Only the deployment can consume the authorisation, and only through the check above.
- **Anyone may submit.** A relayer, the payer or any third party can submit the same authorisation with the same effect. Submission order cannot change the outcome; at most one submission succeeds, because the token marks the nonce as used.
- **Bounded delay.** A relayer can withhold an authorisation, but only until `validBefore`. Payer clients SHOULD keep that window short and MUST offer self-submission of the same authorisation ([§13.2](#132-payer-clients)).
- **Payer revocation.** Before submission, the payer can revoke an unused authorisation with the token's `cancelAuthorization`, where the token implements it.
- **No deduplication across authorisations.** The contract keeps no record of authorisations, only of payments: two authorisations for the same invoice with different `payerSalt`s are two payments wherever `maxPayments ≠ 1`. A withheld authorisation therefore stays dangerous to a client that retries by signing again; [§8.6](#86-retries-and-outstanding-authorisations) makes retries safe.

### 8.6 Retries and outstanding authorisations

A payment is retried when it seems slow or lost, and that is usually because the relayer is slow, not because a transaction failed. The first authorisation is then still valid until its `validBefore`, and the relayer, which is trusted for availability only ([§14.8](#148-relayer-trust)), decides whether it lands. If the client meanwhile re-signs with a new `payerSalt`, or pays through `payWithPermit` or `pay`, both payments settle on a receive card, an open-amount till or an N-seat link, and nothing on-chain refunds the payer. One-off invoices (`maxPayments = 1`) are immune, because the second payment reverts with `SoldOut`; the rules below apply to every invoice anyway, so that clients need no special case.

An authorisation is **outstanding** from the moment the payer signs it until it is **consumed** (`authorizationState(payer, nonce)` is true) or **expired** (chain time is at or past `validBefore` and it is still unused). Block timestamps never decrease, so once the latest block's timestamp reaches `validBefore`, no later block can include it.

A payer client:

1. MUST persist the full relay body ([§11.2](#112-definitions), `RelayPayRequest`) in device storage, keyed by `(chainId, key, payer)`, **before** sending it to a relayer or submitting it, and keep it until the authorisation is consumed or expired. A page reload, a crash or a second tab then finds it instead of signing again.
2. MUST retry an outstanding authorisation only by resubmitting that same body, to the relayer or by self-submission. A reverted submission does not consume the token nonce, and the token settles at most one copy, so resubmission is idempotent.
3. MUST NOT sign another authorisation for the same invoice and payer while one is outstanding.
4. MUST NOT offer `payWithPermit`, `pay` (approve-and-pay) or an EIP-5792 batch for the invoice while an authorisation for it is outstanding, unless the payer first cancels it with the token's `cancelAuthorization(payer, nonce, v, r, s)` and that transaction is mined with status 1 and emits `AuthorizationCanceled(payer, nonce)`; or until it has expired. A cancellation that reverts (typically "authorization is used or canceled", because the relayer landed the payment first) is not a cancellation: the authorisation was consumed by a payment.
5. MUST treat a consumed authorisation that it did not cancel itself as a payment that went through: show it as paid, verify the receipt ([§12](#12-receipt-verification)), and sign a new authorisation for the same invoice only when the user explicitly starts another payment.
6. SHOULD keep `validBefore` short (RECOMMENDED: now + 600 s, [§8.3](#83-the-authorisation-the-payer-signs)), which keeps the lock in rules 3 and 4 short.

| Outstanding authorisation | Relayed retry | Self-submission | New signature | Permit, approve-and-pay |
|---|---|---|---|---|
| none | — | — | allowed | allowed |
| live (unused, before `validBefore`) | the same body | the same body | **no** | **no** (cancel first) |
| consumed, cancelled by this client | — | — | allowed | allowed |
| consumed otherwise | — | — | only as a new payment, on explicit request | only as a new payment |
| expired (unused, at or after `validBefore`) | — | — | allowed | allowed |

The reference SDK implements these rules (`packages/sdk/src/attempts.ts`): `authorizePayment` requires the outstanding authorisation's assessment and refuses while one is live, and the payment router offers only resubmission and withholds the other paths.

---

## 9. Cancellation

### 9.1 Direct cancellation

`cancel(Invoice inv)` MUST revert with `NotPayee()` unless `msg.sender == inv.payee`. It sets `cancelled = true` for `key(inv)` and emits `InvoiceCancelled(bytes32 indexed key, address indexed payee)`.

### 9.2 Signed cancellation

`cancelBySig(Invoice inv, uint256 deadline, bytes payeeSig)` lets any party relay a payee's cancellation, so a payee without gas can cancel. The payee signs, under the PayLink domain of [§4](#4-eip-712-domain):

```text
Cancel(bytes32 key,uint256 deadline)
  CANCEL_TYPEHASH = 0x9e17c698745faeba552ac9e0fa17b141be25ab98edd4766f24b1054263080465

cancelDigest = keccak256(0x1901 ‖ domainSeparator ‖ keccak256(abi.encode(CANCEL_TYPEHASH, key, deadline)))
```

A settlement contract MUST apply these checks in this order:

1. the shape rules of [§7.2](#72-payability-predicate) #1, else `InvalidInvoice()`;
2. `now ≤ deadline`, else `SignatureExpired(deadline)`;
3. the key is not already cancelled, else `Cancelled()`;
4. `payeeSig` is valid over `cancelDigest` for `inv.payee`, with the dispatch of [§6](#6-payee-signature), else `InvalidSignature()`.

It then sets `cancelled = true` and emits `InvoiceCancelled`, as in [§9.1](#91-direct-cancellation). Direct `cancel` applies the shape rules, then `NotPayee()`, then `Cancelled()`. Sold-out and expired invoices can still be cancelled.

Issuers SHOULD use a short deadline (RECOMMENDED: 1 hour). A cancellation signature reveals nothing that the invoice did not already reveal.

### 9.3 Irreversibility

Cancellation is permanent. No function clears `cancelled`. A cancelled key never records another payment (invariant I4), and a second cancellation of the same key MUST revert with `Cancelled()`. To "reopen" an invoice, the payee signs a new invoice with a new salt.

### 9.4 Scope

Cancellation is per deployment. An invoice signed for deployment A cannot be paid through deployment B in any case, because the keys differ. After an incident redeploy, invoices that are still open on the old deployment SHOULD be cancelled there, or the clients SHOULD stop offering that deployment ([incident response](../security/incident-response.md)).

---

## 10. URL encodings

### 10.1 Principles

- The payload lives **only in the URL fragment** (after `#`). User agents do not send the fragment to servers [RFC 3986 §3.5], so the hosting origin never sees invoices or receipts. Issuers MUST NOT put invoice data in the path or the query.
- The origin and path (for example `https://<app>.pages.dev/<edition>/pay/`) are deployment choices and are not signed. The fragment grammar below is the normative part.
- There is no compression. Every field has a fixed or capped length, and decoding is strict.

### 10.2 Invoice URL

```text
https://<app>.pages.dev/<edition>/pay/#2.<chainId>.<inv>.<sig>[.<memo>]
```

| Segment | Content |
|---|---|
| `2` | the wire-format version token |
| `<chainId>` | decimal EIP-155 chain ID |
| `<inv>` | base64url of the 140-byte packed invoice ([§10.4](#104-packed-invoice)) |
| `<sig>` | base64url of the payee signature: 65 bytes for an EOA, 1 to 512 bytes for ERC-1271 |
| `<memo>` | base64url of the memo's UTF-8 bytes, 1 to 280 bytes. Present **if and only if** `memoHash ≠ 0x00…00`. |

### 10.3 Grammar

[ABNF] (RFC 5234). `ALPHA` and `DIGIT` are the core rules.

```abnf
invoice-fragment = version "." chain-id "." inv "." sig [ "." memo ]
receipt-fragment = version "." chain-id "." tx-hash "." log-index
                   [ "." inv "." sig [ "." memo ] ]

version   = "2"
chain-id  = NZDIGIT 0*15DIGIT          ; value in [1, 2^53 - 1]
log-index = "0" / NZDIGIT 0*15DIGIT    ; value in [0, 2^53 - 1]
tx-hash   = "0x" 64LHEX                ; lowercase only

inv       = 187B64                     ; exactly 140 octets
sig       = 2*683B64                   ; 1 to 512 octets
memo      = 2*374B64                   ; 1 to 280 octets

B64       = ALPHA / DIGIT / "-" / "_"
NZDIGIT   = %x31-39
LHEX      = DIGIT / %x61-66
```

The whole fragment, without the leading `#`, MUST be at most **1,200 characters**. A 512-byte ERC-1271 signature (683 characters) and a 280-byte memo (374 characters) cannot both fit. Issuers MUST check the encoded length before sharing, and SHOULD shorten the memo when it is too long.

### 10.4 Packed invoice

The packed invoice is the eight fields in declaration order, big-endian, with no padding and no length prefixes:

| Offset | Length | Field |
|---|---|---|
| 0 | 20 | `payee` |
| 20 | 20 | `token` |
| 40 | 16 | `amount` |
| 56 | 8 | `validAfter` |
| 64 | 8 | `validUntil` |
| 72 | 4 | `maxPayments` |
| 76 | 32 | `salt` |
| 108 | 32 | `memoHash` |
| **140** | | total |

This packing is a transport encoding only. It is never hashed. The key is always computed from the decoded fields with `abi.encode` ([§5](#5-invoice-key)).

### 10.5 Strict decoding

A decoder MUST perform the following steps in this order, and MUST reject the input at the first failure. The symbolic error names are informative; implementations SHOULD expose them as distinct error codes, so that the user interface can explain each one.

1. **Length first.** If the fragment is longer than 1,200 characters, reject (`E_FRAGMENT_TOO_LONG`) before any other processing.
2. **Character set.** Every character MUST be in `[A-Za-z0-9._-]`. In particular, a decoder MUST NOT percent-decode, trim whitespace or change case (`E_FRAGMENT_CHARSET`).
3. **Segments.** Split on `.`. An invoice fragment has 4 or 5 segments, and no segment may be empty (`E_SEGMENT_COUNT`).
4. **Version.** Segment 1 MUST be exactly `2`. Clients SHOULD tell the user that other values need a different application version (`E_VERSION_UNSUPPORTED`).
5. **Chain.** Segment 2 MUST match `chain-id`. The value MUST be at most `2^53 − 1` (`E_CHAIN_ID_FORMAT`) and MUST have a canonical deployment in the registry (`E_CHAIN_UNKNOWN`).
6. **base64url.** Each base64url segment MUST use only the alphabet of [RFC 4648] §5, MUST NOT contain `=` padding, MUST NOT have a length congruent to 1 modulo 4, and MUST be canonical: the unused low-order bits of the last character MUST be zero (`E_BASE64URL`).
7. **Invoice length.** `inv` MUST decode to exactly 140 bytes (`E_INVOICE_LENGTH`).
8. **Signature length.** `sig` MUST decode to 1 to 512 bytes (`E_SIGNATURE_LENGTH`). The 65-byte requirement for EOAs is enforced during verification ([§6.2](#62-eoa-payees)).
9. **Memo presence.** A memo segment MUST be present exactly when `memoHash ≠ 0x00…00` (`E_MEMO_PRESENCE`).
10. **Memo content.** The memo MUST decode to 1 to 280 bytes (`E_MEMO_LENGTH`), MUST be well-formed UTF-8 under a fatal decoder (`E_MEMO_UTF8`), and MUST satisfy `keccak256(bytes) = memoHash` (`E_MEMO_HASH`).
11. **Shape.** Apply the rules of [§3.1](#31-fields), including the uint53 rule, with `verifyingContract` taken from the registry (`E_INVOICE_SHAPE`, `E_UINT53_RANGE`).
12. **Token.** `token` MUST be in the registry allowlist for the chain and the client's edition (`E_TOKEN_UNKNOWN`).

Encoding the decoded value again MUST give back the input byte for byte. The reference SDK checks this round trip with property-based tests (fast-check). A decoder never fetches anything. Signature and state checks come afterwards ([§13.2](#132-payer-clients)).

### 10.6 Receipt URL

```text
https://<app>.pages.dev/<edition>/r/#2.<chainId>.<txHash>.<logIndex>[.<inv>.<sig>[.<memo>]]
```

- `<txHash>` is the transaction hash, written as `0x` followed by 64 lowercase hexadecimal digits.
- `<logIndex>` is the block-level log index of the `Paid` event, in decimal.
- The optional tail carries the paid invoice, so that the verifier can show its terms and memo. Its segments follow the rules of [§10.5](#105-strict-decoding) steps 6 to 12.
- The fragment limit of 1,200 characters applies. If the tail would exceed it, the encoder MUST omit the whole tail.
- A receipt fragment has 4, 6 or 7 segments. Steps 1 to 5 of [§10.5](#105-strict-decoding) apply unchanged; `<txHash>` MUST match `tx-hash` and `<logIndex>` MUST match `log-index` (`E_RECEIPT_FORMAT`).
- Receipts are identified by `(chainId, txHash, logIndex)`. That triple is unique for a `Paid` event; `payerRef` is not.

---

## 11. JSON representation

Signed invoices, payment authorisations, cancellation authorisations, relayer requests and receipt references have a canonical JSON form, defined by [`paylink-invoice-v2.schema.json`](paylink-invoice-v2.schema.json) (JSON Schema draft 2020-12). It is used for device export and import, for relayer request bodies, and for test fixtures.

### 11.1 Encoding rules

- `uint128` and `uint256` values are **decimal strings**, because JSON numbers lose precision above `2^53`.
- `uint64` time values are JSON integers within the uint53 range ([§3.1](#31-fields)). `uint32` values are integers.
- Addresses are `0x`-prefixed hexadecimal. Producers MUST write [EIP-55] checksummed addresses, and consumers MUST verify the checksum of any mixed-case address. A schema validator cannot check EIP-55, so the SDK does it.
- `bytes32` values and signatures are `0x`-prefixed **lowercase** hexadecimal.
- Objects reject unknown properties.

Beyond structure and ranges, the schema enforces three rules of this document: `payee` is not the zero address, `memoHash` is not `keccak256("")` ([§3.1](#31-fields)), and a `SignedInvoice` carries `memo` exactly when `memoHash ≠ 0x00…00` ([§10.5](#105-strict-decoding) step 9). Consumers MUST still apply the rules that a schema cannot express: EIP-55 checksums, the 280-byte UTF-8 limit and the hash of the memo, the upper bounds of decimal strings, the shape rules that involve `verifyingContract` or compare two fields, and the recomputation of `key`.

### 11.2 Definitions

| Schema definition | Use |
|---|---|
| `SignedInvoice` (the schema's root) | Device export and import; sharing outside a URL |
| `Invoice` | The eight fields of [§3.1](#31-fields), embedded in the other objects |
| `PaymentAuthorization` | The payer's EIP-3009 signature fields of [§8.3](#83-the-authorisation-the-payer-signs). It carries no `nonce`: the nonce is always recomputed ([§8.2](#82-binding-nonce)) |
| `RelayPayRequest` | Body of a relayer's `POST /v1/{chainId}/pay` |
| `CancelAuthorization` | A payee-signed cancellation ([§9.2](#92-signed-cancellation)); also the body of a relayer's `POST /v1/{chainId}/cancel` |
| `ReceiptReference` | The `(chainId, txHash, logIndex)` triple of [§12](#12-receipt-verification) |

A relayer MUST reject a request body whose `chainId` differs from the chain named in the request path, and then applies [§13.3](#133-relayers). Payer clients MUST NOT send the memo to a relayer; it is not needed for settlement.

### 11.3 Example

The test vector of [§17.3](#173-example-invoice):

```json
{
  "version": 2,
  "chainId": 10143,
  "invoice": {
    "payee": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "token": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    "amount": "25000000",
    "validAfter": 1791158400,
    "validUntil": 1791763200,
    "maxPayments": 1,
    "salt": "0xf5b34bf6f093a9e7f2275058fccc4b4c517ce2b35455c8f6908d9cff07c148d5",
    "memoHash": "0x9e4171ef418f2c980507bfa20f7262b37301d7ffd5d6ef27634ca2d85d6b7041"
  },
  "payeeSig": "0x9b15ca287effb6724dbbdc508dc3f8418c1c51e38c7df32be3da03a1487de3615537f23f136bfa824748e8a730f38c4ad407223d8f6fd1e9b9ac4309cd6dd1b41b",
  "memo": "Logo design, invoice #12",
  "key": "0x7c3bfd66020e278626ebe781b4d26210c763273be3b3c2be4f90bb1631df15df"
}
```

`key` is OPTIONAL and redundant. When it is present, a consumer MUST recompute it with the registry's `verifyingContract` and reject the object on a mismatch.

---

## 12. Receipt verification

A receipt verifier proves that a specific `Paid` event exists on a canonical deployment and that it matches what the receipt claims. Input: `(chainId, txHash, logIndex)` and, optionally, a signed invoice and memo.

1. **Chain and deployment.** `chainId` MUST be in the registry. Let `A` be its canonical deployment address.
2. **Receipt.** Fetch `eth_getTransactionReceipt(txHash)` from a registry RPC endpoint. It MUST exist and have `status = 0x1`.
3. **Log.** Select the log whose `logIndex` equals the given value. If there is none, reject. The log MUST satisfy:
   - `address = A` (compared as 20-byte values);
   - `topics.length = 4` and `topics[0] = 0xca30d10d6510d85eb6fa9e2f49f80fc8e789aac9619c3000f100dfa51fd7b31d`, which is `keccak256("Paid(bytes32,address,address,address,uint128,uint32,bytes32)")`;
   - `data` is exactly 128 bytes and decodes as `(address token, uint128 amount, uint32 index, bytes32 payerRef)`, with no dirty high-order bits in any word.
4. **Decoded fields.** `key = topics[1]`, `payee = topics[2]` and `payer = topics[3]`. The address topics MUST have zero high-order 12 bytes.
5. **Invoice match (when an invoice is supplied).** Decode it as in [§10.5](#105-strict-decoding). Then require `invoiceKey(inv) = key` (computed locally with `A` and `chainId`), `inv.payee = payee` and `inv.token = token`, and, if `inv.amount ≠ 0`, `amount = inv.amount`. If a memo is supplied, it MUST hash to `inv.memoHash`.
6. **Finality.** Report the block number, and the block timestamp from `eth_getBlockByNumber`. Where the chain supports the `finalized` block tag, report "finalized" only when the receipt's block is at or below it, and "confirmed" otherwise.
7. **Result.** Report `valid` only when steps 1 to 5 succeed. Show token amounts with the registry's decimals.

Notes:

- The payee signature was checked by the contract at payment time, and the event proves that. A verifier MUST NOT treat a payee signature that fails later as invalidating the receipt: ERC-1271 validity can change over time ([§6.3](#63-contract-payees-erc-1271)).
- Indexer data MUST NOT replace steps 2 to 4. An indexer is a cache ([ADR 0009](../adr/0009-read-model-chain-device-indexer.md)).
- A verifier MUST display what the receipt proves: the payee, the token and amount, and the invoice when one is attached. It MUST NOT display a bare "valid": a genuine receipt for a different payee, a smaller amount or another invoice is a classic counter fraud ([THREAT_MODEL T-43](../security/THREAT_MODEL.md#t-43)).
- Verifiers SHOULD use more than one registry RPC when available. Cross-checking a receipt on two RPC endpoints is planned (tier T2; [THREAT_MODEL T-16](../security/THREAT_MODEL.md#t-16)).

---

## 13. Client requirements

### 13.1 Issuers

- MUST generate `salt` with a CSPRNG for every invoice.
- MUST check that the payee is an EOA (`eth_getCode` empty) or a deployed contract, and MUST refuse counterfactual smart-account payees ([§6.3](#63-contract-payees-erc-1271)).
- SHOULD set `validUntil` by default (7 days for one-off invoices) and MUST obtain explicit confirmation before signing `validUntil = 0`.
- MUST show, before the passkey or wallet prompt, exactly what is being signed: amount and token, payee address grouped in fours, expiry, number of payments, network. This is the SigningDisplay of the reference client.
- MUST verify the produced signature locally before sharing, and MUST check the 1,200-character limit.
- SHOULD warn when the payee's code starts with `0xef0100` ([§6.4](#64-eip-7702-delegated-payees)).

### 13.2 Payer clients

- MUST decode strictly ([§10.5](#105-strict-decoding)) and MUST take `verifyingContract` from the registry ([§4.2](#42-resolving-verifyingcontract)).
- MUST show four independent checks before enabling payment, and MUST disable payment when any of them fails:
  1. **Signature valid:** [§6](#6-payee-signature), with the same dispatch as the contract;
  2. **Right network:** the connected account is on `chainId`;
  3. **Genuine contract:** the registry address and, where supported, the masked code-hash check;
  4. **Still payable:** not cancelled, within the time window by chain time, not sold out (`stateOf`).
- MUST state that a valid signature proves only which **address** signed. MUST show the payee address in full, grouped in fours. SHOULD show the user's saved address-book label, and MUST show a distinct warning for a first payment to an address.
- MUST treat the memo as untrusted text from the sender: remove Unicode bidirectional controls (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C) and C0/C1 control characters before display, render it as text and never as markup, and label it as a note from the sender.
- MUST request an ERC-20 allowance equal to the payment amount, never an unlimited allowance.
- MUST offer self-submission ("pay with your own gas") of the **same** authorisation whenever a relayer is used or unavailable ([§8.5](#85-resulting-guarantees)).
- SHOULD send to a relayer only an authorisation and an invoice that stay valid beyond the chain's relay margin ([§13.3](#133-relayers)); a relayer refuses anything else, and the client then self-submits or, once the authorisation has expired, signs a new one ([§8.6](#86-retries-and-outstanding-authorisations)).
- MUST apply the retry rules of [§8.6](#86-retries-and-outstanding-authorisations): persist the signed authorisation before sending it; retry only by resubmitting it; offer a new signature, permit or approve-and-pay for the same invoice only once it is cancelled on the token or expired; treat a consumed one as paid.
- MUST classify a payer whose code is non-empty (a smart account, or an EOA with an EIP-7702 delegation) as a smart-account payer and route it to the allowance path ([§8.3](#83-the-authorisation-the-payer-signs)).
- MUST NOT accept RPC, relayer or indexer endpoints from the URL. Endpoints come from same-origin configuration only.
- SHOULD refuse to enable payment when the page is framed (`top !== self`).
- MUST copy addresses and links to the clipboard from canonical state, never from rendered text.

### 13.3 Relayers

- MUST accept only `payWithAuthorization` and `cancelBySig` calls with `value = 0` to a canonical deployment.
- MUST verify the payee signature and recompute the binding nonce locally, then simulate with `eth_call`, before sending.
- MUST verify the payer's EIP-3009 signature with the token's dispatch ([§8.3](#83-the-authorisation-the-payer-signs)): ERC-1271 for a payer with code, ECDSA only for a payer without.
- MUST set an explicit gas limit within the registry's floor and ceiling for the function and the chain. Some chains charge the gas limit rather than the gas used; Monad does (**C**, PAYLINK-V2-SPEC §2.1).
- MUST, before simulating, refuse a call any of whose time bounds ends within the chain's **relay margin** `M` (the registry's `relay.minRemainingSeconds`; 120 s on every v2 chain until measured): with `now` the timestamp of the block it simulates against, the call MUST still pass its time bounds in a block stamped `now + M`. For `payWithAuthorization` that means `validBefore − 1 ≥ now + M` (the token requires `now < validBefore`) and, when `validUntil ≠ 0`, `validUntil ≥ now + M`; for `cancelBySig`, `deadline ≥ now + M`. `M` MUST be at least the worst-case delay from simulation to inclusion, fee-bump replacements included, and SHOULD stay well below the recommended authorisation window of [§8.3](#83-the-authorisation-the-payer-signs). A relayer SHOULD check the margin again against the pending block's timestamp right before broadcasting. Without the margin, a bound one second ahead passes every check and `eth_call` and reverts in any later block, and the party that chose it sends no transaction at all: the payer chooses `validBefore` alone, a requester can pick an invoice's last second, and anyone can sign a throwaway cancellation with `deadline = now`.
- MUST NOT rely on the simulation alone. A call that passes `eth_call` can revert on inclusion at the relayer's expense: the payee's `isValidSignature` is evaluated again at execution (and can depend on the block or on state the payee controls), an EOA payee can `cancel` the invoice, a payer can set an EIP-7702 delegation, spend its balance or cancel its authorisation on the token, and the same authorisation can land first through another submitter. The authorisations stay unconsumed, so such requests can be replayed. A relayer therefore:
  - MUST bound what it keeps in flight, so that one action by one party reverts at most one paid call: RECOMMENDED at most 1 per invoice key, 1 per payee and 1 per payer, and a small number per token (the reference policy uses 4);
  - MUST, when a call reverts after its simulation passed, **attribute the revert by its cause** from chain evidence at the inclusion block, and penalise only the party the evidence names: never a payee or an invoice for a payer-side failure, never a payer for a payee-side one. The evidence, in order:
    1. *superseded*: the token's `authorizationState(payer, nonce)` is spent and, in the transaction that spent it, `AuthorizationUsed(payer, nonce)` immediately follows the deployment's `Paid` for the same `(key, payee, payer, token, amount, payerRef)` (PayLinkV2 emits `Paid` and then calls the token); for a cancellation, the key is cancelled. The payment or cancellation happened, typically through the payer's own resubmission ([§8.6](#86-retries-and-outstanding-authorisations)) or a copy of the relayer's calldata: nobody is penalised;
    2. *late inclusion*: the including block's timestamp is past the call's last valid second although the margin held at admission. This is the relayer's own latency: nobody is penalised, and the operator SHOULD raise `M` for that chain;
    3. *payer*: the nonce is spent otherwise (cancelled on the token, or used by another authorisation of the payer), the payer's code changed, or the token reverts for the payer's signature or balance;
    4. *payee*: the payee's code changed, the invoice is cancelled, or PayLinkV2 reverts `InvalidSignature`;
    5. *sold out*: PayLinkV2 reverts `SoldOut`, a race that names no party;
    6. *token*: the token is paused or blocks an account (an issuer action);
    7. *unattributed*: anything else, contradictory evidence, or no revert data.

    The relayer obtains the revert data from a trace of the mined transaction where its RPC offers one, otherwise by replaying the call at the inclusion block. It MUST then stop relaying, for a period (RECOMMENDED: 24 hours), for the payer on a *payer* cause; for the payee and the invoice key on a *payee* cause; for the invoice key on a *sold out* cause; and for the invoice key, and the payee or the payer only if it has code, on an *unattributed* cause. It MUST count *payer*, *payee* and *unattributed* reverts against the requester, keyed by IPv4 address or by IPv6 /64 prefix (one IPv6 subscriber holds a whole /64), and SHOULD refuse a requester for that period after a few of them (the reference policy uses 3);
  - SHOULD limit the relays it accepts per requester over time, successful ones included, since they cost gas as well (the reference policy: 20 an hour, a call dropped before inclusion given back);
  - SHOULD relay for payees with code only when the code hash is on an allowlist of wallets known to answer ERC-1271 consistently, and SHOULD NOT relay for payers with code; those payments fall back to self-submission or the allowance path;
  - SHOULD simulate again against the pending block immediately before broadcasting. This narrows the window but does not close it, so it never replaces the rules above;
  - SHOULD keep a daily gas budget, which caps the monetary loss of what the rules above do not prevent.

  The reference policy is `RelayAdmissionLedger` in `packages/sdk/src/relay-admission.ts` with `checkRelayPayRequest` and `checkRelayCancelRequest` (margin) and `attributeRelayRevert` (attribution) in `packages/sdk/src/relayer.ts` and `packages/sdk/src/relay-attribution.ts`. The cases it must withstand are pinned on the compiled contract by `protocol/test/audit/A02_RelayerGriefing.t.sol` and `protocol/test/audit/A04_TimeBoundaryBan.t.sol`, and in the SDK by `packages/sdk/test/audit/A04-time-boundary-ban.test.ts`, `packages/sdk/test/relay-attribution.test.ts` and the anvil suite.
- Are trusted for availability only. They can delay or refuse a payment, but cannot redirect it ([§8.5](#85-resulting-guarantees)). Because they decide whether a withheld authorisation lands, payer clients follow [§8.6](#86-retries-and-outstanding-authorisations) when they retry.

### 13.4 Payment-arrival displays

A client that signals the arrival of a payment, such as the reference client's till, is relied on at a counter to hand over goods. It:

- MUST change its signal (LED, sound) only for a `Paid` event that passed the verification of [§12](#12-receipt-verification);
- MUST, when a specific invoice is armed (displayed for payment), signal only for that invoice's `key`, and for a fixed invoice only for `amount = inv.amount`;
- MUST show the received amount next to the signal, in large digits, for open-amount invoices and receive cards, where any payment of any amount produces a `Paid` event for the payee ([THREAT_MODEL T-44](../security/THREAT_MODEL.md#t-44));
- MUST NOT present a duration it did not measure. Its log queries MUST stay within the block-range caps of the registry RPCs.

---

## 14. Security considerations

The full threat model is in [`docs/security/THREAT_MODEL.md`](../security/THREAT_MODEL.md). This section lists the considerations that every implementer of the format must know.

### 14.1 Replay across chains, contracts and versions

Every signature in this format (invoice, cancellation, and the payment binding through `key`) is bound to `chainId` and `verifyingContract` through the EIP-712 domain, and to the version through the domain's `version` string. A signature for one deployment never verifies under another (invariant I7). Within a deployment, `maxPayments` and the token's single-use nonces bound the number of payments.

### 14.2 Signature malleability

ECDSA signatures are restricted to low `s`, so each ECDSA signature has exactly one valid encoding. ERC-1271 signatures may be malleable, but no state is keyed by a signature: state is keyed by `key`. Malleability therefore cannot cause double payment.

### 14.3 Bearer semantics

An invoice does not name its payer. Anyone holding the link can pay it, and anyone can submit a valid authorisation. A third party that pays a one-off invoice first uses it up; the payee is paid either way. Payer clients MUST present "sold out" as "already paid" and MUST NOT ask for a second payment.

### 14.4 Phishing and look-alike addresses

A signature proves control of an address, not identity. An attacker can generate an address whose first and last characters match a victim's. Mitigations: show the full address grouped in fours, address-book labels, the first-payment warning, and never truncate an address in the payment view. Printed receive cards can be swapped physically (QR overlay fraud); the payer's client still shows the full address and any saved label.

### 14.5 Contract substitution

Because `verifyingContract` comes from the registry ([§4.2](#42-resolving-verifyingcontract)), a link cannot direct a payer to a malicious contract. A compromised registry or web origin defeats this. That is why the origin is dedicated, the Content Security Policy is strict, and releases record the deployment's `initCodeHash` ([ADR 0005](../adr/0005-dedicated-origin-and-rpid.md)).

### 14.6 Salt quality and key collisions

Two invoices with identical fields have the same key and share one state: a second "identical" invoice would look already paid. A 32-byte CSPRNG salt makes accidental collisions negligible. A weak salt also lets an observer enumerate a payee's unpublished invoices, which can matter for privacy.

### 14.7 Long-lived links

Receive cards (`validUntil = 0`, `maxPayments = 0`) stay payable until cancelled. Leaked one-off invoices stay payable until they expire or are cancelled. Default expiries, explicit confirmation for `validUntil = 0`, and gasless cancellation ([§9](#9-cancellation)) mitigate this.

### 14.8 Relayer trust

Relayers can censor or delay within `validBefore`, but cannot redirect funds or change amounts ([§8.5](#85-resulting-guarantees)). Payer clients keep `validBefore` short and always offer self-submission of the same authorisation. A relayer that delays rather than refuses still decides whether a withheld authorisation lands; a client that re-signed or switched path meanwhile would pay twice on a multi-payment invoice, which [§8.6](#86-retries-and-outstanding-authorisations) prevents.

### 14.9 Front-running

- **Permit:** a griefer can submit a payer's EIP-2612 permit first. The contract calls `permit` inside `try/catch` and continues with the allowance, so the griefing has no effect.
- **EIP-3009:** only the deployment can call `receiveWithAuthorization` with itself as `to`. A front-runner that submits the authorisation to the deployment produces exactly the intended payment.

### 14.10 Token behaviour

Fee-on-transfer and rebasing tokens fail the exactness checks or are unsupported. Issuer-controlled tokens such as USDC can block addresses or pause; a blocked payee or payer makes the payment revert, and no funds are lost. Payer clients offer registry-allowlisted tokens only.

### 14.11 ERC-1271 payees

A malicious or buggy ERC-1271 payee can spend gas or revert. On-chain that affects only payments to that payee. It also affects the **relayer**: the payee's answer at inclusion can differ from its answer at simulation, so it can make relayed calls revert at the relayer's expense, and an EOA payee can do the same by cancelling an invoice under queued relays. Relayers bound this and penalise only the party the evidence names, as [§13.3](#133-relayers) requires. Changes of wallet owners or policy can invalidate earlier invoices ([§6.3](#63-contract-payees-erc-1271)).

### 14.12 Time

Validity windows use the block timestamp. Block producers can shift it slightly, which matters only at the window edges. The bounds are inclusive at both ends. Clients use chain time, not device time, for "Still payable". A bound that ends just after the block a relayer simulated against passes the simulation and fails on inclusion, so relayers require a margin on every bound they forward ([§13.3](#133-relayers)).

### 14.13 Decoder resource use

The 1,200-character cap is checked before any decoding. There is no compression, every length is fixed or capped, and decoding does no network access. Malformed links therefore cost a bounded amount of work.

### 14.14 Arithmetic bounds

`total` is a `uint128` and `payments` is a `uint32`. Reaching either bound reverts further payments to that key. Neither bound is reachable with real token supplies or realistic volumes, and the behaviour is documented rather than handled.

### 14.15 Stray funds

Tokens or coins sent to the deployment outside a payment cannot be recovered, because there is no owner. The deployment never relies on its balance ([§7.5](#75-exactness-and-conservation)).

---

## 15. Privacy considerations

- **Fragments stay on the device.** The invoice and receipt payloads are not sent to the hosting origin. Anyone who can read the message that carries the link, such as the messaging service or a shared device, can read the invoice, including its memo.
- **Settlement is public.** Paying or cancelling an invoice publishes its eight fields, minus the memo text, in calldata, and publishes `payerRef` in the `Paid` event.
- **`memoHash` is not hiding.** It is an unsalted `keccak256` of the memo. Anyone who sees the calldata can confirm a guessed low-entropy memo ("Invoice #12"). Memos MUST NOT contain secrets, and SHOULD NOT contain personal data.
- **Addresses link activity.** All invoices of one payee address are publicly linkable. The reference client's trust line ("N payments received since …") uses exactly this public history. Payees who want separation should use separate addresses.
- **No server-side store.** The reference deployment keeps signed invoices, memos, contacts and receipts in the device's IndexedDB only, and runs no analytics ([ARCHITECTURE §7](../ARCHITECTURE.md#7-data-and-privacy)).

---

## 16. Versioning and extensibility

- The version token `2` identifies this wire format **and** the EIP-712 domain version `"2"`. Changing any type string, the domain, the binding type hash, the packed layout or the grammar requires a new version token and a new domain version, and therefore a new deployment.
- Decoding is strict, so a v2 decoder rejects any extension. That is deliberate: a payer must never pay a link that the client only partly understood.
- A future version may add a relayed path for tokens without EIP-3009, with a payer-signed `PayIntent(bytes32 key,uint128 amount,bytes32 payerRef,uint256 deadline)` (PAYLINK-V2-SPEC §9, Mezo wave 2 option a). It would be a new deployment under the same rules.
- Document versions follow semantic versioning. A patch is an editorial change. A minor version adds informative content or client requirements that leave the wire format unchanged. A major version changes the wire format.

---

## 17. Test vectors (informative)

The **normative** golden vectors are generated by the Solidity reference implementation into `protocol/test/vectors/{eip712,nonce,cancel}.json`, and the SDK must reproduce them byte for byte (Vitest). The values below come from three independent implementations that agree: ethers 6.17.0, Foundry `cast` 1.8.5, and the compiled `PayLinkV2` itself. `protocol/test/vectors/SpecExamples.t.sol` deploys the contract exactly as §17.3 describes and asserts every literal value of §7.6 and §17, so CI fails if this document and the contract ever diverge. The three were last re-run together on 2026-10-07.

### 17.1 Type hashes and event topics

| Name | Value |
|---|---|
| `EIP712Domain` type hash | `0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f` |
| `INVOICE_TYPEHASH` | `0x8b0d4e92e431b40f1455755e745c6d48d699d52b9a141b56f0a079793050708e` |
| `CANCEL_TYPEHASH` | `0x9e17c698745faeba552ac9e0fa17b141be25ab98edd4766f24b1054263080465` |
| `PAYMENT_BINDING_TYPEHASH` | `0x1522042427c11deedb016d62cb8d2ed977e5ba802ccb926d4a8fa50abd9af353` |
| EIP-3009 `ReceiveWithAuthorization` type hash | `0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8` |
| `Paid` topic 0 | `0xca30d10d6510d85eb6fa9e2f49f80fc8e789aac9619c3000f100dfa51fd7b31d` |
| `InvoiceCancelled` topic 0 | `0x881d07924d83735d00c06370239f77e65622c5033b00ccd03a9358be68de819d` |
| `keccak256("")`, which issuers must never use as a `memoHash` | `0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470` |

### 17.2 Selected function selectors

Derived from PAYLINK-V2-SPEC §3.3.2 and identical to the `methodIdentifiers` of the compiled contract (checked 2026-10-07, **C**, and asserted by `SpecExamples.t.sol`); the compiled ABI is authoritative. Relayers allowlist the first two. The public constants `INVOICE_TYPEHASH()` (`0x4fe1681a`), `CANCEL_TYPEHASH()` (`0x73fca6ea`) and `PAYMENT_BINDING_TYPEHASH()` (`0xda66ed9f`) are also exposed.

| Selector | Function |
|---|---|
| `0xa4c514ef` | `payWithAuthorization((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32),bytes,(address,uint128,bytes32,uint256,uint256,bytes32,uint8,bytes32,bytes32))` |
| `0x47e6460e` | `cancelBySig((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32),uint256,bytes)` |
| `0x861df419` | `pay((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32),bytes,uint128,bytes32)` |
| `0x7b0a31f7` | `payWithPermit((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32),bytes,uint128,bytes32,(uint256,uint8,bytes32,bytes32))` |
| `0x19a6b20e` | `payNative((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32),bytes,bytes32)` |
| `0xb7eb2e37` | `cancel((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32))` |
| `0x4eeaa709` | `invoiceKey((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32))` |
| `0x2ec920ac` | `paymentNonce(bytes32,address,uint128,bytes32,bytes32)` |
| `0x64482ac4` | `stateOf(bytes32)` |
| `0xf8b72a0b` | `statesOf(bytes32[])` |
| `0x84b0196e` | `eip712Domain()` |

### 17.3 Example invoice

**These addresses are test fixtures, not deployments.** `verifyingContract` and `token` are the addresses that a local anvil chain assigns to the first two contracts deployed by its default account 0 (`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`, nonces 0 and 1). The payee and payer are anvil's default accounts 1 and 2, whose private keys are public (mnemonic `test test test test test test test test test test test junk`). Never send real funds to them.

| Input | Value |
|---|---|
| `chainId` | `10143` (as in the e2e fixture, anvil started with `--chain-id 10143`) |
| `verifyingContract` | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| `payee` | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (anvil account 1) |
| `token` | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` (a 6-decimal mock) |
| `amount` | `25000000` (25.00 tokens at 6 decimals) |
| `validAfter` | `1791158400` (2026-10-05T00:00:00Z) |
| `validUntil` | `1791763200` (2026-10-12T00:00:00Z) |
| `maxPayments` | `1` |
| `salt` | `0xf5b34bf6f093a9e7f2275058fccc4b4c517ce2b35455c8f6908d9cff07c148d5` = `keccak256("PayLink invoice v2 example salt")`. Fixed for reproducibility only; real salts are random. |
| memo | `Logo design, invoice #12` |
| `memoHash` | `0x9e4171ef418f2c980507bfa20f7262b37301d7ffd5d6ef27634ca2d85d6b7041` |

| Output | Value |
|---|---|
| `domainSeparator` | `0x084875ae6ab8d0ac0c9e0e1d2537f8985030baab1d0bfac09d4e0bdac024c27c` |
| `structHash` | `0x43d51889ef0cc89661659d7d1db9a8fc5e52fabf7dbff2ad3a8307d6ad69a110` |
| **`key`** | `0x7c3bfd66020e278626ebe781b4d26210c763273be3b3c2be4f90bb1631df15df` |
| payee signature (RFC 6979, `v = 27`, low `s`) | `0x9b15ca287effb6724dbbdc508dc3f8418c1c51e38c7df32be3da03a1487de3615537f23f136bfa824748e8a730f38c4ad407223d8f6fd1e9b9ac4309cd6dd1b41b` |
| packed invoice (140 bytes) | `0x70997970c51812dc3a010c7d01b50e0d17dc79c8e7f1725e7734ce288f8367e1bb143e90bb3f0512000000000000000000000000017d7840000000006ac2e880000000006acc230000000001f5b34bf6f093a9e7f2275058fccc4b4c517ce2b35455c8f6908d9cff07c148d59e4171ef418f2c980507bfa20f7262b37301d7ffd5d6ef27634ca2d85d6b7041` |

Invoice fragment (316 characters):

```text
2.10143.cJl5cMUYEtw6AQx9AbUODRfcecjn8XJedzTOKI-DZ-G7FD6Quz8FEgAAAAAAAAAAAAAAAAF9eEAAAAAAasLogAAAAABqzCMAAAAAAfWzS_bwk6nn8idQWPzMS0xRfOKzVFXI9pCNnP8HwUjVnkFx70GPLJgFB7-iD3Jis3MB1__V1u8nY0yi2F1rcEE.mxXKKH7_tnJNu9xQjcP4QYwcUeOMffMr49oDoUh942FVN_I_E2v6gkdI6Kcw84xK1AciPY9v0em5rEMJzW3RtBs.TG9nbyBkZXNpZ24sIGludm9pY2UgIzEy
```

### 17.4 Cross-chain key

The same eight fields under `chainId = 84532`, with the same `verifyingContract`, give
`key = 0x51051ac00b30aaee2966aa10faa3d1258492509709a21b179aff066c2bcbed2f`. The signature of [§17.3](#173-example-invoice) does not verify for it.

### 17.5 Payment binding

| Input | Value |
|---|---|
| `key` | from [§17.3](#173-example-invoice) |
| `payer` | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` (anvil account 2) |
| `amount` | `25000000` |
| `payerRef` | `0x0000000000000000000000000000000000000000000000000000000000000000` |
| `payerSalt` | `0x27d8d8eed2e9a08f43724320ccef15205d4c343948c66ee817abd9c4721f4303` = `keccak256("PayLink payment example payer salt")` |
| **`nonce`** | `0xfb35fc12f5759b9a2eda33480fb501423cc85685589966e4d1f378eef8888089` |

### 17.6 Signed cancellation

| Input or output | Value |
|---|---|
| `key` | from [§17.3](#173-example-invoice) |
| `deadline` | `1791244800` (2026-10-06T00:00:00Z) |
| `cancelDigest` | `0xbee48c48fa887318cf8227108e5578be937b736a207dc284a8224f58974696fa` |
| payee signature | `0x7aa4bdfaba049e3148492fb392beba80d7c4b9bbb10a9869fe4c182b53263ec43d641475ef1ed97431720670eb92c823c985d09cf941ca38a928954697cdfd141c` |

### 17.7 Reproducing with Foundry

The typed data of [§17.3](#173-example-invoice), exactly as a wallet receives it through `eth_signTypedData_v4` (save it as `invoice.json`). Integer values may be JSON numbers or decimal strings; integers above `2^53 − 1` must be strings. `amount` and the times are written as strings here, as wallets and viem accept.

```json
{
  "types": {
    "EIP712Domain": [
      {"name": "name", "type": "string"},
      {"name": "version", "type": "string"},
      {"name": "chainId", "type": "uint256"},
      {"name": "verifyingContract", "type": "address"}
    ],
    "Invoice": [
      {"name": "payee", "type": "address"},
      {"name": "token", "type": "address"},
      {"name": "amount", "type": "uint128"},
      {"name": "validAfter", "type": "uint64"},
      {"name": "validUntil", "type": "uint64"},
      {"name": "maxPayments", "type": "uint32"},
      {"name": "salt", "type": "bytes32"},
      {"name": "memoHash", "type": "bytes32"}
    ]
  },
  "primaryType": "Invoice",
  "domain": {"name": "PayLink", "version": "2", "chainId": 10143, "verifyingContract": "0x5FbDB2315678afecb367f032d93F642f64180aa3"},
  "message": {
    "payee": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "token": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    "amount": "25000000",
    "validAfter": "1791158400",
    "validUntil": "1791763200",
    "maxPayments": 1,
    "salt": "0xf5b34bf6f093a9e7f2275058fccc4b4c517ce2b35455c8f6908d9cff07c148d5",
    "memoHash": "0x9e4171ef418f2c980507bfa20f7262b37301d7ffd5d6ef27634ca2d85d6b7041"
  }
}
```

The cancellation of [§17.6](#176-signed-cancellation) uses the same `domain`, the type `"Cancel": [{"name": "key", "type": "bytes32"}, {"name": "deadline", "type": "uint256"}]`, `"primaryType": "Cancel"` and the message `{"key": "0x7c3bfd66…df15df", "deadline": "1791244800"}` (save it as `cancel.json`).

```bash
# Type hash and payment binding (§17.1, §17.5)
cast keccak "Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)"
cast keccak "$(cast abi-encode 'f(bytes32,bytes32,address,uint128,bytes32,bytes32)' \
  0x1522042427c11deedb016d62cb8d2ed977e5ba802ccb926d4a8fa50abd9af353 \
  0x7c3bfd66020e278626ebe781b4d26210c763273be3b3c2be4f90bb1631df15df \
  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 25000000 \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  0x27d8d8eed2e9a08f43724320ccef15205d4c343948c66ee817abd9c4721f4303)"

# Payee signatures (§17.3, §17.6) with anvil's public test account 1. Never use this key for real funds.
PAYEE_KEY="$(cast wallet private-key --mnemonic 'test test test test test test test test test test test junk' --mnemonic-index 1)"
cast wallet sign --private-key "$PAYEE_KEY" --data --from-file invoice.json
cast wallet sign --private-key "$PAYEE_KEY" --data --from-file cancel.json
```

With Foundry 1.8.5 these commands print the values of §17.1, §17.5, §17.3 and §17.6 (re-run on 2026-10-07).

---

## 18. References

### 18.1 Normative

- [EIP-712]: Typed structured data hashing and signing.
- [EIP-3009]: Transfer With Authorization (`receiveWithAuthorization`).
- [EIP-2612]: Permit extension for EIP-20 signed approvals.
- [ERC-1271]: Standard signature validation method for contracts.
- [ERC-5267]: Retrieval of EIP-712 domain.
- [EIP-55]: Mixed-case checksum address encoding.
- [RFC 2119] and [RFC 8174]: requirement keywords.
- [RFC 4648] §5: base64url.
- [RFC 3986]: URI generic syntax (fragment handling, §3.5).
- [ABNF]: RFC 5234.

### 18.2 Informative

- [ERC-6492]: signature validation for predeploy contracts (not supported).
- [EIP-7702]: set code for EOAs.
- [EIP-2098]: compact signature representation (not accepted).
- [EIP-5792]: wallet call API (`wallet_sendCalls`).
- CAIP-2 and CAIP-10: chain and account identifiers, used by the CSV export.
- OpenZeppelin Contracts 5.3.0: `EIP712`, `SignatureChecker`, `ECDSA`, `SafeERC20`, `ReentrancyGuard`, `Address`.
- PayLink repository: [ARCHITECTURE](../ARCHITECTURE.md), [ADRs](../adr/README.md), [threat model](../security/THREAT_MODEL.md).

[EIP-712]: https://eips.ethereum.org/EIPS/eip-712
[EIP-3009]: https://eips.ethereum.org/EIPS/eip-3009
[EIP-2612]: https://eips.ethereum.org/EIPS/eip-2612
[ERC-1271]: https://eips.ethereum.org/EIPS/eip-1271
[ERC-5267]: https://eips.ethereum.org/EIPS/eip-5267
[EIP-55]: https://eips.ethereum.org/EIPS/eip-55
[ERC-6492]: https://eips.ethereum.org/EIPS/eip-6492
[EIP-7702]: https://eips.ethereum.org/EIPS/eip-7702
[EIP-2098]: https://eips.ethereum.org/EIPS/eip-2098
[EIP-5792]: https://eips.ethereum.org/EIPS/eip-5792
[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174
[RFC 4648]: https://www.rfc-editor.org/rfc/rfc4648
[RFC 3986]: https://www.rfc-editor.org/rfc/rfc3986
[RFC 3986 §3.5]: https://www.rfc-editor.org/rfc/rfc3986#section-3.5
[ABNF]: https://www.rfc-editor.org/rfc/rfc5234

---

## 19. Document history

| Version | Date | Change |
|---|---|---|
| 2.0.0 | 2026-10-05 | First complete draft, written against the PayLinkV2 interface of PAYLINK-V2-SPEC §3.3.2. Test vectors cross-checked with ethers 6.17.0 and Foundry cast 1.8.5. |
| 2.0.0 (draft revision) | 2026-10-06 | Editorial, before the freeze: error precedence, selectors and type hashes re-checked against the compiled `PayLinkV2`; §17 vectors recomputed with ethers 6.17.0; §11 split into rules, definitions and example, with the `RelayPayRequest` schema definition for relayer bodies. The wire format is unchanged. |
| 2.0.0 (draft revision) | 2026-10-07 | Client requirements only, no wire change: §12 requires verifiers to show what a receipt proves; new §13.4 for payment-arrival displays (tills) and the matching conformance class. The JSON Schema now enforces three existing rules (non-zero payee, `memoHash ≠ keccak256("")`, memo present exactly when `memoHash ≠ 0`), and §11.1 says so. §7.6 and §17 values re-verified by three implementations, including the compiled contract through `SpecExamples.t.sol`. The wire format is unchanged. |
| 2.0.0 (draft revision) | 2026-10-07 | Pre-freeze audit, client and relayer requirements only, no wire or contract-behaviour change: §8.2 no longer asks for a fresh `payerSalt` per attempt, which let a retry pay a multi-payment invoice twice; new §8.6 (retries and outstanding authorisations); §8.3 documents FiatToken's payer-signature dispatch and routes EIP-7702-delegated payers to the allowance path; §13.2, §13.3, §14.8 and §14.11 updated accordingly (relayers bound what they keep in flight and penalise post-simulation reverts). |
| 2.0.0 (draft revision) | 2026-10-07 | Re-audit (finding A-04), relayer requirements only, no wire or contract-behaviour change: §13.3 requires a minimum remaining validity (the chain's relay margin) on every time bound a relayer forwards, attribution of post-simulation reverts by cause with penalties only for the party named by the evidence (the same authorisation landing elsewhere penalises nobody), requester identities by IPv4 address or IPv6 /64, and a rate limit per requester; §13.2 and §14.12 note the margin; §14.11 updated. |
