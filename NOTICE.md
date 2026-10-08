# Third-party notices

PayLink is released under the [MIT License](LICENSE), © 2026 nambininasafidison. It includes, links to or is built with the third-party components listed below, each under its own licence. Licence identifiers were read from the packages' own metadata (npm registry, PyPI or the files shipped in this repository) on 2026-10-05.

v2 packages under `packages/` and `apps/` are added during the build window. Their exact versions come from the pnpm catalog in [`pnpm-workspace.yaml`](pnpm-workspace.yaml), and this file must be updated in the same pull request that adds a dependency ([CONTRIBUTING.md](CONTRIBUTING.md)).

## 1. Distributed with the v1 web app (`web/`)

| Component | Version | Licence | Copyright and notes | Where |
|---|---|---|---|---|
| ethers | 6.17.0 | MIT | © Richard Moore | `web/ethers.umd.min.js` (vendored bundle) |
| QR Code Generator for JavaScript | as vendored | MIT | © 2009 Kazuhiko Arase. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED. | `web/qrcode.js` |
| Archivo (variable, Latin subset) | as vendored | SIL Open Font License 1.1 | © 2020 The Archivo Project Authors (<https://github.com/Omnibus-Type/Archivo>) | `web/fonts/archivo-var-latin.woff2`; licence text in `web/fonts/OFL-Archivo.txt` |
| Martian Mono (400 and 600, Latin subset) | as vendored | SIL Open Font License 1.1 | © 2020 The Martian Mono Project Authors (<https://github.com/evilmartians/mono>) | `web/fonts/martian-mono-400-latin.woff2`, `web/fonts/martian-mono-600-latin.woff2`; licence text in `web/fonts/OFL-MartianMono.txt` |

**Fonts.** The OFL allows bundling, embedding and redistributing the fonts with software, provided that the copyright notice and licence text travel with them and the fonts are not sold on their own. The v2 design package (`packages/design`) self-hosts the same fonts and must ship the same two OFL texts next to the `.woff2` files. Subsetting a font counts as a modification under the OFL. Neither copyright line declares a Reserved Font Name, so the subsets can keep their original family names. Re-check this if the font sources are ever updated.

### 1.1 Distributed with the v2 deploy page (`web/v2/deploy/`)

The page links v1's `web/paylink.css` and fonts above. Its one library is a vendored, unminified bundle built from the pinned packages by `tools/deploy-page/scripts/vendor.ts`; the licence texts ship next to it in `web/v2/deploy/vendor/LICENSES.txt` and the checksums in `web/v2/deploy/vendor/SHA256SUMS`.

| Component | Version | Licence | Where |
|---|---|---|---|
| viem (18 utility functions) | 2.57.3 | MIT, © weth, LLC | `web/v2/deploy/vendor/viem.js` |
| abitype (ABI formatting, pulled in by viem) | 1.2.3 | MIT, © weth, LLC | same bundle |
| @noble/hashes (keccak-256) | 1.8.0 | MIT, © Paul Miller | same bundle |

## 2. Compiled into the v2 contract

| Component | Version | Licence | Notes |
|---|---|---|---|
| OpenZeppelin Contracts | 5.3.0 | MIT | `EIP712`, `SignatureChecker`, `ECDSA`, `SafeERC20`, `ReentrancyGuard`, `Address` and their imports, compiled into `PayLinkV2`. One advisory (GHSA-9rcw-c2f9-2j55) affects a module that is not imported ([ADR 0002](docs/adr/0002-one-paris-bytecode-oz-5-3-0.md)). |

## 3. Shipped in the v2 web app, relayer and SDK

| Component | Version | Licence | Used in |
|---|---|---|---|
| viem | 2.57.3 | MIT | SDK, chain registry, web, relayer |
| viem's runtime dependencies: ox, abitype, @noble/curves, @noble/hashes, @scure/bip32, @scure/bip39, isows, ws | as resolved in `pnpm-lock.yaml` | MIT | SDK, chain registry, web, relayer |
| @category-labs/mera (preview) | 0.2.0 | MIT OR Apache-2.0, © Category Labs | web, Monad edition (lazy chunk): passkey ceremonies and signing sessions |
| Mera's dependencies: @noble/curves, @noble/hashes, @scure/base | 2.2.0 each | MIT, © Paul Miller | web, Monad edition (lazy chunk) |
| @scure/bip39, @scure/bip32 (direct, the versions viem resolves) | 1.6.0, 1.7.0 | MIT, © Paul Miller | web, Monad edition (lazy chunk): the BIP-39/BIP-44 derivation of Mera's recipe |
| qrcode-generator | 2.0.4 | MIT, © Kazuhiko Arase | web: the same library as v1's `web/qrcode.js` |
| idb | 8.0.3 | ISC, © Jake Archibald | web: the device store |
| vite-plugin-pwa (Workbox runtime) | 2.0.0 (Workbox 7.4.1 as resolved in `pnpm-lock.yaml`) | MIT | web: the generated service worker inlines the Workbox runtime |
| hono | 4.13.13 | MIT | relayer |
| zod | 4.6.5 | MIT | web (`zod/mini`, `/config.json` and device-store validation), relayer |

### 3.1 Distributed in the relayer Worker bundle (`apps/relayer/deploy/`)

Cloudflare deploys the committed, unminified bundle `apps/relayer/deploy/worker.js`, built from the pinned packages by `apps/relayer/scripts/build.ts`, which refuses any other package or licence. The licence texts ship next to it in `apps/relayer/deploy/LICENSES.txt` and the checksums in `apps/relayer/deploy/SHA256SUMS`.

| Component | Version | Licence |
|---|---|---|
| hono | 4.13.13 | MIT, © Yusuke Wada and Hono contributors |
| zod | 4.6.5 | MIT, © Colin McDonnell |
| viem | 2.57.3 | MIT, © weth, LLC |
| ox | 0.14.45 | MIT, © wevm |
| abitype | 1.2.3 | MIT, © weth, LLC |
| @noble/curves | 1.9.1 | MIT, © Paul Miller |
| @noble/hashes | 1.8.0 | MIT, © Paul Miller |

### 3.2 Distributed in the web site build (`apps/web/dist`)

The site Cloudflare Pages serves holds the v2 app, the frozen v1 app under `/arc/` (the components of §1, unchanged) and the deploy kit under `/deploy/` and `/v2/deploy/` (§1.1, unchanged). The v2 app's own bundles contain:

| Component | Version | Licence | Where |
|---|---|---|---|
| Archivo (variable, Latin subset), Martian Mono (400 and 600, Latin subset) | v1's files, byte for byte | SIL Open Font License 1.1 | `packages/design/fonts/` with `OFL-Archivo.txt` and `OFL-MartianMono.txt`; hashed copies in `assets/` |
| viem and its runtime dependencies (the functions the app imports) | 2.57.3 | MIT | `assets/*.js` |
| qrcode-generator, idb, zod (`zod/mini`) | 2.0.4, 8.0.3, 4.6.5 | MIT, ISC, MIT | `assets/*.js` |
| @category-labs/mera, @noble/curves 2.2.0, @noble/hashes 2.2.0, @scure/base 2.2.0, @scure/bip39 1.6.0 (English wordlist), @scure/bip32 1.7.0 | as above | MIT OR Apache-2.0; MIT | `monad/assets/mera-*.js` and its chunks, loaded only when a PayLink key signs |
| Exchange-rate snapshot (USD → MGA, EUR) from fawazahmed0/exchange-api, as published on npm (`@fawazahmed0/currency-api`) | the day in `fx.json` | CC0-1.0 (public domain dedication) | `fx.json`: display-only estimates, labelled with their source and date |
| Workbox runtime | 7.4.1 | MIT | `sw.js` |

The Base edition's "Pay with Base" uses the standard EIP-5792 wallet calls on the payer's own wallet; `@base-org/account` (pinned in the workspace catalogue, Apache-2.0) is **not** shipped ([ADR 0015](docs/adr/0015-editions-t1-passkeys-gasless-rails.md)).

## 4. Indexer: Envio HyperIndex (not open source)

| Component | Version | Licence |
|---|---|---|
| envio (HyperIndex) | 3.12.1 | **Proprietary, not OSI-approved.** The code generator is licensed for non-commercial use. Generated code is under Envio's HyperIndex EULA (`licenses/` in the npm package). |

The EULA (read on 2026-10-05) lets users use, copy, distribute and create derivative works of the generated code, with conditions:

- the generated code may not be offered to third parties as a hosted or managed indexing service;
- licence-key and notice provisions must be respected;
- **products built with the generated code must credit HyperIndex.**

Credit: **This project's indexer (`apps/indexer`) is built with HyperIndex by Envio (<https://envio.dev>).**

`apps/indexer` is an optional cache ([ADR 0009](docs/adr/0009-read-model-chain-device-indexer.md)). Before any commercial use (for example the "PayLink Business" hypothesis), the owner must review Envio's licences or replace the indexer.

## 5. Development and test tools (not distributed with the product)

| Tool | Version | Licence |
|---|---|---|
| Foundry (forge, cast, anvil) | 1.8.5 | MIT OR Apache-2.0 |
| forge-std (vendored in `protocol/lib/forge-std`, test only) | v1.17.0 | MIT OR Apache-2.0 (both texts included) |
| Solidity compiler (solc) | 0.8.30 | GPL-3.0. Used as a tool; compiler output is not covered by the compiler's licence. |
| Slither | 0.11.6 | AGPL-3.0. Used as a tool, not distributed. |
| solc-select | 1.2.0 | AGPL-3.0. Used as a tool, not distributed. |
| TypeScript | 6.0.3 | Apache-2.0 |
| Vite | 8.3.2 | MIT |
| Vitest | 5.0.3 | MIT |
| typescript-eslint | 8.71.1 | MIT |
| ESLint and @eslint/js | 10.12.0, 10.0.1 | MIT |
| fast-check | 4.10.2 | MIT |
| @types/node | 22.20.5 | MIT |
| @vitest/coverage-v8 | 5.0.3 | MIT |
| Playwright (@playwright/test) | 1.56.1 | Apache-2.0 |
| axe-core | 4.13.0 | MPL-2.0 (e2e only, injected unmodified into the page under test) |
| rolldown | 1.2.12 | MIT (bundles the deploy page's vendored viem subset) |
| wrangler | 4.148.0 | MIT OR Apache-2.0 (relayer: deploy-config check and `wrangler dev` tests; the Git integration deploys with the same version) |
| miniflare, @cloudflare/workers-types | 5.20261006.0-alpha, 5.20261006.1 | MIT; MIT OR Apache-2.0 (relayer tests and Worker type-checking) |
| happy-dom | 20.14.5 | MIT (the web app's unit-test DOM) |
| fake-indexeddb | 6.2.5 | Apache-2.0 (the web app's device-store tests) |
| @hono/node-server | 2.1.3 | MIT (the relayer's Node adapter for local e2e and demos; not in the Worker bundle) |
| size-limit | exact pin | MIT |
| v1 tooling: solc-js, ganache | 0.8.26, 7.9.2 | MIT, MIT |

## 6. Standards and reference material

- **SCSVS v2**, the Smart Contract Security Verification Standard by Composable Security, © Damian Rusinek and Paweł Kuryłowicz, licensed under CC BY-SA 4.0. [docs/security/self-review.md](docs/security/self-review.md) references its requirements by identifier and **paraphrases** them; it does not reproduce the standard's text.
- **SWC Registry** (SmartContractSecurity). Weakness identifiers and titles are referenced in the self-review.
- EIPs and ERCs are referenced by number and link. RFCs are referenced by number.

## 7. Trademarks

Monad, Base, Arbitrum, Mezo, Arc, Circle, USDC, AUSD, Agora, Mera, PayPal, Envio, Cloudflare, GitHub and WhatsApp are trademarks of their respective owners. They are used here only to describe compatibility. No affiliation or endorsement is implied.
