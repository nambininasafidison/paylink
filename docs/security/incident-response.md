# Incident response plan

| | |
|---|---|
| **Version** | 1.1 |
| **Date** | 2026-10-05; revised 2026-10-07 (PB-1 redeploy mechanics aligned with `Deploy.s.sol`) |
| **Owner and incident commander** | nambininasafidison |
| **Applies to** | PayLink v2 (contract, web app, relayer, indexer, CI) and PayLink v1 on Arc |
| **Related** | [SECURITY.md](../../SECURITY.md) (reporting), [THREAT_MODEL.md](THREAT_MODEL.md), [ADR 0004](../adr/0004-immutable-ownerless-feeless.md) (no pause, redeploy) |

PayLinkV2 has **no owner, no pause and no upgrade** ([ADR 0004](../adr/0004-immutable-ownerless-feeless.md)), and it never holds funds across a call. Incident response therefore works **around** the contract: it switches off the clients and services that operators control, redeploys a fixed contract, and tells people.

## 1. Roles

The project has one maintainer, so one person holds several roles. They are listed separately so that nothing is forgotten under pressure.

| Role | Who | Responsibilities |
|---|---|---|
| Incident commander (IC) | Owner | Declares the incident and its severity; makes every decision; keeps the timeline |
| Operator | Owner | Uses the kill switches (§4); rotates secrets; approves deployments |
| Engineering support | Claude Code, under the IC's direction | Reproduces on anvil or a fork; drafts the fix, tests and texts. **Never** holds keys, pushes `main` or deploys. |
| Communications | Owner | Banner, advisory, notes to hackathon organisers, post-mortem |

## 2. Severity levels

| Level | Definition | Examples | Response target |
|---|---|---|---|
| **SEV-1** | Loss or redirection of funds is possible or happening, or keys are exposed on the origin | A contract bug that allows misdirected settlement; XSS on the production origin; a malicious deploy | Start containment immediately; banner within 1 hour of confirmation |
| **SEV-2** | Integrity of what users see or sign is at risk, but no funds can move without the user | Wrong registry address or decimals shipped; indexer serving false history; a CI secret leaked | Containment the same day |
| **SEV-3** | Availability is degraded with a working fallback | Relayer down or unfunded; indexer expired; one RPC down | Within 24 hours, or before the next judging window |
| **SEV-4** | Low-impact or theoretical issue | Hardening gaps; documentation errors | Normal pull-request flow |

External reports are acknowledged within **72 hours** ([SECURITY.md](../../SECURITY.md)). The targets above run from the moment the IC confirms the issue.

## 3. Lifecycle

1. **Detect.** Sources:
   - a GitHub private vulnerability report;
   - CI failures (`deployments-check.yml`, `fork-nightly.yml`, nightly fuzzing);
   - the relayer's `/v1/health` and the `/status/` LEDs;
   - a user report;
   - unexpected `Paid` or `InvoiceCancelled` events seen in the explorer or the indexer.
2. **Triage.** Reproduce locally (anvil, or a fork in Actions, since the sandbox has no testnet egress). Classify the severity. Open a private GitHub security advisory draft as the incident record. **Do not** discuss details in public issues.
3. **Contain.** Use the kill switches in §4 that the playbook in §5 lists.
4. **Eradicate and recover.** Fix, run every blocking gate, release, redeploy, and verify with `deployments-check.yml`.
5. **Communicate** (§6). Write first to the affected people, then publicly once users are protected.
6. **Learn.** Hold a blameless post-mortem within 7 days of resolution (§7). Update the [threat model](THREAT_MODEL.md) and add regression tests.

Keep a UTC timeline from the first minute: who did what, when, and the transaction hashes and links involved.

## 4. Kill switches and levers

| Lever | Effect | How | Time to effect |
|---|---|---|---|
| **Warning banner** | Every client shows a banner with the given text | Set `banner` in `apps/web/public/config.json`, merge, and let `site.yml` deploy. In an emergency, upload directly with `wrangler pages deploy` from a clean checkout | Minutes |
| **Revoke a deployment** | Clients lock the Pay key for that deployment ([spec §4.2](../spec/paylink-invoice-v2.md#42-resolving-verifyingcontract)) | Set the deployment `status` to `revoked` in `@paylink/chains` and redeploy the site | One site deploy |
| **Stop the relayer** | No gasless payments or cancellations; every request answers `fallback: self-submit` | Everything at once, immediately: delete the `RELAYER_PK` secret, or disable the Worker's `workers.dev` route ([relayer runbook §8](../runbooks/relayer.md#8-operations-refill-update-rotate-stop-roll-back)). One chain: a commit that sets its `dailyGasBudgetWei` to 0 in `apps/relayer/src/core/policy.ts` (limits are code, not dashboard settings), then the rebuilt bundle is pushed and Cloudflare's Git integration deploys it | Minutes; one push for a single chain |
| **Keep cancellations open** | Payees can still cancel without gas during a payment freeze | Stop only payments on that chain: set its `maxRelaysPerPayerPerDay` to 0 in `apps/relayer/src/core/policy.ts` (every payment is refused as `daily-cap`, cancellations still pass), when `cancelBySig` is not affected | One push |
| **Roll back the site** | Serve the previous build | Cloudflare dashboard → the Pages project → Deployments → the previous production deployment → Rollback | Minutes |
| **Drop the indexer** | The UI shows "history unavailable" | Remove the indexer URL from `/config.json` | One site deploy |
| **Rotate secrets** | Invalidates leaked credentials | Cloudflare API token, `RELAYER_PK`, `ENVIO_API_TOKEN`, `TESTNET_DEPLOYER_PK` (§5, PB-8) | Minutes |
| **Freeze merges** | Stops further changes reaching `main` | Lock the branch, or temporarily require a review in branch protection | Minutes |
| **Contract pause** | **Does not exist** | — | — |

## 5. Playbooks

### PB-1. Contract vulnerability (SEV-1 or SEV-2)

1. Reproduce on anvil with the exact release artefact. Identify the affected entry points, tokens and chains.
2. **Contain:**
   - turn on the banner ("Do not pay PayLink links on <chain> until further notice");
   - mark the affected deployments `revoked`;
   - stop the relayer's pay route on those chains, but keep the cancel route if it is unaffected.
3. **Protect users:**
   - Ask payers who approved PayLinkV2 to set the allowance to 0 (clients approve exact amounts, which limits exposure; see [THREAT_MODEL T-27](THREAT_MODEL.md#t-27)).
   - Ask payees to cancel open invoices and receive cards on the old deployment.
   - Remember that the old contract stays callable forever: third-party clients can still pay open invoices there ([THREAT_MODEL T-32](THREAT_MODEL.md#t-32)).
4. **Fix:** write a failing test first, then the patch. Run every blocking gate (unit, fuzz at 10,000 runs, invariants I1–I11, Slither, coverage) and the nightly set if time allows. Tag `contracts-v2.0.N`.
5. **Redeploy** through route A ([deploy runbook §4](../runbooks/deploy.md#4-deploying-v2-to-a-testnet)). The fix changes the init code, so `release.json` for the new tag carries a new `initCodeHash` and a new CREATE2 address; on a chain that already has a deployment record, `Deploy.s.sol` only verifies the recorded contract unless `PAYLINK_REDEPLOY=true` is set, which is the deliberate incident-response override. The new `verifyingContract` invalidates every old signature on the new contract. Update the registry (new deployment `active`, old one `revoked`), redeploy the site, and ask payees to re-issue invoices and receive cards.
6. **Communicate and disclose:** publish the GitHub advisory, add a note in every affected submission, and inform the event organisers through their official channels.

### PB-2. Web origin compromise, malicious deploy or XSS (SEV-1)

1. **Roll back** the Pages deployment to the last known good build. If the cause is unclear, set the banner to "Do not sign anything on this site" while you investigate.
2. Revoke and re-issue `CLOUDFLARE_API_TOKEN`. Review the Cloudflare audit log and the Actions run logs for the deploy that changed the site.
3. Verify the restored `_headers` (CSP, frame-ancestors), `/config.json` and the registry against git.
4. **Mera users:** a passkey-derived key that was in page memory during the compromise must be treated as exposed. The key is derived deterministically from the passkey, so the account cannot be "rotated". Users must create a new passkey (a new account) and move their testnet funds. Say this plainly in the banner and the advisory.
5. Find the root cause (a dependency, a CI change, an account takeover) and continue with PB-7 or PB-8 as needed.

### PB-3. Relayer key compromise or gas drain (SEV-2)

1. Stop the relayer for the affected chain (§4).
2. Generate a new testnet key without displaying it and set it as the `RELAYER_PK` secret ([relayer runbook §4](../runbooks/relayer.md#4-create-the-relayer-key-and-store-it-yourself)). Fund the new address, keeping at most about 2 MON.
3. Review the drained transactions on the explorer, Workers Logs (`request.done`, `tx.sent`, `tx.final` with the attributed cause) and the budget in `/v1/health`. Tighten the caps in `apps/relayer/src/core/policy.ts` if the drain came from valid-looking requests.
4. Impact is bounded: the key can spend gas but cannot redirect payments (invariant I8). Users can always self-submit.

### PB-4. Relayer outage or empty budget (SEV-3)

The UI falls back to "Pay with your own gas" automatically. Refill from the faucets ([faucets runbook](../runbooks/faucets.md)), check `/v1/health`, and post a status note if a judging window is open.

### PB-5. Indexer outage, expiry or false data (SEV-3, or SEV-2 if the data is false)

1. Remove the indexer URL from `/config.json`. The UI then shows "history unavailable".
2. Redeploy on Envio Cloud. A development deployment lives at most 30 days, and its URL changes on every push (**L**). Then restore the URL.
3. If the data was false, check that no client path used it for receipts or payability. That is a design invariant ([ADR 0009](../adr/0009-read-model-chain-device-indexer.md)); any violation is a SEV-2 bug.

### PB-6. RPC outage or inconsistent RPC (SEV-3)

Remove or reorder the endpoint in `@paylink/chains` and redeploy. viem `fallback()` already skips failing endpoints. If an RPC returned false data, treat it as SEV-2 and review receipt verification.

### PB-7. Supply-chain compromise (SEV-1 or SEV-2)

1. Freeze merges. Identify the package and versions from `pnpm-lock.yaml`. Check whether the malicious version reached a production build: compare the deployed asset hashes with the build logs.
2. Pin or revert to a known good version, then rebuild and redeploy.
3. Rotate every secret available to the jobs that installed the package (PB-8).
4. If the code reached the production origin, continue with PB-2.

### PB-8. CI or cloud secret leak (SEV-2)

| Secret | Rotation |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Revoke in the Cloudflare dashboard; create a token with only "Cloudflare Pages: Edit" and "Workers Scripts: Edit"; update the GitHub secret |
| `RELAYER_PK` | PB-3 |
| `TESTNET_DEPLOYER_PK` | Create a new deployer wallet; move the remaining testnet funds; update the `testnet` environment secret. Existing deployments are unaffected, because there is no owner. |
| `ENVIO_API_TOKEN` | Revoke at envio.dev; create a new token; update the GitHub secret |

Then review the workflow runs since the suspected exposure, and check that no `pull_request_target` or unpinned action was introduced.

### PB-9. PayLink v1 on Arc (SEV by impact)

v1 also has no owner and no pause. The v1 files are frozen ([ADR 0010](../adr/0010-arc-stays-on-v1.md)), and a security fix is the only allowed exception. Revert or patch `web/` on `main` (GitHub Pages), tell the Arc reviewers through the submission channel, and disclose in `docs/submissions/`.

### PB-10. AI agent misbehaviour or prompt injection (SEV-2 to SEV-4)

1. Stop the agent session or flow. Revert unreviewed changes.
2. Identify the injected input: a memo, an issue, a pull request or tool output. Add it to the injection test fixtures.
3. Tighten tool allowlists. Agents must never hold keys, push `main` or merge ([AI_DISCLOSURE.md](../../AI_DISCLOSURE.md)).

## 6. Communication

**Channels, in order:**

1. the in-app banner;
2. a GitHub Security Advisory on this repository;
3. a pinned README note;
4. the official channels of the affected events: the Monad support forum, Colosseum and Arc reviewers.

The banner and the advisory are served from infrastructure the owner controls, independently of social-media accounts.

**Banner template** (keep it under 200 characters; add FR and MG versions when time allows):

> PayLink security notice (<date> UTC): do not pay or sign PayLink links on <chain> until further notice. Your funds are not held by PayLink. Details: <advisory link>

**Advisory template:**

```text
Title: <component>: <one-line description>
Severity: <SEV level> (CVSS v3.1 or v4.0 vector if applicable)
Affected: <deployments by chainId and address; app versions; dates>
Impact: <who could lose what, under which conditions>
Status: <contained | fixed | redeployed>
Actions for users: <revoke allowance; cancel invoices; re-issue receive cards; create a new passkey>
Timeline (UTC): <detection → containment → fix → redeploy>
Credit: <reporter, if they agree>
```

## 7. Post-mortem template

Blameless. File it as `docs/security/postmortems/YYYY-MM-DD-<slug>.md` within 7 days of resolution.

```markdown
# Post-mortem: <title>

- Date, severity, duration, author
- Summary (3 sentences)
- Impact (users, funds, deployments, submissions)
- Timeline (UTC)
- Root cause and contributing factors
- Detection: how, and how it could have been earlier
- Response: what worked, what did not
- Action items (owner, due date, tracking issue)
- Threat-model and test changes
```

## 8. Readiness checklist

Before each submission deadline (Oct 12) and each deployment:

- [ ] The banner field is present in `/config.json`, and its rendering is tested in e2e.
- [ ] The registry `status` field is enforced by the client (an e2e "revoked deployment" spec).
- [ ] The relayer is funded, its budget and caps are the reviewed defaults (`apps/relayer/src/core/policy.ts`), and `/v1/health` reports `ready` for every chain the app relays.
- [ ] Private vulnerability reporting is enabled on the repository ([SECURITY.md](../../SECURITY.md)).
- [ ] Phishing-resistant MFA is on for the GitHub and Cloudflare accounts.
- [ ] A tabletop run-through of PB-1 on anvil is done: banner, revoke, redeploy, re-issue.
- [ ] Every person who holds a secret is listed: only the owner.
