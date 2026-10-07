# Security policy

> **PayLink is not audited by a third party.** The v2 contract (`PayLinkV2`) is deployed to **testnets only**. PayLink v1 runs on Arc mainnet for small amounts. Do not use either with funds you cannot afford to lose.

## Supported versions

| Component | Version | Network | Supported |
|---|---|---|---|
| `PayLinkV2` contract (`protocol/`) | `contracts-v2.0.x` tags | Monad testnet 10143, Base Sepolia 84532, Arbitrum Sepolia 421614; later Mezo testnet 31611 | Yes |
| v2 SDK, web app and relayer (`packages/`, `apps/`) | `main` | the production origin `https://<app>.pages.dev` | Yes |
| PayLink v1 (`contracts/PayLink.sol`, `web/`) | tag `arc-microgrants-v1` and its `.1` follow-up | Arc mainnet 5042, `https://nambininasafidison.github.io/paylink/web/` | Security fixes only |
| Anything else | — | — | No |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

**<https://github.com/nambininasafidison/paylink/security/advisories/new>**

The same address is in the contract's NatSpec (`@custom:security-contact`). If private reporting is unavailable for any reason, open a public issue titled "Security contact request", **with no details**, and we will set up a private channel.

Please include:

- the affected component, version, commit or deployment (chain ID and address);
- the impact: who can lose what, and under which conditions;
- reproduction steps, ideally a Foundry test or a script against a local anvil chain;
- whether you want to be credited, and under what name.

Reports in English or French are welcome.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement | within **72 hours** |
| Initial assessment and severity (CVSS) | within 7 days |
| Status updates | at least weekly until resolved |
| Fix or mitigation | as fast as severity requires; see the [incident response plan](docs/security/incident-response.md) |
| Coordinated disclosure | a GitHub Security Advisory once users are protected (fix deployed, or affected deployments revoked in the registry), and at the latest 90 days after the report unless we agree otherwise |

The contract is immutable and has no pause ([ADR 0004](docs/adr/0004-immutable-ownerless-feeless.md)). A contract fix therefore means a new deployment, while the client stops offering the vulnerable one. Old deployments stay callable on-chain.

## Scope

**In scope:**

- `protocol/src/` (`PayLinkV2` and its interfaces) and the deployment records in `protocol/deployments/`;
- `packages/sdk` and `packages/chains`: invoice codec, signature verification, receipt verification, registry;
- `apps/web` on the production origin: XSS, CSP bypass, signing-display mismatches, payment to the wrong address or contract;
- `apps/relayer`: any way to redirect funds, abuse the hot key, or bypass validation;
- the invoice format itself ([docs/spec/paylink-invoice-v2.md](docs/spec/paylink-invoice-v2.md));
- GitHub Actions workflows: secret exposure, privilege escalation;
- PayLink v1 (`contracts/PayLink.sol`, `web/`).

**Out of scope:**

- Vulnerabilities in third-party services or libraries themselves (Cloudflare, Envio, RPC providers, wallets, the Mera SDK, token contracts). Report them upstream, but tell us if PayLink is affected.
- Testnet faucets, testnet token balances and gas prices.
- Volumetric denial of service, spam, and social engineering of the maintainer.
- Attacks that require a compromised device, operating system, browser extension or authenticator.
- Missing security headers or best practices without a demonstrable impact.
- The documented residual risks in [THREAT_MODEL §8](docs/security/THREAT_MODEL.md#8-residual-risks), unless you show a new way to exploit them.

## Testing rules

- Test against a local anvil chain or your own testnet deployment whenever possible. Never test with other users' invoices or funds.
- Do not drain or flood the shared testnet relayer. Ask us for a dedicated test budget if you need one.
- Do not access, modify or delete other people's data, and stop as soon as you reach any.
- Give us reasonable time to fix before any disclosure.

## Safe harbour

We will not pursue or support legal action against anyone who researches and reports in good faith under this policy: avoiding harm to users, data and services, following the testing rules and coordinating disclosure with us. If a third party starts legal action over such research, we will make it known that you acted under this policy. When in doubt, ask us first through the private channel.

## Recognition

There is no cash bounty. With your consent, valid reports are credited in the advisory and in a **hall of fame** below.

### Hall of fame

_No reports yet._

## Further reading

- [Threat model](docs/security/THREAT_MODEL.md)
- [Self-review checklist](docs/security/self-review.md) (a self-review, not an audit)
- [Incident response plan](docs/security/incident-response.md)
- [Architecture](docs/ARCHITECTURE.md)
