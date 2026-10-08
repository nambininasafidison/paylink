# Runbook: testnet faucets

How to fund the testnet wallets for deployments, the relayer and the demos. Start tonight, then claim on every refill cadence: faucets run dry, rate-limit and change their rules.

> **All faucet facts below are unverified (U) or likely (L).** Check each one from Madagascar, since some faucets restrict countries, require social logins or ask for a mainnet balance. Record what actually worked in the [claim log](#4-claim-log).
>
> Faucets only ever need your **public address**. A faucet that asks for a private key or a seed phrase is a scam.

## 1. Targets

| Wallet | Chain | Target balance | Why |
|---|---|---|---|
| W-deploy | Monad testnet 10143 | **≥ 0.5 MON** | Deploy budget: about 3.0M gas × about 105 gwei ≈ 0.32 MON |
| W-relay | Monad testnet 10143 | **1–2 MON**, never more than about 2 | Relayer gas; capped to bound the damage if the key leaks |
| W-deploy, W-relay | Base Sepolia 84532 | ≥ 0.02 ETH each | Deploy and relay |
| W-deploy, W-relay | Arbitrum Sepolia 421614 | ≥ 0.01 ETH each (optional) | Optional edition |
| W-pay, test payers | Base Sepolia, Arbitrum Sepolia, Monad testnet | a few USDC | Demo payments |
| Mera payers | Monad testnet | a few AUSD | Gasless demo; the payer never holds MON |

Monad note (**C**): an EOA with 0 MON cannot send anything, because of the 10-MON reserve-balance rule. Mera merchants and payers never need MON, because the relayer pays the gas and never sends value.

## 2. Faucets by asset

| Asset | Faucet | Cadence | Notes |
|---|---|---|---|
| MON (Monad testnet) | First, the MON testnet faucet on the Monad Metropolis dashboard (**UV**, 2026-10-06; terms as shown there). Then QuickNode `faucet.quicknode.com/monad` (no account or mainnet balance needed) or ZalalenA `faucet.zalalena.com/monad` (captcha). The public `faucet.monad.xyz` has unclear eligibility | Dashboard: as shown there; QuickNode every 12 h | Claim for W-deploy first, then W-relay |
| AUSD (Monad testnet) | The relayer's `POST /v1/10143/onboard`, or call `requestFunds(<your address>)` on the faucet proxy `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C` yourself | 60 s cooldown, global: anyone's drip blocks everyone for a minute (**C**, fork, 2026-10-07) | 10,000 AUSD per drip; it ran dry once (**L**). The relayer has no AUSD of its own to fall back on: if the faucet is dry, fund payers from another test wallet |
| USDC (Monad testnet, Base Sepolia, Arbitrum Sepolia, Arc testnet) | `faucet.circle.com` | 20 USDC per 2 h per chain (**L**) | Choose the right network on the page |
| Base Sepolia ETH | Bware Labs (no registration), the Ethereum Ecosystem faucet (no login), the CDP faucet (free account), thirdweb, LearnWeb3 | about 24 h | Try them in that order |
| Arbitrum Sepolia ETH | `arbitrum.faucet.dev`, LearnWeb3, `ethfaucet.com`; or proof-of-work Sepolia ETH from pk910, bridged over the canonical bridge | about 24 h, plus the bridge delay | Optional edition only |
| Mezo test BTC | `faucet.test.mezo.org` (captcha); the Mezo Discord, which the Mezo programme requires participants to join (**UV**, 2026-10-06) | from Oct 13 | Needed to borrow MUSD (§3) |

Token addresses are in [ARCHITECTURE §6](../ARCHITECTURE.md#6-deployments-and-code-integrity). On Monad testnet, `0xf817257fed379853cDe0fa4F97AB987181B1E5Ea` is **not** Circle's USDC. Never use it.

## 3. MUSD on Mezo testnet (no faucet)

Test MUSD cannot come from a faucet. You must borrow it:

1. Claim test BTC early, from Oct 13. The amount needed is significant: about $2.2k of test BTC at the testnet price feed.
2. Borrow **at least 2,000 MUSD** (1,800 plus a 200 gas deposit) at **≥ 110 %** collateral at `mezo.org/feature/borrow` on testnet.
3. If the faucet is too slow, ask in the Mezo Discord.

## 4. Claim log

Keep this table up to date: in this file, or privately if you prefer. Never record keys.

| Date (UTC) | Faucet | Chain | Asset | Amount | Wallet | Transaction or notes |
|---|---|---|---|---|---|---|
| | | | | | | |

## 5. Before each demo or judging window

- [ ] W-relay has enough MON for the window. Monad judging runs Oct 14–27 (**L**).
- [ ] The AUSD faucet still has funds: try `/v1/10143/onboard` once ([relayer runbook §6](relayer.md#6-smoke-test)). If it is dry, send AUSD to the demo payers from a wallet that holds some.
- [ ] Demo payers hold enough USDC or AUSD for every retake ([demo-recording runbook](demo-recording.md)).
- [ ] Use small demo amounts (for example 5.00 or 12.50), so that faucet limits never block a retake.
