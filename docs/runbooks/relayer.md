# Runbook: the gasless relayer on Cloudflare Workers

How to put the relayer (`apps/relayer`, [ADR 0007](../adr/0007-relayer-durable-object-per-chain.md)) online at **`https://paylink-relayer.raherizonambinina.workers.dev`**, give it its own key and gas, check it, and run it through the judging windows. What it does and why is in the [relayer README](../../apps/relayer/README.md).

Who does what:

| Step | Who | Where |
|---|---|---|
| Code, the deployable bundle `apps/relayer/deploy/`, checks after every change | Claude | this repository |
| Push `main` | you | GitHub |
| Create the Worker from the repository, check its build settings ([§2](#2-create-the-worker-from-the-repository), [§3](#3-check-the-build-settings)) | you, or your browser assistant with the [prompt in §9](#9-prompt-for-your-browser-assistant) | Cloudflare dashboard |
| Create the relayer key and store it as a secret ([§4](#4-create-the-relayer-key-and-store-it-yourself)) | **you only**, never an assistant | your computer's browser, Cloudflare dashboard |
| Fund the relayer's address ([§5](#5-fund-the-relayer)) | you | a faucet or MetaMask |
| Smoke test and checks ([§6](#6-smoke-test)) | you or the assistant | browser |
| Turn the relayer on in the app ([§7](#7-turn-the-relayer-on-in-the-app)) | Claude, after your smoke test | this repository |

> **Golden rule.** `RELAYER_PK` is a **new, throwaway testnet key made for the relayer alone**. It is never your MetaMask key or any key derived from your seed phrase. It exists in exactly one place, the Worker secret: never in the chat (yours with Claude or with a browser assistant), GitHub, a file, a screenshot or a password manager note. The relayer only ever needs it inside Cloudflare, so nobody, you included, has to know it.

## Contents

1. [Before you start](#1-before-you-start)
2. [Create the Worker from the repository](#2-create-the-worker-from-the-repository)
3. [Check the build settings](#3-check-the-build-settings)
4. [Create the relayer key and store it (yourself)](#4-create-the-relayer-key-and-store-it-yourself)
5. [Fund the relayer](#5-fund-the-relayer)
6. [Smoke test](#6-smoke-test)
7. [Turn the relayer on in the app](#7-turn-the-relayer-on-in-the-app)
8. [Operations: refill, update, rotate, stop, roll back](#8-operations-refill-update-rotate-stop-roll-back)
9. [Prompt for your browser assistant](#9-prompt-for-your-browser-assistant)
10. [Troubleshooting](#10-troubleshooting)
11. [Fallback: deploy from your own computer](#11-fallback-deploy-from-your-own-computer)

---

## 1. Before you start

- [ ] `main` is pushed to `github.com/nambininasafidison/paylink` and contains `apps/relayer/deploy/` with three files besides `SHA256SUMS`: `wrangler.toml`, `worker.js` and `LICENSES.txt`. Cloudflare deploys `worker.js` byte for byte (`no_bundle = true`); Claude rebuilds and commits it after every change, and the test suite fails if it is stale (`pnpm --filter @paylink/relayer run build:check`).
- [ ] You can sign in to the Cloudflare account that owns the Pages project `paylink-mg` and the workers.dev subdomain **`raherizonambinina.workers.dev`** (Workers & Pages → the subdomain is shown on the overview page).
- [ ] Cloudflare's GitHub app already has access to `nambininasafidison/paylink`: the Pages project has been connected to it since 2026-10-07. Workers use the same app.
- [ ] Your MetaMask holds some MON on Monad testnet (5 MON on 2026-10-07), or a MON faucet works for you ([faucets runbook](faucets.md)).

What the Worker is, so you recognise it in the dashboard:

| Setting | Value (from `apps/relayer/deploy/wrangler.toml`) |
|---|---|
| Worker name | `paylink-relayer` (must match exactly, or the build fails) |
| URL | `https://paylink-relayer.raherizonambinina.workers.dev` |
| Durable Object binding | `CHAIN_SENDER` → class `ChainSender`, SQLite-backed (the only kind the Workers Free plan offers) |
| Secret | `RELAYER_PK` (you add it in [§4](#4-create-the-relayer-key-and-store-it-yourself)); there are **no** plain variables |
| Logs | Workers Logs on, every request (`[observability]`) |
| Preview URLs | off |

## 2. Create the Worker from the repository

Cloudflare's Git integration for Workers ("Workers Builds") clones `main`, runs one deploy command in `apps/relayer/deploy`, and redeploys on every push that touches that folder. Dashboard labels move from time to time; the text in quotes is what to look for.

1. Open `https://dash.cloudflare.com` and sign in. Pick the account if asked.
2. In the left sidebar open **"Workers & Pages"** (under "Compute"; on some layouts "Compute (Workers)" → "Workers & Pages").
3. Click **"Create"** (or "Create application"), stay on the **Workers** tab, and choose **"Import a repository"** → **"Get started"** / "Continue with GitHub".
4. Select the GitHub account **`nambininasafidison`**, then the repository **`paylink`**. Click **"Next"** / "Begin setup".
5. On "Set up your application" (or "Configure your project") fill in exactly:

   | Field | Value |
   |---|---|
   | Project name | `paylink-relayer` |
   | Build command | *(leave empty)* |
   | Deploy command | `npx wrangler@4.148.0 deploy` |
   | Builds for non-production branches | **off** (untick it). If it cannot be unticked here, set its command to `npx wrangler@4.148.0 versions upload` and untick it in [§3](#3-check-the-build-settings) |
   | "Advanced settings" → Path (root directory) | `apps/relayer/deploy` |
   | "Advanced settings" → API token | keep "Create new token" (Cloudflare makes a build token for this Worker and keeps it; you never see or copy it) |
   | "Advanced settings" → Variables | *none*. **Never** put `RELAYER_PK` here: build variables are not runtime secrets |

6. Click **"Deploy"** (or "Create and deploy"). The first build takes one to two minutes.
7. The build log must end with lines like these. The Durable Object line and the workers.dev URL are the two that matter:

   ```text
   Your Worker has access to the following bindings:
   Binding                                    Resource
   env.CHAIN_SENDER (ChainSender)             Durable Object
   Uploaded paylink-relayer (… sec)
   Deployed paylink-relayer triggers (… sec)
     https://paylink-relayer.raherizonambinina.workers.dev
   ```

   The very first deploy also applies the migration `v1` (`new_sqlite_classes = ["ChainSender"]`). If the build fails, see [§10](#10-troubleshooting).
8. Open `https://paylink-relayer.raherizonambinina.workers.dev/v1/health`. It answers HTTP 503 with `"status": "down"` and every chain `"state": "not-configured"`, `"relayer": null`: correct, there is no key yet.

## 3. Check the build settings

Worker **`paylink-relayer`** → **"Settings"** → **"Build"** (section "Build configuration" / "Git repository"):

| Setting | Must be |
|---|---|
| Git repository | `nambininasafidison/paylink` |
| Branch control → Production branch | `main` |
| Branch control → Builds for non-production branches | **disabled** |
| Build configuration → Build command | empty |
| Build configuration → Deploy command | `npx wrangler@4.148.0 deploy` |
| Build configuration → Root directory / Path | `apps/relayer/deploy` |
| Build watch paths → Include paths | `apps/relayer/deploy/*` (edit the default `*`; then commits that do not change the bundle do not redeploy) |
| Build watch paths → Exclude paths | empty |

Then **"Settings"** → **"Domains & Routes"**: `workers.dev` **enabled**, "Preview URLs" **disabled**. Leave everything else as it is: no custom domain (the zone `safidison.me` has a bot challenge that would block the app's requests), no routes, no cron triggers.

## 4. Create the relayer key and store it (yourself)

Do this on a computer, alone: **do not let a browser assistant run, watch or read this step**, and do not share your screen. The key goes from your browser's random generator to your clipboard to the Cloudflare secret field without ever being shown.

1. In Chrome, Edge or Firefox on your computer, open a **new tab** at `about:blank`.
2. Open the developer console: `Ctrl+Shift+J` (Windows, Linux) or `Cmd+Option+J` (macOS). In Firefox: `Ctrl+Shift+K` / `Cmd+Option+K`.
3. If the console says pasting is blocked, type `allow pasting` and press Enter.
4. Paste this line and press Enter:

   ```js
   copy("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""))
   ```

   The console prints `undefined`. A fresh 32-byte key is now in your clipboard and nowhere else; it is not displayed. (`crypto.getRandomValues` is the browser's cryptographic generator; `copy()` is the console's clipboard helper.)
5. In the Cloudflare tab: Worker **`paylink-relayer`** → **"Settings"** → **"Variables and Secrets"** → **"+ Add"**:
   - Type: **"Secret"** (not "Text");
   - Variable name: `RELAYER_PK`;
   - Value: paste (`Ctrl+V` / `Cmd+V`). Do not type or reveal it.

   Click **"Deploy"**. Cloudflare encrypts it and deploys a new version with it; the value can never be read back from the dashboard, only replaced.
6. Clear the clipboard: copy any other text (for example a word on this page). Close the `about:blank` tab.

Nobody knows this key now, which is the point: it only pays relay gas, it holds at most about 2 MON of testnet coin, and it is replaced, not recovered, if anything goes wrong ([§8](#8-operations-refill-update-rotate-stop-roll-back)). The relayer accepts it with or without `0x` and refuses anything that is not a valid secp256k1 key (the chain then stays `not-configured`).

## 5. Fund the relayer

1. Open `https://paylink-relayer.raherizonambinina.workers.dev/v1/health` again. Every chain now shows the same `"relayer": "0x…"`: the relayer's **public address**, safe to copy and share. Its state is `"unfunded"`.
2. **Monad testnet:** send it **1.5 to 2 MON**, never more than about 2 (it bounds what a leaked key could spend):
   - from the MON faucet on the Monad Metropolis dashboard, or QuickNode `faucet.quicknode.com/monad`, entering the relayer's address; or
   - from MetaMask on Monad testnet: **Send** → paste the relayer's address → `1.5` MON → confirm. Check the first and last four characters of the address in MetaMask against the health page.
3. **Base Sepolia and Arbitrum Sepolia** (when you have Sepolia ETH): send **0.01 to 0.02 ETH** to the same address on each. One key, one address, every chain.
4. Reload the health page. Monad testnet should read `"state": "awaiting-deployment"` until the PayLinkV2 deployment on Monad is recorded in the registry ([deploy runbook](deploy.md#4-deploying-v2-to-a-testnet)), then `"ready"`. `balanceWei` is the balance in wei (1 MON = 10^18), `minBalanceWei` the level below which the chain reports `unfunded` (one payment at the gas ceiling and twice the base fee, about 0.07 MON on Monad).

What a relay costs the relayer (measured on an anvil fork of Monad testnet, 2026-10-07): a gasless payment has a limit of about 275,000 gas, all of it charged on Monad, so about **0.028 MON** at the 100-gwei minimum base fee; an onboarding drip about 0.015 MON. The daily gas budget stops the relayer at **1 MON a day** on Monad (about 35 payments) and 0.005 ETH a day on each Sepolia chain ([`apps/relayer/src/core/policy.ts`](../../apps/relayer/src/core/policy.ts)); after that, payers self-submit until midnight UTC.

## 6. Smoke test

The onboarding endpoint signs and sends a real transaction without needing the PayLinkV2 deployment, so it tests the key, the funding, the Durable Object, the RPCs and the Workers CPU limits at once. It asks the AUSD faucet for 10,000 test AUSD for **your own** address.

From a terminal on your computer, with your MetaMask address in place of `<your address>` (copied from MetaMask: `0x` and 40 hexadecimal characters).

macOS, Linux, or Git Bash on Windows:

```bash
curl -sS -X POST https://paylink-relayer.raherizonambinina.workers.dev/v1/10143/onboard \
  -H 'content-type: application/json' \
  -d '{"chainId":10143,"address":"<your address>"}'
```

Windows PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri https://paylink-relayer.raherizonambinina.workers.dev/v1/10143/onboard `
  -ContentType 'application/json' -Body '{"chainId":10143,"address":"<your address>"}'
```

Expected answer, HTTP 202 (`gasLimit` is about 143,000: `clamp(estimate × 1.10, 130000, 195000)` for the real faucet):

```json
{"status":"submitted","kind":"onboard","chainId":10143,"txHash":"0x…","duplicate":false,"subject":"<your address>","nonce":0,"gasLimit":"142771"}
```

Open `https://testnet.monadvision.com/tx/<txHash>`: the transaction is from the relayer's address, to the faucet `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`, value 0, and your AUSD balance grows by 10,000. Other answers:

| Answer | Meaning |
|---|---|
| 503 `faucet-unavailable` | The faucet's 60-second cooldown is global, or the faucet is dry. Wait a minute and retry once |
| 429 `refused`, `reason: daily-cap` | One drip per address per day; try another address of yours |
| 503 `relayer-unavailable` | No valid `RELAYER_PK` ([§4](#4-create-the-relayer-key-and-store-it-yourself)), or not funded ([§5](#5-fund-the-relayer)) |
| 500 `internal` or a Cloudflare error page (1101, 1102) | See [§10](#10-troubleshooting), especially the CPU limit |

Then look at the logs: Worker → **"Logs"** (Workers Logs; "Observability" on some layouts). Each line is one JSON event. You should see `http`, `request.done` with `"outcome":"submitted"`, `tx.sent`, then about a second later `tx.final` with `"outcome":"settled"`. The logs never contain a key, a signature, a request body or an IP address; requesters appear only as a short `requesterTag`. If a line ever shows something that looks like a key, delete the secret at once ([§8](#8-operations-refill-update-rotate-stop-roll-back)) and tell Claude.

PayLinkV2 is deployed on Monad testnet (2026-10-08), so once the relayer reports `ready` the first gasless **payment** can be made from `https://paylink-mg.pages.dev/monad/` with two PayLink keys ([§7](#7-turn-the-relayer-on-in-the-app)).

## 7. Turn the relayer on in the app

Already done (2026-10-08, [ADR 0015](../adr/0015-editions-t1-passkeys-gasless-rails.md)): the app's runtime config `apps/web/public/config.json` names the Worker for the three relayed testnets, and the app's Content-Security-Policy (`apps/web/public/_headers`) allows it:

```json
"relayer": { "url": "https://paylink-relayer.raherizonambinina.workers.dev", "chains": [10143, 84532, 421614] }
```

The app asks `GET /v1/health` before every gasless payment, cancel or onboarding, and uses the relayer for a chain only while that chain reports `ready` (with the operation enabled). Until the Worker is live, or for a chain that is `awaiting-deployment` or `unfunded`, payers see "the service that covers the network fee is not answering" and the app offers what works without it; nothing else changes, so there is nothing to commit after the smoke test. `/status/` shows the relayer lamp. To take the relayer out of the app (an incident), remove the `relayer` entry (set it to `null`), run `pnpm --filter @paylink/web run headers`, commit and push.

The relayer answers browsers only from `https://paylink-mg.pages.dev` and its preview deployments `https://<branch>.paylink-mg.pages.dev`; any other page that tries gets HTTP 403 `origin-not-allowed`. Requests without an `Origin` (curl, scripts) are served and limited like any other client: CORS is a browser rule, not access control.

## 8. Operations: refill, update, rotate, stop, roll back

| Task | How |
|---|---|
| **Check** | `GET /v1/health`: per chain `state`, `balanceWei`, `pending`, today's `budget` (`spentWei`, `reservedWei`, `limitWei`). Before each judging window (Monad Oct 14–27) and before every demo recording |
| **Refill** | When Monad's balance falls under about 0.3 MON or the state is `unfunded`: [§5](#5-fund-the-relayer). Keep it at most about 2 MON |
| **Update** | Nothing to do: Claude commits a rebuilt `apps/relayer/deploy/worker.js`, you push `main`, Workers Builds deploys it (Worker → "Deployments" shows the new version with its commit). Recording a new PayLinkV2 deployment in `@paylink/chains` also changes the bundle, which is how a chain moves from `awaiting-deployment` to `ready` |
| **Rotate the key** | Repeat [§4](#4-create-the-relayer-key-and-store-it-yourself) (Variables and Secrets → `RELAYER_PK` → "Edit" → paste the new key → "Deploy"), then fund the new address ([§5](#5-fund-the-relayer)). Transactions still pending under the old key are followed to their receipts and never replaced. The old address keeps its leftover testnet MON |
| **Emergency stop** | Variables and Secrets → `RELAYER_PK` → **"Delete"** → "Deploy". Every chain turns `not-configured` and every request answers 503 `relayer-unavailable` with `fallback: self-submit`, so payers with gas pay themselves. To take the URL offline completely: Settings → Domains & Routes → `workers.dev` → **Disable** |
| **Roll back** | Worker → **"Deployments"** → "Version history" → the previous version → **"Deploy"** / "Rollback". The next push to `main` that touches `apps/relayer/deploy/` deploys again. A version carries its bindings, secrets included (**L**): after a key rotation, never roll back to a version older than the rotation |
| **Leaked key** (it appeared anywhere outside the secret) | Emergency stop, then rotate. Testnet funds only: the relayer cannot redirect any payment ([THREAT_MODEL T-01](../security/THREAT_MODEL.md#t-01), [T-47](../security/THREAT_MODEL.md#t-47)) |

Limits are code, not settings ([`policy.ts`](../../apps/relayer/src/core/policy.ts)): there is nothing to tune in the dashboard. A change is a reviewed commit and a redeploy.

## 9. Prompt for your browser assistant

Paste the block below into your browser assistant (for example Claude in Chrome) while you are signed in to Cloudflare. It does [§2](#2-create-the-worker-from-the-repository) and [§3](#3-check-the-build-settings), stops before the key, and checks the result after you have done [§4](#4-create-the-relayer-key-and-store-it-yourself) and [§5](#5-fund-the-relayer) yourself.

```text
You are helping me deploy a Cloudflare Worker from my GitHub repository, in my Cloudflare dashboard
(https://dash.cloudflare.com), where I am already signed in. Work step by step, describe what you see,
and stop and ask me whenever the screen does not match these instructions.

HARD RULES
- Never create, type, paste, read, reveal, copy or screenshot any private key, secret value or API token.
  The secret RELAYER_PK is added by me alone. When we reach it, stop and hand over to me; do not watch.
- Never put anything in "Variables", "Build variables" or "Secrets" fields.
- Do not change anything other than what is listed here: not the Pages project "paylink-mg", not DNS,
  not the zone "safidison.me", not account members, billing or plans (never upgrade to a paid plan),
  not other Workers. Do not add custom domains, routes or cron triggers. Do not enable preview URLs.
- If Cloudflare offers to change the repository (add files, open a pull request), decline.

PART A: create the Worker
1. Open Workers & Pages (left sidebar, under Compute). Click "Create" (or "Create application"),
   stay on the Workers tab, choose "Import a repository", then GitHub.
2. Select GitHub account "nambininasafidison", repository "paylink". Continue.
3. Set up the application with exactly these values:
   - Project name: paylink-relayer
   - Build command: leave empty
   - Deploy command: npx wrangler@4.148.0 deploy
   - Builds for non-production branches: off (untick). If it cannot be turned off here, set its command
     to "npx wrangler@4.148.0 versions upload" and we turn it off in Part B.
   - Advanced settings > Path (root directory): apps/relayer/deploy
   - Advanced settings > API token: keep "Create new token" (do not open or copy it)
   - Advanced settings > Variables: none
4. Click "Deploy" and wait for the build to finish. Report the last 15 lines of the build log.
   Success means the log lists "env.CHAIN_SENDER (ChainSender)  Durable Object" and
   "https://paylink-relayer.raherizonambinina.workers.dev". If the build fails, report the error
   lines verbatim and stop.

PART B: check the settings of Worker "paylink-relayer"
5. Settings > Build. Confirm and fix if needed: repository nambininasafidison/paylink; production branch
   main; builds for non-production branches disabled; build command empty; deploy command
   "npx wrangler@4.148.0 deploy"; root directory "apps/relayer/deploy"; build watch paths: include
   "apps/relayer/deploy/*" (replace the default "*"), exclude empty. Save.
6. Settings > Domains & Routes: workers.dev enabled; Preview URLs disabled. No custom domains or routes.
7. Bindings (a tab of the Worker, or under Settings): there is exactly one binding, the Durable Object
   CHAIN_SENDER -> ChainSender. Report it.
8. Open https://paylink-relayer.raherizonambinina.workers.dev/v1/health in a new tab and report the JSON:
   "status" and, for each chain, "chainId", "state" and "relayer". Expected now: every state
   "not-configured".

PART C: hand over
9. Tell me: "Part B done. Please add the secret RELAYER_PK yourself (runbook section 4) and fund the
   relayer (section 5). Tell me when you are done." Then stop and wait. Do not open the
   Variables and Secrets page while I work there.

PART D: after I say I am done
10. Reload https://paylink-relayer.raherizonambinina.workers.dev/v1/health and report "status" and, per
    chain, "state", "relayer" (the public address), "balanceWei" and "minBalanceWei".
    Expected: one and the same relayer address on every chain; Monad testnet (10143) "awaiting-deployment"
    or "ready"; other chains "unfunded" until they are funded.
11. Open the Worker's Logs (Workers Logs / Observability), filter the last 15 minutes, and report the
    "event" names you see and any line with "level":"error". Do not copy whole lines.
12. Give me a short checklist of what is done and anything that did not match.
```

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Build log: "The name in your Wrangler configuration file … must match the name of your Worker" | The Worker was created under another name. Delete it (Settings → "Delete") and redo [§2](#2-create-the-worker-from-the-repository) with `paylink-relayer` |
| Build log: "Could not find a wrangler.toml / wrangler.json" or "Missing entry-point" | Root directory is not `apps/relayer/deploy`, or `main` is not pushed. Fix it in [§3](#3-check-the-build-settings) and "Retry build" |
| Build log mentions Durable Objects and the free plan, or `new_classes` | The free plan needs SQLite-backed classes; the shipped `wrangler.toml` uses `new_sqlite_classes`. If the error persists, copy the error lines to Claude. Fallback: [ADR 0007](../adr/0007-relayer-durable-object-per-chain.md) option B |
| A build runs for a commit that did not touch the relayer | Build watch paths are still `*` ([§3](#3-check-the-build-settings)). Harmless: it redeploys the same bundle |
| Health: every chain `not-configured`, `"relayer": null` | No secret, or not a 32-byte key. Redo [§4](#4-create-the-relayer-key-and-store-it-yourself). The logs show `relayer.key-invalid` (never the value) |
| Health: `unfunded` | [§5](#5-fund-the-relayer) |
| Health: `awaiting-deployment` | PayLinkV2 is not recorded for that chain yet. Deploy it ([deploy runbook](deploy.md)); Claude records it and the next bundle switches the chain to `ready` |
| Health: `rpc-error` or `unreachable` | The chain's public RPCs did not answer. Wait a few minutes; if it lasts, tell Claude (the RPC list is in `@paylink/chains`) |
| The app shows 403 `origin-not-allowed` | The page is not served from `paylink-mg.pages.dev` or one of its previews |
| Error 1101 ("Worker threw exception") or 500 `internal` | A bug: the logs show `http.error` or `request.error` with the request id; send Claude the `requestId` and the `event` names, not whole lines |
| Error 1102, or logs showing "Exceeded CPU Limit" | A Workers Free plan limit (**L**: check the limits your plan shows in the dashboard). The front Worker does under 1 ms of work per request; the signature checks and signing (about 20 to 40 ms of CPU per payment, measured in Node) run in the Durable Object, which Cloudflare documents with its own per-request CPU allowance. If relays still hit a CPU limit, the options are the Workers Paid plan (your decision, about 5 USD a month) or self-submission only; tell Claude before changing plans |
| 503 `budget-exhausted` | Today's gas budget is spent; it resets at 00:00 UTC. Payers self-submit meanwhile |
| 503 `fees-too-high` | Network fees above the relayer's cap (500 gwei on Monad, 10 gwei on the Sepolia chains); retry later |
| `pending` stays above 0 for minutes | Look for `tx.replaced` and `tx.voided` in the logs: a stuck transaction is re-sent with fees × 1.25 after 30 s, up to three times, then its nonce is voided. If `tx.stuck` appears, fees exceed the cap; tell Claude |

## 11. Fallback: deploy from your own computer

Only if the Git integration is unavailable. It needs Node.js 22 and a browser on the same computer.

```bash
git clone https://github.com/nambininasafidison/paylink.git
cd paylink/apps/relayer/deploy
sha256sum -c SHA256SUMS                         # macOS: shasum -a 256 -c SHA256SUMS; every line must say OK
npx wrangler@4.148.0 login                      # opens Cloudflare in the browser; approve
npx wrangler@4.148.0 deploy                     # same output as §2 step 7
npx wrangler@4.148.0 secret put RELAYER_PK      # paste the key from §4 at the prompt; it is not echoed
```

Then continue with [§5](#5-fund-the-relayer). Afterwards, prefer reconnecting the Git integration, so that every update comes from `main`.
