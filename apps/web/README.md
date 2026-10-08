# @paylink/web

The PayLink v2 web app: signed dollar invoices that a payee creates and shares in seconds, and that a payer anywhere checks and pays from their own wallet, with a receipt anyone can verify. A Vite 8 multi-page progressive web app in strict TypeScript, without a UI framework ([ADR 0006](../../docs/adr/0006-vanilla-typescript-port-at-parity.md)), in v1's "Precision Terminal" design language. Production: `https://paylink-mg.pages.dev` ([Cloudflare Pages runbook](../../docs/runbooks/cloudflare-pages.md), [ADR 0014](../../docs/adr/0014-web-app-and-single-pages-site.md)).

## Routes

| Route | Who | What it does |
|---|---|---|
| `/` | payee | The terminal: network (band selector), amount (or open amount), memo, number of payments, expiry; a signing display that states exactly what the wallet will sign; then the printed card with its QR code, copy, WhatsApp, the system share sheet, print (A6) and "show on the till". No transaction, no gas. |
| `/pay/#2.<chainId>.<inv>.<sig>[.<memo>]` | payer | The bill in a dark display window and four lamps read from the chain: **signature valid** (the payee's, with the contract's own dispatch), **right network** (the wallet's), **genuine PayLink contract** (registry address, masked runtime hash, EIP-712 immutables), **still payable** (window, cancelled, sold out, by chain time). Any red lamp locks the Pay key; an unknown one offers to check again. The payee's address grouped by four, a saved name or the amber first-payment warning, the memo as the sender's untrusted note, the ariary estimate (Monad, `all`). The PaymentRouter picks the path: **gasless** (one EIP-3009 signature, the relayer submits `payWithAuthorization`), the same authorisation with the payer's own gas when the relayer refuses, "Pay with Base" (EIP-5792 `[approve, pay]`) for smart accounts, `payWithPermit` or an exact-amount `approve` then `pay`. A PayLink key's payer first reads the **signing display** (what the fingerprint approves) and can get test AUSD through the relayer's faucet. The receipt is verified before "Approved · settled in N.N s". |
| `/r/#2.<chainId>.<txHash>.<logIndex>[…]` | anyone | The receipt slip, re-verified on every opening (status, canonical contract, `Paid` event, allowlisted token, and the invoice when attached); confirmed or final; prints on an 80 mm roll or A6. |
| `/ledger/` | payee | The books: invoices signed on this device by the connected account, each state from `statesOf` and chain time, a tally per token, filters, CSV export (RFC 4180, ISO 8601, CAIP-2/CAIP-10, formula-safe), copy, view, till, and cancel in two presses: gasless (`Cancel` signed, `cancelBySig` through the relayer) or one `cancel` transaction. Receipts of payments made from this device. |
| `/send/` | both | **Your receive card** (the account's open-amount, unlimited link as the printable card with its QR code, WhatsApp, print, watch on the till) and the address book: a contact is a name on an address plus their receive card, checked against the registry before it is saved; "Send" opens their card, where the payer types any amount; the pay view then shows "Saved as …". |
| `/till/` (`#<invoice>` to arm it) | payee | The counter display: big condensed numerals, an LED and a chime. Armed, it lights only for a verified `Paid` of that invoice at its amount; watching, for every verified payment to the payee. Polls `eth_getLogs` from `head − 10` every second (under Monad's 100-block cap). Full screen and screen wake lock. |
| `/status/` | anyone | Each chain of the edition checked live (RPC, genuine release), the relayer and indexer from `/config.json`, the build, configuration, storage and offline mode. |
| `404.html` | anyone | Served by Pages for unknown paths. |

The editions `monad` and `base` serve the same routes under `/monad/` and `/base/` ([ADR 0008](../../docs/adr/0008-editions.md)); `?chain=` picks among the edition's own chains only.

## Layout

| Path | Contents |
|---|---|
| `src/editions/` | `EditionProfile`: the three extension points (account layers, default token, payment rails) and the profile of each edition |
| `src/accounts/` | `AccountProvider` / `AccountLayer`; EIP-6963 discovery with EIP-3326 switch, EIP-3085 add from the registry and EIP-5792 batches; the passkey layer and its Mera chunk |
| `src/rails/` | `PaymentRail`; the wallet rail (`permit`, `approve-pay`, `native`), the authorisation rails (relayed, own gas) and the EIP-5792 batch rail, with registry-clamped gas limits |
| `src/read/` | the read model: the four checks, the ledger from `statesOf`, the CSV export |
| `src/store/` | the device store: IndexedDB (`idb`), every record re-validated on read, memory fallback |
| `src/core/` | runtime configuration (`/config.json`, zod), chain clients over the registry's RPCs, the relayer client, the display-only exchange rate (`/fx.json`), the edition registry, formatting, links, preferences, errors |
| `src/ui/` | the typed `h()` builder and the Precision Terminal pieces: lamps, grouped addresses, band selector, segmented keys, ticket, receipt slip, QR code (SVG), toasts, print |
| `src/app/` | boot, the page frame, the session (remembered wallet or PayLink key), the wallet picker and the KeyCard, the payer's facts for the router (`payer.ts`), test funds (`funds.ts`), cancelling (`cancel.ts`) |
| `src/pages/` | one module per route; `src/entries/` boots each page |
| `src/pwa/` | service worker registration under Trusted Types, update prompt |
| `public/` | `config.json`, `_headers` (generated), icons, `robots.txt` |
| `scripts/` | `build.ts` (editions, assembly, gates), `site.ts` (the site: `/arc/`, `/deploy/`, `_headers`), `headers.ts`, `cloudflare-pages.sh` (the Pages build command) |

## Extension points (editions)

| Varies | Interface | T0 (today) | T1 |
|---|---|---|---|
| Who signs | `AccountLayer` → `AccountProvider` (`src/accounts/types.ts`) | EIP-6963 injected wallets | **built:** Mera passkeys (`passkey.ts`, `mera.ts`; the Monad edition's only layer, one fingerprint per signature, behind a signing display); EIP-5792 `atomicCapability`/`sendCalls` on injected wallets (Base: smart-account payers) |
| Default token | `EditionProfile.defaultToken(chain)` | the registry's default token | per edition (AUSD on Monad, USDC on Base) |
| How a payment reaches the chain | `PaymentRail` (`src/rails/types.ts`) | the payer's wallet | **built:** `relayedAuthorizationRail` and `selfAuthorizationRail` (`authorization.ts`, invoice spec §8.6), `batchRail` (`batch.ts`, EIP-5792) |

Only `src/editions/index.ts` chooses implementations; pages ask the profile. What each edition gets, and why "Pay with Base" uses EIP-5792 on the payer's own wallet rather than a bundled SDK, is [ADR 0015](../../docs/adr/0015-editions-t1-passkeys-gasless-rails.md).

| Edition | Account layer | Rails, best first | Extras |
|---|---|---|---|
| `monad` (`/monad/`) | PayLink keys (Mera passkeys) only | relayed authorisation, own-gas authorisation, wallet | relayer onboarding (test AUSD), gasless cancel, ariary estimate |
| `base` (`/base/`) | EIP-6963 wallets | relayed authorisation (EOAs), EIP-5792 batch (smart accounts), own-gas authorisation, wallet | link to Circle's faucet |
| `all` (`/`) | EIP-6963 wallets | relayed authorisation, wallet | ariary estimate |

## Commands

```bash
pnpm --filter @paylink/web dev            # Vite dev server
pnpm --filter @paylink/web test           # Vitest (happy-dom, fake-indexeddb)
pnpm --filter @paylink/web test:coverage
pnpm --filter @paylink/web typecheck
pnpm --filter @paylink/web lint
pnpm --filter @paylink/web run headers    # regenerate public/_headers after a config.json or registry change
node apps/web/scripts/fx.ts               # refresh public/fx.json (display-only exchange rates; checks the npm tarball integrity)
pnpm --filter @paylink/web build          # the whole site into dist/ (as Cloudflare Pages builds it)
bash apps/web/scripts/cloudflare-pages.sh # the Pages build command, from the repository root
```

End to end: `pnpm --filter @paylink/e2e test` builds `dist-e2e/` (`build --e2e`, with a local chain swapped into the registry) and runs `e2e/specs/app.spec.ts` against anvil under the production headers; `e2e/specs/editions.spec.ts` builds `dist-e2e-editions/` and runs the Monad and Base editions against two anvil chains, the relayer process and Chromium's WebAuthn virtual authenticator with PRF ([e2e README](../../e2e/README.md)).

## Security

- **Addresses come from the registry only** (`@paylink/chains`), scoped to the edition; links for other chains are refused. `/config.json` may add endpoints and a banner, never an address, and is validated strictly.
- **No HTML sinks.** `h()` creates elements and text nodes, sets allowlisted attributes, refuses `on*`, `style`, `srcdoc`, `javascript:` and protocol-relative URLs; ESLint bans every HTML sink.
- **Headers** (`public/_headers`): `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `connect-src` limited to the registry RPCs and `/config.json` endpoints, Trusted Types with the single `paylink-sw` policy, `frame-ancestors 'none'` plus a JavaScript frame lock, `no-referrer`, a closed `Permissions-Policy`. The policy is repeated as a `<meta>` in every page.
- **Gas limits** are `clamp(estimate × 1.10, floor, ceiling)` from the registry; allowances are exact, never unlimited.
- **PayLink keys** (Monad): the rpId is fixed at build time (`paylink-mg.pages.dev`) and ceremonies run only on that exact host, so a preview deployment cannot use a production key; the key exists only for one signature; the device stores the credential ID, the address and a label, nothing secret.
- **Retry safety** (invoice spec §8.6): an EIP-3009 authorisation is stored in IndexedDB before it is sent anywhere; a retry resubmits it; settlement is read from the chain, not from the relayer.
- **Untrusted text**: memos are stripped of bidi and control characters and shown as the sender's note; copies come from canonical state.

The threat model's web rows (T-04, T-05, T-06, T-25, T-28, T-29, T-35, T-44) cite the tests above.
