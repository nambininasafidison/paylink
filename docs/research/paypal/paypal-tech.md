# PayPal technology for PayLink: research notes for the PayPal AI Hackathon

> Copied into the repository on 2026-10-21 from the planning notes of 2026-10-13, unchanged. The owner's decisions of 2026-10-21 ([docs/paypal/SPEC.md](../../paypal/SPEC.md), [ADR 0018](../../adr/0018-paypal-edition.md)) supersede it where they differ: the edition runs on Ethereum Sepolia, not Arbitrum Sepolia, and its AI on Workers AI.

Written 2026-10-13. Scope: PayPal developer technology that a framework-free web app (strict CSP) plus a Cloudflare Worker can use in sandbox; PayPal's AI/agent tools; Madagascar availability; fees; what can be shown fully in sandbox; a minimal "freelancer invoice paid by PayPal or by stablecoin" sequence.

## 0. How to read this

- Tags: **[V]** checked from a primary artifact (official PayPal GitHub repo, npm/PyPI registry, or on-chain call); **[S]** taken from a search-result snippet of the cited page (the page itself could not be opened from this sandbox); **UNVERIFIED** means no primary confirmation; check before relying on it.
- These hosts were unreachable from the sandbox (DNS or proxy denial): developer.paypal.com, docs.paypal.ai, docs.paxos.com, paypalaihackathon.devpost.com. Endpoints and scopes therefore come from PayPal's own OpenAPI files on GitHub (`paypal/paypal-rest-api-specifications`, commit 90e8041, 2026-04-07) [R1], which are the source PayPal publishes its API reference from.
- Source keys ([R1], [S4]...) are listed in section 15.

## 1. Summary

1. **Use no PayPal browser JavaScript.** PayLink's CSP (`default-src 'none'; script-src 'self'; style-src 'self'; ... form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'`, from `apps/web/public/_headers`) would block the PayPal JS SDK (scripts, frames and styles from paypal.com). Two PayPal flows need no SDK at all:
   - **Invoicing v2 hosted invoice**: the Worker creates and sends the invoice; the payer pays on PayPal's page at `detail.metadata.recipient_view_url` [V R1].
   - **Orders v2 redirect**: the Worker creates the order with `payment_source.paypal.experience_context.{return_url,cancel_url,user_action:"PAY_NOW"}`, the app navigates to the `payer-action` link, and the Worker captures the order when the payer comes back [V R1].

   Either way the page CSP stays as it is, and only the Worker talks to `api-m.sandbox.paypal.com`.
2. **Invoicing v2 is the closest match to PayLink.** It has an invoice with a payer link, `send_to_recipient:false` for "share the link yourself", a QR code endpoint, `INVOICING.INVOICE.PAID` webhooks, and **recording an external payment** (`POST /v2/invoicing/invoices/{id}/payments`). The last one lets a stablecoin payment close the PayPal invoice [V R1].
3. **PayPal's AI offering is the Agent Toolkit** (`@paypal/agent-toolkit` 1.11.0, published 2026-09-01; Python `paypal-agent-toolkit` 1.11.0) and the **PayPal MCP server**: local `@paypal/mcp` 1.8.1, plus a remote server at `mcp.sandbox.paypal.com` / `mcp.paypal.com` [V R2, R4, R5; remote URLs S1].
4. **PYUSD (PayPal USD) on Arbitrum Sepolia works with PayLinkV2 as it is.** Token `0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1`, 6 decimals. It implements EIP-3009 `receiveWithAuthorization` (v,r,s and bytes forms) and EIP-2612 `permit`, and its EIP-712 domain is `name "PayPal USD"`, `version "1"`. Each point was checked on chain [V R7].
   - PayLinkV2 is **not yet deployed on 421614**.
   - The CREATE2 factory `0x4e59…956C` is there, so the same address `0x448e…5082` can be deployed. It needs Arbitrum Sepolia ETH for gas.
5. **Madagascar:** whether a Madagascar resident's PayPal account can *receive* is **UNVERIFIED**. Secondary sources say it cannot (send-only) [S10]. Sandbox accounts are fictional, so the demo does not depend on it. The pitch must not claim that Malagasy freelancers can receive PayPal today.
6. **Do the AI part in the Worker with no new dependencies.** An LLM with tool use, where each tool is a thin `fetch` wrapper over the Invoicing/Orders endpoints, with the tools named and shaped like the Agent Toolkit's. Optionally, point an LLM's remote-MCP client at PayPal's remote MCP server; whether it accepts a bearer token is UNVERIFIED (see 9.3).

## 2. Hackathon facts that constrain the build

| Fact | Value | Source / status |
|---|---|---|
| Brief | "Build What's Next with PayPal and AI"; the project must meaningfully use **both PayPal and AI**; no tracks | [S9] third-party transcription of the Devpost page (howdycarter repo); Devpost snippet |
| PayPal environment | "Must use the free PayPal sandbox environment"; projects must "integrate PayPal API/SDK (Sandbox)" | [S9] two third-party sources, UNVERIFIED on Devpost |
| Window / deadline | Oct 1 to Nov 12, 2026; deadline **Nov 12, 2026, 3:00 PM EST = 20:00 UTC** | [S9] (coursejoiner: Nov 13 01:30 IST, the same instant) |
| Existing projects | Allowed only if "significantly updated after the submission period began", at the sponsor's discretion; the updates must be explained in the submission | [S9] Devpost rules snippet |
| Prizes | $67,500 cash ($69,750 total). 1st $12,000, 2nd $8,000, 3rd $5,000. Most Creative, Most Impactful, Best Demo Delivery, **Best Use of PayPal + AI**, **Best Use of Agentic Commerce**: $5,000 each. Sponsor awards on top. The PayPal blog says "$60,000+" | [S9], conflicting totals |
| Judging | Technological Implementation; Design; Potential Impact; Innovation/Idea; Presentation. Weights not published | [S9] third-party transcription, UNVERIFIED |
| Submission | Public open-source repo with a visible licence, a working demo (hosted URL or run instructions), a demo video under 3 minutes on YouTube, a list of tools used | [S9] third-party transcription |
| Excluded regions | Brazil, Crimea, Cuba, Iran, North Korea, Quebec, Russia (Madagascar not listed) | [S9] third-party transcription, UNVERIFIED |
| Winners | Dec 21, 2026 (one source); judging Nov 13 to Dec 15 (another) | [S9], conflicting |

Implication: keep dated commits from 2026-10-21 onward and an explicit "built during the hackathon" section, because PayLink predates the window.

## 3. Environments, OAuth and scopes

| Item | Sandbox | Live | Source |
|---|---|---|---|
| REST base | `https://api-m.sandbox.paypal.com` | `https://api-m.paypal.com` | [V R1] `servers` in every spec |
| Token | `POST /v1/oauth2/token`, Basic `client_id:client_secret`, body `grant_type=client_credentials` → `{access_token, token_type:"Bearer", expires_in, scope, app_id}` | same on live base | [V R2] README |
| Token lifetime | Sandbox 3–8 h; live 8 h (cache it in the Worker; refresh before expiry) | | [V R2] README (PayPal's wording) |
| Credentials | Developer Dashboard → Apps & Credentials → Sandbox/Live → Create App (bound to a sandbox business account) | | [V R2] README |

Scopes are granted to the app by the features enabled on it; each operation declares the OAuth2 scope it needs [V R1]:

| API | Scope (from `security` in the spec) |
|---|---|
| Orders v2 create/get/patch/authorize/capture | `https://uri.paypal.com/services/payments/payment` (alternative: `.../payments/orders/deprecating-jssdk-migration-for-limited-merchants`) |
| Payments v2 captures get / authorizations | `https://uri.paypal.com/services/payments/payment/authcapture` |
| Payments v2 refunds | `https://uri.paypal.com/services/payments/refund` |
| Invoicing v2 read (list, get, search, templates get) | `https://uri.paypal.com/services/invoicing/invoices/read` |
| Invoicing v2 write (create, send, remind, cancel, payments, refunds, QR, next number, update, delete) | `https://uri.paypal.com/services/invoicing/invoices/readwrite` |
| Payouts v1 | `https://uri.paypal.com/payments/payouts` |
| Webhooks management | `https://uri.paypal.com/services/applications/webhooks` |
| Verify webhook signature | `https://uri.paypal.com/services/applications/verify-webhook-signature` (or the webhooks scope) |
| Payment Links API | UNVERIFIED (docs say the app must have "Payment Links & Buttons" enabled [S4]) |

## 4. Orders v2 / Checkout

### 4.1 Endpoints [V R1, `checkout_orders_v2.json` v2.32]

| Method | Path | Notes |
|---|---|---|
| POST | `/v2/checkout/orders` | headers `PayPal-Request-Id` (idempotency), `Prefer` |
| GET | `/v2/checkout/orders/{id}` | |
| PATCH | `/v2/checkout/orders/{id}` | |
| POST | `/v2/checkout/orders/{id}/confirm-payment-source` | |
| POST | `/v2/checkout/orders/{id}/authorize` | |
| POST | `/v2/checkout/orders/{id}/capture` | headers `PayPal-Request-Id`, `Prefer` |
| POST | `/v2/checkout/orders/{id}/track`, PATCH `/trackers/{tracker_id}` | shipping, not needed |
| POST | `/v2/payments/captures/{capture_id}/refund`, GET `/v2/payments/captures/{id}` | Payments v2 |

- Order statuses: `CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED`.
- `purchase_unit_request` fields: `reference_id, amount, payee, payment_instruction, description, custom_id, invoice_id, soft_descriptor, items, shipping, supplementary_data`. Put the PayLink invoice key in `custom_id` and the human invoice number in `invoice_id`.
- `paypal_wallet_experience_context` fields: `brand_name, locale, shipping_preference (GET_FROM_FILE|NO_SHIPPING|SET_PROVIDED_ADDRESS), contact_preference, return_url, cancel_url, app_switch_context, landing_page (LOGIN|GUEST_CHECKOUT|NO_PREFERENCE|BILLING), user_action (CONTINUE|PAY_NOW), payment_method_preference, order_update_callback_config`.
- The spec's create example is "PayPal Wallet as Payment Source, Resulting in PAYER_ACTION_REQUIRED Response … receives payer-action link" [V R1].

Redirect flow (no JS SDK):

1. The Worker calls `POST /v2/checkout/orders` with `{"intent":"CAPTURE","purchase_units":[{"custom_id":K,"invoice_id":N,"amount":{"currency_code":"USD","value":"120.00"}}],"payment_source":{"paypal":{"experience_context":{"return_url":…,"cancel_url":…,"user_action":"PAY_NOW","shipping_preference":"NO_SHIPPING"}}}}`.
2. The response has `status:"PAYER_ACTION_REQUIRED"` and a `links[]` entry with `rel:"payer-action"`. The app calls `location.assign(href)`. Top-level navigation is not restricted by `form-action`/`default-src`.
3. The payer approves and comes back to `return_url`. The query parameters carry the order ID; the exact name (`token`) is UNVERIFIED, so test it.
4. The Worker calls `POST /v2/checkout/orders/{id}/capture` with `PayPal-Request-Id: K`, then checks `status:"COMPLETED"` and the capture amount and currency.

### 4.2 JS SDK (only if the PayPal button UI is wanted)

- **npm `@paypal/paypal-js` 11.2.2** (Apache-2.0, published 2026-10-09) is the loader with TypeScript types [V R4]. The **v6 Web SDK** is loaded from `https://www.sandbox.paypal.com/web-sdk/v6/core` (live: `https://www.paypal.com/web-sdk/v6/core`) through `loadCoreSdkScript({environment:"sandbox"})` from `@paypal/paypal-js/sdk-v6` [V R3].
  - Call `paypal.createInstance({clientId | clientToken, components:["paypal-payments",…]})`, then `findEligibleMethods()`, then `createPayPalOneTimePaymentSession({onApprove})`, then `session.start({presentationMode}, createOrderPromise)`.
  - `presentationMode` takes `"auto"`; a web-components type lists `AUTO|MODAL|POPUP|REDIRECT` [V R3].
  - `environment` is required and decides sandbox or live, whatever the clientId [V R3].
- The **v5 loader** (`loadScript`) adds the script from `https://www.sandbox.paypal.com/sdk/js` and supports `dataCspNonce`. It copies `data-csp-nonce` onto the script's `nonce` attribute [V R3 `src/utils.ts`].
- The **v6 loader in paypal-js has no nonce option** in the source scanned (`src/v6/*.ts` sets only data attributes) [V R3]. A nonce would need per-response HTML, which a static Cloudflare Pages site does not have.
- CSP requirements, per PayPal's CSP page and Report URI [S3]: `*.paypal.com`, `*.paypalobjects.com` and `*.venmo.com` (only if Venmo is offered) on `script-src`, `style-src`, `img-src`, `connect-src`, `frame-src`/`child-src`; and a nonce in `script-src` and `style-src`. That is incompatible with PayLink's `style-src 'self'` without a nonce. **`require-trusted-types-for 'script'` compatibility is UNVERIFIED**, and is likely to break third-party DOM injection.
- If buttons are needed, serve them from a separate path (for example `/paypal/`) with its own `_headers` CSP. Do not relax the main app's CSP.

## 5. Invoicing v2 (recommended PayPal rail)

### 5.1 Endpoints [V R1, `invoicing_v2.json` v2.6]

| Method | Path | Scope |
|---|---|---|
| POST | `/v2/invoicing/invoices` (creates a **draft**; `items` required; "the merchant … must have a PayPal account in good standing") | readwrite |
| GET | `/v2/invoicing/invoices` | read |
| GET / PUT / DELETE | `/v2/invoicing/invoices/{invoice_id}` | read / readwrite |
| POST | `/v2/invoicing/invoices/{invoice_id}/send` (body `notification`: `send_to_invoicer`, `send_to_recipient`, `additional_recipients`; 200 returns a link) | readwrite |
| POST | `/v2/invoicing/invoices/{invoice_id}/remind` | readwrite |
| POST | `/v2/invoicing/invoices/{invoice_id}/cancel` | readwrite |
| POST | `/v2/invoicing/invoices/{invoice_id}/payments` (record payment; `payment_detail.method` required) | readwrite |
| DELETE | `/v2/invoicing/invoices/{invoice_id}/payments/{transaction_id}` | readwrite |
| POST / DELETE | `/v2/invoicing/invoices/{invoice_id}/refunds[/{transaction_id}]` | readwrite |
| POST | `/v2/invoicing/invoices/{invoice_id}/generate-qr-code` (Base64 PNG; scanning opens the PayPal mobile pay flow) | readwrite |
| POST | `/v2/invoicing/generate-next-invoice-number` | readwrite |
| POST | `/v2/invoicing/search-invoices` | read |
| GET/POST/PUT/DELETE | `/v2/invoicing/templates[/{template_id}]` | read / readwrite |

The Agent Toolkit also calls `/v2/invoicing/recurring-invoices…`, `/v2/invoicing/search-recurring-invoices`, `/v2/invoicing/invoices/{id}/cancel-reminders`, `/conditional-rules`, `/v2/invoicing/setup-reminders` and `/v2/invoicing/reminders/{id}`. These are **not in the public spec commit 90e8041**, so treat them as newer or UNVERIFIED [V R2 `src/shared/functions.ts`].

### 5.2 Facts that matter for PayLink [V R1]

- `send` with `notification.send_to_recipient:false` sends the invoice "through a share link and not through PayPal". PayLink keeps WhatsApp/QR sharing and does not depend on PayPal email.
- `detail.metadata.recipient_view_url` is "the URL for the invoice payer view hosted on paypal.com"; `invoicer_view_url` is the merchant view.
- `detail` fields: `reference, currency_code, note, terms_and_conditions, memo, attachments, invoice_number, invoice_date, payment_term, metadata`. Store the PayLink invoice key in `reference`.
- Payment terms: `DUE_ON_RECEIPT, DUE_ON_DATE_SPECIFIED, NET_10, NET_15, NET_30, NET_45, NET_60, NET_90, NO_DUE_DATE`. `partial_payment.allow_partial_payment` and `minimum_amount_due` are available.
- Statuses: `DRAFT, SENT, SCHEDULED, PAID, MARKED_AS_PAID, CANCELLED, REFUNDED, PARTIALLY_PAID, PARTIALLY_REFUNDED, MARKED_AS_REFUNDED, UNPAID, PAYMENT_PENDING, AUTO_CANCELLED, PAID_EXTERNAL, REFUNDED_EXTERNAL, SHARED`.
- Record payment: `payment_detail = {type: PAYPAL|EXTERNAL, payment_id, payment_date, method: BANK_TRANSFER|CASH|CHECK|CREDIT_CARD|DEBIT_CARD|PAYPAL|WIRE_TRANSFER|OTHER, note, amount, shipping_info}`. "If no payment is due, the invoice is marked as `PAID`."
  - **Bridge:** a stablecoin payment confirmed on chain is recorded as `method:"OTHER"` with the tx hash and CAIP-2 in `note`.
  - Which status shows afterwards (`PAID` / `MARKED_AS_PAID` / `PAID_EXTERNAL`) is UNVERIFIED; test it in sandbox.
- Webhook events, per PayPal pages [S5]: `INVOICING.INVOICE.CREATED, .SENT (invoicing page only), .PAID, .CANCELLED, .REFUNDED, .SCHEDULED, .UPDATED`. `PAID` also fires on partial or pending payments [S5], so always re-read the invoice with `GET` before showing "paid".

## 6. Payment Links API [S4 only, UNVERIFIED in a spec file]

- `POST /v1/checkout/payment-resources` creates a link (201 with id and shareable URL); `GET /v1/checkout/payment-resources` (paginated), `GET/PUT /v1/checkout/payment-resources/{id}`. One doc version also lists `DELETE`.
- Requires a business account and an app with Payment Links & Buttons enabled. Links only; buttons are made in the dashboard [S4].
- Not in `paypal-rest-api-specifications` at 90e8041. This is a product-style link, so Invoicing fits "invoice paid by link" better.

## 7. Payouts v1 [V R1, `payments_payouts_batch_v1.json` v1.9]

- `POST /v1/payments/payouts` (header `PayPal-Request-Id`; body `sender_batch_header` plus `items[]`; a `sender_batch_id` reused within 30 days is rejected); `GET /v1/payments/payouts/{id}`; `GET /v1/payments/payouts-item/{payout_item_id}`; `POST /v1/payments/payouts-item/{payout_item_id}/cancel`. Scope `https://uri.paypal.com/payments/payouts`.
- `recipient_type`: `EMAIL|PHONE|PAYPAL_ID`; `recipient_wallet`: `PAYPAL|VENMO`.
- Relevance: a payout is the *sending* side (for example a platform paying many freelancers). It works in sandbox.
- **Live Payouts usually need PayPal approval** (UNVERIFIED).
- Whether a Madagascar recipient can receive a payout is UNVERIFIED. PayPal's country feature-set table [S10] could not be read for "M" countries.

## 8. Webhooks and verification

Endpoints [V R1, `notifications_webhooks_v1.json` v1.11]:

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/notifications/webhooks` | create; also GET / PATCH / DELETE `/{webhook_id}` and `/{webhook_id}/event-types` |
| POST | `/v1/notifications/verify-webhook-signature` | body: `auth_algo, cert_url, transmission_id, transmission_sig, transmission_time, webhook_id, webhook_event` (all required); response `verification_status: SUCCESS\|FAILURE` |
| POST | `/v1/notifications/simulate-event` | sandbox mock events |
| GET | `/v1/notifications/webhooks-events[/{event_id}]` | |
| POST | `/v1/notifications/webhooks-events/{event_id}/resend` | |
| GET | `/v1/notifications/webhooks-event-types` | |

Event names in the spec include `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`.

Worker implementation:

- The header values map to the body fields: `PAYPAL-TRANSMISSION-ID`, `-TRANSMISSION-TIME`, `-TRANSMISSION-SIG`, `-CERT-URL`, `-AUTH-ALGO`. The header names are UNVERIFIED in a spec, but widely documented [S5].
- **Postback (simplest):** call `verify-webhook-signature` with `webhook_event` set to the **raw** event body. Splice the raw text into the JSON rather than re-serializing it (practice note). Hookdeck reports that postback does **not** work for simulator/mock events [S5].
- **Self-verify (no API call):** RSA-SHA256 over `transmission_id|transmission_time|webhook_id|crc32(raw body)`; the cert must come from a `*.paypal.com` host; reject anything older than 5 minutes [S5].
  - One PayPal page shows a SHA-256 body hash instead of CRC32, so the docs conflict (UNVERIFIED).
  - WebCrypto in Workers can verify RSASSA-PKCS1-v1_5/SHA-256, but extracting the public key needs a small X.509 parser. Prefer postback during the hackathon.
- **Never trust a webhook alone.** After verifying it, `GET` the invoice or order and compare amount, currency and `reference`/`custom_id`.

## 9. AI and agent offerings

### 9.1 PayPal Agent Toolkit [V R2, R4, R5]

| Item | Value |
|---|---|
| Repo | `github.com/paypal/agent-toolkit` (HEAD a3aa963, 2026-09-01). Subfolders `typescript/`, `python/` |
| npm | **`@paypal/agent-toolkit` 1.11.0** (published 2026-09-01). Exports `./ai-sdk`, `./mcp`, `./openai`, `./langchain`, `./bedrock`. Requires Node 18+ |
| PyPI | **`paypal-agent-toolkit` 1.11.0**; Python 3.11+; pins `openai-agents==0.0.2`, `langchain==0.3.23`, `crewai-tools==0.13.2` |
| Frameworks (TS) | Vercel AI SDK, OpenAI Agents SDK, LangChain, MCP, Amazon Bedrock. Python: OpenAI Agents, LangChain, CrewAI |
| Licence | Repo `LICENSE` file: **Apache-2.0**. `typescript/package.json` and npm metadata: **ISC**. Python: none declared. The conflict is unresolved: cite both and treat it as permissive |
| Config | `new PayPalAgentToolkit({clientId, clientSecret, configuration:{actions:{invoices:{create,list,send,sendReminder,cancel,…}, orders:{create,get}, …}, context:{sandbox:true}}})`. Also `PayPalWorkflows` with `ALL_TOOLS_ENABLED`. Env: `PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT=SANDBOX\|PRODUCTION` (default SANDBOX) |
| Runtime dependencies | `ai ^4.0.23` (AI SDK v4), `openai 4.86.1`, `@langchain/core 0.3.6`, `@modelcontextprotocol/sdk ^1.6.1`, `@paypal/paypal-server-sdk ^1.0.0`, `axios`, `os`, `@dotenvx/dotenvx`, `mathjs`, `lodash`, `zod ^3` |
| API host it calls | `https://api.sandbox.paypal.com` / `https://api.paypal.com` (`src/shared/client.ts`) |

Tools in the TS README:

- **Invoices:** `create_invoice, list_invoices, get_invoice, send_invoice, send_invoice_reminder, cancel_sent_invoice, generate_invoice_qr_code, delete_invoice, generate_invoice_number, search_invoicing, update_invoicing, cancel_invoice_auto_reminder, record_payment_for_invoice, record_refund_for_invoice, create_conditional_rules_for_invoice, create_recurring_series, activate_recurring_series, get_recurring_series, cancel_recurring_series, delete_recurring_series`.
- **Payments:** `create_order, get_order, pay_order, create_refund, get_refund`.
- **Disputes:** `list_disputes, get_dispute, accept_dispute_claim`.
- **Shipment:** `create/get/update_shipment_tracking`.
- **Catalog:** `create_product, list_products, show_product_details`.
- **Subscriptions:** `create_subscription_plan, update_plan, list_subscription_plans, show_subscription_plan_details, create_subscription, show_subscription_details, update_subscription, cancel_subscription`.
- **Reporting:** `list_transactions, get_merchant_insights`.

The README ends with PayPal's disclaimer: "AI-generated content may be inaccurate or incomplete…".

**Cloudflare Worker fit:** it imports `axios`, `os` and `debug` and depends on the APIMatic server SDK. Running it in a Worker (even with `nodejs_compat`) is **UNVERIFIED** and adds weight. AI SDK v4 is also behind the current major. Recommendation: in the Worker, reimplement the 6–8 needed tools as `fetch` calls with the same names and argument shapes. Run the toolkit itself in a Node CLI or demo agent if you want to say you "use the Agent Toolkit".

### 9.2 PayPal MCP server

- **Local:** npm **`@paypal/mcp` 1.8.1** (published 2025-10-28; bin `mcp`; depends on `@paypal/agent-toolkit@latest`; no licence field) [V R4]. Run it with `npx -y @paypal/mcp --tools=all` and env `PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT=SANDBOX`. It uses stdio transport [S1]. It cannot run inside a Worker, because Workers cannot spawn processes.
- **Remote:**
  - SSE: `https://mcp.sandbox.paypal.com/sse` (sandbox) and `https://mcp.paypal.com/sse` (live) [S1].
  - Streamable HTTP: the official quickstart snippet gives `https://mcp.sandbox.paypal.com/http` and `https://mcp.paypal.com/http` [S1]. Directories list `/mcp` instead (**conflict; UNVERIFIED**). PayPal's blog announced streamable HTTP alongside SSE [S2].
  - Auth: a browser login flow, or an `Authorization` header built from client credentials via `mcp-remote` [S1]. The exact header format is UNVERIFIED.

### 9.3 Using it from PayLink's Worker (AI piece)

- **Option A, recommended:** an LLM with tool use plus PayLink-owned `fetch` tools that mirror Agent Toolkit names: `create_invoice`, `send_invoice`, `get_invoice`, `send_invoice_reminder`, `record_payment_for_invoice`, `create_order`, `get_order`, `list_invoices`.
  - The Worker holds the PayPal secret, and the LLM never sees it.
  - Gate writes (send, record payment) behind a user confirmation or a deterministic check, so the agent cannot send money-affecting calls on its own.
- **Option B:** a remote-MCP connector to PayPal's remote MCP. For example, Anthropic's Messages API MCP connector: beta `mcp-client-2025-11-20`, `mcp_servers:[{type:"url", url, name, authorization_token}]` plus `tools:[{type:"mcp_toolset", mcp_server_name}]` [R8].
  - It only works if PayPal's remote server accepts a bearer token without an interactive login (UNVERIFIED).
  - It exposes every enabled tool to the model, so restrict tools with `default_config:{enabled:false}` plus per-tool `configs`.
- **Agentic commerce context:** PayPal launched **Agent Ready** and **Store Sync** in Oct 2025 [S12]. Store Sync launch partners were Wix, Cymbio, BigCommerce/Feedonomics and Shopware. WebMCP-based agent checkout is "limited to Store Sync customers today" [S12]. These are merchant programmes, not public sandbox APIs a solo developer can call (UNVERIFIED). The realistic agentic-commerce story is: an agent drafts, sends, chases and reconciles invoices through the Agent Toolkit or MCP tools.

## 10. PYUSD (PayPal USD) on testnets

On-chain checks [V R7], 2026-10-13, via `https://sepolia-rollup.arbitrum.io/rpc`:

| Check | Result |
|---|---|
| chainId | 421614 |
| `0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1` | proxy (2,050 bytes); `name()` "PayPal USD", `symbol()` "PYUSD", `decimals()` 6; totalSupply 7,479,675.84 |
| Implementation | slot `keccak("org.zeppelinos.proxy.implementation")` = `0xe0abc37950e526a23763f8f2d968e7dd9aa12d27` (raw storage word, lowercase) (18,334 bytes) |
| EIP-3009 | `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` = standard `0x7c7c…2267`; `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` = standard `0xd099…3de8`. Selectors present in the implementation: `receiveWithAuthorization(…,uint8,bytes32,bytes32)` 0xef55bec6 (**the form PayLinkV2 calls**), the bytes-signature forms 0x88b7ab63 / 0xcf092995, `transferWithAuthorization` 0xe3ee160e, `cancelAuthorization` 0x5a049a70, `transferWithAuthorizationBatch` 0xf5968e2d; `authorizationState(address,bytes32)` answers |
| EIP-2612 | `permit(…,uint8,bytes32,bytes32)` 0xd505accf present; `nonces(address)` answers; `PERMIT_TYPEHASH` standard |
| EIP-712 domain | `DOMAIN_SEPARATOR()` = `0xf3ec…acb2` equals keccak(`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`, "PayPal USD", **"1"**, 421614, token). `eip712Domain()` (EIP-5267) is **not** implemented |
| PayLinkV2 `0x448eCce9711860502806A3d5B021a4f9Ba715082` on 421614 | **no code** (not deployed) |
| CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` | present on Arbitrum Sepolia and Base Sepolia, so the same-address deployment is possible |
| PayLinkV2 on Base Sepolia | code present |

Other facts:

- Ethereum Sepolia PYUSD is `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9` per the Paxos docs [S6]. Not checked on chain: no reachable Ethereum Sepolia RPC from this sandbox.
- The Paxos docs list Arbitrum Sepolia `0x637A…B1B1`, which matches the on-chain token [S6].
- No PYUSD address was found for Base Sepolia or Monad testnet.
- Faucets: Google Cloud Web3 faucet (up to 100 test PYUSD per Google account per day; Ethereum Sepolia and Solana Devnet as of May 2025) and the Paxos faucet. PayPal's Arbitrum blog says both serve Arbitrum Sepolia [S7]. Which networks each faucet serves today is UNVERIFIED.
- PayLink's registry already lists Arbitrum Sepolia (421614, editions `all`/`base`, USDC with 3009 off, `contracts: {}`) in `packages/chains/src/chains/arbitrum-sepolia.ts`. Adding PYUSD there with `eip3009:true, eip2612:true`, domain `{name:"PayPal USD", version:"1"}` would match what the chain answered.
- **PayPal "Pay with Crypto"** [S8]: a US-merchant checkout feature (buyers pay crypto, merchant settles in local currency; redirect flow; $0.01 minimum; refunds in PYUSD). Its sandbox availability and API surface are UNVERIFIED, and a third-party guide says it goes through Orders v2. It is not usable by a Madagascar merchant.

## 11. Madagascar: receiving vs sending, sandbox vs live

| Question | Finding | Status |
|---|---|---|
| Can someone in Madagascar hold a PayPal account? | PayPal has a Madagascar fee page (`paypal.com/mg/digital-wallet/paypal-consumer-fees`), and the April 2025 consumer fee PDF lists Madagascar | [S10] snippet |
| Can a Madagascar account **receive** and withdraw? | Secondary sources (GlobalBanks, an old PayPal Community thread, Global Voices 2012) say no: send/pay only. A 2026 vendor blog (NOWPayments) claims yes. No official page was reached | **UNVERIFIED; assume send-only** |
| Payouts to MG recipients | Country feature-set table not readable for MG | UNVERIFIED |
| Inbound remittance to MG | Xoom (a PayPal service) sends **to** Madagascar: cash pickup, Orange Money, Airtel Money, bank deposit | [S10] |
| Sandbox | Sandbox accounts are test accounts created in the Developer Dashboard, separate from live eligibility. Whether a Madagascar-based developer can sign in and create apps is **UNVERIFIED**; check on day 1 | UNVERIFIED |
| Hackathon eligibility | Madagascar is not in the excluded list | [S9] third-party |

Product framing that stays honest:

- PayPal is the **payer-side** rail. The client abroad (US/EU) pays with PayPal or a card.
- The payee side is either:
  - (a) a PayPal business account in a receiving country (a diaspora or partner merchant, not shown live), or
  - (b) PYUSD/USDC settlement to the freelancer's own wallet, which PayLink already does.
- The demo runs entirely on sandbox and testnets.

## 12. Fees (live; none are charged in sandbox)

US merchant rates. All secondary sources [S11]; PayPal's own fee page could not be reached:

- PayPal Checkout and Invoicing: **3.49% + $0.49**.
- Payments from outside the merchant's market: **+1.50%**.
- Currency conversion: about 3–4%.
- Chargeback: about $20.
- An older "2.9% + $0.30" figure is reported as retired.

Pay with Crypto: 0.99% promotional rate through 2026-07-31, then 1.5% (third-party [S8]). PayLinkV2 itself charges 0% (it is immutable and fee-less); only gas, paid by the relayer.

## 13. What can be shown fully in sandbox

| Capability | Fully in sandbox? | Notes |
|---|---|---|
| OAuth client-credentials token | Yes | |
| Invoicing: create, send (share link), payer pays on hosted page, `INVOICING.INVOICE.PAID`, QR, remind, cancel, record external payment | Yes | The payer logs in with a sandbox personal account. Hosted page on sandbox paypal.com; exact host UNVERIFIED |
| Orders v2 redirect plus capture | Yes | Sandbox buyer account |
| Webhooks to a Worker URL; simulator | Yes | Postback verification fails for simulator events [S5]; test with real sandbox events |
| Payouts | Yes in sandbox | Live needs approval (UNVERIFIED) |
| Payment Links API | Probably | [S4] says sandbox base supported |
| Agent Toolkit / local MCP against sandbox | Yes | `context.sandbox:true` / `PAYPAL_ENVIRONMENT=SANDBOX` |
| Remote MCP sandbox `mcp.sandbox.paypal.com` | Probably | Auth flow UNVERIFIED |
| PYUSD payment (EIP-3009 via relayer) | Yes on testnet | Needs PayLinkV2 deployed on 421614, test PYUSD and Sepolia ETH (Arbitrum) for the relayer |
| Pay with Crypto, Agent Ready, Store Sync | No / UNVERIFIED | Merchant programmes |
| A Malagasy payee receiving live PayPal | No | See section 11 |

## 14. Minimal sequence: "freelancer invoice paid by PayPal or by stablecoin"

Actors:

- F: freelancer, in the PayLink web app (payee).
- W: PayLink Cloudflare Worker, the existing relayer plus new `/paypal/*` and `/ai/*` routes; it holds `PAYPAL_CLIENT_ID/SECRET` and the LLM key.
- PP: PayPal sandbox REST.
- C: client abroad (payer).
- L: LLM.
- CH: chain (Base Sepolia USDC, or Arbitrum Sepolia PYUSD once deployed).

```
F  ──(text: "Logo for Acme, $120, net 7, acme@ex.com")──▶ W /ai/draft ──▶ L (tool schema, strict) ──▶ W ──▶ F   [draft fields]
F  signs PayLink EIP-712 invoice (unchanged; gives key K)                         [no gas, offline-capable]
F  ──(K, draft)──▶ W /paypal/invoice
W  ──POST /v1/oauth2/token (cached)──────────────────────────────────────────▶ PP
W  ──POST /v2/invoicing/invoices {detail:{invoice_number, reference:K, currency_code:"USD",
        payment_term:{term_type:"NET_10"}}, invoicer:{…}, primary_recipients:[{billing_info:{email_address}}],
        items:[{name, quantity:"1", unit_amount:{currency_code:"USD", value:"120.00"}}]}────────▶ PP  → DRAFT, id I
W  ──POST /v2/invoicing/invoices/I/send {send_to_invoicer:false, send_to_recipient:false}───▶ PP  → link
W  ──GET  /v2/invoicing/invoices/I ───────────────────────────────────────────▶ PP  → detail.metadata.recipient_view_url U
W  stores K↔I (Durable Object or KV); returns U ──▶ F; the PayLink link/QR now offers two rails: "PayPal" (U) and "USDC/PYUSD" (K)

── Rail 1: PayPal ──
C  opens PayLink link → taps PayPal → location.assign(U) → pays on PayPal's page (sandbox personal account)
PP ──webhook INVOICING.INVOICE.PAID──▶ W /paypal/webhook
W  ──POST /v1/notifications/verify-webhook-signature (raw event)──▶ PP → SUCCESS
W  ──GET /v2/invoicing/invoices/I──▶ PP → status PAID, amount 120.00 USD, reference K   (re-read, never trust body)
W  marks K settled-by-PayPal; F's till lights. To stop a later on-chain payment of K, submit PayLink's
   gasless cancel. That needs a payee-signed cancel, which F could pre-sign at creation (design option; check the cancel format)

── Rail 2: stablecoin ──
C  signs EIP-3009 ReceiveWithAuthorization (nonce bound to the invoice, ADR 0003) → W relays PayLinkV2.payWithAuthorization → CH
W  sees the Paid event / receipt for K (already does this)
W  ──POST /v2/invoicing/invoices/I/payments {method:"OTHER", payment_date, amount:{currency_code:"USD",value:"120.00"},
        note:"PYUSD eip155:421614 tx 0x…"}──▶ PP → invoice PAID (spec), so the PayPal page no longer takes payment (UNVERIFIED)

── AI follow-up (agentic part) ──
L (tools: list_invoices/search, send_invoice_reminder, get_invoice) answers "who still owes me", drafts FR/MG/EN reminders,
reconciles chain receipts against PayPal invoices. W executes tools; "send"/"record" only after F confirms.
```

Optional Orders variant, for PayPal from PayLink's own pay page with a return to PayLink's receipt:

1. `POST /v2/checkout/orders` with `custom_id:K`, `invoice_id:N`, the experience context and `PayPal-Request-Id:K`.
2. Redirect to `payer-action`; the payer returns to `return_url`.
3. `POST /v2/checkout/orders/{id}/capture` with `PayPal-Request-Id:K-capture`.
4. `PAYMENT.CAPTURE.COMPLETED` webhook.
5. Optionally record the capture on invoice I (`method:"PAYPAL"`; whether this is allowed is UNVERIFIED).

Worker routes to add (no change to the page CSP, which already allows the relayer origin in `connect-src`): `POST /paypal/invoice`, `GET /paypal/invoice/:K`, `POST /paypal/webhook`, `POST /paypal/record`, `POST /ai/draft`, `POST /ai/agent`. Secrets go in Worker secrets: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, and the LLM key.

### Day-1 checks (before 2026-10-21)

1. Developer Dashboard login from Madagascar works; create a sandbox app with Invoicing enabled; sandbox business (US) and personal accounts exist.
2. `send_to_recipient:false` returns a usable `recipient_view_url`; a sandbox personal account can pay it; `INVOICING.INVOICE.PAID` reaches a Worker URL.
3. Record-payment status label (`PAID` vs `MARKED_AS_PAID` vs `PAID_EXTERNAL`) and the hosted page's behaviour after it.
4. Orders return-URL query parameter name; capture response shape.
5. Remote MCP sandbox URL (`/http` vs `/mcp`) and whether a client-credentials bearer token works.
6. Test PYUSD on Arbitrum Sepolia from a faucet; Arbitrum Sepolia ETH for the deployer and relayer; deploy PayLinkV2 via CREATE2 and confirm `0x448e…5082`.
7. Devpost Rules page text: "existing project" wording, sandbox requirement, judging weights.

## 15. Sources

**Primary [V]:**

- [R1] PayPal OpenAPI specs: https://github.com/paypal/paypal-rest-api-specifications (commit 90e8041, 2026-04-07). Files `openapi/checkout_orders_v2.json`, `invoicing_v2.json`, `payments_payouts_batch_v1.json`, `notifications_webhooks_v1.json`, `payments_payment_v2.json`.
- [R2] PayPal Agent Toolkit: https://github.com/paypal/agent-toolkit (commit a3aa963, 2026-09-01). Files `README.md`, `LICENSE`, `typescript/README.md`, `typescript/package.json`, `typescript/src/shared/client.ts`, `functions.ts`, `python/README.md`.
- [R3] paypal-js: https://github.com/paypal/paypal-js (commit f58396a, 2026-10-09). Files `packages/paypal-js/README.md`, `src/utils.ts`, `src/v6/index.ts`, `types/v6/index.d.ts`, `types/script-options.d.ts`.
- [R4] npm registry:
  - https://registry.npmjs.org/@paypal/agent-toolkit (1.11.0)
  - https://registry.npmjs.org/@paypal/mcp (1.8.1)
  - https://registry.npmjs.org/@paypal/paypal-server-sdk (2.5.0, MIT; controllers Orders, Payments, Vault, Transaction Search, Subscriptions, **no Invoicing or Payouts** per [R6])
  - https://registry.npmjs.org/@paypal/paypal-js (11.2.2)
  - https://registry.npmjs.org/@paypal/react-paypal-js (10.6.0)
- [R5] PyPI: https://pypi.org/pypi/paypal-agent-toolkit/json (1.11.0)
- [R6] https://github.com/paypal/PayPal-TypeScript-Server-SDK README (`npm install @paypal/paypal-server-sdk@2.5.0`)
- [R7] JSON-RPC `eth_call` / `eth_getCode` / `eth_getStorageAt` on https://sepolia-rollup.arbitrum.io/rpc and https://sepolia.base.org, 2026-10-13 (script: `scratchpad/paypal/tools/probe.py`, `probe2.py`)
- [R8] Anthropic Claude API docs, MCP connector (beta `mcp-client-2025-11-20`; `mcp_servers` with `authorization_token`; `mcp_toolset`), via the bundled claude-api reference

**Search snippets [S]** (pages not openable from the sandbox):

- [S1] MCP server:
  - https://developer.paypal.com/ai-tools/mcp-server.md
  - https://docs.paypal.ai/developer/tools/ai/mcp-quickstart.md
  - https://paypal.gitbook.com/agent-toolkit-and-mcp-server/mcp-server/set-up-a-remote-mcp-server
  - Directories (non-official): https://mcp.so/servers/paypal, https://mcpservers.org/remote-mcp-servers/paypal, https://mcpplaygroundonline.com/mcp-servers/paypal
- [S2] https://developer.paypal.com/community/blog/streamable-paypal-mcp
- [S3] CSP: https://developer.paypal.com/sdk/js/csp/ ; https://docs.report-uri.com/platforms/paypal/
- [S4] Payment Links API: https://developer.paypal.com/api/payment-links-buttons ; https://docs.paypal.ai/payments/pay-links-buttons-api
- [S5] Webhooks and verification:
  - https://developer.paypal.com/api/invoicing/webhooks
  - https://developer.paypal.com/api/rest/webhooks/event-names/
  - https://developer.paypal.com/api/rest/webhooks/rest
  - https://hookdeck.com/webhooks/platforms/how-to-secure-and-verify-paypal-webhooks-with-hookdeck
- [S6] PYUSD testnet addresses: https://docs.paxos.com/guides/stablecoin/pyusd/testnet ; https://docs.sandbox.paxos.com/guides/stablecoin/pyusd/testnet
- [S7] PYUSD on Arbitrum and testnet faucets: https://developer.paypal.com/community/blog/pyusd-on-arbitrum/ ; https://developer.paypal.com/community/blog/testnet-pyusd
- [S8] Pay with Crypto: https://developer.paypal.com/crypto ; https://stablecoininsider.org/how-to-enable-paypal-pay-with-crypto/ (third-party)
- [S9] Hackathon:
  - https://paypalaihackathon.devpost.com/ , /rules , /resources
  - https://developer.paypal.com/community/blog/PayPal_AI_Hackathon/
  - https://raw.githubusercontent.com/howdycarter/paypal-ai-hackathon-2026/main/docs/competition.md (third-party transcription, read in full)
  - https://coursejoiner.com/hackathon/paypal-ai-hackathon-2026/
- [S10] Madagascar:
  - https://www.paypal.com/mg/digital-wallet/paypal-consumer-fees
  - https://www.paypalobjects.com/marketing/web/shared/clac/en/paypal-fees/paypal-consumer-fees-en-21-Apr-2025.pdf
  - https://globalbanks.com/sending-money-to-madagascar-from-us/
  - https://www.paypal-community.com/t5/Managing-Account-Archives/Why-paypal-doesn-t-work-in-Madagascar/td-p/2796594
  - https://globalvoices.org/2012/02/18/madagascar-why-malagasies-cannot-use-paypal/
  - https://www.xoom.com/madagascar
  - https://nowpayments.io/blog/payment-gateway-madagascar
  - https://docs.paypal.ai/growth/payouts/reference/countries-supported-features.md
- [S11] Fees (secondary): https://checkoutpage.com/tools/paypal-fee-calculator ; https://cartmango.com/how-much-does-paypal-charge/ ; https://tipalti.com/paypal-fees/
- [S12] Agentic commerce: https://www.digitalcommerce360.com/2025/10/28/paypal-agentic-commerce-ai-driven-shopping-services/ ; https://developer.paypal.com/community/blog/WebMCP_PayPal_Agent_Ready
