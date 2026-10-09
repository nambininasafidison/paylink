# Runbook: the history indexer on Envio Cloud

How to put the history indexer (`apps/indexer`, Envio HyperIndex 3.12.1, [ADR 0009](../adr/0009-read-model-chain-device-indexer.md)) online on **Envio Cloud** (formerly "Hosted Service"), free development plan, straight from the GitHub repository; then wire its GraphQL endpoint into the app, keep it alive through the judging windows, and turn it off. What the indexer does and why: [apps/indexer/README.md](../../apps/indexer/README.md).

Who does what:

| Step | Who | Where |
|---|---|---|
| Indexer code, tests, this runbook | Claude | this repository |
| Push `main` | you | GitHub |
| Create the deployment branch `envio` ([§2](#2-create-the-deployment-branch)) | you, or your browser assistant with the [prompt in §9](#9-prompt-for-your-browser-assistant) | GitHub |
| Sign in to Envio Cloud, connect the repository, add the indexer ([§3](#3-add-the-indexer-on-envio-cloud)) | you or the assistant | envio.dev |
| Create an Envio API token and paste it, **only if** a deployment asks for one ([§4](#4-the-envio-api-token-only-if-asked)) | **you only**, never an assistant | envio.dev |
| Check the endpoint ([§5](#5-check-the-endpoint)) | you or the assistant | browser or terminal |
| Put the endpoint in `/config.json` and ship ([§6](#6-turn-the-history-service-on-in-the-app)) | Claude, after your check | this repository |

> **Nothing here is secret except the Envio API token**, and the indexer may not even need one on Envio Cloud. The GraphQL endpoint, the contract addresses and everything the indexer stores are public on-chain data. The token, if asked for, is pasted by you into Envio's own environment-variable field and nowhere else: not GitHub, not this repository, not a chat.

## Contents

1. [Before you start](#1-before-you-start)
2. [Create the deployment branch](#2-create-the-deployment-branch)
3. [Add the indexer on Envio Cloud](#3-add-the-indexer-on-envio-cloud)
4. [The Envio API token (only if asked)](#4-the-envio-api-token-only-if-asked)
5. [Check the endpoint](#5-check-the-endpoint)
6. [Turn the history service on in the app](#6-turn-the-history-service-on-in-the-app)
7. [Operations: redeploy, update, turn off](#7-operations-redeploy-update-turn-off)
8. [Troubleshooting](#8-troubleshooting)
9. [Prompt for your browser assistant](#9-prompt-for-your-browser-assistant)
10. [Bounty answer draft (Monad Metropolis, Envio)](#10-bounty-answer-draft-monad-metropolis-envio)

---

## 1. Before you start

- [ ] `main` is pushed to `github.com/nambininasafidison/paylink` (public) and contains `apps/indexer/` with `package.json`, `config.yaml`, `schema.graphql` and `src/handlers/PayLinkV2.ts`.
- [ ] Locally, the indexer's tests pass: `pnpm --filter @paylink/indexer test` (offline, no Docker).
- [ ] You can sign in to GitHub as `nambininasafidison`.

What Envio Cloud will build, so you recognise it in its dashboard:

| Setting | Value |
|---|---|
| Indexer name | `paylink-v2` (any unique name works; this one matches `config.yaml`) |
| Repository | `nambininasafidison/paylink` |
| Root Directory | `apps/indexer` |
| Config File | `config.yaml` |
| Deployment branch | `envio` (not `main`, see [§2](#2-create-the-deployment-branch)) |
| Plan | Development (free) |
| HyperIndex version | `3.12.1`, read from `apps/indexer/package.json` |
| Chains | Monad testnet `10143` from block `69331735`; Base Sepolia `84532` from block `47859253` |
| Contract | `0x448eCce9711860502806A3d5B021a4f9Ba715082` on both chains |
| Data source | HyperSync (both chains are in envio 3.12.1's HyperSync list), the public RPCs as fallback |
| Environment variables | none, unless [§4](#4-the-envio-api-token-only-if-asked) applies |

Facts about the free development plan, as Envio's documentation and pricing page described them when this runbook was written (2026-10-09, read through a web search, not first hand; **check them on the page** before relying on them):

- no payment card; 3 development indexers per organisation, 3 deployments per indexer (delete old deployments to free a slot);
- a development deployment lives **at most 30 days**, has no uptime commitment, and is cleaned up past soft limits (about 100,000 events, 5 GB of storage, or 7 days without requests);
- **every deployment gets its own GraphQL URL**: on the development plan the URL changes with each deployment (static endpoints are a paid-plan feature);
- the build must work with pnpm 10.32 and Node 22 or later (Envio recommends Node 24); envio 3.12.1 itself requires Node 22 or later;
- the Root Directory's `package.json` must list `envio` with an explicit version (it does: `test/package.test.ts` keeps it so).

## 2. Create the deployment branch

Envio Cloud deploys whenever the branch it watches receives a push (the default branch name it suggests is `envio`). Use a dedicated `envio` branch, not `main`: every deployment on the free plan gets a **new URL**, so watching `main` would replace the indexer, and break the app's `/config.json`, on every unrelated push.

Create it from `main`, once:

- **Web:** github.com/nambininasafidison/paylink → the branch selector (top left, shows "main") → type `envio` → "Create branch envio from main".
- **Terminal:** `git push origin main:envio`

To deploy a newer version later, move `envio` to the new `main` (§7).

## 3. Add the indexer on Envio Cloud

Dashboard labels change from time to time; the text in quotes is what to look for.

1. Open **https://envio.dev/app** and choose **"Sign in with GitHub"**. Authorise Envio for your account if GitHub asks.
2. If asked to pick or create an organisation, use your personal one (`nambininasafidison`).
3. Click **"Add indexer"** (or "New indexer" / "Deploy indexer").
4. When Envio asks for repository access, it opens GitHub to install the **"Envio Deployments"** GitHub app. Choose **"Only select repositories"** → `nambininasafidison/paylink` → "Install". Do not grant access to all repositories.
5. Fill in the indexer settings with the values of [§1](#1-before-you-start): name `paylink-v2`, repository `nambininasafidison/paylink`, **Root Directory `apps/indexer`**, **Config File `config.yaml`**, **branch `envio`**, plan **Development** (free). If a plan picker asks for a card, you are on a paid plan: go back and pick Development.
6. Leave environment variables empty. Create the indexer.
7. The first deployment starts from the latest commit on `envio` (if it does not, push to `envio` again: §7). Open the deployment and watch its build logs, then its sync status. Both chains start at their deployment block, so the backfill covers only PayLink's own short history.
8. When the deployment shows it is synced (or "ready"), copy its **GraphQL endpoint**. Development endpoints have the form `https://indexer.dev.hyperindex.xyz/<id>/v1/graphql`; copy exactly what the dashboard shows.

If the build fails, the logs say why: [§8](#8-troubleshooting).

## 4. The Envio API token (only if asked)

HyperSync needs an API token when HyperIndex runs **outside** Envio Cloud (`pnpm --filter @paylink/indexer dev` on your computer). Whether Envio Cloud needs one depends on Envio's current setup. Add it **only** if the deployment logs ask for it (a message about a missing or invalid HyperSync / API token, or `ENVIO_API_TOKEN`):

1. In Envio's dashboard, open your account's **API tokens** page and create a token. Do this yourself; do not let an assistant read or copy it.
2. In the indexer's settings, open **Environment variables**, add the name `ENVIO_API_TOKEN` and paste the token as its value. Envio Cloud only passes variables whose names start with `ENVIO_`.
3. Variables apply to the next deployment: redeploy (§7).

Never put the token in GitHub (no GitHub secret is needed: nothing in this repository's workflows talks to Envio), in this repository, or in a chat.

## 5. Check the endpoint

Replace `URL` with the endpoint from §3 step 8. From a terminal (or ask the assistant to run the same queries in the GraphQL playground Envio shows):

```bash
URL='https://indexer.dev.hyperindex.xyz/<id>/v1/graphql'

# 1. Progress per chain: both chains present, isReady true once caught up.
curl -s "$URL" -H 'content-type: application/json' \
  --data '{"query":"{ _meta { chainId progressBlock isReady } }"}'

# 2. Your own wallet as a payee (any payments made to it through PayLink v2):
curl -s "$URL" -H 'content-type: application/json' \
  --data '{"query":"{ Payee(where: {payee: {_eq: \"0x0c397c6c8f94eaa6662ee548fa140e6dfed4aea6\"}}) { chainId payments links uniquePayers firstPaidAt lastPaidAt } }"}'

# 3. The latest payments on both chains:
curl -s "$URL" -H 'content-type: application/json' \
  --data '{"query":"{ Payment(order_by: {timestamp: desc}, limit: 5) { chainId key payee payer amount txHash logIndex } }"}'

# 4. The browser may call it from the app's origin (CORS):
curl -s -o /dev/null -D - -X OPTIONS "$URL" \
  -H 'Origin: https://paylink-mg.pages.dev' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' | grep -i '^access-control-allow'
```

Expected: (1) two rows, `10143` and `84532`, `progressBlock` at or near each chain's head; (2) and (3) whatever payments really happened on PayLink v2 (empty lists are a valid answer if none happened yet); (4) `access-control-allow-origin` is `*` or `https://paylink-mg.pages.dev`, and `access-control-allow-headers` includes `content-type`. If (4) prints nothing, the browser cannot use this endpoint: tell Claude before §6.

Cross-check one payment against the chain: open `https://testnet.monadscan.com/tx/<txHash>` (or `https://sepolia.basescan.org/tx/<txHash>` for 84532) and see the `Paid` log of contract `0x448eCce9…715082`.

## 6. Turn the history service on in the app

Claude does this in the repository once you send the endpoint and the result of §5:

1. `apps/web/public/config.json`: `"indexer": { "url": "<URL>", "chains": [10143, 84532] }`. It is the only place the URL lives (spec §3.6: no URL-configurable endpoints).
2. `pnpm --filter @paylink/web run headers`: the Content-Security-Policy `connect-src` of `public/_headers` gains the endpoint's origin (the web tests fail if `_headers` is stale).
3. `pnpm -r test`, then commit; you push `main`; Cloudflare Pages redeploys.
4. Check on the live site:
   - `/status/` → "History service" reads "Monad testnet: indexed to block …" (green once both chains are caught up, amber while one is catching up);
   - `/monad/ledger/` with your PayLink key → "Payments received" shows your record ("N payments received since … · M payers"), says "From the PayLink history service (Envio)" and lists your payments; each "Verify receipt" opens a receipt that verifies on the network.

If the history service stops answering, nothing breaks: the ledger falls back to the network's latest blocks and says so, and every invoice state still comes from `statesOf`. The pay view does not use the history service yet (its first load is at the 110 kB budget: [apps/indexer/README.md](../../apps/indexer/README.md#why-it-exists)).

## 7. Operations: redeploy, update, turn off

| When | What | Then |
|---|---|---|
| **Before each judging window** (Monad Metropolis judging Oct 14–27; Colosseum review) and at least every 25 days: a development deployment lives at most 30 days | Move `envio` to `main`: `git push origin main:envio` (or on GitHub delete branch `envio` and create it again from `main`) | New deployment, **new URL**: redo §5, then Claude updates `/config.json` (§6) |
| `apps/indexer` changed on `main` | Same as above | Same |
| Envio asks for a token | §4 | Redeploy |
| Out of deployment slots (3 per indexer) | Delete the oldest deployments in the indexer's page; keep the one `/config.json` points to until its replacement is live | |
| Turn it off | `"indexer": null` in `/config.json` (Claude), then delete the indexer on Envio Cloud | The app reads the network only |

Never point `/config.json` at an endpoint you have not checked with §5.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails before any script: "missing envio package / invalid version" | Root Directory is not `apps/indexer`, so Envio reads the repository root's `package.json` (the frozen v1 app, without `envio`) | Set Root Directory `apps/indexer`, Config File `config.yaml`; redeploy |
| Build fails in `pnpm install` | Envio's builder and this pnpm workspace disagree (the package is designed to install either inside the workspace or alone) | Send Claude the log lines around the error |
| Logs mention a missing HyperSync / API token | Envio Cloud needs `ENVIO_API_TOKEN` for this account | §4 |
| Synced, but `_meta` lacks a chain, or `progressBlock` stays at the start block | HyperSync for that chain unavailable; the RPC fallback is slow (Monad: 100 blocks per request) | Wait; check Envio's status page; tell Claude |
| Endpoint answers but the app shows "Payment history … unavailable" | CORS (§5 check 4), a stale `_headers`, or `/config.json` not deployed yet | Check `/status/` and the browser console; tell Claude |
| Old URL stopped answering | 30-day lifetime or clean-up after 7 days without requests | §7 redeploy; the app falls back to the network meanwhile |

## 9. Prompt for your browser assistant

Paste the block below into your browser assistant (for example Claude in Chrome) while you are signed in to GitHub. It creates the branch, adds the indexer, waits for the first deployment and reports the endpoint. It stops whenever a token is involved.

```text
You are helping me deploy a blockchain indexer from my public GitHub repository to Envio Cloud (envio.dev),
on the free Development plan. Work step by step, describe what you see, and stop and ask me whenever the
screen does not match these instructions.

HARD RULES
- Never create, type, paste, read, reveal, copy or screenshot any API token, secret, password or key.
  If any page asks for a token (for example an "Environment variables" field or "ENVIO_API_TOKEN"),
  stop and tell me: I will create and paste it myself, and you must not watch that page while I do.
- Never choose a paid plan, never enter payment details. If a card is requested, stop and tell me.
- When GitHub asks which repositories an app may access, choose "Only select repositories" and select
  only nambininasafidison/paylink. Never "All repositories".
- On GitHub, the only change you may make is creating the branch "envio" from "main". Do not edit files,
  open pull requests, change settings, or touch any other branch. On Envio, change nothing except the one
  indexer described here. Do not delete anything.

PART A: deployment branch (GitHub)
1. Open https://github.com/nambininasafidison/paylink. Open the branch selector (it shows "main").
   If a branch named "envio" already exists, report its latest commit and skip to step 3.
2. Type "envio" and choose "Create branch envio from main". Report the commit it points to
   (the 7-character hash shown on the branch page).

PART B: the indexer (Envio Cloud)
3. Open https://envio.dev/app and sign in with GitHub (account nambininasafidison).
   If asked for an organisation, use the personal one.
4. Choose "Add indexer" (or "New indexer" / "Deploy indexer"). If Envio sends you to GitHub to install the
   "Envio Deployments" app, install it on "Only select repositories" -> nambininasafidison/paylink.
5. Enter exactly:
   - Indexer name: paylink-v2
   - Repository: nambininasafidison/paylink
   - Root Directory: apps/indexer
   - Config File: config.yaml
   - Branch: envio
   - Plan: Development (free)
   - Environment variables: none
   Create the indexer.
6. Open the indexer's latest deployment. If no deployment started within 2 minutes, tell me (I will push
   to the branch) and wait. Otherwise watch the build logs. If the build fails, report the 20 log lines
   around the first error verbatim and stop. If any log line mentions an API token, HyperSync token or
   ENVIO_API_TOKEN, stop and tell me (runbook section 4).
7. When the build succeeds, watch the sync status until both chains are synced or 15 minutes have passed.
   Report the status per chain (10143 and 84532) and the processed block if shown.

PART C: report
8. Copy the deployment's GraphQL endpoint URL (it should look like
   https://indexer.dev.hyperindex.xyz/<id>/v1/graphql) and report it exactly.
9. If Envio shows a GraphQL playground (Hasura console) for the deployment, run this query and report the
   JSON answer:  { _meta { chainId progressBlock isReady } }
   Then this one:  { Payment(order_by: {timestamp: desc}, limit: 5) { chainId payee amount txHash } }
10. Give me a short checklist: branch created (commit), indexer created (settings as entered), deployment
    status, endpoint URL, query results, and anything that did not match these instructions.
```

When it reports back, send Claude the endpoint and the two query answers (§5); Claude runs the CORS check (§5, step 4) and wires the app (§6).

## 10. Bounty answer draft (Monad Metropolis, Envio)

For the form field *"meaningfully uses HyperIndex/HyperSync/HyperRPC to power real on-chain data, actually driving a feature"*. Fill the bracketed parts only with what is true on submission day; delete a sentence rather than guess.

> PayLink's indexer (`apps/indexer`, HyperIndex 3.12.1, sourced from HyperSync) indexes our PayLinkV2 contract's `Paid` and `InvoiceCancelled` events on Monad testnet (and Base Sepolia) from its deployment block. It drives the merchant's books in the live app: the ledger lists every payment received, across devices, newest first, each with a receipt link that the app re-verifies on Monad RPC; it shows the merchant's record ("N payments received since <date> · M payers") and volume per token, and the median time to get paid for multi-payment links; and the status page shows how far the index has processed each chain. Monad's public RPC caps `eth_getLogs` at 100 blocks (about 40 seconds), so none of these could be built from the browser alone; without the indexer the app falls back to the last few minutes of logs and says so. The indexer is a cache by design: payment states come from the contract (`statesOf`) and receipts from RPC, so a stale or wrong index cannot make an unpaid invoice look paid. Handlers are pure functions tested with Envio's `createTestIndexer`. Endpoint: [GraphQL URL from §3]. Indexed so far: [from `_meta`, on submission day].
