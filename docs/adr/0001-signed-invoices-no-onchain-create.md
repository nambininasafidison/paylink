---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering); the three design proposals and three judge reviews synthesised in PAYLINK-V2-SPEC
informed: contributors, hackathon reviewers
---

# ADR 0001: Signed invoices, no on-chain create

## Context and problem statement

PayLink v1 creates every link on-chain: `create(amount, expiresAt, memo)` is a transaction paid by the payee, and the contract stores the link, including the memo, in a registry. That model has three costs for v2's users and editions:

- **The payee needs the chain's gas token before they can ask for money.** On Monad, an EOA holding 0 MON cannot send any transaction, because of the 10-MON reserve-balance rule (**C**, PAYLINK-V2-SPEC §3.4). A Mera passkey merchant would have to acquire MON first, which defeats the "no gas token" story.
- **Creating a link needs connectivity and a confirmed transaction**, which rules out offline creation at a market stall.
- **The memo becomes public, permanent on-chain data**, written at creation time even if the invoice is never paid.

The validated prototype (`scratchpad/v2plan/secproto`) supported both signed invoices and an optional on-chain `publish`. Two link modes doubled the surface: `publish`, `invoiceOf`, `keyOf`, `publishedBy` with unbounded per-payee arrays, and a branch that skipped the signature check for published links.

How should a payee create a payment request in v2?

## Decision drivers

- Zero gas and no gas token for the payee, on every chain.
- Offline creation.
- A small contract surface that can be reviewed in full before the 2026-10-07 freeze.
- One link mode, so that every client, test and document has a single path to verify.
- No server that stores invoices ([ADR 0009](0009-read-model-chain-device-indexer.md)).
- Personal data stays off-chain until, and unless, it is needed.

## Considered options

- **A.** The payee signs an EIP-712 `Invoice` off-chain; the link id is its digest, and the contract verifies the payee signature on every payment.
- **B.** On-chain registry, as in v1: a `create` transaction per link.
- **C.** Hybrid, as in the prototype: signed invoices plus an optional on-chain `publish`.
- **D.** Invoices stored by a PayLink server and referenced by an opaque id.
- **E.** Batched commitments: the payee periodically posts a Merkle root of invoices.

## Decision outcome

Chosen option: **A, signed invoices with no on-chain create**, because it is the only option that gives zero-gas, offline creation with one link mode and no server, and the contract stays small: about 250 lines in the plan and a little over 300, NatSpec included, in the implementation (`protocol/src/PayLinkV2.sol`), with six state-changing entry points.

The format is specified normatively in [docs/spec/paylink-invoice-v2.md](../spec/paylink-invoice-v2.md). `publish`, `invoiceOf`, `keyOf` and `publishedBy` are removed from the prototype.

### Consequences

- Good, because a merchant can create and share invoices holding no gas token at all, which is the Mera-on-Monad story.
- Good, because creation works offline, and the invoice travels as a URL fragment or a QR code ([spec §10](../spec/paylink-invoice-v2.md#10-url-encodings)).
- Good, because state is one lazily written slot per key: nothing is stored for invoices that are never paid or cancelled.
- Good, because the memo never goes on-chain; only `memoHash` does, and only on payment or cancellation.
- Bad, because the payee signature must be verified on **every** payment. That costs gas (an `ecrecover`, or an ERC-1271 `staticcall`), and for ERC-1271 payees it means validity can change over time.
- Bad, because unpaid invoices are invisible on-chain. Unpaid invoices exist only on the payee's device and in the links already shared. A lost device means lost unpaid invoices unless they were exported ([ADR 0009](0009-read-model-chain-device-indexer.md)).
- Bad, because URLs are long: 316 characters for the specification's example. QR codes are therefore denser than v1's.
- Bad, because counterfactual (not yet deployed) smart accounts cannot be payees: their signatures cannot be checked on-chain without ERC-6492, which is out of scope ([THREAT_MODEL T-12](../security/THREAT_MODEL.md#t-12)).
- Neutral, because a signed invoice is a bearer payment request: anyone holding it can pay it ([spec §14.3](../spec/paylink-invoice-v2.md#143-bearer-semantics)).

### Confirmation

- Unit tests cover every custom error of every entry point, including `InvalidSignature` for wrong signer, wrong chain and wrong contract.
- Invariant I7 (domain separation) is fuzzed over `vm.chainId` and alternate deployments.
- Golden vectors `protocol/test/vectors/eip712.json` are produced by Forge and reproduced byte for byte by the SDK (Vitest).
- The e2e suite creates an invoice in one browser context and pays it in another.
- Review check: the deployed ABI has no `create`, `publish` or registry function.

## Pros and cons of the options

### A. Signed EIP-712 invoices (chosen)

- Good, because creation costs 0 gas and works offline.
- Good, because there is one link mode and a small contract.
- Good, because the key commits to `chainId` and `verifyingContract`, so a signature for one deployment is useless on another.
- Bad, because verification runs on every payment.
- Bad, because unpaid invoices are not discoverable on-chain.

### B. On-chain registry (v1 model)

- Good, because it is simple, already built and tested (v1 has 7 contract tests).
- Good, because unpaid links can be listed on-chain.
- Bad, because the payee needs gas and connectivity for every link; on Monad that means holding MON.
- Bad, because memos become public at creation, and per-payee arrays grow without bound.

### C. Hybrid (signed plus optional publish)

- Good, because it supports both discoverable and private links.
- Bad, because it means two code paths, plus a signature-skip branch for published links, which is a classic place for authorisation bugs.
- Bad, because it roughly doubles the views and the storage, and the tests needed to cover them.

### D. Server-stored invoices

- Good, because URLs are short and unpaid invoices can sync across devices.
- Bad, because it needs a server holding personal data, which contradicts the no-server design and adds a GDPR-style responsibility.
- Bad, because the server becomes a single point of failure and of trust.

### E. Batched Merkle commitments

- Good, because many invoices are amortised into one transaction.
- Bad, because it still needs gas and a transaction, adds proof plumbing to every payment, and delays availability until the next batch.

## More information

- PAYLINK-V2-SPEC §0 decision 2, §3.3, §3.5.
- [Invoice specification](../spec/paylink-invoice-v2.md); [ARCHITECTURE §4.1](../ARCHITECTURE.md#41-create-and-share-an-invoice-offline-capable-zero-gas).
- Related: [ADR 0003](0003-bind-3009-nonce-to-payment.md) (payment binding), [ADR 0004](0004-immutable-ownerless-feeless.md) (no admin), [ADR 0009](0009-read-model-chain-device-indexer.md) (read model).
