---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering); PRF experiment riskfirst-prf (headless PRF in Chromium 141, C)
informed: users, contributors
---

# ADR 0005: Dedicated web origin and passkey rpId

## Context and problem statement

In the Monad edition, accounts are Mera passkeys. The SDK derives a secp256k1 key from the WebAuthn **PRF** output and keeps it in page memory to sign. Mera keys are secp256k1, not P-256 (PAYLINK-V2-SPEC §2.1). Whoever runs JavaScript on the app's origin can therefore sign as the user, and the origin's security **is** the account's security.

Three web-platform facts constrain the choice:

- **A passkey belongs to its rpId**, which is a registrable suffix of the origin's host, and cannot move. Changing the rpId after users created passkeys means every user loses access to those keys.
- **Same-origin pages share storage.** `nambininasafidison.github.io` serves every GitHub Pages site of that account (`/paylink/`, `/ranoka/`, …), which share one origin: IndexedDB, localStorage, service-worker scope rules, and any passkey bound to that rpId. A bug or compromise in any other repository's page would reach PayLink's keys and books.
- **GitHub Pages cannot set response headers.** A `<meta>` CSP cannot express `frame-ancestors`, and there is no Permissions-Policy, Referrer-Policy or `nosniff` control.

Where should v2 be served, and what is the rpId?

## Decision drivers

- Isolation of passkey material, IndexedDB and storage from every other site.
- Real HTTP security headers: CSP with `frame-ancestors`, Trusted Types (T1), Permissions-Policy.
- An rpId that never has to change.
- Free, with no card: the owner may not be able to pay for services.
- The v1 URL `/paylink/web/` on GitHub Pages must keep working ([ADR 0010](0010-arc-stays-on-v1.md)).

## Considered options

- **A.** A dedicated Cloudflare Pages project `<app>.pages.dev`, production only, previews disabled, `_headers` for security headers, rpId `<app>.pages.dev`.
- **B.** A sub-path of the existing GitHub Pages site, `nambininasafidison.github.io/paylink/v2/`.
- **C.** A custom domain.
- **D.** A new free GitHub organisation whose `<org>.github.io` hosts only PayLink.
- **E.** Another static host (Vercel Hobby, Netlify or Deno Deploy).

## Decision outcome

Chosen option: **A**, with **D** as the documented fallback if Cloudflare sign-up without a card fails. A is the only free option that gives a dedicated site **and** real response headers.

- `pages.dev` is on the Public Suffix List (**C**, `publicsuffix/list` fetched on 2026-10-05), so `<app>.pages.dev` is its own site and rpId.
- **Preview deployments are disabled.** A preview at `<hash>.<app>.pages.dev` is a subdomain of the rpId and could assert it, which would let unreviewed preview code use production passkeys.
- The rpId is **fixed before the first passkey is created**. The recommended name is `paylink-mg`; whether it is available is unknown until the owner checks.
- Deploys run only from `main` through GitHub Actions (`wrangler pages deploy`, the action pinned by SHA), with a scoped API token.

### Consequences

- Good, because a compromise elsewhere in the owner's GitHub Pages cannot touch PayLink keys or books.
- Good, because the full header set is available: `default-src 'none'`, `frame-ancestors 'none'`, Trusted Types (T1), `Permissions-Policy` with only `publickey-credentials-get=(self)`, `Referrer-Policy: no-referrer` ([ARCHITECTURE §9](../ARCHITECTURE.md#9-client-security-architecture)).
- Bad, because it adds a vendor account and an API token, which must be scoped to "Cloudflare Pages: Edit" and "Workers Scripts: Edit" only, and stored as GitHub secrets.
- Bad, because the rpId is permanent. Moving to a custom domain later requires users to create new passkeys and move funds off the old passkey-derived addresses first. Testnet-only balances make that acceptable for v2.0.
- Bad, because preview deployments cannot be used for review. Reviews use local builds and the e2e production-headers test.
- Neutral, because v1 stays on GitHub Pages, unchanged.

### Confirmation

- An e2e spec loads the production build with the real `_headers` (CSP and, at T1, Trusted Types) and checks that the Pay key is locked when framed.
- The deploy runbook includes a manual check that previews are disabled in the Cloudflare project settings ([deploy runbook](../runbooks/deploy.md)).
- `/status/` shows the deployment state, and CI's `site.yml` deploys only from `main`.

## Pros and cons of the options

### A. Cloudflare Pages, dedicated project (chosen)

- Good, because it gives a dedicated site, real headers, free hosting and Actions-driven deploys.
- Bad, because it needs a vendor account and careful handling of preview deployments.

### B. Sub-path of the existing GitHub Pages site

- Good, because it needs no new account and fits the existing workflow.
- Bad, because the origin, storage and rpId are shared with every other repository's site, and response headers are impossible.

### C. Custom domain

- Good, because it is the best long-term identity, and the rpId would be stable across hosts.
- Bad, because it needs payment (a card), and is explicitly not done before Oct 12 (PAYLINK-V2-SPEC §2.7).

### D. Dedicated GitHub organisation site (fallback)

- Good, because it is free and gives a dedicated origin and rpId: `github.io` is also on the Public Suffix List (**C**, `publicsuffix/list` re-read on 2026-10-07), so `<org>.github.io` is a site of its own. The problem with option B is the origin shared by every repository of one account, not the site.
- Bad, because there are no response headers: only a meta CSP (no `frame-ancestors`) plus the JavaScript frame lock. The relayer then needs another host.

### E. Other hosts

- Good, because they have header support.
- Bad, because their free-tier terms and preview-deployment defaults are unverified (**U**), and nothing is gained over A.

## More information

- PAYLINK-V2-SPEC §0 decision 7, §3.6 (client security), §3.11, §5 threats 5 and 6.
- [THREAT_MODEL T-05 and T-06](../security/THREAT_MODEL.md#t-05).
