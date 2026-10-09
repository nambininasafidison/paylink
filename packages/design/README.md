# @paylink/design

The "Precision Terminal" design system of PayLink v2: the v1 tokens of `web/paylink.css` **copied verbatim**, and v1's components re-cut into cascade layers for the v2 app (`apps/web`). Plain CSS, no build step, no runtime.

## Files

| File | Layer | Contents |
|---|---|---|
| `src/index.css` | — | Declares `@layer reset, tokens, base, components, utilities` once, then imports every part |
| `src/tokens.css` | `tokens` | v1's token block byte for byte (paper and graphite surfaces, `--screen` display windows that stay dark in both themes, `--signal` laterite `#FF5A1F` with `--signal-ink`, `--lcd-ok`, LED colours, slip tokens, `--mono` Martian Mono, `--sans` Archivo), the light, dark-media and `data-theme` sets, plus v2-only tokens that never redefine a v1 one |
| `src/fonts.css` | — | `@font-face` only: Archivo (variable) and Martian Mono 400/600, Latin subsets, `font-display: swap` |
| `src/reset.css`, `src/base.css` | `reset`, `base` | Box model, typography, the focus ring and selection colours |
| `src/components.css` | `components` | Terminal (`.device`, `.plate`), DisplayWindow (`.screen`, `.readout`), Lamp (`.led`, `.lamp`, `.pill`), Key (`.key*`), ReceiveCard (`.ticket`, `.lamba` on printed slips), ReceiptSlip (`.receipt`, `.perf`), LedgerTape (`.links`, `.tally`, `.footing`); new in the same grammar: SigningDisplay, VerificationStrip (`.vstrip`), BandSelector (`.bands`, engraved chain labels with a laterite marker on the active one, never brand colours), TillDisplay, status board; `.sr-only`; v1's reduced-motion and forced-colours switches |
| `src/print.css` | `components` | The print area at 80 mm (receipt roll) and A6 (card) |
| `src/utilities.css` | `utilities` | Small single-purpose helpers (`.mono`, `.tabular`, `.nowrap`, `.anywhere`, …) |
| `fonts/` | — | v1's woff2 files and their OFL licence texts, byte for byte |
| `brand/mark.svg` | — | The master mark for logos and submissions: the app's mark (`apps/web/public/icons/mark.svg`, v1's favicon) drawn on a 1024 grid at exactly ×32, with the laterite dot's LED glow. Inert SVG (no script, no external reference) |
| `brand/social-card.html`, `brand/frame.html` | — | The 1200 × 630 social card and the 390 px phone frame for screenshots, rendered to PNG by `e2e/capture/02-artwork.spec.ts` into `docs/submissions/assets/` |

Use it from a Vite entry: `@import "@paylink/design/index.css";` (the app adds its own rules in the `components` layer).

## Guarantees, enforced by tests

- **Tokens:** the v1 token block, byte for byte; the three theme sets identical to v1's; v2 tokens added without redefining a v1 token; every token in the `tokens` layer (`test/tokens.test.ts`).
- **Palette:** no colour literal outside v1's palette and the tokens; laterite is the only signal colour; v1's reduced-motion and forced-colours switches kept (`test/layers.test.ts`).
- **Contrast:** text pairs reach 4.5:1 and UI component pairs 3:1 in light and dark, and the ratios v1 documents next to its tokens still hold (`test/contrast.test.ts`, WCAG 2.2 AA).
- **Fonts:** exactly v1's files and licence texts; one face per file (`test/fonts.test.ts`).
- **Brand:** the master mark is the app's mark at ×32 with the same colours; every colour of the mark, the card and the frame is a v1 token; the SVG is inert; the templates load only this package's fonts, the mark and the committed screenshots (`test/brand.test.ts`).

The e2e suite checks the result in a browser: axe reports zero WCAG 2.2 AA violations on every route in light and dark, and no route scrolls sideways at 390 px.
