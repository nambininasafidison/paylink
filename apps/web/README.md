# @paylink/web

The PayLink v2 web app: signed dollar invoices that a payee creates and shares in seconds, and that a payer anywhere checks and pays from their own wallet, with a receipt anyone can verify. A Vite 8 multi-page progressive web app in strict TypeScript, without a UI framework ([ADR 0006](../../docs/adr/0006-vanilla-typescript-port-at-parity.md)), in v1's "Precision Terminal" design language. Production: `https://paylink-mg.pages.dev` ([Cloudflare Pages runbook](../../docs/runbooks/cloudflare-pages.md), [ADR 0014](../../docs/adr/0014-web-app-and-single-pages-site.md)).

## Routes

| Route | Who | What it does |
|---|---|---|
| `/` | payee | The terminal: network (band selector), amount (or open amount), memo, number of payments, expiry; a signing display that states exactly what the wallet will sign; then the printed card with its QR code, copy, WhatsApp, the system share sheet, print (A6) and "show on the till". No transaction, no gas. |
| `/pay/#2.<chainId>.<inv>.<sig>[.<memo>]` | payer | The bill in a dark display window and four lamps read from the chain: **signature valid** (the payee's, with the contract's own dispatch), **right network** (the wallet's), **genuine PayLink contract** (registry address, masked runtime hash, EIP-712 immutables), **still payable** (window, cancelled, sold out, by chain time). Any red lamp locks the Pay key; an unknown one offers to check again. The payee's address grouped by four, a saved name or the amber first-payment warning, the memo as the sender's untrusted note. Pays with `payWithPermit` (one signature, one transaction) or an exact-amount `approve` then `pay`, then verifies the receipt before "Approved". |
| `/r/#2.<chainId>.<txHash>.<logIndex>[…]` | anyone | The receipt slip, re-verified on every opening (status, canonical contract, `Paid` event, allowlisted token, and the invoice when attached); confirmed or final; prints on an 80 mm roll or A6. |
| `/ledger/` | payee | The books: invoices signed on this device by the connected wallet, each state from `statesOf` and chain time, a tally per token, filters, CSV export (RFC 4180, ISO 8601, CAIP-2/CAIP-10, formula-safe), copy, view, till, and cancel (one `cancel` transaction, two presses). Receipts of payments made from this device. |
| `/send/` | payer | The address book: a contact is a name on an address plus their receive card, checked against the registry before it is saved; the pay view then shows "Saved as …". |
| `/till/` (`#<invoice>` to arm it) | payee | The counter display: big condensed numerals, an LED and a chime. Armed, it lights only for a verified `Paid` of that invoice at its amount; watching, for every verified payment to the payee. Polls `eth_getLogs` from `head − 10` every second (under Monad's 100-block cap). Full screen and screen wake lock. |
| `/status/` | anyone | Each chain of the edition checked live (RPC, genuine release), the relayer and indexer from `/config.json`, the build, configuration, storage and offline mode. |
| `404.html` | anyone | Served by Pages for unknown paths. |

The editions `monad` and `base` serve the same routes under `/monad/` and `/base/` ([ADR 0008](../../docs/adr/0008-editions.md)); `?chain=` picks among the edition's own chains only.

## Layout

| Path | Contents |
|---|---|
| `src/editions/` | `EditionProfile`: the three extension points (account layers, default token, payment rails) and the profile of each edition |
| `src/accounts/` | `AccountProvider` / `AccountLayer`; EIP-6963 discovery with EIP-3326 switch and EIP-3085 add from the registry |
| `src/rails/` | `PaymentRail`; the wallet rail (`permit`, `approve-pay`, `native`) with registry-clamped gas limits |
| `src/read/` | the read model: the four checks, the ledger from `statesOf`, the CSV export |
| `src/store/` | the device store: IndexedDB (`idb`), every record re-validated on read, memory fallback |
| `src/core/` | runtime configuration (`/config.json`, zod), chain clients over the registry's RPCs, the edition registry, formatting, links, preferences, errors |
| `src/ui/` | the typed `h()` builder and the Precision Terminal pieces: lamps, grouped addresses, band selector, segmented keys, ticket, receipt slip, QR code (SVG), toasts, print |
| `src/app/` | boot, the page frame, the session (remembered wallet), the wallet picker |
| `src/pages/` | one module per route; `src/entries/` boots each page |
| `src/pwa/` | service worker registration under Trusted Types, update prompt |
| `public/` | `config.json`, `_headers` (generated), icons, `robots.txt` |
| `scripts/` | `build.ts` (editions, assembly, gates), `site.ts` (the site: `/arc/`, `/deploy/`, `_headers`), `headers.ts`, `cloudflare-pages.sh` (the Pages build command) |

## Extension points (editions)

| Varies | Interface | T0 (today) | T1 |
|---|---|---|---|
| Who signs | `AccountLayer` → `AccountProvider` (`src/accounts/types.ts`) | EIP-6963 injected wallets | Mera passkeys behind a SigningDisplay (Monad); Base Account for payers (Base) |
| Default token | `EditionProfile.defaultToken(chain)` | the registry's default token | per edition |
| How a payment reaches the chain | `PaymentRail` (`src/rails/types.ts`) | the payer's wallet | the gasless relayer (`apps/relayer`) and the payer's own submission of the same authorisation |

Only `src/editions/index.ts` chooses implementations; pages ask the profile.

## Commands

```bash
pnpm --filter @paylink/web dev            # Vite dev server
pnpm --filter @paylink/web test           # Vitest (happy-dom, fake-indexeddb)
pnpm --filter @paylink/web test:coverage
pnpm --filter @paylink/web typecheck
pnpm --filter @paylink/web lint
pnpm --filter @paylink/web run headers    # regenerate public/_headers after a config.json or registry change
pnpm --filter @paylink/web build          # the whole site into dist/ (as Cloudflare Pages builds it)
bash apps/web/scripts/cloudflare-pages.sh # the Pages build command, from the repository root
```

End to end: `pnpm --filter @paylink/e2e test` builds `dist-e2e/` (`build --e2e`, with a local chain swapped into the registry) and runs `e2e/specs/app.spec.ts` against anvil under the production headers ([e2e README](../../e2e/README.md)).

## Security

- **Addresses come from the registry only** (`@paylink/chains`), scoped to the edition; links for other chains are refused. `/config.json` may add endpoints and a banner, never an address, and is validated strictly.
- **No HTML sinks.** `h()` creates elements and text nodes, sets allowlisted attributes, refuses `on*`, `style`, `srcdoc`, `javascript:` and protocol-relative URLs; ESLint bans every HTML sink.
- **Headers** (`public/_headers`): `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `connect-src` limited to the registry RPCs and `/config.json` endpoints, Trusted Types with the single `paylink-sw` policy, `frame-ancestors 'none'` plus a JavaScript frame lock, `no-referrer`, a closed `Permissions-Policy`. The policy is repeated as a `<meta>` in every page.
- **Gas limits** are `clamp(estimate × 1.10, floor, ceiling)` from the registry; allowances are exact, never unlimited.
- **Untrusted text**: memos are stripped of bidi and control characters and shown as the sender's note; copies come from canonical state.

The threat model's web rows (T-04, T-05, T-06, T-25, T-28, T-29, T-35, T-44) cite the tests above.
