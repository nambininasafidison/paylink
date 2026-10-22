# Reconciler and executor (workstream B)

The part of [`apps/api`](../../README.md) that decides, from what PayPal's `GET` of a twin (P5) and Ethereum Sepolia say, what each twin's situation is, what may happen next, and that carries out only that: [docs/paypal/SPEC.md](../../../../docs/paypal/SPEC.md) §10 and §11, with the decisions of 2026-10-21 (Ethereum Sepolia, Workers AI, the cut scope). The model never decides any of it: the desk assistant reads the fence and proposes inside it; code executes after the payee's tap on exact values.

## Modules

| Path | Holds |
|---|---|
| [`situation.ts`](situation.ts) | the situation table S0–S9 (pure), the fence with exact values, the executor's admission rule |
| [`echo.ts`](echo.ts) | PayLink's P6 note and the echo filter (method `OTHER` + note for this K + a verified `Paid` in that transaction) |
| [`observe.ts`](observe.ts), [`money.ts`](money.ts), [`codes.ts`](codes.ts) | P5 parsed defensively; money and dates; the fixed reason and alert codes |
| [`engine.ts`](engine.ts) | `registerTwin`, `reconcileTwin` (lock, fresh reads, automatic record, proposals, alerts, audit, next check), `reconcileTwinEvent` (the webhook's sink) |
| [`executor.ts`](executor.ts) | approve (hash, HMAC token, single use, fresh read, fence, effect), reject, Undo |
| [`desk.ts`](desk.ts) | the desk view, "Check my invoices", and the assistant's toolbox (`allowedActions`, `propose`, `DeskAgent`) |
| [`check.ts`](check.ts) | "Was I really paid?": a verdict from P5 and the chain only |
| [`cron.ts`](cron.ts) | the minute backstop (≤ 20 twins, one chain `eth_call`, back-off) and the daily purge |
| [`../approvals/`](../approvals/) | canonical proposal, SHA-256, HMAC approval tokens |
| [`../session/`](../session/) | EIP-712 `PayLinkSession` verification, HMAC session tokens |
| [`../store/`](../store/) | the store contract, its logic over a synchronous key-value space (`kv.ts`), the in-memory stores, quotas |
| [`../worker/durable.ts`](../worker/durable.ts) | the `Payee` and `Global` Durable Objects running that same logic |
| [`../chain/`](../chain/) | the read-only chain reader (Multicall3 `aggregate3` of `statesOf` and the clock; `Paid` and `InvoiceCancelled` logs) |
| [`../routes/session.ts`](../routes/session.ts), [`../routes/desk.ts`](../routes/desk.ts), [`../routes/check.ts`](../routes/check.ts) | the HTTP handlers |

## The situation table

| | PayPal | Chain | Fence (exact values in the arguments) |
|---|---|---|---|
| S0 | unreadable, unknown status, `SCHEDULED`, `DRAFT`, reference, currency, amount or paid amount not the signed ones | unreadable, not deployed, a payment of another amount or token | nothing; an alert |
| S1 | open | payable | `share_reminder_text`; `send_reminder` when due or 3 days after sending, with a recipient email, at most once per 24 h |
| S2 | paid with a non-echo transaction, or marked paid by the merchant | payable | `cancel_paylink` (tap and the payee's signature) |
| S3 | open | paid, verified | `record_external_payment` automatically; after an Undo only by a tap; `cancel_paypal` if PayPal stays open after the record; a record gone from PayPal without an Undo here (`record-missing`, an alert): a tap to record again or `cancel_paypal` |
| S4 | paid with a non-echo transaction | paid | nothing; alert `paid-twice` |
| S5 | `PAYMENT_PENDING`, `PARTIALLY_PAID`; or a chain payment still confirming (15 min) | any | nothing (wait) |
| S6 | cancelled | payable | `cancel_paylink` |
| S7 | open | cancelled or expired (on chain time) | `cancel_paypal` |
| S8 | closed and consistent | closed and consistent | nothing (read again once a day for 30 days, and by "Check my invoices": PayPal's side can reopen) |
| S9 | refunded | any | nothing (information) |

`test/reconciler/situation.test.ts` checks all 17 × 8 × 4 combinations of status, chain and transactions against a hand-written table; `test/reconciler/properties.test.ts` checks with fast-check that no situation but S0, S1 or S5 leaves both rails open, that once a rail took money the other is closed, closed by the fence, waited on or alarmed, and that the executor admits exactly the fence's tap actions with exactly their values.

## For the other workstreams

- **PayPal spine.** After P3/P4 (or a P2 hit), call `registerTwin(services, newTwin, now, { invoice })` with the signed invoice's token, `validUntil` and amount: it stores, indexes and reconciles (idempotent, so re-registering a payee's links rebuilds a lost store, §11). Charge `chargeQuota(services, payee, "twins", now)` first. The webhook can hand verified events to `reconcileTwinEvent` (a `TwinEventSink`). `GET /v1/twin/:key` reads `situation` and `fence` from the payee's store; the public rails route finds the payee with `findTwinByKey`.
- **AI.** Implement `DeskAgent` (`desk.ts`): it receives the payee's open twins, `allowedActions(K)` and `propose(...)`; it returns the assistant's state. `propose` keeps only a tap action of the fence, with the fence's values and reason code; the text is kept only when `grounded` is true and it holds again against the twin's own facts (`checkMessage(text, factsOfTwin(twin))`, AI-5). Admit each run with `admitAssistant` (src/ai/admission.ts: the payee's, the source's and the lane's quotas and neurons).
- **Web.** The desk's shapes are `@paylink/api-contract`'s `desk.ts`: approve with the `hash` and `token` of the `ProposalView`; a `cancel_paylink` answers `signature-required` with the `Cancel(key, deadline)` to sign and submit from the payee's wallet (no relayer on Sepolia).

"Recorded on PayPal" is P5's to say (an echo of the chain transaction among the invoice's transactions, §10.3): the `AutoRecord` of an earlier P6 only holds off a second one for `RECORD_LAG_MS` (10 minutes). Past that, a record P5 no longer shows is marked `missing` and never recorded blind again; a P7 whose answer is lost is settled by reading P5. Every write carries the deterministic `PayPal-Request-Id` of `src/paypal/idempotency.ts`; a P9 whose answer is lost counts as sent (`unconfirmed`).

## Run

```sh
pnpm --filter @paylink/api exec vitest run test/reconciler test/approvals test/session test/store test/chain
PAYLINK_FORK_SEPOLIA=1 NODE_USE_ENV_PROXY=1 pnpm --filter @paylink/api exec vitest run test/chain/fork.test.ts   # anvil fork of Sepolia
PAYLINK_WORKERD=1 pnpm --filter @paylink/api exec vitest run test/store/workerd.test.ts                          # Durable Objects in workerd
```

## Sources, and what stays unverified

Read for this work: PayPal's `invoicing_v2.json` at `90e8041` (vendored in `apps/api/test/openapi/`: statuses, `payment_detail` with read-only `type`, `notification` ignoring `subject` and `note`); the PayLinkV2 release ABI and constants in `packages/sdk` (`statesOf`, `Paid`, `InvoiceCancelled`, `Cancel(bytes32,uint256)`, `decodePaidLog`); the registry's Sepolia entry (`packages/chains`, Multicall3 and the 50,000-block log range read on chain on 2026-10-21) and [docs/research/paypal/sepolia.md](../../../../docs/research/paypal/sepolia.md) (pruned history); `@cloudflare/workers-types` 5.20261006.1 (`SyncKvStorage`, `transactionSync`). The fork test deploys PayLinkV2 from `web/v2/deploy/data/release.json` (its init code hashes to the release's `initCodeHash`) at the release CREATE2 address on a fork of Sepolia and pays real Circle USDC by the payer's own EIP-3009 authorisation.

UNVERIFIED until the owner's capture run or the first deployment:

- the PayPal status after P6 (`PAID`, `MARKED_AS_PAID` or `PAID_EXTERNAL`; the reconciler accepts each, and an invoice left open after the record is proposed for `cancel_paypal`), after P7 (back to open is assumed), and whether P7's transaction id is P6's `payment_id`;
- whether PayPal keeps the `·` of PayLink's note (the echo parser accepts any separator);
- PayPal's reminder limit and whether P9 needs a recipient email (one reminder per 24 h, and only with an email, here);
- the sandbox payer host of `recipient_view_url` (only PayPal's own hosts and the configured one count as trusted links in "Was I really paid?");
- the Workers Free plan's subrequest limit (50, seen in a search snippet: the cron's worst case is 34) and the Durable Objects on Cloudflare itself (exercised in local workerd only);
- the confirmation depth (2 blocks) and the 15-minute wait for an unverified chain payment, which are design choices (E).
