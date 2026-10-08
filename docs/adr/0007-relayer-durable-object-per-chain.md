---
status: accepted
date: 2026-10-05
decision-makers: nambininasafidison (owner)
consulted: Claude Code (engineering)
informed: contributors, relayer operators
---

# ADR 0007: Relayer on Cloudflare Workers with one Durable Object per chain

## Context and problem statement

Gasless payments and cancellations need a service that submits `payWithAuthorization` and `cancelBySig` transactions from a funded hot key. A single sender key per chain must keep its transaction nonces strictly ordered, even with concurrent requests. Stuck transactions must be replaced with the same nonce and a higher fee. Abuse must be capped per IP, per payer and per day, and against a daily gas budget.

Chain specifics:

- Monad charges the **gas limit**, not the gas used (**C**).
- An EOA cannot spend below a 10-MON reserve (**C**). The relayer therefore must never send value, and the gas limit must be explicit.

The owner cannot pay for infrastructure. Thanks to the payment binding ([ADR 0003](0003-bind-3009-nonce-to-payment.md)), the relayer is trusted for availability only.

Where and how should the relayer run?

## Decision drivers

- Serialised nonce management per chain, with stuck-transaction replacement.
- Free hosting, with no card.
- Keys stored as platform secrets, never in GitHub, the sandbox or chat.
- Minimal surface: two selectors, `value = 0`, simulation before sending.
- Testable locally and in e2e without the cloud.

## Considered options

- **A.** A Cloudflare Worker (Hono, zod, viem) with one Durable Object `ChainSender` per `chainId`, which serialises the nonce, the queue, replacement, counters and the gas budget.
- **B.** A stateless Worker: `pending` nonce, retry on "nonce too low", concurrency of 1 by design.
- **C.** A conventional server (VPS) with Redis or a database.
- **D.** A third-party relay service.
- **E.** ERC-4337 bundler and paymaster.

## Decision outcome

Chosen option: **A**, with **B** as the fallback if Durable Objects are unavailable on the Workers free plan (**L**; check at sign-up). Option A serialises nonce handling per chain at no cost, and keeps the relayer a small, auditable program.

**Endpoints:** `POST /v1/:chainId/pay` (`payWithAuthorization` only), `POST /v1/:chainId/cancel` (`cancelBySig` only), `POST /v1/10143/onboard` (testnet AUSD faucet, capped), `GET /v1/health`.

**Pipeline for every request:**

1. zod validation;
2. registry and canonical-deployment check, the two allowed selectors only, `value == 0`;
3. local payee-signature check with the contract's dispatch, recomputation of the bound nonce, and the payer's EIP-3009 signature checked with the token's dispatch (ERC-1271 for a payer with code; `checkRelayPayRequest` in `@paylink/sdk`); every time bound the call carries (`validBefore`, `validUntil`, a cancellation's `deadline`) must still hold `relay.minRemainingSeconds` (120 s, per chain in the registry) after the block simulated against;
4. token, amount and minimum-amount allowlist;
5. per-IP, per-payer and per-day caps, and the daily gas budget;
6. admission against post-simulation reverts (`RelayAdmissionLedger` in `@paylink/sdk`, state persisted by the Durable Object): the time margin again on the relayer's clock; at most 1 relay in flight per invoice key, per payee and per payer, and 4 per token; at most 20 relays an hour per requester; bans of the party a post-simulation revert is attributed to (step 9) for 24 hours; requesters identified by IPv4 address or IPv6 /64 (`requesterFromIp`), with a strike per attributable revert (3 strikes: banned); payees with code only from a code-hash allowlist; payers with code not at all;
7. `eth_call` simulation, repeated against the pending block immediately before broadcast together with the time margin (`assertRelayWindow`);
8. send with `gasLimit = clamp(estimate × 1.10, floor, ceiling)`;
9. return the transaction hash, then release the admission ticket with the receipt's outcome: settled; dropped (never included); or, for a revert, the cause established from chain evidence by `attributeRelayRevert` (the revert data from a trace or from `replayRevertData`), so that only the party the evidence names is penalised and a payment that landed by another route penalises nobody.

Amended on 2026-10-07 (pre-freeze audit): steps 3 and 6 and the pending-block re-simulation were added after a review showed that a payee (with or without code) or a payer can make a simulated relay revert on inclusion at the relayer's expense, so the simulation alone does not protect the gas budget ([THREAT_MODEL T-03, T-13, T-46](../security/THREAT_MODEL.md#t-13)).

Amended again on 2026-10-07 (re-audit, finding A-04): the time margin in steps 3, 6 and 7, attribution by cause in step 9, requester identities per IPv6 /64 and the per-requester rate in step 6. Before, a time bound one second ahead passed every check and the simulation and reverted on inclusion with no attacker transaction, and every post-simulation revert banned the key, the payee and the payer together, so a sybil payer could shut an honest merchant out of the gasless path for a day ([THREAT_MODEL T-03, T-13](../security/THREAT_MODEL.md#t-03), [spec §13.3](../spec/paylink-invoice-v2.md#133-relayers)).

**Key handling:** `RELAYER_PK` is a testnet-only key, set as a Cloudflare secret through the dashboard. The balance stays at about 2 MON at most. The key is never EIP-7702-delegated.

Amended on 2026-10-08 (implementation, `apps/relayer`), without changing the decision:

- **Deployment.** There is no `relayer.yml` workflow and no Cloudflare API token in GitHub: the owner's Cloudflare account has none, and the development sandbox cannot reach `api.cloudflare.com` (2026-10-07). Cloudflare's Git integration (Workers Builds) deploys from `main`, with `apps/relayer/deploy` as its root and `npx wrangler@4.148.0 deploy` as its only command. That folder holds `wrangler.toml` and the Worker bundle, built by `apps/relayer/scripts/build.ts` from the lockfile's exact packages (not minified, every region named `package@version/path`, seven allowlisted MIT packages), committed, and uploaded byte for byte (`no_bundle`). Nothing of ours is installed or built on Cloudflare, and what runs is the file that was reviewed: `build:check` and `apps/relayer/test/unit/deploy.test.ts` fail when it differs from a rebuild. Steps for the owner and a browser-assistant prompt: [relayer runbook](../runbooks/relayer.md).
- **Durable Objects** are SQLite-backed (`new_sqlite_classes`), the kind the Workers Free plan offers (**L**), so option B is not built. The front Worker only validates and routes (under 1 ms of CPU per request); the signature checks and signing run inside the Durable Object.
- **Onboarding** calls only the registry faucet's `requestFunds(address)` (Monad testnet). The fallback transfer from a relayer-held AUSD inventory is **not** built: the relayer never signs a token transfer. `assertSendable` is the single signing choke point: `payWithAuthorization` and `cancelBySig` on the canonical deployment, the faucet call, or a zero-value self-transfer that voids a stuck nonce; value always 0; testnets only; never from an account with code.
- **Stuck transactions** are re-sent with the same nonce and fees × 1.25 every 30 s, at most three times; after that, or once the call's time bounds have passed, the nonce is voided with a zero-value self-transfer (21,000 gas) instead of paying the full limit for a certain revert.
- **Abuse limits** (code, not configuration): token buckets of 30 requests a minute per requester and 600 per chain; daily caps per chain and per payer, and for onboarding per address and per requester; a daily gas budget (1 MON on Monad testnet, 0.005 ETH on each Sepolia chain), reserved at `gasLimit × maxFeePerGas` until the receipt settles the cost.
- **CORS** answers only `https://paylink-mg.pages.dev`; any other `Origin` is refused with 403 before anything runs ([THREAT_MODEL T-48](../security/THREAT_MODEL.md#t-48)).

Amended again on 2026-10-08 (review): relays that **succeed** shared one daily budget, so one requester could spend it with self-dealing one-cent payments or cancellations of throwaway invoices, and the onboarding cap alone (100 drips) could cost more than the whole day. The budget is now split by kind of transaction (Monad: 0.6 MON payments, 0.1 MON cancellations, 0.3 MON onboarding, the last sized to its cap of 15 drips); one requester may spend at most a fifth of each share per UTC day at the expected price and make at most 10 relays; a payer at most 10 relays, a payee at most 20 relayed payments received and 3 gasless cancellations a day. The counters persist in the Durable Object's state for the day ([THREAT_MODEL T-03, T-33](../security/THREAT_MODEL.md#t-03)). CORS no longer admits the deployment hosts `https://<hash>.paylink-mg.pages.dev` and branch aliases, where a build withdrawn after an incident stays reachable ([incident response PB-2](../security/incident-response.md)). Logs are JSON lines without keys, bodies, signatures or IP addresses ([T-38](../security/THREAT_MODEL.md#t-38)).

### Consequences

- Good, because nonce ordering, replacement (same nonce, fee × 1.25 after 30 s) and the counters are consistent per chain, without an external database.
- Good, because it is free, runs at the edge, and has a Node adapter for e2e tests and local demo recording.
- Good, because the worst case of compromise is bounded. A stolen key can spend at most the gas balance; it cannot redirect payments (I8).
- Bad, because the relayer is a single point of **availability**. The PWA always offers self-submission ([THREAT_MODEL T-02](../security/THREAT_MODEL.md#t-02)).
- Bad, because it depends on Cloudflare and on the Durable Objects free-plan terms (**L**).
- Bad, because the hot key needs topping up from faucets during judging windows (keep-alive duty).

### Confirmation

- Relayer unit tests run through Hono's `app.request()` in Node, and integration tests run the Node adapter on anvil with the release build, with coverage of at least 85 % (`apps/relayer/test/`; the bundle itself runs in workerd in `apps/relayer/test/integration/worker.test.ts`).
- Tests reject other selectors, non-zero value, unknown chains and deployments, a tampered nonce, cap overruns and failed simulations.
- Tests replay the post-simulation revert cases on anvil (payee `cancel` under queued relays; an ERC-1271 payee that toggles; a payer that delegates; a payer that cancels its authorisation; the same authorisation landing first; a sold-out race; a relay mined past its margin) and show that each reverts at most one relay and that the attribution names, and bans, only what caused it. The admission policy itself is tested in `packages/sdk/test/relay-admission.test.ts`, `packages/sdk/test/relay-attribution.test.ts`, `packages/sdk/test/relayer.test.ts` (margin) and `packages/sdk/test/audit/A04-time-boundary-ban.test.ts`, and on anvil in `packages/sdk/test/integration/anvil.test.ts`.
- The e2e tests "relayer down → pay with own gas" and "relayer slow, then lands → charged once" pass.
- `/status/` shows the relayer health LED, fed by `GET /v1/health`.

## Pros and cons of the options

### A. Worker with a Durable Object per chain (chosen)

- Good, because it serialises per chain at no cost, with platform secrets.
- Bad, because of vendor lock-in and free-plan uncertainty.

### B. Stateless Worker (fallback)

- Good, because it is simplest and needs no Durable Objects.
- Bad, because of nonce races under concurrency (mitigated by a concurrency of 1 at demo volume), and counters without strong consistency.

### C. VPS with Redis

- Good, because it gives full control.
- Bad, because it costs money (a card), needs operations and patching, and is a bigger attack surface.

### D. Third-party relay service

- Good, because it is managed.
- Bad, because of API keys, unclear support for Monad testnet, a vendor that can censor, and a dependency in the trust story.

### E. ERC-4337 paymaster

- Good, because it is the standard for sponsored smart accounts.
- Bad, because Mera and EOA payers are not 4337 accounts, it needs bundler infrastructure, and it is not needed when EIP-3009 already gives gasless transfers.

## More information

- PAYLINK-V2-SPEC §0 decision 5, §3.7, §3.3.6, §5 threats 1–3.
- [Spec §13.3](../spec/paylink-invoice-v2.md#133-relayers) (relayer requirements).
