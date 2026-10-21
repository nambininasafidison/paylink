# Runbook: PayPal sandbox for PayLink Twin

How the PayPal edition's API (`apps/api`, [ADR 0018](../adr/0018-paypal-edition.md)) talks to PayPal's sandbox, what the owner sets up and runs, and how to read what goes wrong. The design is [docs/paypal/SPEC.md](../paypal/SPEC.md) §7 (with the decisions of 2026-10-21 on top); the code is `apps/api/src/paypal/` and the routes `apps/api/src/routes/twin.ts` and `apps/api/src/routes/webhook.ts`.

| Step | Who | Where |
|---|---|---|
| The PayPal client, the webhook route, the twin routes, the PayPal fake, the capture script | Claude | this repository |
| The sandbox REST app "PayLink Twin" and its secret ([§1](#1-the-sandbox-app)) | **you only** | developer.paypal.com |
| The Worker's PayPal secrets ([§2](#2-the-workers-paypal-secrets)) | **you only** | Cloudflare dashboard |
| The capture run ([§3](#3-the-capture-run)) and its three manual checks | you, on a machine that reaches the sandbox | your computer |
| The webhook subscription ([§4](#4-the-webhook-subscription)) | you | your computer or developer.paypal.com |
| Reading the capture report and pinning what it shows ([§5](#5-what-the-capture-decides)) | Claude | this repository |

> **Golden rule.** `PAYPAL_CLIENT_SECRET` exists in two places only: the Worker's secrets in Cloudflare, and the environment of the one shell that runs the capture. Never in the repository, a file, a chat (with Claude or a browser assistant), a screenshot or a log. The client id is public, but it is kept next to the secret so both rotate together. The API never logs either (its logger scrubs every secret value it is given, `apps/api/src/core/log.ts`), and the capture report is not written if it would contain one.

## 1. The sandbox app

1. Sign in to the PayPal Developer Dashboard with the owner's account (sandbox mode, the default).
2. **Apps & Credentials → Sandbox → Create App**: name it **PayLink Twin**, type *Merchant*, bound to the sandbox business account that stands for the freelancer's PayPal (SPEC §1.2 item 3).
3. In the app's features, keep **Invoicing** on. Turn off what PayLink never calls (payments capture, refunds, payouts) if the dashboard allows it (UNVERIFIED that it does; SPEC §7.7).
4. Copy the **Client ID** and reveal the **Secret** only when you are about to paste it into Cloudflare (§2) or into the capture shell (§3).

The API asks for these OAuth scopes through the app's features (the `security` of each operation in the vendored OpenAPI files, `apps/api/test/openapi/`): `invoicing/invoices/read`, `invoicing/invoices/readwrite`, `applications/webhooks` and `applications/verify-webhook-signature`. The capture report lists the scopes the sandbox actually granted (`findings.tokenScopes`).

## 2. The Worker's PayPal secrets

Cloudflare dashboard → **Workers & Pages → paylink-api → Settings → Variables and Secrets → Add → Secret** (never "Text"):

| Secret | Value | Without it |
|---|---|---|
| `PAYPAL_CLIENT_ID` | the app's Client ID | every PayPal route answers `paypal-unavailable` (rule `E_PAYPAL_NOT_CONFIGURED`), health row `paypal` = `not-configured` |
| `PAYPAL_CLIENT_SECRET` | the app's Secret | same |
| `PAYPAL_WEBHOOK_ID` | the subscription's id ([§4](#4-the-webhook-subscription)) | the webhook answers 503 (rule `E_WEBHOOK_NOT_CONFIGURED`) and PayPal delivers again later; health row `webhook` = `not-configured` |

A secret takes effect on the next request; no redeploy is needed. The OAuth token is cached in the `Global` Durable Object until 10 minutes before PayPal's `expires_in` (sandbox tokens last 3 to 8 hours, the Agent Toolkit's README says): after rotating the secret, a token issued with the old one keeps working until it expires or PayPal refuses it, and a refused token (401) is dropped and replaced once, automatically (`apps/api/src/paypal/token.ts`).

## 3. The capture run

`api-m.sandbox.paypal.com` is not reachable from the agents' build machine, so everything PayPal does beyond its OpenAPI files is UNVERIFIED until this run. It takes about ten minutes, or twenty with the buyer's payment.

```sh
cd apps/api
read -rs PAYPAL_CLIENT_SECRET && export PAYPAL_CLIENT_SECRET   # paste, Enter: nothing is echoed or kept in history
export PAYPAL_CLIENT_ID=<the app's Client ID>
node --conditions=@paylink/source scripts/capture/main.ts --wait-payment 10 --events --out paypal-capture.json
unset PAYPAL_CLIENT_SECRET
```

What it does (`apps/api/scripts/capture/run.ts`): four invoices of $1.00 with random keys, a placeholder payee address and a synthetic client (`payer@example.com`); every operation the API uses (P1 to P9, the event list), with the alternatives the specification left open. With `--wait-payment 10` it prints the payer link of the first invoice: open it in a browser logged in as a **sandbox personal (buyer) account** and pay; the run waits up to ten minutes. `--events` then reads PayPal's recent `INVOICING.INVOICE.PAID` events to record their shape (it needs the webhooks scope). The open invoices of the run are cancelled at the end (`--keep` leaves them).

While it runs, do the three manual checks it prints and write the answers next to the report:

1. **K4**: when it prints "manual check (K4)", open that link before the next step runs: does PayPal's payer page still accept a payment after the external payment was recorded?
2. **P9**: where did the sandbox reminder appear (Developer Dashboard → Testing tools → Sandbox notifications, or nowhere)?
3. **P10**: once the webhook is subscribed (§4) and the Worker deployed, pay one invoice as a sandbox buyer; the Worker's logs (Workers & Pages → paylink-api → Logs) show `webhook.received` with `outcome: processed`.

The report keeps statuses, methods, error names and issues and the run's own amounts; every other string is reduced to its length, URLs to scheme, host and an id-free path (`apps/api/scripts/capture/report.ts`). It holds no secret, no token, no email, no name and no invoice id, so it can be committed or pasted to Claude as it is.

## 4. The webhook subscription

Either from the capture shell (same environment as §3):

```sh
node --conditions=@paylink/source scripts/capture/main.ts subscribe --url https://paylink-api.raherizonambinina.workers.dev/v1/paypal/webhook
```

which subscribes the URL to `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED` and `INVOICING.INVOICE.UPDATED` (P11) and prints `PAYPAL_WEBHOOK_ID=…` once, or in the dashboard (the app → **Webhooks → Add Webhook**, the same URL and events). Store the id as the secret `PAYPAL_WEBHOOK_ID` (§2). One subscription per environment: the preview Worker and the production Worker each have their own.

What the route does with a delivery (`apps/api/src/routes/webhook.ts`): it checks the five `PAYPAL-*` headers, asks PayPal whether the delivery is genuine with the body spliced in byte for byte (P10, postback), records the event id (a repeat answers `duplicate`), reads the invoice (P5) and hands the twin to the reconciler. A delivery that does not verify answers 400 and changes nothing. PayPal's simulator events are reported not to verify by postback (Hookdeck's guide, S), so check with a real sandbox payment, not the dashboard's simulator.

## 5. What the capture decides

Until the report is in, the code tolerates every alternative, and the PayPal fake (`apps/api/src/paypal/fake/`) takes the pessimistic or expected one, switchable in tests (`FakeBehaviour` in `apps/api/src/paypal/fake/model.ts`):

| UNVERIFIED (SPEC §7) | Finding in the report | The fake's default | What the code does meanwhile |
|---|---|---|---|
| Open status after a share-link send | `statusAfterShare` | `SHARED` | `SENT`, `SHARED` and `UNPAID` are all "open" (§7.4) |
| 200 or 202 on send without an issue date | `sendAnswer` | 200 | 202 registers the twin as S0 and answers 409 `E_PAYPAL_SCHEDULED` |
| `payment_term` with `due_date` alone, or with `term_type` too | `createWithDueDateOnly`, `createWithTermTypeAndDueDate` | due date alone accepted, both refused | sends `due_date` alone |
| A twin without a recipient email; P9 without one | `createWithoutEmail`, `shareWithoutEmail`, `remindWithoutEmail` | twin accepted, reminder refused | the reminder is offered only for twins with an email |
| Host of `recipient_view_url` | `recipientViewUrl` | the fake's own host | `config.paypal.payerHost` stays `null`, so the pay page shows no PayPal key until it is pinned |
| `reference` search exact or partial | `referenceSearch` | partial | keeps only exact matches |
| Status after a recorded payment (K4) | `statusAfterRecord` | `MARKED_AS_PAID` | `PAID`, `MARKED_AS_PAID` and `PAID_EXTERNAL` are all handled by the echo filter |
| The §7.3 note kept byte for byte (the `·` separators) | `recordNote` | kept | the reconciler's parser tolerates mangled separators |
| P7's `transaction_id` is P6's `payment_id` | `undoWithPaymentId` | yes | Undo sends P6's `payment_id` |
| Where an invoicing event carries the invoice | `webhookEventPaths` | `resource.invoice` | accepts `resource.invoice.id`, `resource.id` and invoice links |
| Whether Invoicing honours `PayPal-Request-Id` | not observable in one run | not honoured | every write sends one; a write whose answer is lost is settled by reading, never repeated blind |
| Sandbox rate limits and the reminder limit | `remindWithEmail` (one call only) | 2 reminders per invoice per day | at most one P9 per invoice per 24 h (the fence); 429 backs off |

Once the report is in, Claude pins what it shows: the fake's defaults follow the sandbox, `payerHost` gets the real host, the specification's UNVERIFIED tags on these rows become **C** with the report's date, and the L0 suite (`apps/api/test/openapi/contract.test.ts`) keeps running against the fake.

## 6. Without PayPal: the fake

Tests, the e2e suite and `pnpm --filter @paylink/api run dev:offline` run against the PayPal fake: Invoicing v2 and Webhooks with PayPal's paths, statuses and error bodies, OAuth tokens, RSA-signed webhook deliveries and a P10 that accepts exactly the bytes delivered, a payer page (`/invoice/p/<id>`) with one "pay" button, and test controls under `/__fake/` (pay, force a status, deliver webhooks, inject faults). Its answers are validated against PayPal's vendored schemas on every test run (`apps/api/test/openapi/contract.test.ts`).

## 7. Troubleshooting

| Symptom | Rule (in the problem's `rule`, or the log line) | Cause | Fix |
|---|---|---|---|
| Every PayPal route answers 503 | `E_PAYPAL_NOT_CONFIGURED` | client id or secret missing | §2 |
| 503 after a secret change | `invalid_client` (log `paypal.call`, op `P1`, status 401) | wrong secret pasted | paste the app's current Secret again |
| PayPal deliveries answer 503 | `E_WEBHOOK_NOT_CONFIGURED` | `PAYPAL_WEBHOOK_ID` missing | §4, then §2 |
| PayPal deliveries answer 400 | `E_WEBHOOK_SIGNATURE` (log `webhook.rejected`) | the id belongs to another subscription, a simulator event, or a forged call | check the id against the subscription of this Worker's URL; test with a real sandbox payment |
| A twin answers 409 | `E_PAYPAL_SCHEDULED` | PayPal scheduled the share (an issue date in its future) | report it: the twin is S0; the capture's `sendAnswer` says whether this can happen |
| A twin answers 400 | `E_CHAIN_UNKNOWN` | PayLinkV2 is not recorded on Ethereum Sepolia yet (decision D-CHAIN) | deploy with the deploy kit ([deploy runbook](deploy.md)) |
| 502 `paypal-rejected` | PayPal's name and issue, e.g. `UNPROCESSABLE_ENTITY:CANNOT_REMIND_INVOICE` | PayPal refused what the API sent | the issue says why; `debug_id` is in the log line for PayPal support |
| 503 `paypal-unavailable` with `Retry-After` | `E_PAYPAL_NO_ANSWER`, `SERVICE_UNAVAILABLE`, `RATE_LIMIT_REACHED` | PayPal down or throttling | nothing: reads are retried, the cron backs off, the API answers again when PayPal does |
