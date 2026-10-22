# @paylink/api

The PayPal edition's API ([docs/paypal/SPEC.md](../../docs/paypal/SPEC.md) §6, §12, §13; [ADR 0018](../../docs/adr/0018-paypal-edition.md)). It twins a signed PayLink invoice as a PayPal Invoicing v2 invoice, verifies PayPal webhooks, reconciles the two rails (PayPal and Ethereum Sepolia) inside a fence, and proposes actions that the payee approves. It is trusted for **availability and advice only**: it holds no chain key and no wallet client, cannot sign a PayLink invoice or a cancellation, and has no PayPal operation that moves money (no capture, refund or dispute call exists in [`src/paypal/client.ts`](src/paypal/client.ts)).

- **Production:** the Cloudflare Worker `paylink-api` (Hono, zod), with the SQLite-backed Durable Objects `Payee` (one per payee address) and `Global`, one cron every minute and the Workers AI binding, at `https://paylink-api.raherizonambinina.workers.dev` once the owner has deployed it ([Deploy](#deploy-owner)). Decision D-HOST.
- **Local:** the same Hono app in Node ([`src/node/server.ts`](src/node/server.ts)) for tests, e2e and an offline demo with no PayPal or Cloudflare account.

**State on 2026-10-22: every route implemented** (no route answers [`not-implemented`](#problem-not-implemented) any more), wired in the Worker with the `Payee` and `Global` Durable Objects, the minute cron and the Workers AI binding, and in the Node entry with in-memory stores. What each part does and what stays UNVERIFIED: the PayPal client and fake ([`src/paypal/`](src/paypal/), [docs/runbooks/paypal.md](../../docs/runbooks/paypal.md)), the reconciler and executor ([`src/reconciler/README.md`](src/reconciler/README.md)), the AI ([`src/ai/models.ts`](src/ai/models.ts), [`evals/README.md`](evals/README.md)). The two rails end to end (L3): [`e2e/specs/paypal-rails.spec.ts`](../../e2e/specs/paypal-rails.spec.ts).

## Routes

The table is [`API_ROUTES`](../../packages/api-contract/src/common.ts) in `@paylink/api-contract`; bodies are the types of that package (the web edition imports them without any server code).

| Method | Path | Auth | Does | Workstream |
|---|---|---|---|---|
| POST | `/v1/session` | EIP-712 signature | Verify a signed `PayLinkSession`; return a session token (12 h) | reconciler |
| POST | `/v1/ai/draft` | session | A1: a client message to an invoice draft (Workers AI, structured output) | AI |
| POST | `/v1/twin` | session | Verify the signed link, then P2, (P3, P4), P5: the PayPal twin | PayPal spine |
| GET | `/v1/twin/:key` | session | The payee's twin, its situation and last check | PayPal spine |
| GET | `/v1/rails/:key` | public | The PayPal rail of a link for the pay page (status, amount, currency, URL, checked at) | PayPal spine |
| POST | `/v1/paypal/webhook` | PayPal postback (P10) | Verify, then P5, then reconcile; a webhook body never decides anything | PayPal spine |
| GET | `/v1/desk` | session | Proposals, auto-records, alerts | reconciler |
| POST | `/v1/desk/sweep` | session | "Check my invoices": reconcile every open twin (≤ 20), then run the A2 desk once, in the body's `locale` (optional) | reconciler |
| POST | `/v1/desk/:id/approve` | session + approval token | Executor: fresh read, fence, act | reconciler |
| POST | `/v1/desk/:id/reject` | session | Close a proposal | reconciler |
| POST | `/v1/desk/:id/undo` | session | P7 within 24 h of an auto-record | reconciler |
| POST | `/v1/check` | session | "Was I really paid?": a deterministic verdict from P5 and the chain | reconciler |
| GET | `/v1/health` | public | Status rows: PayPal, webhook, assistant (with today's neurons left), chain, store | foundation |
| cron | `* * * * *` | | Poll open and in-flight twins (at most 20 a run); daily cleanup | reconciler |

Cut by decision D-SCOPE: `POST /v1/desk/ask` (the free-text desk question), A3 reason codes, P12 (the PayPal QR code) and the judge PYUSD faucet. The pay page's payer pays Sepolia gas (no relayer in this edition).

Every response carries `X-Request-Id`. Bodies are JSON (`Content-Type: application/json`), at most 8 KiB, except the webhook (64 KiB), `/v1/ai/draft` and `/v1/check` (16 KiB each), checked before the body is read ([`src/routes/types.ts`](src/routes/types.ts)). CORS allows the edition's origins only: `https://paypal.paylink-mg.pages.dev` (the Pages preview of branch `paypal`) and `https://paylink-mg.pages.dev` ([`src/core/config.ts`](src/core/config.ts)); a request with another `Origin` is refused with [`origin-not-allowed`](#problem-origin-not-allowed).

## Problem codes

Errors are RFC 9457 `application/problem+json` objects `{ type, code, status, title, detail, rule?, retryAfter?, issues?, requestId? }`. Clients branch on `code` (and `rule`, which carries the specification's error such as `E_STALE` or `E_PAYPAL_SCHEDULED`), never on `detail`. `type` links to the row below.

| Code | Status | Meaning |
|---|---|---|
| <a id="problem-invalid-json"></a>`invalid-json` | 400 | The body is not UTF-8 JSON. |
| <a id="problem-invalid-request"></a>`invalid-request` | 400 | The body fails the route's schema; `issues` lists the first offending JSON paths. |
| <a id="problem-unsupported-media-type"></a>`unsupported-media-type` | 415 | Send `Content-Type: application/json`. |
| <a id="problem-payload-too-large"></a>`payload-too-large` | 413 | The body is larger than the route's limit. |
| <a id="problem-unauthorized"></a>`unauthorized` | 401 | The route needs `Authorization: Bearer <session token>` and none valid was sent. |
| <a id="problem-forbidden"></a>`forbidden` | 403 | The session's payee may not act on this twin or proposal. |
| <a id="problem-origin-not-allowed"></a>`origin-not-allowed` | 403 | The request's `Origin` is not one of the edition's origins. |
| <a id="problem-not-found"></a>`not-found` | 404 | No such route, twin or proposal. |
| <a id="problem-method-not-allowed"></a>`method-not-allowed` | 405 | The path exists with another method. |
| <a id="problem-stale"></a>`stale` | 409 | The situation changed since the proposal was made: read the desk again (`E_STALE`). |
| <a id="problem-conflict"></a>`conflict` | 409 | The request conflicts with the twin's current state. |
| <a id="problem-rate-limited"></a>`rate-limited` | 429 | Too many requests; `retryAfter` says when to try again. |
| <a id="problem-quota-exhausted"></a>`quota-exhausted` | 429 | The payee's or the day's quota is used up (twins, assistant calls, neurons). |
| <a id="problem-webhook-rejected"></a>`webhook-rejected` | 400 | The webhook did not verify (P10) or names no known twin. |
| <a id="problem-paypal-rejected"></a>`paypal-rejected` | 502 | PayPal answered with an error; `rule` carries its `name`. |
| <a id="problem-paypal-unavailable"></a>`paypal-unavailable` | 503 | PayPal did not answer, or the sandbox credentials are not configured. |
| <a id="problem-chain-unavailable"></a>`chain-unavailable` | 503 | Ethereum Sepolia could not be read. |
| <a id="problem-assistant-unavailable"></a>`assistant-unavailable` | 503 | The assistant is resting (budget, quota, provider down); every flow works without it. |
| <a id="problem-not-implemented"></a>`not-implemented` | 501 | A route without a handler (none in this release; the contract keeps the code). |
| <a id="problem-internal"></a>`internal` | 500 | A bug; the log line carries the `requestId`. |

### Rules

`rule` carries the specification's error, so a client can word it ([apps/web](../web/src/editions/paypal/context.ts) maps the ones it shows):

| Area | Rules |
|---|---|
| Sessions | `E_SESSION_CHAIN`, `E_SESSION_ORIGIN`, `E_SESSION_FIELDS`, `E_SESSION_TIME`, `E_SESSION_SIGNATURE`, `E_SESSION_REPLAYED`, `E_SESSION_ERC1271_UNREADABLE`, `E_SESSION_QUOTA`, `E_SESSION_KEY_MISSING`, `E_SESSION_KEY_INVALID` (500: the secret is absent or not 32 hex bytes) |
| Twins | `E_TWIN_LINK`, `E_CHAIN_UNKNOWN` (PayLinkV2 not deployed on the link's chain), `E_TWIN_CHAIN`, `E_TWIN_NOT_PAYEE`, `E_TWIN_SIGNATURE`, `E_TWIN_ERC1271_UNREADABLE`, `E_TWIN_MULTI_PAYMENT`, `E_TWIN_OPEN_AMOUNT`, `E_TWIN_PRECISION`, `E_TWIN_TOKEN`, `E_TWIN_EXPIRED`, `E_TWIN_DUE_DATE`, `E_TWIN_INPUT`, `E_TWIN_KEY`, `E_PAYPAL_SCHEDULED` (409: PayPal scheduled the share instead of sending it) |
| PayPal | `paypal-rejected` carries PayPal's `NAME:ISSUE`; `paypal-unavailable` carries `E_PAYPAL_NOT_CONFIGURED`, `E_PAYPAL_TOKEN`, `E_PAYPAL_NO_ANSWER`, `E_PAYPAL_UNAVAILABLE`, `E_PAYPAL_UNEXPECTED_RESPONSE`; also `E_PAYPAL_INVALID_INPUT`, `E_PAYPAL_REMINDER_LIMIT` |
| Webhook | `E_WEBHOOK_MALFORMED`, `E_WEBHOOK_SIGNATURE` (400, nothing changes), `E_WEBHOOK_NOT_CONFIGURED`, `E_WEBHOOK_UNVERIFIABLE` (503: PayPal delivers again later) |
| Desk | `E_STALE`, `E_ALREADY_USED`, `E_BUSY`, `E_APPROVAL_HASH`, `E_APPROVAL_INVALID`, `E_APPROVAL_EXPIRED`, `E_APPROVAL_OTHER_PAYEE`, `E_APPROVAL_KEY_MISSING`, `E_APPROVAL_KEY_INVALID`, `E_PROPOSAL_EXPIRED`, `E_PROPOSAL_CORRUPT`, `E_ALREADY_UNDONE`, `E_UNDO_EXPIRED` |
| Quotas | `E_QUOTA_PAYEE`, `E_QUOTA_GLOBAL` (`retryAfter` at the next UTC midnight) |

## Layout and ownership

Each area is owned by one workstream ([docs/paypal/SPEC.md](../../docs/paypal/SPEC.md), section "Ownership"); the owner of an interface implements it, other workstreams code against it and ask for changes through a handoff. Shared files stay with the foundation: a workstream that needs one changed describes the change in its handoff instead of making it.

| Path | Holds | Owner |
|---|---|---|
| [`src/core/`](src/core/) | the Hono app (request id, CORS, security headers, sessions on session routes, body limits, problems), runtime and configuration types, logger, services wiring | foundation |
| [`src/routes/types.ts`](src/routes/types.ts), [`src/routes/health.ts`](src/routes/health.ts) | handler contract and body limits; `GET /v1/health` | foundation |
| [`src/worker/index.ts`](src/worker/index.ts), [`src/worker/env.ts`](src/worker/env.ts), [`src/worker/runtime.ts`](src/worker/runtime.ts) | Worker entry (`fetch`, `scheduled`), bindings and secrets | foundation |
| [`src/node/`](src/node/) | Node entry over the same app (`--offline` for the fake and replay modes) | foundation |
| [`scripts/build.ts`](scripts/build.ts), [`deploy/`](deploy/) | the committed bundle and `wrangler.toml` | foundation (release step) |
| [`src/paypal/`](src/paypal/), [`src/routes/twin.ts`](src/routes/twin.ts), [`src/routes/webhook.ts`](src/routes/webhook.ts), [`test/openapi/`](test/openapi/) | `PayPalClient` (P1–P11), OpenAPI-derived types, HTTP client, PayPal fake, capture script, webhook route, L0 | PayPal spine |
| [`src/reconciler/`](src/reconciler/), [`src/approvals/`](src/approvals/), [`src/session/`](src/session/), [`src/store/`](src/store/), [`src/chain/`](src/chain/), [`src/worker/durable.ts`](src/worker/durable.ts), [`src/routes/session.ts`](src/routes/session.ts), [`src/routes/desk.ts`](src/routes/desk.ts), [`src/routes/check.ts`](src/routes/check.ts) | situation table, echo filter, executor, cron, HMAC approvals, sessions, stores and Durable Objects, chain reads, L1 | reconciler and executor |
| [`src/ai/`](src/ai/), [`src/routes/ai.ts`](src/routes/ai.ts), [`test/vendor/`](test/vendor/) | `AiProvider`, Workers AI and replay providers, A1, A2, injection suite, evals, Agent Toolkit parity | AI |

Each workstream adds its tests under `test/<area>/` and its fixtures next to them. The handlers of a workstream are one map in its `src/routes/<area>.ts` (`RouteHandlers`), which the app registers; the app would answer 501 for a route without a handler (`src/core/not-implemented.ts` stays for that rule).

## Configuration and secrets

Configuration is code ([`src/core/config.ts`](src/core/config.ts)): origins, the PayPal sandbox base `https://api-m.sandbox.paypal.com`, the Workers AI models and their daily neuron ceiling ([`src/ai/models.ts`](src/ai/models.ts), sources there), the chain (Ethereum Sepolia, 11155111) and the quotas. [`deploy/wrangler.toml`](deploy/wrangler.toml) has no `[vars]` and no secret; [`test/deploy.test.ts`](test/deploy.test.ts) keeps it so.

| Secret | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID` | the sandbox app "PayLink Twin" (public, but kept with its secret for one place to rotate) |
| `PAYPAL_CLIENT_SECRET` | the sandbox app's secret |
| `PAYPAL_WEBHOOK_ID` | the webhook subscription, for P10 |
| `APPROVAL_HMAC_KEY`, `SESSION_HMAC_KEY` | 32 random bytes each; rotating one only invalidates open proposals or sessions |

They exist only as Cloudflare secrets (dashboard: Workers & Pages → `paylink-api` → Settings → Variables and Secrets) or as environment variables of a local process ([`.dev.vars.example`](.dev.vars.example) lists the names; `.dev.vars` and `.env*` are git-ignored). Never in this repository, a log, a screenshot or a chat. The logger ([`src/core/log.ts`](src/core/log.ts)) scrubs every secret value it was given from each line and drops fields named like credentials; bodies, headers and tokens are never logged. Without the PayPal secrets every PayPal route answers [`paypal-unavailable`](#problem-paypal-unavailable) and health says so.

Workers AI needs no secret: the `[ai]` binding is the account's own. Models and quotas are tagged in [`src/ai/models.ts`](src/ai/models.ts); the model never signs, never moves money and only proposes values the fence allows (AI-1 to AI-7 of the specification).

## Develop and test

```sh
pnpm --filter @paylink/api run typecheck    # Node and Worker programs
pnpm --filter @paylink/api run lint
pnpm --filter @paylink/api run test         # smoke, OpenAPI contract, deploy configuration and wrangler dry run
pnpm --filter @paylink/api run build        # rebuild deploy/worker.js, LICENSES.txt, SHA256SUMS
pnpm --filter @paylink/api run build:check  # release gate: exit 1 unless deploy/ equals a rebuild of the tree
pnpm --filter @paylink/api run dev:offline  # Node entry on 127.0.0.1:8788, PayPal fake and AI replay modes
```

`start:local` takes `--port`, `--host`, `--origin <origin>` (repeatable; the web edition's origin in e2e), `--offline` and `--cron-seconds <n>` (the cron's interval, 60 by default as deployed, 0 for none), and prints one JSON line `{"event":"listening",...}` once it serves. Offline it runs the PayPal fake (its payer pages and test controls under `/__paypal`, its signed webhooks delivered to this server's own `POST /v1/paypal/webhook` and verified there by P10) and the AI replay provider; two options exist for the end-to-end suites only, and only offline: `--local-chain '<json>'` (an anvil fork of Ethereum Sepolia with PayLinkV2 at its release address; the registry's RPC URL is sent to the fork) and `--payer-origin <origin>` (the origin written into `recipient_view_url`). The Worker has none of these.

```sh
pnpm --filter @paylink/api run capture -- --out paypal-capture.json   # the owner's sandbox capture (docs/runbooks/paypal.md)
PAYLINK_FORK_SEPOLIA=1 NODE_USE_ENV_PROXY=1 pnpm --filter @paylink/api exec vitest run test/chain/fork.test.ts
PAYLINK_WORKERD=1 pnpm --filter @paylink/api exec vitest run test/store/workerd.test.ts
```

The vendored PayPal OpenAPI files (`invoicing_v2.json` 2.6, `notifications_webhooks_v1.json` 1.11, from `paypal/paypal-rest-api-specifications` at `90e8041`, Apache-2.0) and their checksums are in [`test/openapi/SOURCE.md`](test/openapi/SOURCE.md); [`test/openapi.test.ts`](test/openapi.test.ts) checks the checksums, that P2–P11 exist with their methods, and validates the request bodies of the specification with ajv. `api-m.sandbox.paypal.com` is not reachable from the agents' sandbox: everything PayPal answers at run time is UNVERIFIED until the owner's capture run.

## Deploy (owner)

Like the relayer ([relayer runbook](../../docs/runbooks/relayer.md) §2–§3, same dashboard steps): Cloudflare's Git integration deploys the committed bundle in [`deploy/`](deploy/) byte for byte (`no_bundle = true`), without installing this workspace or running a build of ours.

| Field | Value |
|---|---|
| Project name | `paylink-api` (must match `name` in `wrangler.toml`) |
| Production branch | `paypal` until the edition merges |
| Build command | *(empty)* |
| Deploy command | `npx wrangler@4.148.0 deploy` |
| Path (root directory) | `apps/api/deploy` |
| Variables | none (secrets are added afterwards, above) |

The build log must list `env.PAYEE (Payee)` and `env.GLOBAL (Global)` as Durable Objects and `env.AI` as AI, then the workers.dev URL. Before a push meant for deployment, run `build:check`: the bundle is rebuilt and committed by the release step, not by each workstream, so concurrent changes to `src/` do not collide in `deploy/`.
