# PayPal AI Hackathon 2026: rules, eligibility, prizes, judging and deliverables

> Copied into the repository on 2026-10-21 from the planning notes of 2026-10-13; one edit: a path in another repository is no longer formatted as a path of this one. Devpost's answer of 2026-10-20 (Madagascar eligible, prizes by mail or bank wire) is recorded in [docs/paypal/SPEC.md](../../paypal/SPEC.md), section "Decisions of 2026-10-21".

Researched 2026-10-13 for PayLink (solo, Antananarivo, Madagascar).

## 0. How to read this file

The official Devpost pages could not be opened from this sandbox. `paypalaihackathon.devpost.com`, `devpost.com` and `developer.paypal.com` all return proxy 403 or DNS failures. So the facts below come from four other kinds of source. Each fact carries a tag:

| Tag | Meaning |
|---|---|
| **S2** | Two independent participant extractions of the official Devpost pages agree, sometimes with search-engine snippets of `paypalaihackathon.devpost.com/rules` as well |
| **S1** | One participant extraction only (usually [A], which says it covers the full rules, the FAQ, the resources page and the sponsor pages) |
| **SN** | Only a search-engine snippet or summary. These are weak, and LLM summaries can be wrong |
| **V** | Verified by me (JSON-RPC call, npm registry or repository git log) |
| **UNVERIFIED** | Inferred, conflicting or missing. Ask the organisers |

Sources:

- **[A]** github.com/aaravbodla/PAYPAL-AI-HACKATHON, README section "PayPal AI Hackathon — Participant Reference", "Extracted and checked on October 10, 2026 from the official Devpost rules, overview, FAQs, resources, and sponsor resource pages". Raw copy: https://raw.githubusercontent.com/aaravbodla/PAYPAL-AI-HACKATHON/main/README.md
- **[H]** github.com/howdycarter/paypal-ai-hackathon-2026, docs/competition.md in that repository, "Researched Oct 4, 2026 … from the live Devpost page". Raw copy: https://raw.githubusercontent.com/howdycarter/paypal-ai-hackathon-2026/main/docs/competition.md
- **[R]** https://paypalaihackathon.devpost.com/rules, **[O]** https://paypalaihackathon.devpost.com/ (overview), **[F]** https://paypalaihackathon.devpost.com/details/faqs, **[RES]** https://paypalaihackathon.devpost.com/resources. These are the official pages. I saw them only through [A], [H] and search snippets.
- **[BLOG]** https://developer.paypal.com/community/blog/PayPal_AI_Hackathon, PayPal's announcement of Sept 30, 2026, seen through search snippets.
- **[X]** https://x.com/paypaldev/status/2105749692650754285, seen through search snippets.

Before submitting, open [R], [F] and https://paypalaihackathon.devpost.com/updates in a normal browser and check every line below. The official rules prevail over everything else, including the overview page ([A] §11).

---

## 1. Identity

| Item | Value | Tag / source |
|---|---|---|
| Name | PayPal AI Hackathon, tagline "Build what's next with PayPal and AI" | S2 [A][H] |
| Sponsor | PayPal Inc., 2211 North First Street, San Jose, CA 95131 | S1 [A] |
| Administrator | Devpost, Inc., 250 Broadway, Floor 24, New York, NY 10007 | S1 [A] |
| Format | Online, global. No prescribed problem statements and no tracks. Award categories are not mandatory tracks | S2 [A][H]; SN [BLOG] |
| Entry fee | None ("no purchase necessary") | S1 [A] |
| Field size | "4,957 participants registered so far (as of Oct 4, 2026)" | S1 [H] |
| Contacts | support@devpost.com (rules questions); janet@devpost.com (hackathon manager, listed on the overview); Discord https://discord.gg/sJ2G6DyvSK | S1 [A] |
| Judges | PayPal developer advocates and engineers (Jo Franchetti, Eddie Jaoude, Marco Podien, Karthik Ravi, Himraj Singh, Nathaniel Olson) plus sponsor judges | S1 [H] |

## 2. Dates

The official rules use Pacific Time. US daylight saving time ends on Sunday, 2026-11-01, so every date from November onward is in PST (UTC−8). Madagascar is on EAT (UTC+3).

| Milestone | Official (PT) | UTC | Antananarivo (EAT) | Tag |
|---|---|---|---|---|
| Submission period opens | Thu 2026-10-01 09:15 PDT | 16:15 | 19:15 | S1 [A]; SN says 09:00 PT |
| **Submission deadline** | **Thu 2026-11-12 12:00 PST** | **20:00** | **23:00** | S2: [A] says noon PT; the Devpost banner reads 1:00 pm MST ([A]); [H] says 3:00 pm EST; SN says 12:00 pm PST. All four are 20:00 UTC. One SN summary said 2:00 pm PT. **UNVERIFIED outlier** |
| Judging | 2026-12-01 14:00 PST → 2026-12-15 08:00 PST | Dec 1 22:00 → Dec 15 16:00 | Dec 2 01:00 → Dec 15 19:00 | S1 [A]. One SN summary said judging runs Nov 13 → Dec 15. **UNVERIFIED** |
| Winners announced | On or around 2026-12-21 14:00 PST | 22:00 | Dec 22 01:00 | S1 [A]; SN [BLOG] "Dec 21, 2026 - Winners announced" |
| Webinars (past) | Oct 6 "Start building with PayPal", Oct 7 APIMatic, Oct 12 payments dashboard, Oct 13 "Start building with PayPal" | | | S1 [H]. Recordings are probably on [RES]. **UNVERIFIED** |

Your plan (build from Oct 21, submit around Nov 5) leaves 7 days of buffer. Devpost lets you save a draft before the deadline, and the entry cannot be changed after the deadline (S1 [A] §5).

## 3. Eligibility (Madagascar)

**Who may enter.** Individuals who have reached the age of majority where they live, teams of such individuals, and organisations. Solo entries are allowed, and there is no maximum team size. An individual may also join teams. S2 [A][H]; SN quotes [R]: "Individuals at or above the age of majority…".

**Who may not enter** (S2 [A][H]; SN):

- Residents of **Brazil, Quebec, Russia, Crimea, Cuba, Iran, North Korea**, plus "any country comprehensively sanctioned by OFAC". The list is not exhaustive: it also covers any jurisdiction "where U.S. or local law prohibits participation or receipt of a prize".
- Employees of PayPal and Devpost, judges, and their families or households. Anyone with a conflict of interest.

**Madagascar: probably eligible, UNVERIFIED.**

- Madagascar is not on the named list.
- University compliance lists of OFAC comprehensive sanctions name Cuba, Iran, North Korea, the occupied Ukrainian regions and, depending on the source, Syria or Russia. Madagascar is not on any of them. Sources: https://www.cwu.edu/about/offices/information-services/security-services/sanctioned-countries, https://research.ua.edu/resources/export-controls/sanctions-and-embargoes/. I could not reach OFAC's own page.
- The "local law" clause remains, so get a written confirmation (§10, Q1).

**Practical blockers for a Malagasy entrant** (all UNVERIFIED):

- **PayPal developer account.** You need one for sandbox access ([A] §10: "Use an existing PayPal account or create a free developer account"). PayPal's consumer service in Madagascar has historically been limited. Global Voices (2012) reports that accounts could be opened but money could not be withdrawn: https://globalvoices.org/2012/02/18/madagascar-why-malagasies-cannot-use-paypal/. That article is old. Xoom (a PayPal service) does send money *to* Madagascar: https://www.xoom.com/madagascar. The FAQ says "Country-specific PayPal sign-up issues can be raised in Discord" (S1 [A] §10). **Create the developer account at developer.paypal.com now, before Oct 21.** Sandbox test accounts are given a country when you create them ([sandbox accounts](https://developer.paypal.com/sandbox-testing/accounts), SN). A US sandbox business account is the usual choice. Whether that choice is unrestricted is UNVERIFIED.
- **Prize payment.** Winners return forms within **10 business days** and are paid within **60 days** of returning them. Winners pay taxes and banking, foreign-exchange and wiring fees. A non-US winner files W-8BEN and "withholding may apply" (S1 [A] §7).
  - Madagascar does not appear in the IRS treaty excerpts I found ([Table 3](https://www.irs.gov/pub/irs-lbi/table-3-list-of-tax-treaties.pdf), [A–Z](https://irs.gov/businesses/international-businesses/united-states-income-tax-treaties-a-to-z)). The excerpts were partial, so this is unconfirmed.
  - If there is no treaty, the default US rate on prizes paid to non-residents is **30%**. This is my inference and UNVERIFIED: check IRS Publication 515.
  - The payout channel to Madagascar (wire, PayPal, Payoneer) is UNVERIFIED.

## 4. What must be built

Mandatory items (S2 [A][H]; SN quotes [R]):

1. An application that **centrally integrates the PayPal developer platform, using the free sandbox environment**. PayPal must be "central to the project, not merely mentioned" ([A]), or "central, not decorative" ([H]).
2. **An AI tool, model or platform of your choice.** Any provider is allowed (S2). The overview asks entrants to **name the AI tools and models used** (S1 [A] §5). [H] reads the requirement as "meaningfully use BOTH PayPal and AI" and "AI is meaningfully incorporated into the experience or functionality".
3. **A working application**: "installable … runs consistently on its intended platform and functions as shown in its video and description". "A design mockup, static prototype, or non-functional demo does not" qualify (S2; SN quotes [R]).

### 4.1 What counts as "PayPal technology"

**PayPal services allowed by the rules** (S1 [A] §4):

- PayPal itself, Venmo, Braintree, Xoom, Honey, Zettle, Paidy, Hyperwallet, Simility, Swift Financial and others.
- [A] warns that being on the list "is not a promise that every service has identical sandbox access or regional availability".

**APIs and tools linked from [RES]** (S1 [A] §9):

- **APIs and SDKs:**
  - REST APIs: https://developer.paypal.com/api/rest/
  - JavaScript SDK: https://developer.paypal.com/sdk/js/
  - Checkout: https://developer.paypal.com/checkout/
  - Payments: https://developer.paypal.com/payments/
  - Payment links and buttons: https://developer.paypal.com/payment-links-buttons/overview
  - Subscriptions: https://developer.paypal.com/platforms/subscriptions
  - **Invoicing**: https://developer.paypal.com/invoicing/about
  - Payouts: https://developer.paypal.com/docs/payouts/
  - Disputes: https://developer.paypal.com/platforms/disputes/overview
  - Webhooks: https://developer.paypal.com/api/webhooks/overview
  - Sandbox starter: https://github.com/paypaldev/getting-started-with-paypal-sandbox
- **AI and agent tooling:**
  - PayPal AI Toolkit: https://github.com/paypal/AI-Toolkit
  - Docs: https://docs.paypal.ai/
  - Agent Toolkit quickstart: https://docs.paypal.ai/developer/tools/ai/agent-toolkit-quickstart
  - MCP quickstart: https://docs.paypal.ai/developer/tools/ai/mcp-quickstart
  - Tools reference: https://docs.paypal.ai/developer/tools/ai/agent-tools-ref

**Checked by me** (V):

- npm packages on 2026-10-13:
  - `@paypal/agent-toolkit` 1.11.0 ("PayPal toolkit for AI agent workflows in typescript")
  - `@paypal/mcp` 1.8.1
  - `@paypal/paypal-server-sdk` 2.5.0
  - `@paypal/paypal-js` 11.2.2
  - `@paypal/react-paypal-js` 10.6.0
- The Agent Toolkit README lists tools for:
  - **Invoices**: `create_invoice`, `send_invoice`, `send_invoice_reminder`, `generate_invoice_qr_code`, `record_payment_for_invoice`, recurring series and more.
  - **Payments**: `create_order`, `get_order`, `pay_order`, `create_refund`, `get_refund`.
  - Disputes, shipment tracking, catalog, subscriptions, and reporting (`list_transactions`, `get_merchant_insights`).
  - Source: https://raw.githubusercontent.com/paypal/agent-toolkit/main/README.md
- `paypal/AI-Toolkit` is a coding-assistant plugin (Claude Code, Codex, Cursor) that connects to "PayPal's sandbox MCP servers". It uses a sandbox token from `https://api-m.sandbox.paypal.com/v1/oauth2/token`, and "Tokens expire in up to 8 hours". Source: https://raw.githubusercontent.com/paypal/AI-Toolkit/main/README.md

**PYUSD: UNVERIFIED as a qualifying PayPal technology.**

- PYUSD has a resource centre on PayPal's developer site: https://developer.paypal.com/dev-center/pyusd/ (SN).
- It is issued by Paxos and lives on public chains, not in the PayPal sandbox.
- No extraction of [R] or [F] mentions PYUSD or crypto.
- The hard requirement says "PayPal developer platform … free sandbox environment". An entry whose only PayPal component is on-chain PYUSD **could fail the Stage 1 pass/fail check**.
- Treat PYUSD as a complement to a PayPal REST sandbox integration (Invoicing or Orders, plus Webhooks), not a replacement. Ask the organisers (Q3).

**PYUSD testnet facts** (in case PayLink adds it):

- **Arbitrum Sepolia `0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1`** is listed by Paxos (https://docs.paxos.com/guides/stablecoin/pyusd/testnet, SN). **V** through `sepolia-rollup.arbitrum.io`:
  - `symbol()` = "PYUSD", `name()` = "PayPal USD", `decimals()` = 6
  - `DOMAIN_SEPARATOR()` is present and `nonces()` answers, which fits EIP-2612
  - `authorizationState(address,bytes32)` answers without reverting, which suggests EIP-3009. This is an inference, not proven.
- **Trap (V):** the same address on **Base Sepolia** is **"PAXG / Paxos Gold", 18 decimals**, not PYUSD. Never take a token address from another chain.
- Ethereum Sepolia PYUSD `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9` is listed by Paxos (SN). No Sepolia RPC was reachable here, so it is not checked.
- PayLinkV2 `0x448eCce9711860502806A3d5B021a4f9Ba715082` has **no code on Arbitrum Sepolia** (V, `eth_getCode` = `0x`). It would need a CREATE2 deployment there.

### 4.2 What "AI" must do

- **Required:** an AI tool, model or platform of your choice, used in the project (S2). Judges score "thorough, skillful use of PayPal **and** AI" (S2, §6).
- **Not established (UNVERIFIED):** whether AI used only to *write* the code, such as Claude Code, satisfies the rule.
  - PayPal's own AI-Toolkit is a coding-assistant plugin, which suggests PayPal values that kind of use.
  - But [H] reads the rule as AI "incorporated into the experience or functionality", and the Technological Implementation criterion points the same way.
  - **Safe reading:** AI must be a working feature of the product, and the submission must name the model and provider. PayLink's `AI_DISCLOSURE.md` covers AI-assisted development separately.
- **Agentic commerce** is a named $5,000 honourable mention. No definition was found (UNVERIFIED). [A] suggests examples: "shopping agents, contractor payouts, freelancer dashboards, … invoicing, creator tipping, chat-based money requests" ([RES], S1).

### 4.3 Sponsor tools (optional)

AG Grid, APIMatic, Astropods, Bryntum, Channel3, Elastic, KERNEL, Postman, Render and Zapier are all optional (S2 [A][H]). Only AG Grid, APIMatic, Bryntum, Channel3 and Render have **sponsor prizes** (§7). See §8 for credits.

## 5. Pre-existing projects

**Rule** (S2; SN quotes [R] "How To Enter"):

- New projects are allowed.
- A project that existed before the submission period opened (Oct 1, 2026) **must be "significantly updated" after the period starts**, and the submission must **explain the updates**.
- The sponsor and administrator decide what is significant "at their sole discretion".
- [H] summarises: "meaningful progress happens during the hackathon".

**Exclusion** (S1 [A]): a project developed, or derived from a project developed, with **financial or preferential support from PayPal or Devpost** is not eligible. Examples are funding, contract development, or a commercial licence received before the period ends. "Ask the organizer about any potentially applicable relationship."

**What this means for PayLink:**

- **V:** the first commit in `/home/user/paylink-main` is **2026-10-04 18:04 UTC** ("PayLink: shareable USDC payment links on Arc"). `AI_DISCLOSURE.md` says v1 was built Oct 4–5 and v2 started Oct 5. So the whole codebase postdates the opening (2026-10-01 16:15 UTC) and is inside the submission period. The PayPal and AI work planned from Oct 21 adds the "significant update" on top.
- **UNVERIFIED:**
  - PayLink is also entered in Monad Metropolis, Colosseum and Arc Microgrants. No extracted rule forbids entering the same project in other events.
  - **Multiple entries** to *this* hackathon must each be "unique and substantially different" (S1 [A]). Submit one PayLink entry.

## 6. Judging

**Stage 1 (pass/fail).** The project must "reasonably fit the theme and reasonably apply the required APIs/SDKs" (S2 [A]; SN).

**Stage 2.** Five criteria. [A] says they are **equally weighted**, quoting [R]. [H] says "weights were not published on the Devpost page as of Oct 4" ([H] read only the overview). Treat equal weights as S1, likely correct.

| # | Criterion | What judges assess ([A][H]) |
|---|---|---|
| 1 | **Technological Implementation** | How thoroughly and skilfully the project uses the PayPal developer platform and AI; genuine effort; a working, non-trivial implementation |
| 2 | **Design** | A complete, coherent product experience, not just a technical proof of concept |
| 3 | **Potential Impact** | A credible, specific problem and audience, and a demo that shows the solution addressing it |
| 4 | **Innovation / Idea** | Creativity, novelty, difference from existing concepts |
| 5 | **Presentation** | The video shows the project working end to end; the pitch explains problem, audience and value |

**Ties** are broken by comparing criteria in the order above, starting with Technological Implementation. If still tied, the judges vote (S1 [A]).

**Method.** Judging "may utilize expert panels, peer review, automated AI-driven analysis, or any combination" (SN quotes [R]; S1 [A]). So the README and description must be easy for both humans and machines to parse. Judges are **not required to run the project** and may judge from text, images and video alone (S1 [A]). The video therefore carries most of the weight.

## 7. Prizes (USD)

$67,500 in cash, plus $2,250 in Render credits and APIMatic subscriptions, $69,750 in total (S2 [A][H]; SN Devpost listing). PayPal's blog says "$60,000+" (SN [BLOG]), which is probably an older figure.

| Prize | Amount | Winners | Tag |
|---|---|---|---|
| 1st Place | $12,000 | 1 | S2 |
| 2nd Place | $8,000 | 1 | S2 |
| 3rd Place | $5,000 | 1 | S2 |
| HM: Most Creative | $5,000 | 1 | S2 |
| HM: Most Impactful | $5,000 | 1 | S2 |
| HM: Best Demo Delivery | $5,000 | 1 | S2 |
| HM: **Best Use of PayPal + AI** | $5,000 | 1 | S2 |
| HM: **Best Use of Agentic Commerce** | $5,000 | 1 | S2 |
| Best Use of AG Grid, 1st / 2nd / 3rd | $5,000 / $2,000 / $1,000 | 1 / 1 / **3** | S1 [A] |
| Best Use of APIMatic | $1,000 + 6 months of APIMatic Business | 3 | S1 [A] |
| Best Use of Bryntum | $1,000 | 3 | S1 [A] |
| Best Use of Channel3 | $1,500 | 1 | S1 [A] |
| Best Use of Render, 1st / 2nd / 3rd | $1,000 / $750 / $500 in Render credits | 1 each | S1 [A] |

The cash adds up to $67,500, which matches the headline (my arithmetic).

**Award limits** (S1 [A], which states them in both its summary and its §7):

- A project can win at most **one grand prize + one sponsor prize**, **or one honourable mention + one sponsor prize**.
- It cannot win a grand prize and an honourable mention together, or more than one sponsor prize.
- Prizes go to the individual entrant or the team representative.
- The sponsor may decline to award a category that has no eligible entries.

## 8. Credits and resources for participants (S1 [A] §8, from the Devpost sponsor pages)

| Sponsor | Offer | Link |
|---|---|---|
| Render | **$50 credits** | https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon |
| KERNEL | **$50 credits**, code `KERNELDEVPOST2026` | https://dashboard.onkernel.com/hackathon?code=KERNELDEVPOST2026 |
| Channel3 | 20,000 free API credits per key, code `PAYPAL-HACKATHON-2026` | https://trychannel3.com/developers |
| APIMatic | 1 month of Basic if you use its Context Plugin for the PayPal integration | Google Form linked from https://paypalaihackathon.devpost.com/details/apimatic |
| Elastic | 14-day serverless trial, extendable by 30 days, or run it locally for free | https://ela.st/elastic-paypal-hackathon |
| AG Grid | 45-day AG Studio trial; PayPal + AG Grid starter | https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate |
| Bryntum | 45-day trial | https://bryntum.com/download/ |
| Zapier | Standard 14-day Pro trial (not a hackathon-specific offer) | https://zapier.com/sign-up |
| Postman, Astropods | Free tiers only; PayPal Postman collection | https://www.postman.com/paypal |
| PayPal | Free sandbox; no credits needed | https://developer.paypal.com/dashboard/ |

No LLM-provider credits are listed (UNVERIFIED that there are none). The project must stay **free and working until Dec 15, 2026** (§9), so check that every trial and the AI-provider budget last that long.

## 9. Required deliverables (S2 [A][H] unless marked)

| Deliverable | Requirement |
|---|---|
| Devpost entry | Every required field completed before the deadline. Drafts are allowed. No changes after the deadline |
| Description | Features and functionality; **list the tools and AI models used and how**; explain the "significant updates" made for this hackathon |
| Functional demo | **A hosted demo URL or complete run instructions** in the repository. Public hosting is optional |
| Repository | **Public** on GitHub, GitLab or Bitbucket, with all source, assets and instructions. **Open-source licence file** that the host detects and shows in the About area. PayLink has MIT (V) |
| Video | **Less than 3 minutes**; judges need not watch beyond 3:00. Must show the project **working on its intended device or platform**. **Public on YouTube**. No third-party trademarks, copyrighted music or other protected material without permission |
| Language | English, or full English translations of the video, description and testing instructions (S1 [A]). PayLink's EN UI qualifies; narrate in English or add English subtitles |
| Test access | A working site, demo or test build. **If access is private, put test login credentials in the testing instructions.** Give the "test-account credentials, API keys, or sandbox details necessary to test", plus any special access steps in the README or description (S1 [A]) |
| Availability | **Free and unrestricted for the sponsor, administrator and judges until judging ends on Dec 15, 2026** (S1 [A]) |
| Winner paperwork | Identity and eligibility checks; forms within 10 business days; W-8BEN for non-US winners (S1 [A]) |

**Practical (not rules):**

- Never commit the sandbox client secret.
- Give judges **sandbox buyer accounts** (email and password of a sandbox personal account) and a hosted demo whose server holds the secret. Do not give them API keys.
- PayPal sandbox access tokens expire within 8 hours (V, AI-Toolkit README). The server must refresh them using client credentials, or the demo will break during judging.
- `api-m.sandbox.paypal.com` is unreachable from *this* sandbox (V, proxy 403). Do the PayPal integration tests on your own machine or in CI.

**Legal points (S1 [A] §11):**

- You keep your IP and grant a non-exclusive licence for judging.
- You consent to publicity for 3 years.
- **The relationship is not confidential.**
- Disputes go to individual AAA arbitration under New York law.
- Devpost's Terms of Service apply.

## 10. Questions for the organisers

Ask in writing before Oct 21: Discord https://discord.gg/sJ2G6DyvSK, support@devpost.com, janet@devpost.com. The rules ask for a "written request for clarification before the deadline" on anything ambiguous (S1 [A]).

1. **Eligibility and payout (Madagascar).** Please confirm that a resident of Madagascar is eligible. How is a prize paid to Madagascar: bank wire, PayPal, or something else? What withholding applies with a W-8BEN, given that there is apparently no US–Madagascar tax treaty?
2. **PayPal account from Madagascar.** If a Malagasy resident cannot open a PayPal or PayPal Developer account, may the sandbox business and personal test accounts be created under another country, such as the US?
3. **PYUSD and crypto.** Does on-chain PYUSD (Paxos testnet, for example on Arbitrum Sepolia) count as the required "PayPal developer platform" use? Or must the central integration be the PayPal REST sandbox (Invoicing, Orders, Webhooks, Agent Toolkit or MCP)? Is a hybrid acceptable: PayPal sandbox checkout plus an on-chain stablecoin rail on public testnets?
4. **AI scope.** Must AI be a running feature of the product? Does AI-assisted development (Claude Code) count on its own? Is any provider, such as Anthropic Claude, acceptable? May judges use the AI feature through our hosted key?
5. **Prior or concurrent work.** The repository's first commit is 2026-10-04, inside the submission period. The same project is also entered in other hackathons (Monad, Colosseum, Arc/Circle microgrants). Is that allowed? How should the "significant updates" be documented, for example as a commit range or a changelog section?
6. **Credentials.** Is the Devpost "testing instructions" field visible only to judges? Is it acceptable to share sandbox buyer logins there, with no API keys, given that the repository must be public?
7. **Dates.** Please confirm the deadline is 2026-11-12 12:00 PT (20:00 UTC). One source says 2:00 pm PT. Does judging run Dec 1–15 or Nov 13–Dec 15? Must the demo stay live until Dec 15 08:00 PT?
8. **Criteria.** Are the five criteria equally weighted? Is automated AI-driven analysis used, and does it read the repository, the README, or only the Devpost text?
9. **"Best Use of Agentic Commerce".** What qualifies? For example, would an agent that drafts PayPal invoices and payment links through the Agent Toolkit or MCP, with the human approving before money moves, count?
10. **Render prize.** Does hosting only the API or agent service on Render (with the web app on Cloudflare Pages) qualify as "using Render tools"?
11. **Video.** Is "under 3:00" strict? Is English narration required, or are English subtitles over French or Malagasy narration acceptable?
12. **Webinar recordings.** Where are the recordings of the Oct 6, 7, 12 and 13 webinars?

## 11. Facts that matter most for PayLink

- The PayPal REST sandbox must be **central**: PayPal Invoicing or Orders, plus Webhooks, plus Agent Toolkit or MCP. An on-chain PYUSD path alone risks failing the Stage 1 pass/fail check. PYUSD is a differentiator, not the qualifier.
- AI must be **in the product**: for example, an agentic back-office that turns a chat or voice request (EN/FR/MG) into a signed PayLink invoice plus a PayPal sandbox invoice, with a human approval step. Name the model in the submission.
- Best-fit prizes:
  - Grand prizes
  - HM **Best Use of PayPal + AI** or **Best Use of Agentic Commerce** (only one HM can be won)
  - One sponsor prize: **Render** (hosting the API) or **AG Grid** (ledger grid)
- Deliver:
  - a hosted demo with sandbox buyer logins
  - a public MIT repository
  - an English YouTube video under 3:00, showing the product on a phone
  - a README section "What was built for the PayPal AI Hackathon (since 2026-10-01)"
  - everything kept live until 2026-12-15 16:00 UTC
