# @paylink/indexer

PayLink v2's history indexer: [Envio HyperIndex](https://envio.dev) 3.12.1 over the two events of `PayLinkV2`, `Paid` and `InvoiceCancelled`, on **Monad testnet (10143)** and **Base Sepolia (84532)**. It turns them into a GraphQL API the web app reads for the payee's history ([PAYLINK-V2-SPEC §3.8](../../docs/ARCHITECTURE.md), [ADR 0009](../../docs/adr/0009-read-model-chain-device-indexer.md)).

This project's indexer is built with HyperIndex by Envio. Licence terms: [NOTICE.md §4](../../NOTICE.md#4-indexer-envio-hyperindex-not-open-source).

## Why it exists

The public Monad testnet RPC answers `eth_getLogs` for at most 100 blocks (about 40 seconds of chain). Without an index, a browser can only see the last few minutes of payments. HyperSync reads the whole history from the deployment block, so the app can show:

| Feature in the app | Entity it reads | Without the indexer |
|---|---|---|
| Ledger, "Payments received": every payment to the connected payee on the edition's chains, newest first, each with a receipt link | `Payment` | The chain's latest 10 log ranges only (Monad: 1,000 blocks), labelled "Read from the network's latest blocks only" |
| Ledger, the payee's record: "12 payments received since 9 Oct 2026 · 5 payers", and the volume per token | `Payee`, `PayeeToken` | "N payments in the last M minutes" |
| Ledger, "Typical time to get paid" for multi-payment links | `Invoice.firstPaidAt` | One-off invoices only (their single payment time is on the chain) |
| Pay view, the payer-side trust line under "To" | `Payee` | **Not shipped yet**: the pay route's first load is at its budget (PAYLINK-V2-SPEC §4.4: 110 kB of gzipped JavaScript; 109.9 kB in the Monad edition's e2e build on 2026-10-09), and the smallest payer-side trust line built here needs about 0.55 kB of it (0.3 kB of code that loads the history reader lazily, measured in that build, and about 0.25 kB of words, estimated). The payee sees the same record on the ledger |
| Status page, "History service": processed block per chain | Envio's `_meta` | "Not configured" |

## What it is not

A cache. The web app never takes from it a payment state, a receipt or anything that gates a payment:

- invoice states come from `statesOf` on the chain;
- every row links to a receipt (`/r/#…`) that the receipt page verifies on RPC (`eth_getTransactionReceipt`, canonical contract, `Paid` topic, decoded fields);
- the indexer client is never imported by the payment rails or the receipt code (`apps/web/test/indexer.test.ts` checks the imports);
- the record ("N payments received since …") is labelled as coming from the history service, says nothing about identity, and never gates a payment (THREAT_MODEL T-15, T-36). It is on the ledger only; the payer-side trust line on the pay view waits for room in the pay route's budget (table above).

## Files

| File | Contents |
|---|---|
| `config.yaml` | Chains, the canonical address and deployment block from `protocol/deployments/<chainId>.json`, both event signatures, lowercase addresses, transaction hash selected; the public RPCs as fallback (Monad's capped at 100 blocks per request) |
| `schema.graphql` | `Invoice`, `Payment`, `Payee`, `PayeeToken`, `PayerPayee`, `DailyVolume`, `DailyActivity`; every id starts with the chain ID |
| `src/ledger.ts` | The arithmetic, as pure functions over plain entity values (`applyPaid`, `applyCancelled`, ids, UTC days) |
| `src/handlers/PayLinkV2.ts` | Load the entities a log touches, apply, write back; a replayed `Paid` or a second `InvoiceCancelled` changes nothing |
| `test/ledger.test.ts` | The arithmetic without Envio |
| `test/handlers.test.ts` | The handlers under Envio's own test indexer (`createTestIndexer`) with simulated logs: no network |
| `test/config.test.ts` | Envio's parse of `config.yaml` against the deployment records, the release ABI and the registry RPCs |
| `test/package.test.ts` | The Envio Cloud package contract (below) |

**Not derivable, so not indexed:** the time from issuing an invoice to its payment. Invoices are signed off-chain and their issue time never reaches the chain (`validAfter` is optional and usually 0). The web app derives it for invoices issued on the device, from the device's creation time and the first payment time (`apps/web/src/read/settle.ts`).

## Commands

```bash
pnpm --filter @paylink/indexer test        # envio codegen, then Vitest: offline
pnpm --filter @paylink/indexer typecheck
pnpm --filter @paylink/indexer lint
pnpm --filter @paylink/indexer dev         # local indexer: needs Docker and ENVIO_API_TOKEN in your shell
```

`envio codegen` writes `.envio/` and `envio-env.d.ts` (git-ignored); every script above runs it first.

## Envio Cloud package contract

Envio Cloud builds this folder as its Root Directory, reads the HyperIndex version from this `package.json`, and may install it on its own, outside the pnpm workspace. So:

- `envio` is a production dependency with an exact version (`3.12.1`), and every dependency is an exact version equal to the workspace catalogue pin: no `catalog:` or `workspace:` specifier;
- `tsconfig.json` does not extend the workspace base (it repeats its options), and `eslint.config.js` imports the shared config by path;
- nothing in `src/` imports outside this folder.

`test/package.test.ts` fails if any of this drifts. Deployment, redeployment and the browser-assistant prompt: [docs/runbooks/envio.md](../../docs/runbooks/envio.md).

## Supply chain

`envio@3.12.1` brings high-severity advisories in `express` (its internal health and metrics server) and in `ws` (its viem's WebSocket client). They are accepted narrowly, path by path and until a review date, in `scripts/toolchain/audit-workspace.py`, with the evidence; see [ADR 0011, "Known audit item for the indexer"](../../docs/adr/0011-workspace-layout.md#known-audit-item-for-the-indexer). Nothing from this package is shipped to browsers.
