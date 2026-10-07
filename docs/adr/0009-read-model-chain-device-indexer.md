---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering); local Envio pipeline verified end to end in the sandbox (C)
informed: contributors
---

# ADR 0009: Read model: chain > device > indexer

## Context and problem statement

The app reads data from three places:

1. **The chain**, through public RPCs: invoice state (`stateOf`, `statesOf`), transaction receipts and events.
2. **The device**, through IndexedDB: signed invoices with their memos (the chain only sees `memoHash`), receive cards, the address book, receipts and settings.
3. **An indexer**: Envio HyperIndex 3.12.1 on the Envio Cloud free development plan, for history, payee statistics and the trust line ("N payments received since …").

These sources can disagree, lag or fail:

- Public Monad RPCs cap `eth_getLogs` at 100 blocks, about 30 s (**L**). History cannot be rebuilt from logs on the client.
- An Envio development deployment lives at most 30 days, and its URL changes on every push (**L**).
- The indexer is a third-party service that could be stale, down or wrong.
- The device can be lost or cleared.

Which source is authoritative for what, and what happens when one fails?

## Decision drivers

- Correctness of anything that gates or proves a payment must not depend on a third-party cache.
- The app degrades gracefully: the ledger and payments keep working when the indexer is down.
- No server-side database, and no personal data held by the operator ([spec §15](../spec/paylink-invoice-v2.md#15-privacy-considerations)).
- Monad's log caps must not break the history features (the Envio bounty: a core feature driven by on-chain data).

## Considered options

- **A.** Strict precedence chain > device > indexer, with the indexer as a cache only.
- **B.** The indexer as the source of truth for history and state.
- **C.** Chain only, no indexer.
- **D.** An operator-run backend database fed by an indexer.

## Decision outcome

Chosen option: **A**, because it keeps every security-relevant read on the chain, keeps personal data on the device, and still delivers history and statistics where the chain alone cannot.

| Rank | Source | Authoritative for | Never used for |
|---|---|---|---|
| 1 | Chain | state, receipts, deployment code | — |
| 2 | Device | signed invoices, memos, contacts, settings | payment status without a chain check |
| 3 | Indexer | nothing (cache) | receipts, payability checks, any value that gates a payment |

Rules:

- "Paid" is shown only from `statesOf` or from a receipt verified on RPC ([spec §12](../spec/paylink-invoice-v2.md#12-receipt-verification)).
- The indexer URL comes only from same-origin `/config.json`, behind a health check. On failure the UI shows "history unavailable" and keeps working.
- Till mode reads the chain directly (`eth_getLogs` with `fromBlock = head − 10` every second), within the cap.
- Indexer handlers are pure functions with unit tests.

### Consequences

- Good, because a spoofed or stale indexer cannot make the app show an unpaid invoice as paid, or enable an unsafe payment.
- Good, because the app keeps working through indexer expiry and outages.
- Good, because the operator stores nothing personal; device data stays on the device.
- Bad, because the client merges three sources, which needs careful code and tests.
- Bad, because **the trust line comes from the indexer.** A compromised indexer could inflate it. It is therefore labelled as coming from the history service, shown as a soft signal, and never gates payment ([THREAT_MODEL T-15](../security/THREAT_MODEL.md#t-15)).
- Bad, because cross-device history depends on the indexer, and the books on a lost device are gone unless exported (export at T1, passkey-encrypted backup at T2).
- Bad, because the Envio deployment must be redeployed before each judging window (Monad Oct 14–27).

### Confirmation

- Receipt-verifier unit tests: wrong contract address, wrong topic, failed status, dirty data words and invoice mismatch are all rejected.
- An e2e scenario runs with the indexer down and checks for the "history unavailable" label and a working ledger.
- Ledger merge unit tests check that the chain overrides the device and the indexer.
- Code review checks that the indexer client is never imported by the payment or receipt modules.

## Pros and cons of the options

### A. Chain > device > indexer (chosen)

- Good, because security never depends on the cache, and degradation is graceful.
- Bad, because the merge logic is more complex, and the trust line is a soft signal.

### B. Indexer as the truth

- Good, because it is simple and fast.
- Bad, because a third party becomes authoritative for payments: spoofing and outages break the product.

### C. Chain only

- Good, because it is trustless and simple.
- Bad, because history and statistics are impossible within Monad's 100-block log cap, which loses the Envio bounty fit and the trust line.

### D. Operator database

- Good, because it allows rich queries and cross-device sync.
- Bad, because it means a server with personal data, an operational burden and a trust anchor, contrary to the no-server design.

## More information

- PAYLINK-V2-SPEC §3.8, §5 threats 15, 16 and 22.
- [ARCHITECTURE §7](../ARCHITECTURE.md#7-data-and-privacy).
