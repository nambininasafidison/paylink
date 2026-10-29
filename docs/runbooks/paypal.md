# Runbook: PayPal sandbox for PayLink Twin

How the PayPal edition's API (`apps/api`, [ADR 0018](../adr/0018-paypal-edition.md)) talks to PayPal's sandbox, what the owner sets up and runs, and how to read what goes wrong. The design is [docs/paypal/SPEC.md](../paypal/SPEC.md) §7 (with the decisions of 2026-10-21 on top); the code is `apps/api/src/paypal/` and the routes `apps/api/src/routes/twin.ts` and `apps/api/src/routes/webhook.ts`.

| Step | Who | Where |
|---|---|---|
| The PayPal client, the webhook route, the twin routes, the reconciler and desk, the assistant, the PayPal fake, the capture script, the end-to-end suites | Claude | this repository |
| The sandbox REST app "PayLink Twin" and its secret ([§1](#1-the-sandbox-app)) | **you only** | developer.paypal.com |
| The Worker's secrets ([§2](#2-the-workers-secrets)) | **you only** | Cloudflare dashboard |
| The capture run ([§3](#3-the-capture-run)) and its three manual checks (run on 2026-10-29; K4 is left for the rehearsal) | you, on a machine that reaches the sandbox | your computer |
| The webhook subscription ([§4](#4-the-webhook-subscription)) | you | your computer or developer.paypal.com |
| Reading the capture report and pinning what it shows ([§5](#5-what-the-capture-decides), done for the run of 2026-10-29) | Claude | this repository |
| The Pages preview of the branch `paypal` ([§7](#7-the-pages-preview-of-the-branch-paypal)) | you | Cloudflare dashboard |
| The Worker `paylink-api` from Git ([§8](#8-the-worker-paylink-api)) | you | Cloudflare dashboard |
| PayLinkV2 on Ethereum Sepolia ([§9](#9-paylinkv2-on-ethereum-sepolia)) | you sign it in your wallet; Claude verifies and records it | the deploy kit |
| Judge sandbox buyers and judge links ([§10](#10-judge-sandbox-buyers-and-judge-links)) | you | developer.paypal.com, the edition |
| The rehearsal ([§11](#11-rehearsal)) and the judging period ([§12](#12-until-judging-ends)) | you | the live edition |

**Going live, in order.** Each step needs the one before it.

1. The sandbox app ([§1](#1-the-sandbox-app)), if it is not made yet. **It existed already (checked on 2026-10-28).**
2. The Pages preview of `paypal` ([§7](#7-the-pages-preview-of-the-branch-paypal)): the edition and the deploy kit get a URL. **Done on 2026-10-28; on 2026-10-29 its Status page read Build `452c0ee` and "Release 2.0.0: code and immutables match".**
3. The Worker `paylink-api` ([§8](#8-the-worker-paylink-api)) and its four secrets that exist before the webhook: `APPROVAL_HMAC_KEY`, `SESSION_HMAC_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` ([§2](#2-the-workers-secrets)). Its Status rows answer. **Done: on 2026-10-29 `/v1/health` read the chain (deployed), PayPal, the webhook and the store ok, and the assistant unknown (not used yet).**
4. PayLinkV2 on Ethereum Sepolia ([§9](#9-paylinkv2-on-ethereum-sepolia)); Claude records it and pushes `paypal`. Invoices can be signed and paid from then on. **Deployed and recorded on 2026-10-29.**
5. The capture run ([§3](#3-the-capture-run)); Claude pins what it shows ([§5](#5-what-the-capture-decides)) and pushes. **Run on 2026-10-29; pinned the same day.**
6. The webhook subscription and `PAYPAL_WEBHOOK_ID` ([§4](#4-the-webhook-subscription)); one real sandbox payment shows "Last verified webhook" on Status. **Done on 2026-10-29: five real deliveries `processed`, the health row `webhook` ok (`last-verified`).**
7. Judge buyers and judge links ([§10](#10-judge-sandbox-buyers-and-judge-links)), the rehearsal ([§11](#11-rehearsal)), the video ([submission pack §8](../submissions/paypal.md#8-video-storyboard-under-300-captions-no-invented-numbers)). **The three buyers exist (2026-10-29); the judge links, the rehearsal (with K4) and the video remain.**

> **Golden rule.** `PAYPAL_CLIENT_SECRET` exists in two places only: the Worker's secrets in Cloudflare, and the environment of the one shell that runs the capture. Never in the repository, a file, a chat (with Claude or a browser assistant), a screenshot or a log. The client id is public, but it is kept next to the secret so both rotate together. The API never logs either (its logger scrubs every secret value it is given, `apps/api/src/core/log.ts`), and the capture report is not written if it would contain one.

## 1. The sandbox app

1. Sign in to the PayPal Developer Dashboard with the owner's account (sandbox mode, the default).
2. **Apps & Credentials → Sandbox → Create App**: name it **PayLink Twin**, type *Merchant*, bound to the sandbox business account that stands for the freelancer's PayPal (SPEC §1.2 item 3).
3. In the app's features, keep **Invoicing** on. Turn off what PayLink never calls (payments capture, refunds, payouts) if the dashboard allows it (UNVERIFIED that it does; SPEC §7.7).
4. Copy the **Client ID** and reveal the **Secret** only when you are about to paste it into Cloudflare (§2) or into the capture shell (§3).

The API asks for these OAuth scopes through the app's features (the `security` of each operation in the vendored OpenAPI files, `apps/api/test/openapi/`): `invoicing/invoices/read`, `invoicing/invoices/readwrite`, `applications/webhooks` and `applications/verify-webhook-signature`. The capture report lists the scopes the sandbox actually granted (`findings.tokenScopes`): on 2026-10-29, 24 scopes, among them `https://uri.paypal.com/services/invoicing` and `https://uri.paypal.com/services/applications/webhooks`, the two PayLink's calls need; the others (payments, refunds, disputes, subscriptions, …) are features of the app that PayLink's client has no operation for.

## 2. The Worker's secrets

Cloudflare dashboard → **Workers & Pages → paylink-api → Settings → Variables and Secrets → Add → Secret** (never "Text"):

| Secret | Value | Without it |
|---|---|---|
| `PAYPAL_CLIENT_ID` | the app's Client ID | every PayPal route answers `paypal-unavailable` (rule `E_PAYPAL_NOT_CONFIGURED`), health row `paypal` = `not-configured` |
| `PAYPAL_CLIENT_SECRET` | the app's Secret | same |
| `PAYPAL_WEBHOOK_ID` | the subscription's id ([§4](#4-the-webhook-subscription)) | the webhook answers 503 (rule `E_WEBHOOK_NOT_CONFIGURED`) and PayPal delivers again later; health row `webhook` = `not-configured` |
| `APPROVAL_HMAC_KEY` | 32 random bytes in hex: `openssl rand -hex 32` (64 characters; a `0x` prefix is accepted) | the desk can list proposals but approving one answers 500 (rule `E_APPROVAL_KEY_MISSING`; a value that is not at least 32 hex bytes: `E_APPROVAL_KEY_INVALID`) |
| `SESSION_HMAC_KEY` | another 32 random bytes, made the same way (never the same value as `APPROVAL_HMAC_KEY`) | no desk session can open: `POST /v1/session` answers 500 (rule `E_SESSION_KEY_MISSING` or `E_SESSION_KEY_INVALID`), so the desk, twins and the assistant are closed; links are still signed and paid on the chain |

Make the two HMAC keys in a terminal and paste each straight into its secret field; keep no copy (rotating one only closes open proposals or sessions: `apps/api/src/core/runtime.ts`). A secret takes effect on the next request; no redeploy is needed. The OAuth token is cached in the `Global` Durable Object until 10 minutes before PayPal's `expires_in`, whatever lifetime PayPal gives (the Agent Toolkit's README says sandbox tokens last 3 to 8 hours; the capture's token lasted 32,326 seconds, about 9 hours, on 2026-10-29): after rotating the secret, a token issued with the old one keeps working until it expires or PayPal refuses it, and a refused token (401) is dropped and replaced once, automatically (`apps/api/src/paypal/token.ts`).

## 3. The capture run

`api-m.sandbox.paypal.com` is not reachable from the agents' build machine, so everything PayPal does beyond its OpenAPI files was UNVERIFIED until this run. It takes about ten minutes, or twenty with the buyer's payment.

**Run on 2026-10-29**, with the payer step and the event list: the report and a dated note are [`docs/research/paypal/capture-2026-10-29.json`](../research/paypal/capture-2026-10-29.json) and [`capture-2026-10-29.md`](../research/paypal/capture-2026-10-29.md); what it decided is in [§5](#5-what-the-capture-decides). The manual checks: **K4** not checked (the run went on to the undo first), so the rehearsal checks it ([§11](#11-rehearsal)); **P9** answered (the reminder was accepted; it went to the run's synthetic address, which is no sandbox account, so Sandbox notifications listed nothing for it); **P10** proven by the deployed Worker (five `webhook.received` with `outcome: processed`, no error). Run it again only to re-check a behaviour; an earlier attempt that day stopped at P1 with 401 `invalid_client` because a secret from the wrong place had been pasted (§13).

```sh
cd apps/api
read -rs PAYPAL_CLIENT_SECRET && export PAYPAL_CLIENT_SECRET   # paste, Enter: nothing is echoed or kept in history
export PAYPAL_CLIENT_ID=<the app's Client ID>
node --conditions=@paylink/source scripts/capture/main.ts --wait-payment 10 --events --out paypal-capture.json
unset PAYPAL_CLIENT_SECRET
```

What it does (`apps/api/scripts/capture/run.ts`): four invoices of $1.00 with random keys, a placeholder payee address and a synthetic client (`payer@example.com`); every operation the API uses (P1 to P9, the event list), with the alternatives the specification left open. With `--wait-payment 10` it prints the payer link of the first invoice: open it in a browser logged in as a **sandbox personal (buyer) account** and pay; the run waits up to ten minutes. `--events` then reads PayPal's recent `INVOICING.INVOICE.PAID` events to record their shape (it needs the webhooks scope). The open invoices of the run are cancelled at the end (`--keep` leaves them).

While it runs, do the three manual checks it prints and write the answers next to the report:

1. **K4**: when it prints "manual check (K4)", open that link before the next step runs: does PayPal's payer page still accept a payment after the external payment was recorded? (Not checked on 2026-10-29: the rehearsal checks it, [§11](#11-rehearsal).)
2. **P9**: where did the sandbox reminder appear (Developer Dashboard → Testing tools → Sandbox notifications, or nowhere)? Only a reminder to a sandbox account can be listed there; the run's goes to `payer@example.com`, which is not one.
3. **P10**: once the webhook is subscribed (§4) and the Worker deployed, pay one invoice as a sandbox buyer; the Worker's logs (Workers & Pages → paylink-api → Logs) show `webhook.received` with `outcome: processed`.

The report keeps statuses, methods, error names and issues and the run's own amounts; every other string is reduced to its length, URLs to scheme, host and an id-free path (`apps/api/scripts/capture/report.ts`). It holds no secret, no token, no email, no name and no invoice id, so it can be committed or pasted to Claude as it is.

## 4. The webhook subscription

Either from the capture shell (same environment as §3):

```sh
node --conditions=@paylink/source scripts/capture/main.ts subscribe --url https://paylink-api.raherizonambinina.workers.dev/v1/paypal/webhook
```

which subscribes the URL to `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED` and `INVOICING.INVOICE.UPDATED` (P11) and prints `PAYPAL_WEBHOOK_ID=…` once, or in the dashboard (the app → **Webhooks → Add Webhook**, the same URL and events). Store the id as the secret `PAYPAL_WEBHOOK_ID` (§2). One subscription per environment: the preview Worker and the production Worker each have their own.

**Done on 2026-10-29** for `paylink-api`: the Worker's logs held five `webhook.received` lines with `outcome: processed` and no error (from 05:36:07 to 05:36:22 UTC: two `INVOICING.INVOICE.PAID`, two `INVOICING.INVOICE.CANCELLED`, one `INVOICING.INVOICE.UPDATED`), and `/v1/health` read `webhook` ok (`last-verified`). That is P10 proven by the route itself; PayPal's event list, which the capture also read, held no event of the paid invoice yet, and nothing depends on it.

What the route does with a delivery (`apps/api/src/routes/webhook.ts`): it checks the five `PAYPAL-*` headers, asks PayPal whether the delivery is genuine with the body spliced in byte for byte (P10, postback), records the event id (a repeat answers `duplicate`), reads the invoice (P5) and hands the twin to the reconciler. A delivery that does not verify answers 400 and changes nothing. PayPal's simulator events are reported not to verify by postback (Hookdeck's guide, S), and the owner found the same on 2026-10-29: check with a real sandbox payment, not the dashboard's simulator.

## 5. What the capture decides

Until the report was in, the code tolerated every alternative, and the PayPal fake (`apps/api/src/paypal/fake/`) took the pessimistic or expected one, switchable in tests (`FakeBehaviour` in `apps/api/src/paypal/fake/model.ts`). The report of the run of 2026-10-29 ([`capture-2026-10-29.md`](../research/paypal/capture-2026-10-29.md)) decided each row below (**C**); the specification's rows say the same ([SPEC, Capture of 2026-10-29](../paypal/SPEC.md#capture-of-2026-10-29)).

| Behaviour (SPEC §7) | Finding in the report | The sandbox, 2026-10-29 | The fake's default now | What the code does |
|---|---|---|---|---|
| Open status after a share-link send | `statusAfterShare` | `UNPAID` | `UNPAID` (`SHARED` and `SENT` stay switchable) | `SENT`, `SHARED` and `UNPAID` are all "open" (§7.4) |
| 200 or 202 on send without an issue date | `sendAnswer` | 200 | 200 | 202 still registers the twin as S0 and answers 409 `E_PAYPAL_SCHEDULED` (PayPal's files describe it) |
| `payment_term` with `due_date` alone, or with `term_type` too | `createWithDueDateOnly`, `createWithTermTypeAndDueDate` | both accepted | both accepted (`DUE_ON_DATE_SPECIFIED` with a date; any other term type with a date refused) | sends `due_date` alone |
| A twin without a recipient email; P9 without one | `createWithoutEmail`, `shareWithoutEmail`, `remindWithoutEmail` | twin created and shared; reminder refused, 400 `INVALID_REQUEST` `CANNOT_REMIND_AS_BILLING_INFO_ABSENT` | the same refusal | the reminder is never offered or sent for a twin without an email: the share card says why, and the refusal, should it come, is `E_PAYPAL_REMINDER_NEEDS_EMAIL` |
| P9 with an email | `remindWithEmail` | accepted (Sandbox notifications list only reminders to sandbox accounts) | accepted, 2 a day | at most one P9 per invoice per 24 h (the fence) |
| Host of `recipient_view_url` | `recipientViewUrl` | `https://www.sandbox.paypal.com/invoice/p/#{id}` | the same path and fragment on the fake's own origin (`/invoice/p/` opens `/invoice/p/<id>`) | the pay page follows exactly that payer page: `https:`, `www.sandbox.paypal.com`, `/invoice/p/`, the invoice in the fragment, no query (`payerUrl` in `apps/web/src/editions/paypal/rails.ts`: a host in `PAYPAL_PAYER_HOSTS`, and the rule `isPayPalPayerPage` of `packages/api-contract/src/common.ts`); anything else withholds the PayPal key and says why. The API's `config.paypal.payerHost` (`apps/api/src/core/config.ts`), which "Was I really paid?" uses to recognise PayPal links, is that host |
| `reference` search exact or partial | `referenceSearch` | partial | partial | keeps only exact matches |
| Status after the buyer's payment | `statusAfterPayerPayment`, `payerTransaction` | `PAID`, a transaction of type and method `PAYPAL` | the same | S2: the till lights via PayPal, the desk proposes cancelling the link |
| Status after a recorded payment (K4) | `statusAfterRecord` | `MARKED_AS_PAID` | `MARKED_AS_PAID` | the echo filter handles it, and still `PAID` and `PAID_EXTERNAL`; whether the payer page still takes a payment after a record is the open half of K4, checked at the rehearsal ([§11](#11-rehearsal)) |
| The §7.3 note kept byte for byte (the `·` separators) | `recordNote` | exact | kept | the reconciler's parser still tolerates mangled separators |
| P7's `transaction_id` is P6's `payment_id` | `undoWithPaymentId`, `paymentIdShape`, `statusAfterUndo` | yes; the id had 22 characters of `^[0-9A-Za-z_-]+$`; `UNPAID` after the undo | yes, 22 characters | Undo sends P6's `payment_id`, checked against that shape (`PAYPAL_PAYMENT_ID_PATTERN`) |
| Cancel after an undo | `cancelAfterUndo`, `statusAfterCancel` | accepted; `CANCELLED` | the same | `cancel_paypal` (P8) |
| Token lifetime and scopes | `tokenLifetimeSeconds`, `tokenScopes` | 32,326 s; 24 scopes, `invoicing` and `applications/webhooks` among them | 32,326 s | used until 10 minutes before `expires_in`, whatever PayPal gives |
| Where an invoicing event carries the invoice | `webhookEventPaths` | `[]`: the event list held no event of the paid invoice right after the payment | `resource.invoice` | still UNVERIFIED; accepts `resource.invoice.id`, `resource.id` and invoice links, and nothing reads the event list: P10 is proven by the Worker's processed deliveries ([§4](#4-the-webhook-subscription)) |
| Whether Invoicing honours `PayPal-Request-Id` | not observable in one run | not observed | not honoured | every write sends one; a write whose answer is lost is settled by reading, never repeated blind |
| Sandbox rate limits and the reminder limit | not observable in one run | not observed | 2 reminders per invoice per day | at most one P9 per invoice per 24 h (the fence); 429 backs off |

Pinned on 2026-10-29: the fake's defaults follow the sandbox, `payerHost` and `PAYPAL_PAYER_HOSTS` hold the real host and the pay page the real payer page, the specification's UNVERIFIED tags on these rows read **C** with the report's date, and the L0 suite (`apps/api/test/openapi/contract.test.ts`) keeps running against the fake, which now also answers the sandbox's 400 for a reminder without an email (`apps/api/test/openapi/contract.ts`, correction 3).

## 6. Without PayPal: the fake

Tests, the e2e suite and `pnpm --filter @paylink/api run dev:offline` run against the PayPal fake: Invoicing v2 and Webhooks with PayPal's paths, statuses and error bodies, OAuth tokens, RSA-signed webhook deliveries and a P10 that accepts exactly the bytes delivered, a payer page with one "pay" button (its links take PayPal's form, `/invoice/p/#<id>`, and open `/invoice/p/<id>`), and test controls under `/__fake/` (pay, force a status, deliver webhooks, inject faults). Its answers are validated against PayPal's vendored schemas on every test run (`apps/api/test/openapi/contract.test.ts`).

## 7. The Pages preview of the branch `paypal`

The edition is served by Cloudflare Pages from the branch `paypal` at **`https://paypal.paylink-mg.pages.dev/paypal/`** (decision D-HOST, [ADR 0018](../adr/0018-paypal-edition.md)); production (`main`) stays as it is while other events judge it. In the Pages project `paylink-mg` ([Cloudflare Pages runbook §2](cloudflare-pages.md#2-build-settings)):

1. **Settings → Build → Branch control → Preview branch: Custom branches.** Add **`paypal`** to the included branches and keep `mezo`. A preview host is a subdomain of the passkey rpId ([ADR 0005](../adr/0005-dedicated-origin-and-rpid.md)); the PayPal edition has no passkeys (decision D-SCOPE), and allowing this branch is your decision.
2. **Settings → Environment variables → Preview:** `NODE_VERSION` = `22.22.0`, `PNPM_VERSION` = `10.28.0`, `SKIP_DEPENDENCY_INSTALL` = `1` (type Text). They are already there if the `mezo` preview builds; check them.
3. **A push builds it.** Pages builds a branch when it receives a push, so the push of `paypal` made before step 1 is not built: the next push is (Claude's, with the deployment record of [§9](#9-paylinkv2-on-ethereum-sepolia), or yours). Until then, the deploy kit can run from your computer ([§9](#9-paylinkv2-on-ethereum-sepolia) step 2).
4. **Check** `https://paypal.paylink-mg.pages.dev/paypal/status/`: "Build" names the pushed commit and the edition `paypal`; the PayLink API row reads the Worker of [§8](#8-the-worker-paylink-api) once it exists; the contract row turns green once [§9](#9-paylinkv2-on-ethereum-sepolia) is recorded and pushed. `https://paylink-mg.pages.dev/monad/` must not have changed.

The edition's API endpoint is `https://paylink-api.raherizonambinina.workers.dev`, written in `apps/web/public/config.json` (the relayer's account subdomain). If Cloudflare gives the Worker another URL, tell Claude: the configuration, the API's CORS list (`apps/api/src/core/config.ts`) and the CSP change together.

## 8. The Worker `paylink-api`

Cloudflare's Git integration deploys the committed bundle `apps/api/deploy/` byte for byte, as for the relayer ([relayer runbook §2–§3](relayer.md)); the settings are in [apps/api/README.md, "Deploy (owner)"](../../apps/api/README.md#deploy-owner):

| Field | Value |
|---|---|
| Project name | `paylink-api` |
| Production branch | `paypal` |
| Build command | *(empty)* |
| Deploy command | `npx wrangler@4.148.0 deploy` |
| Path (root directory) | `apps/api/deploy` |
| Variables | none |
| Builds for non-production branches | off |

1. Workers & Pages → Create → Import a repository → `nambininasafidison/paylink`, with the fields above.
2. The build log must list `env.PAYEE (Payee)` and `env.GLOBAL (Global)` as Durable Objects, `env.AI` as AI, the cron `* * * * *`, then the `workers.dev` URL. `apps/api/deploy/wrangler.toml` declares nothing else: no variable, no secret.
3. Add the secrets of [§2](#2-the-workers-secrets), type **Secret**: first `APPROVAL_HMAC_KEY`, `SESSION_HMAC_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`; `PAYPAL_WEBHOOK_ID` after [§4](#4-the-webhook-subscription).
4. Check `https://paylink-api.raherizonambinina.workers.dev/v1/health`: the rows `paypal`, `assistant`, `chain`, `store`; `webhook` stays "not configured" until §4. The Status page of the edition shows the same rows.

Workers AI needs no secret: the `[ai]` binding uses the account's own allocation, 10,000 neurons a day on the Free plan (`apps/api/src/ai/models.ts`, from Cloudflare's docs repository). The cron runs every minute and reads at most 20 twins a run. Whether the account's plan accepts a second Worker with Durable Objects and a cron is shown by step 2 (UNVERIFIED here).

## 9. PayLinkV2 on Ethereum Sepolia

Until this was done, the edition said "PayLinkV2 not deployed on Ethereum Sepolia yet": nothing could be signed or paid, and twins answered `E_CHAIN_UNKNOWN`. The deployment is the release's, through the CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C`, at `0x448eCce9711860502806A3d5B021a4f9Ba715082`, as on the other chains ([deploy runbook §8](deploy.md#8-mezo-testnet) is the same procedure for Mezo).

**Done on 2026-10-29 (steps 1 to 5).** The owner's "PayPal Demo" wallet, a standard account, sent the deployment directly from the kit: transaction `0x9a5ade1164108da82f79a2f522d8247e1822f8f182d87d338484c358fab0e5b3`, block 12,017,054, 18,946,483 gas used under a limit of 21,174,513, at the 1.5 gwei a gas MetaMask chose (0.0284 Sepolia ETH; read from the transaction and its receipt). `tools/verify-deployment` passed its ten checks through the registry's RPC, and the record the kit printed is byte-identical to `protocol/deployments/11155111.json`.

**Step 6 done on 2026-10-29.** Etherscan (Sepolia) shows "Source Code Verified - Exact Match" for the contract `PayLinkV2`: compiler `v0.8.30+commit.73712a01`, optimization on with 10,000 runs, EVM version `paris`, licence MIT, format Solidity Standard Json-Input, at `https://sepolia.etherscan.io/address/0x448eCce9711860502806A3d5B021a4f9Ba715082#code` (the owner's check).

1. **Gas: Sepolia runs Amsterdam.** The deployment needs about **19.25 million gas** (`eth_estimateGas` on Sepolia: 19,249,557; on a fork, 19,240,803), seven times Ethereum's earlier schedule ([sepolia.md §5](../research/paypal/sepolia.md#5-gas-sepolia-runs-amsterdam-read-2026-10-22)). The kit sends its estimate × 1.10, about 21.2 million, inside the measured bounds 19,241,000 to 28,862,000 (`web/v2/deploy/data/chains.json`). Your wallet must accept a gas limit that high; whether MetaMask asks for confirmation of it is UNVERIFIED. Cost: on 2026-10-22 (block 11,968,700) the base fee was 16 wei, the RPC suggested a 12-wei tip and most recent blocks' median tip was 1 gwei; at a 1 gwei tip the deployment charges about 0.019 Sepolia ETH and the wallet needs about 0.021 up front. The "PayPal Demo" wallet's 0.05 Sepolia ETH covers it.
2. **Open the kit.** On the preview (§7): `https://paypal.paylink-mg.pages.dev/v2/deploy/?chain=11155111`. Before the preview exists, from a checkout of `paypal`, in the browser where MetaMask runs: `python3 -m http.server 8080 --directory web`, then `http://localhost:8080/v2/deploy/?chain=11155111`.
3. **Release identity, before any prompt:** `initCodeHash` `0x289dcd64…7ac5`, address `0x448eCce9711860502806A3d5B021a4f9Ba715082`. If either differs, stop.
4. **Wallet:** a standard account (MetaMask's smart-account mode off: a relayed EIP-7702 deployment is untested on Sepolia), network Ethereum Sepolia (11155111). Every lamp green, **Deploy**, confirm without changing the gas limit.
5. The kit verifies the code and the transaction and prints the record. **Download** `11155111.json` and give it to Claude with the transaction hash and the date. Claude re-verifies it (`tools/verify-deployment`), commits `protocol/deployments/11155111.json` (done on 2026-10-29), regenerates the registry, the kit's data and the relayer bundle, adds the deployment to [`docs/tools/address-allowlist.json`](../tools/address-allowlist.json), the landing page and the submission pack, rebuilds `apps/api/deploy/`, runs the gates and pushes `paypal`.
6. **Source on Etherscan, the same day:** the file to upload is committed, `protocol/PayLinkV2-2.0.0.standard-input.json`; once `paypal` is pushed, download it from `https://raw.githubusercontent.com/nambininasafidison/paylink/paypal/protocol/PayLinkV2-2.0.0.standard-input.json`. It is exactly what `cd protocol && forge build --build-info && python3 script/standard-input.py > PayLinkV2-2.0.0.standard-input.json` writes, and the script prints nothing unless solc 0.8.30 compiles it to the release's init code (`initCodeHash` `0x289dcd64…7ac5`, checked again on 2026-10-29). Then on `https://sepolia.etherscan.io/address/0x448eCce9711860502806A3d5B021a4f9Ba715082` "Verify and Publish" with "Solidity (Standard-Json-Input)", compiler `v0.8.30+commit.73712a01`, contract `src/PayLinkV2.sol:PayLinkV2`, no constructor arguments (menu names UNVERIFIED: Etherscan is not reachable from here). Give Claude the link. **Done on 2026-10-29: Exact Match** (above).

The rehearsal of exactly this deployment, and of USDC and PayPal USD payments through it, ran on a fork of Sepolia under its own rules before the deployment: `tools/deploy-page/scripts/sepolia-fork.ts`, which now forks at block 12,017,053, the last block without the contract, whose state the public RPC no longer serves. `e2e/specs/paypal-rails.spec.ts` pays through the deployed contract itself, on a fork of today's Sepolia.

## 10. Judge sandbox buyers and judge links

The rules ask for test credentials in the testing instructions and a demo that stays free until judging ends ([rules §9](../research/paypal/rules.md#9-required-deliverables-s2-ah-unless-marked)). Judges get **sandbox buyer logins only**: never the client id, the secret, an HMAC key or a wallet key.

1. Developer Dashboard → **Testing tools → Sandbox accounts**: keep the business account bound to "PayLink Twin"; create **three personal (buyer) accounts**: "video", "judge A", "judge B", each with a sandbox balance large enough for the whole judging period (whether the balance is set at creation is UNVERIFIED; check in the dashboard). A US country is the usual choice for sandbox accounts (UNVERIFIED that any choice is unrestricted; never a false country for your own developer account). **Done by 2026-10-29:** the three exist, personal, US, 5,000 USD each, Verified; "video" paid the capture's invoice.
2. Keep their emails and passwords in your password manager. They go **only** into Devpost's testing-instructions field ([submission pack §6](../submissions/paypal.md#6-judge-access-instructions)), never into this repository, a screenshot, the video, a chat or the public description.
3. **Judge links (path B).** After [§9](#9-paylinkv2-on-ethereum-sepolia), on `/paypal/` with the payee wallet: three invoices per judge (for example 5.00, 7.50 and 12.00 USDC), each with its PayPal twin (a due date in the twin panel, 30 days ahead, is only PayPal's). **Set the form's "Expires" to "Never"** (and tick its confirmation) for every judge link and the video's: the form's default is 7 days and its longest finite choice 30, so a link signed around 2026-11-01 would stop being payable before or during judging (Dec 1–15); an expired link turns the PAYABLE lamp red, and the pay page then hides **Pay with PayPal** too (`apps/web/src/read/checks.ts`). If you prefer finite links, make new ones every week until 2026-12-15. Put the links in the testing instructions; a judge pays one with **Pay with PayPal** and their buyer login, without a wallet. Make new ones when they are used up.
4. **The demo payee's reserved lane.** Done on 2026-10-29: the "PayPal Demo" wallet, which deployed PayLinkV2 in [§9](#9-paylinkv2-on-ethereum-sepolia) and is the payee of the video and the judge links, is the one address in `demoPayees` (`apps/api/src/core/config.ts`), from the Worker bundle of that commit on. If you use another payee wallet, tell Claude its address (it is public): it goes into `demoPayees` too, so that the sessions and assistant calls of the wallet used for the video and the judge links draw on a reserved daily lane (500 sessions, 150 assistant calls, 2,500 of the 10,000 neurons) that the public cannot spend, and no per-source limit applies to it ([`src/store/quotas.ts`](../../apps/api/src/store/quotas.ts)). A judge's own wallet (path A) uses the public limits: 20 sessions per wallet and 30 per IP address a day, 60 assistant calls per wallet, 30 per IP address and 1,500 neurons per IP address a day.
5. After the winners are announced (around 2026-12-21), change the buyers' passwords.

## 11. Rehearsal

Twice before recording, then once a week until judging ends. Each line must pass on the live edition (preview, Worker, sandbox, Sepolia):

- [ ] `/paypal/status/`: PayLink API online; PayPal sandbox read; webhook "Last verified webhook" recent; assistant with its neurons left; PayLinkV2 deployed.
- [ ] **Rail 1:** an invoice of 12.00 USDC with a PayPal twin (twin panel "made and read back from PayPal"); the link in a second browser profile; **Pay with PayPal**; pay as the "video" buyer on PayPal's sandbox page; the till turns green "via PAYPAL · verified with PayPal"; the desk proposes "Cancel the PayLink link" with the exact values; approve; the wallet sends one `cancel`; the card reads Done.
- [ ] **Rail 2:** another invoice, paid in USDC from the second profile's wallet (one signature, one transaction); **Check my invoices** shows "Recorded on PayPal invoice …" with Undo; PayPal's merchant view of that invoice shows the recorded payment (the capture saw `MARKED_AS_PAID`: write down the status it shows); Undo once, then record again by a tap.
- [ ] **K4, the open half of the capture's question:** with the twin recorded (`MARKED_AS_PAID`), open the twin's payer page (`https://www.sandbox.paypal.com/invoice/p/#…`, the link the pay page offered before the payment) in a browser logged in as a sandbox buyer, and write down whether PayPal still offers to pay it. Do not pay it. Tell Claude: if it does, the executor must also propose cancelling the PayPal invoice after a record (SPEC §10.4).
- [ ] **Assistant:** paste a client message on create, Draft, check the values, Use draft. Note the model shown on the card and the neurons left on Status afterwards.
- [ ] **Was I really paid?** with a made-up "payment pending" notice: "Not received", from PayPal and the chain.
- [ ] The Worker's logs (Workers & Pages → `paylink-api` → Logs) show `webhook.received` with `outcome: processed` for the PayPal payment, and no error line.

Write down what differed from this runbook and tell Claude.

## 12. Until judging ends

The demo stays live and free until **2026-12-15** (end of judging; [rules §2](../research/paypal/rules.md#2-dates)). Weekly: one sandbox payment (a fresh verified webhook), the buyers' balances, the assistant's neurons on Status (the free allocation resets at 00:00 UTC; when it is spent the assistant rests and every manual path works), the payee wallet's Sepolia ETH, and **every judge link still PAYABLE**: open each one, the four lamps are green (PAYABLE among them) and **Pay with PayPal** is shown; a link that expired or was paid is replaced ([§10](#10-judge-sandbox-buyers-and-judge-links) step 3). The desk's alerts: a `record-missing` alert means a record of a chain payment left the PayPal invoice (a lost Undo answer, or a deletion in PayPal's dashboard), so that invoice is payable on PayPal again; record it again or cancel the PayPal invoice from the desk. Do not push anything breaking to `paypal`; a push redeploys both the preview and the Worker. After 2026-12-22, rotate every secret of [§2](#2-the-workers-secrets) and the buyers' passwords.

## 13. Troubleshooting

| Symptom | Rule (in the problem's `rule`, or the log line) | Cause | Fix |
|---|---|---|---|
| Every PayPal route answers 503 | `E_PAYPAL_NOT_CONFIGURED` | client id or secret missing | §2 |
| 503 after a secret change | `invalid_client` (log `paypal.call`, op `P1`, status 401) | wrong secret pasted | paste the app's current Secret again |
| The capture stops at `token` (P1) with 401 `invalid_client` | the capture's step `token` refused | a secret from another place was pasted (on 2026-10-29: the dashboard's Sandbox/Live switch is easy to miss) | copy the Secret of the **Sandbox** app "PayLink Twin" again, check it with one token request, then run again (§3) |
| PayPal deliveries answer 503 | `E_WEBHOOK_NOT_CONFIGURED` | `PAYPAL_WEBHOOK_ID` missing | §4, then §2 |
| PayPal deliveries answer 400 | `E_WEBHOOK_SIGNATURE` (log `webhook.rejected`) | the id belongs to another subscription, a simulator event, or a forged call | check the id against the subscription of this Worker's URL; test with a real sandbox payment |
| A twin answers 409 | `E_PAYPAL_SCHEDULED` | PayPal scheduled the share (an issue date in its future) | report it: the twin is S0; the capture's `sendAnswer` says whether this can happen |
| A twin answers 400 | `E_CHAIN_UNKNOWN` | PayLinkV2 is not recorded on Ethereum Sepolia yet (decision D-CHAIN) | [§9](#9-paylinkv2-on-ethereum-sepolia) |
| Opening the desk answers 500 | `E_SESSION_KEY_MISSING` or `E_SESSION_KEY_INVALID` | `SESSION_HMAC_KEY` missing or not 32 hex bytes | [§2](#2-the-workers-secrets) |
| Approving a proposal answers 500 | `E_APPROVAL_KEY_MISSING` or `E_APPROVAL_KEY_INVALID` | `APPROVAL_HMAC_KEY` missing or not 32 hex bytes | [§2](#2-the-workers-secrets) |
| The pay page withholds the PayPal key | (pay page note "PayPal option withheld") | the twin's amount differs from the signed one, or PayPal's payer link is not the pinned payer page `https://www.sandbox.paypal.com/invoice/p/#…` (another host, path or a query) | the desk says which; for the page, [§5](#5-what-the-capture-decides) |
| No "Send PayPal's reminder" on an open invoice; the share card says PayPal's reminder is not offered | reason `share-reminder-no-email`; rule `E_PAYPAL_REMINDER_NEEDS_EMAIL` if PayPal refused one anyway | the twin has no client email on PayPal, and PayPal refuses its reminder without one (400 `CANNOT_REMIND_AS_BILLING_INFO_ABSENT`, the capture of 2026-10-29) | share the reminder message from the share card; give the client's email when making the next twin |
| The deploy kit refuses the gas, or the wallet caps it | `E_GAS_ABOVE_CEILING`, or the wallet's own message | an estimate outside 19,241,000–28,862,000, or a wallet that will not send about 21.2 million gas | [§9](#9-paylinkv2-on-ethereum-sepolia) step 1; tell Claude the estimate shown |
| 502 `paypal-rejected` | PayPal's name and issue, e.g. `UNPROCESSABLE_ENTITY:CANNOT_REMIND_INVOICE` | PayPal refused what the API sent | the issue says why; `debug_id` is in the log line for PayPal support |
| 503 `paypal-unavailable` with `Retry-After` | `E_PAYPAL_NO_ANSWER`, `SERVICE_UNAVAILABLE`, `RATE_LIMIT_REACHED` | PayPal down or throttling | nothing: reads are retried, the cron backs off, the API answers again when PayPal does |
| A reminder card reads "PayPal did not answer. It may have sent the reminder…" | audit `P9-unconfirmed` (log `executor.unconfirmed`) | PayPal's answer to the reminder was lost; it cannot be read back, so it counts as sent | nothing: no reminder is offered for 24 hours, so the client never gets two |
| A desk alert "PayLink's record of the chain payment is no longer on the PayPal invoice" | alert `record-missing` (log `reconcile.record-missing`) | a record PayLink made on PayPal is gone without an Undo here: a lost Undo answer, or a deletion in PayPal's dashboard | the chain is paid and the PayPal invoice is payable again: approve "record it again" or "cancel the PayPal invoice" on its card |
| 429 on opening a desk session or on the assistant | `E_QUOTA_SOURCE`, `E_QUOTA_PAYEE`, `E_QUOTA_GLOBAL`, `E_SESSION_QUOTA` | a daily limit of the public demo (per IP address, per wallet, or the deployment's) | wait for 00:00 UTC; the demo payee of [§10](#10-judge-sandbox-buyers-and-judge-links) step 4 has its own lane |
