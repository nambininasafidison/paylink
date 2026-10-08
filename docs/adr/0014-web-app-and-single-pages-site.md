# ADR 0014: The v2 web app, and one Pages site for v2, its editions, v1 and the deploy kit

- **Status:** accepted
- **Date:** 2026-10-08
- **Deciders:** nambininasafidison (owner), Claude Code (engineering)
- **Related:** PAYLINK-V2-SPEC §3.6, §3.8, §3.9, §3.10, §3.11, §4.4; ADR 0005 (dedicated origin and rpId); ADR 0006 (vanilla TypeScript, no framework); ADR 0008 (editions); ADR 0009 (read model); ADR 0010 (Arc stays on v1); ADR 0013 (browser deploy page)

## Context

- Tier T0 (spec §2.1, §2.2) needs the v2 app live on `https://paylink-mg.pages.dev`: create and sign an invoice, share it (link, QR code, WhatsApp), pay it with `pay` or `payWithPermit` from an injected wallet, a receipt verified on the chain, and the payee's ledger from `statesOf`.
- The Pages project `paylink-mg` is the passkey rpId's origin (ADR 0005). It is Git-connected to this repository and today serves `web/` as is: v1 at `/` and the deploy kit at `/v2/deploy/` (ADR 0013) (**UV**). Its build settings change only from the owner's browser; the sandbox cannot reach Cloudflare's API (**C**).
- `web/` (v1) must stay byte-identical, and v1 must keep a URL for the Arc Microgrants judges (ADR 0010). Links to `/v2/deploy/` have already been sent.
- Editions differ only in the account layer, the default token and the payment rail (ADR 0008). The relayer (`apps/relayer`) and Mera passkeys arrive at T1 and must slot in without touching the pages.
- Monad's public RPCs cap `eth_getLogs` at 100 blocks; Monad charges the gas **limit** (spec §3.3.6).

Questions: how is the app built so that T1 is an addition, not a rewrite; and how does one Pages project serve v2, its editions, v1 and the kit without weakening any of their policies?

## Options

1. **The app.**
   - **A.** A framework SPA (React or Preact): rejected by ADR 0006 and spec §2.7.
   - **B.** A Vite multi-page app in strict TypeScript with the typed `h()` builder, one page per route, the design system and the translations as workspace packages, and the three edition variables as interfaces.
2. **Hosting.**
   - **A.** Separate Pages projects for v1, the kit and v2: a second origin for v1 and the kit, more settings for the owner to keep in step, and the rpId origin would no longer host the deploy kit it links to.
   - **B.** One project, one build, one output folder; each area with its own Content-Security-Policy.
   - **C.** Keep `web/` as the root and put the v2 build inside it: the build output would land in `web/`, a v1 directory, and the app could not own `/`.

## Decision

Options **1B** and **2B**.

1. **Packages.** `@paylink/design` carries v1's tokens verbatim and the Precision Terminal components in `@layer reset, tokens, base, components, utilities`, self-hosted fonts (OFL) and contrast tests. `@paylink/i18n` carries EN, FR and MG with typed keys and placeholders, plurals, `Intl` formatting, a completeness test over every key the SDK can produce, and the Malagasy drafts listed for the founder's review.
2. **Routes.** `/`, `/pay/`, `/r/`, `/ledger/`, `/send/`, `/till/`, `/status/` and `404.html`, each a Vite entry that boots the shared frame (top bar, the terminal, the voices of the lead column, the footer). Payer routes have no mode switch.
3. **Extension points.** `EditionProfile` names the three things an edition may change: `accountLayers` (`AccountLayer`, today EIP-6963 with EIP-3326/3085 from the registry), `defaultToken`, and `rails` (`PaymentRail`, today the payer's wallet: `permit`, then `approve-pay`, never an unlimited allowance). The SDK's PaymentRouter ranks the paths; the payer view uses the best path a ready rail supports. Mera passkeys, Base Account and the relayer rail are new implementations of these interfaces, chosen in `src/editions/index.ts` only.
4. **Read model (ADR 0009).** Chain first: every lamp and status from the registry's RPCs (`statesOf`, chain time, receipts, the masked code hash), never from the wallet's RPC; a transport failure is "unknown", never valid or invalid, and any red lamp locks the Pay key. Device second: IndexedDB through `idb`, every record re-validated when read (zod, then the SDK's strict parser against the registry), memory when storage is refused. The indexer slot exists in `/config.json` and is never authoritative.
5. **Gas.** Every transaction the app sends carries `clamp(eth_estimateGas × 1.10, floor, ceiling)` from `@paylink/chains`; approve, which has no registry bounds, gets the margin only.
6. **Security.** No HTML sink anywhere (ESLint bans; `h()` sets text and allowlisted attributes, refuses `on*`, `style`, `srcdoc` and non-same-origin, non-https URLs); the app's CSP is also written as a `<meta>` in every page; Trusted Types with the single policy `paylink-sw`, which only returns the edition's own `sw.js`; the frame lock in JavaScript; memos stripped of bidi and control characters and labelled as the sender's; copies from canonical state.
7. **PWA.** vite-plugin-pwa `generateSW` with the Workbox runtime inlined (no `importScripts` under Trusted Types), a precache of the edition's own build only, no navigation fallback, `/config.json` and every RPC left to the network, and an update prompt instead of `skipWaiting`.
8. **One site.** `apps/web/scripts/build.ts` builds the `all` edition at `/` and `monad` and `base` under their paths, then `apps/web/scripts/site.ts` copies `web/` (minus `web/v2/` and `web/_headers`) to `/arc/` byte for byte and the kit to `/deploy/` and `/v2/deploy/` (only its two links to v1's stylesheet and fonts rewritten to `/arc/`), and writes `_headers`: the app's policy on `/*`, then for `/arc/*`, `/deploy/*` and `/v2/deploy/*` a detach (`! Content-Security-Policy`) followed by that area's own policy. The same text is committed as `apps/web/public/_headers`; a stale copy fails the build.
9. **Build command.** `bash apps/web/scripts/cloudflare-pages.sh` from the repository root, output `apps/web/dist`, with `NODE_VERSION`, `PNPM_VERSION` and `SKIP_DEPENDENCY_INSTALL` set ([runbook](../runbooks/cloudflare-pages.md)). It installs only `@paylink/web` and its workspace dependencies from the frozen lockfile.

## Consequences

- The owner changes four build settings and three variables once; from then on every push to `main` deploys v2, its editions, v1 and the kit together, and a rollback restores all of them together.
- v1 moves from `/` to `/arc/` on this origin. Its GitHub Pages URL is unchanged, and its bytes are checked at build time (assembly test) and on the served site (e2e).
- The deploy kit stays a separate, build-free page (ADR 0013): two implementations of the release rules (the kit's `lib/core.js` and the SDK) remain until the kit is retired; both are tested against the same records.
- Three editions triple the build (about 7 s in all) and the `_headers` rules; the pay route budget is checked per edition.
- T1 work (Mera, Base Account, relayer rail, indexer history) adds implementations behind the existing interfaces and entries in `/config.json`; pages do not change shape.

## Confirmation

- `pnpm --filter @paylink/web test` (Vitest, happy-dom): the DOM builder's refusals, `/config.json` validation, EIP-6963 discovery and EIP-3326/3085, the session, the device store under fake-indexeddb, the read model and CSV export, the lamps, the wallet rail's gas and approve rules, the error decoder, the UI pieces, every route rendered in EN, FR and MG, and the site assembly and headers; coverage floors on the shared modules.
- `pnpm --filter @paylink/design test` and `pnpm --filter @paylink/i18n test`: tokens equal v1's, contrast ratios, layers, fonts; catalogue completeness and placeholders.
- `pnpm --filter @paylink/e2e test` (`e2e/specs/app.spec.ts`, Playwright on anvil with the release at its CREATE2 address, under the production `_headers`): the hero flow (sign, share, permit payment, receipt, ledger, CSV), the armed till, cancel, an impostor contract, tampered and oversized links, framing, the language switch, axe on every route in light and dark at 1280 and 390 px, Trusted Types without a violation, the service worker offline, and v1 served byte for byte under its own policy.
- `bash apps/web/scripts/cloudflare-pages.sh` from a clean clone with an empty pnpm store ([runbook §9](../runbooks/cloudflare-pages.md#9-reproduce-a-pages-build-locally)).
