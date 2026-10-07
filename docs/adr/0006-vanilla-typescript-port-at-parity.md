---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering); 2026-10-05 toolcheck (Vite 8.3.2, TypeScript 6.0.3, typescript-eslint 8.71.1)
informed: contributors
---

# ADR 0006: Port the v1 web app to vanilla TypeScript at parity (no framework)

## Context and problem statement

The v1 web app (`web/app.js`, 426 lines of vanilla JavaScript, with ethers 6 bundled locally) carries the "Precision Terminal" design system: display windows, LEDs, keys, tickets, receipts and documented contrast ratios. It also carries accessibility work: a live-region announcer, keyboard flows and visible focus. Its DOM builder `h()` only ever sets `textContent`.

v2 needs typed code shared with the SDK, the viem stack, several routes and editions, a PWA, and a strict bundle budget: at most 110 kB of gzipped JavaScript on the pay route. The schedule allows about five days before the T1 feature freeze.

Do we rewrite the UI in a framework or port it?

## Decision drivers

- Keep the v1 design and accessibility work intact.
- Small bundles on slow mobile networks (Lighthouse performance ≥ 0.9, LCP ≤ 2.5 s on slow 4G).
- No DOM injection sinks, which matters because passkey-derived keys live in page memory ([ADR 0005](0005-dedicated-origin-and-rpid.md)).
- Low schedule risk: change one thing at a time, guarded by tests.
- Strict typing shared with the SDK.

## Considered options

- **A.** Port `web/app.js` to TypeScript at **parity first**, guarded by Playwright; then swap ethers for viem; then add features. No framework; keep and type the `h()` builder.
- **B.** Rewrite in React or Preact.
- **C.** Keep v1's JavaScript and bolt the v2 features onto it.
- **D.** Rewrite in Svelte or Solid.

## Decision outcome

Chosen option: **A**, because it preserves the tested design and accessibility, keeps bundles small, and confines risk to one change at a time. React and Preact rewrites are explicitly excluded before Oct 12 (PAYLINK-V2-SPEC §2.7).

Implementation rules:

- Vite 8.3.2 multi-page app, TypeScript 6.0.3 (typescript-eslint 8.71.1 does not support TypeScript 7), viem 2.57.3.
- `h()` stays the only DOM builder and sets `textContent` only. ESLint bans `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and `new Function`.
- QR codes are drawn with `createElementNS`.
- `@category-labs/mera` and `@base-org/account` are lazy chunks in their own editions.
- CSS is organised as `@layer reset, tokens, base, components, utilities`, and `tokens.css` copies v1's tokens verbatim.

### Consequences

- Good, because the v1 look, its contrast documentation and its accessibility behaviour carry over unchanged.
- Good, because the bundle stays small with no framework runtime, and per-edition tree shaking works.
- Good, because the absence of HTML-string rendering removes a whole class of XSS sinks, and lint enforces it.
- Bad, because state management and routing are hand-written. The multi-page split keeps each page simple.
- Bad, because there are fewer off-the-shelf components and contributors used to React have a learning curve.
- Bad, because the parity port is effort that does not add features, but it is what makes later changes safe.

### Confirmation

- Playwright parity specs (create, pay, receipt, ledger) pass on the port before viem is swapped in, and again after.
- `size-limit` gates the pay route at 110 kB of gzipped JavaScript.
- ESLint `strictTypeChecked` with DOM-sink bans runs as a blocking gate.
- axe reports zero violations on every route, in light and dark themes.

## Pros and cons of the options

### A. Vanilla TypeScript port at parity (chosen)

- Good, because it has the lowest risk, the smallest bundle and the strongest sink control, and keeps the design.
- Bad, because UI plumbing is manual.

### B. React or Preact rewrite

- Good, because of the large ecosystem and familiar component patterns.
- Bad, because a rewrite under deadline puts the design and accessibility at risk, adds a runtime (Preact is small, React is not), and makes `dangerouslySetInnerHTML`-style sinks possible. It is excluded by the plan.

### C. Keep v1 JavaScript

- Good, because it needs no port.
- Bad, because there are no types, the ethers bundle is heavy (`web/ethers.umd.min.js` is about 527 kB), and the SDK cannot be shared.

### D. Svelte or Solid

- Good, because both are small and fast.
- Bad, because a new toolchain and compiler would have to be learned under deadline, and their compatibility with the Mera and Base Account SDKs is unverified.

## More information

- PAYLINK-V2-SPEC §2.7, §3.6, §3.10, §4.4.
- Related: [ADR 0008](0008-editions.md) (editions).
