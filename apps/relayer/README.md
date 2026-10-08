# @paylink/relayer

The PayLink v2 gasless relayer ([PAYLINK-V2-SPEC §3.7](../../docs/ARCHITECTURE.md), [ADR 0007](../../docs/adr/0007-relayer-durable-object-per-chain.md), [invoice spec §13.3](../../docs/spec/paylink-invoice-v2.md#133-relayers)). A payer signs one EIP-3009 authorisation and holds no gas token; the relayer submits `payWithAuthorization` from its own throwaway testnet key. It is trusted for **availability only**: the token nonce is bound on-chain to the invoice, payer, amount and reference ([ADR 0003](../../docs/adr/0003-bind-3009-nonce-to-payment.md)), so the relayer can delay or refuse a payment but never redirect it, and the payer can always submit the same authorisation itself.

- **Production:** a Cloudflare Worker with one Durable Object `ChainSender` per chain, at `https://paylink-relayer.raherizonambinina.workers.dev`. Deployed by Cloudflare's Git integration from [`deploy/`](deploy/); the owner's steps are in [docs/runbooks/relayer.md](../../docs/runbooks/relayer.md).
- **Local:** the same app and engine in Node (`src/node/`), for e2e tests and demo recording against anvil.

## Endpoints

| Endpoint | Body | Does |
|---|---|---|
| `POST /v1/{chainId}/pay` | `RelayPayRequest` ([schema](../../docs/spec/paylink-invoice-v2.schema.json), spec §11.2) | `payWithAuthorization` on the chain's canonical PayLinkV2, nothing else |
| `POST /v1/{chainId}/cancel` | `CancelAuthorization` | `cancelBySig` on the canonical PayLinkV2 |
| `POST /v1/{chainId}/onboard` | `{ "chainId": 10143, "address": "0x…" }` | the registry faucet's `requestFunds(address)`: 10,000 test AUSD, **Monad testnet only** |
| `GET /v1/health` | | per chain: state, relayer address and balance, canonical deployment, pending transactions, today's gas budget |

Chains served: the enabled v2 **testnets** of `@paylink/chains` (Monad testnet 10143, Base Sepolia 84532, Arbitrum Sepolia 421614). Mainnets are never served, whatever the registry says. Pay and cancel need the chain's canonical deployment in the registry; until it is recorded, health reports `awaiting-deployment` and those endpoints answer [`chain-not-ready`](#problem-chain-not-ready). Onboarding does not need it.

Success is `202 Accepted` with the transaction hash, before inclusion; clients follow the chain (Monad includes in about a second):

```json
{ "status": "submitted", "kind": "pay", "chainId": 10143, "txHash": "0x…", "duplicate": false, "subject": "0x<invoice key>", "nonce": 7, "gasLimit": "274619" }
```

Resubmitting the same body is safe and expected (spec §8.6): while the relay is pending the answer is `200` with `"status": "pending"`, after it settled `200` with `"status": "settled"`, both with the original `txHash` and `"duplicate": true`. Nothing new is sent.

## Pipeline

Each relay goes through, in order (spec §3.7):

1. **Front (stateless Worker).** CORS, `application/json`, at most 8 KiB, JSON, the zod schemas ([`src/core/schemas.ts`](src/core/schemas.ts), kept equal to the normative JSON Schema by [`test/unit/schemas.test.ts`](test/unit/schemas.test.ts)), the path's chain against the relay registry, the body's `chainId` against the path, and the requester identity (`CF-Connecting-IP` as an IPv4 address or an IPv6 /64, `requesterFromIp`).
2. **ChainSender (Durable Object for that chain)**, [`src/core/engine.ts`](src/core/engine.ts):
   1. request rate per requester and per chain (token buckets);
   2. a resubmission in flight or recently settled is answered from memory;
   3. `checkRelayPayRequest` / `checkRelayCancelRequest` from `@paylink/sdk` at the latest block: invoice decoding rules, the payee signature with the contract's dispatch, the recomputed binding nonce, the payer's signature with the token's dispatch (ERC-1271 for code, EIP-7702 included), the time windows, and the 120 s relay margin on every time bound;
   4. at least one cent (10^(decimals−2) base units), EIP-3009 registry tokens only; per-payer and per-chain daily caps;
   5. `RelayAdmissionLedger.admit`: 1 relay in flight per invoice key, payee and payer, 4 per token, 20 an hour per requester, day-long bans of whoever a post-simulation revert is attributed to, no relaying for payers with code or payees with unknown code;
   6. `eth_call` at the checked block;
   7. **send section, one at a time:** the margin against the pending block, `eth_call` and `eth_estimateGas` against the pending block, `gasLimit = clamp(estimate × 1.10, floor, ceiling)` from `@paylink/chains` (an estimate above the ceiling is refused, never truncated), fees (`2 × baseFee + tip`, capped), the daily gas budget, the balance, the nonce, the signing choke point `assertSendable`, then the record is **persisted before the broadcast**.
3. **Tracker (Durable Object alarm, every second while anything is pending).** Each nonce is followed to its receipt. Settled: the ticket is released. Reverted although the simulation passed: `attributeRelayRevert` reads the evidence at the inclusion block and the ledger bans only the party it names. Still pending after 30 s: re-sent with the same nonce and fees × 1.25, up to three times; after that, or once the call's time bounds have passed, the nonce is **voided** with a zero-value self-transfer (21,000 gas) instead of paying for a certain revert. Expired bans, counters and windows are pruned, so no requester identity outlives a day.

### Never value, never anything else

`assertSendable` ([`src/core/chains.ts`](src/core/chains.ts)) runs immediately before every signature, replacements included, and allows exactly: `payWithAuthorization` and `cancelBySig` to the chain's canonical, non-revoked deployment; `requestFunds(address)` to the registry's faucet; and a zero-value, empty-data transfer to the relayer itself. Value is always zero: Monad's reserve-balance rule makes value spends revert and the relayer has no reason to move coin. It never transfers tokens of its own (the spec's inventory fallback for onboarding is deliberately not built), never signs on a mainnet, and refuses to sign while its own account has code (an EIP-7702 delegation).

## Keys, secrets and logs

- `RELAYER_PK` comes **only** from the Worker secret of that name, set by the owner in the dashboard. It is the relayer's own throwaway testnet key, never the owner's MetaMask key; [`deploy/wrangler.toml`](deploy/wrangler.toml) has no variables and [`test/unit/deploy.test.ts`](test/unit/deploy.test.ts) keeps it so. A missing or malformed key leaves the relayer up with every chain `not-configured`.
- Logs are JSON lines in Workers Logs. The logger scrubs every known secret from each line whatever field carries it, drops fields named like key material or signatures, never logs bodies, and logs requesters only as `requesterTag`, a truncated SHA-256 under a per-isolate random salt that is never stored ([`src/core/log.ts`](src/core/log.ts); THREAT_MODEL T-38).
- CORS allows `https://paylink-mg.pages.dev` only, not the deployment hosts `https://<hash>.paylink-mg.pages.dev` or branch aliases (a withdrawn build stays reachable there; incident-response PB-2); a request with any other `Origin` is refused before it is processed. CORS is not access control: scripts that send no `Origin` are served like browsers, and are bounded by everything above.

## Limits (code, not configuration: [`src/core/policy.ts`](src/core/policy.ts))

| Chain | Daily gas budget: payments / cancellations / onboarding | Fee cap | Relays per day (per payer, per requester) | Per payee per day (payments, cancellations) | Onboarding per day (per address, per requester) |
|---|---|---|---|---|---|
| Monad testnet | 1 MON: 0.6 / 0.1 / 0.3 (about 21 payments at 0.028 MON each, their whole limit; 7 to 11 cancellations; 15 drips) | 500 gwei | 300 (10, 10) | 20, 3 | 15 (1, 3) |
| Base Sepolia, Arbitrum Sepolia | 0.005 ETH: 80 % / 20 % / none | 10 gwei | 300 (10, 10) | 20, 3 | none |

No single party can spend the day's budget with relays that succeed (review 2026-10-08): each kind of transaction has its own share, and one requester (an IPv4 address or an IPv6 /64) may spend at most a fifth of each share per UTC day, counted at the expected price (`gasLimit × (baseFee + tip)`, what Monad charges), on top of 10 relays a day and the payee caps. Refusals are `refused` with `reason: "daily-cap"` or `"requester-budget"` (429, `Retry-After` at UTC midnight); a spent share is `budget-exhausted`. The counters live in the chain's persisted state for the UTC day only.

Requests: 30 a minute per requester, 600 a minute per chain. The relayer's key should hold about two days of budget (2 MON on Monad), refilled from the faucets ([runbook](../../docs/runbooks/relayer.md#5-fund-the-relayer)).

## Problem codes

Errors are RFC 9457 `application/problem+json` with a stable `code`, a `fallback` hint (`self-submit`, `retry`, `none`) and, when a retry can succeed later, `retryAfter` and the `Retry-After` header. `type` links to the row below.

| Code | HTTP | Meaning, and what the client does |
|---|---|---|
| <a id="problem-invalid-json"></a>`invalid-json` | 400 | The body is not UTF-8 JSON. |
| <a id="problem-invalid-request"></a>`invalid-request` | 400 | The body fails the schema (`issues` lists up to eight JSON paths), a checksum, or names another chain than the path (`rule: ChainMismatch`). |
| <a id="problem-unsupported-media-type"></a>`unsupported-media-type` | 415 | Send `Content-Type: application/json`. |
| <a id="problem-payload-too-large"></a>`payload-too-large` | 413 | Bodies are limited to 8 KiB. |
| <a id="problem-origin-not-allowed"></a>`origin-not-allowed` | 403 | The page is not served from the PayLink origin. |
| <a id="problem-not-found"></a>`not-found` | 404 | No such endpoint. |
| <a id="problem-method-not-allowed"></a>`method-not-allowed` | 405 | Wrong method (`Allow` lists the right ones). |
| <a id="problem-unknown-chain"></a>`unknown-chain` | 404 | The relayer does not serve this chain. Self-submit. |
| <a id="problem-chain-not-ready"></a>`chain-not-ready` | 503 | No canonical deployment on this chain yet, or it is revoked. |
| <a id="problem-onboarding-unavailable"></a>`onboarding-unavailable` | 404 | The chain has no faucet the relayer may call. |
| <a id="problem-rejected"></a>`rejected` | 422 | The request fails a relay check; `rule` says which (`WrongAmount`, `E_SIGNATURE_INVALID`, `RelayValidityTooShort`, `BelowMinimumAmount`, …). Fix the request, or self-submit when `fallback` says so. |
| <a id="problem-already-settled"></a>`already-settled` | 409 | The authorisation was used on the token: the payment went through (verify its receipt). |
| <a id="problem-already-cancelled"></a>`already-cancelled` | 409 | The invoice is already cancelled. |
| <a id="problem-invoice-closed"></a>`invoice-closed` | 409 | The invoice no longer accepts this payment (`error.name`: `SoldOut`, `Cancelled`, `Expired`, `NotYetValid`). |
| <a id="problem-refused"></a>`refused` | 429, 409 or 422 | The admission policy or a daily cap refuses it now; `reason` is the refusal (`in-flight-key` 409, `banned-payer` 429, `payer-has-code` 422, `daily-cap` 429, `requester-budget` 429, …). Self-submit the same authorisation. |
| <a id="problem-rate-limited"></a>`rate-limited` | 429 | Too many requests; retry after `Retry-After`. |
| <a id="problem-simulation-failed"></a>`simulation-failed` | 422 | The transaction would revert; `error` carries the decoded error and its i18n key. |
| <a id="problem-gas-above-ceiling"></a>`gas-above-ceiling` | 422 | The estimate is above the registry ceiling (a hostile ERC-1271 payee, or a ceiling to re-measure). Self-submit. |
| <a id="problem-budget-exhausted"></a>`budget-exhausted` | 503 | Today's gas budget is spent; `Retry-After` is UTC midnight. Self-submit. |
| <a id="problem-fees-too-high"></a>`fees-too-high` | 503 | Network fees exceed the relayer's cap. Self-submit or retry. |
| <a id="problem-relayer-unavailable"></a>`relayer-unavailable` | 503 | No valid key, an unfunded key, or a key with code. Self-submit. |
| <a id="problem-faucet-unavailable"></a>`faucet-unavailable` | 503 | The faucet refused; its 60 s cooldown is global (anyone's drip blocks everyone). Retry after a minute. |
| <a id="problem-upstream-error"></a>`upstream-error` | 502 | The chain's RPC endpoints failed or refused the broadcast. Retry or self-submit. |
| <a id="problem-internal"></a>`internal` | 500 | A bug; the request id is in `instance` and `X-Request-Id`. |

## Layout

| Path | What |
|---|---|
| `src/core/` | Isomorphic: HTTP app (Hono), schemas (zod), engine, policy, state, logs. Type-checked against both Node and Workers types. |
| `src/worker/` | Cloudflare entry: `fetch` and the `ChainSender` Durable Object (RPC methods, storage, alarms). `registry.ts` is the seam the workerd suite replaces. |
| `src/node/` | Node adapter (`startNodeRelayer`, local chains only by default) and the `start:local` CLI. |
| `scripts/build.ts` | Bundles the Worker with rolldown into `deploy/worker.js` (not minified, regions named `package@version/path`), `LICENSES.txt` and `SHA256SUMS`; `--check` fails when the committed bundle is stale. |
| `deploy/` | What Cloudflare deploys: `wrangler.toml` and the committed bundle, uploaded byte for byte (`no_bundle`). |

## Develop and test

```bash
source ~/.paylink-toolchain/env.sh                      # sandbox: anvil and forge on PATH
(cd protocol && forge build)                            # the suites deploy the release build and the mocks from protocol/out
pnpm --filter @paylink/relayer test                     # unit, anvil (Node adapter), faults, workerd (wrangler dev)
pnpm --filter @paylink/relayer test:coverage            # >= 85 % lines (spec §4.1); needs anvil
pnpm --filter @paylink/relayer run build                # after any change under src/ or in a workspace dependency
pnpm --filter @paylink/relayer run build:check
RELAYER_FORK_MONAD=1 pnpm --filter @paylink/relayer exec vitest run test/integration/fork.test.ts   # needs egress to testnet-rpc.monad.xyz
```

| Suite | Proves |
|---|---|
| `test/unit/app.test.ts` | CORS (production, previews, look-alikes refused), media type, size, JSON and schema errors without reaching the sender, requester identities, problem documents, health aggregation and caching. |
| `test/unit/schemas.test.ts` | The zod schemas equal the normative JSON Schema keyword for keyword. |
| `test/unit/core.test.ts` | Key parsing, the signing choke point, log scrubbing, rate limits, state pruning, policy. |
| `test/unit/deploy.test.ts` | `wrangler.toml` (SQLite Durable Object, no variables, no previews); the bundle equals a rebuild; wrangler 4.148.0 accepts it and uploads exactly the committed bytes. |
| `test/integration/relay.test.ts` | On anvil 10143 (Monad's gas schedule): a real `payWithAuthorization` with Mock3009, value 0, exactly `clamp(estimate × 1.10)`, receipt verified; tampered amount, reference and invoice rejected with no gas spent; replays answered idempotently or refused (409); one relay in flight per invoice; `cancelBySig`; onboarding and the faucet's cooldown; replacement after 30 s; voiding past the time bounds; a payee who cancels under a queued relay is banned with the card; budget, key, rate and gas-ceiling refusals; every relayer transaction has value 0 and a permitted target; logs carry no key, signature or IP. |
| `test/integration/faults.test.ts` | Broadcast refused (nonce too low, insufficient funds, underpriced) or lost; receipts that never show; evidence that cannot be read; RPC failures; fee cap; unfunded and delegated relayer accounts; revoked deployments; daily caps; `invoice-closed`. |
| `test/integration/worker.test.ts` | The bundle in workerd under `wrangler dev` with the production `wrangler.toml`: Durable Object RPC, storage, alarms, secret binding, CORS, a relayed payment tracked to its receipt, cancel and onboarding. |
| `test/integration/fork.test.ts` (opt-in) | On a fork of Monad testnet: the real AUSD faucet funds a payer through the relayer, and a gasless payment in the **real AUSD** settles through PayLinkV2. Measured on 2026-10-07: faucet `requestFunds` gasUsed 128,414 (limit 142,771, bounds 130k–195k); `payWithAuthorization` gasUsed 247,533 (limit 274,619, bounds 224k–336k). |

Local relayer for the web app's e2e or a demo recording (the Node adapter refuses non-local chains; the key is one of the ten test accounts anvil prints at startup, which hold value nowhere):

```bash
RELAYER_PK=<private key of an anvil test account> \
  pnpm --filter @paylink/relayer start:local --config local.json --port 8787
```

`local.json` lists anvil chains (`chainId`, `rpcUrl` on 127.0.0.1, `deployment`, `gas: "monad" | "snapshot"`, `tokens`, optional `faucet`), validated by [`src/node/local-config.ts`](src/node/local-config.ts). Programmatic use: `startNodeRelayer({ registry, privateKey, allowedOrigins })` from `src/node/server.ts`.

## Known limits

- **Workers Free plan CPU** (L, check on the account's Limits page): a Worker invocation gets 10 ms of CPU. The front does well under 1 ms per request once warm (measured in Node); the signature checks and signing, about 20 to 40 ms of CPU per payment in Node, run inside the Durable Object, whose CPU limit is per request (30 s by default in Cloudflare's documentation). If Workers Logs ever show "Exceeded CPU Limit", relays fail closed and clients self-submit.
- **Arbitrum Sepolia gas** (C, measured 2026-10-07): `eth_estimateGas` there adds the L1 data cost, about 11,000 gas for a 676-byte call at the time; if a relay ever estimates above the registry ceiling it is refused (`gas-above-ceiling`) and the client self-submits.
- **The faucet** (C, fork, 2026-10-07): one global 60 s cooldown for everyone; onboarding is therefore at most one drip a minute for the whole world.
- **Anvil's public test accounts carry EIP-7702 delegations on Monad testnet** (C, observed on the fork 2026-10-07): never fund or use them there. The relayer refuses to sign from an account with code, and the fork suite uses fresh keys.
