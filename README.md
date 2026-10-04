# ⚡ PayLink — shareable USDC payment links on Arc

**Arc Microgrants Mainnet Challenge** · live on **Arc mainnet** (chainId 5042)

| | |
|---|---|
| **Live app** | https://nambininasafidison.github.io/paylink/web/ |
| **Contract (Arc mainnet)** | _see [`deployments/mainnet.json`](deployments/) once deployed_ |
| **Source** | [`contracts/PayLink.sol`](contracts/PayLink.sol): one file, about 120 lines, no dependencies |

Freelancers, small shops and creators, from Antananarivo to anywhere, need a simple way to get paid in dollars. PayLink makes it a link:

1. **Create**: set an amount, a memo and an optional expiry. One transaction.
2. **Share**: send the URL or the **QR code** over WhatsApp, email, or a printed counter sign.
3. **Get paid in under a second.** The customer opens the link and pays. **The USDC goes straight to the payee in the same transaction**; the contract never holds funds.

There are two kinds of links:
- **Fixed amount (invoice):** it accepts exactly one payment of the exact amount, then closes itself.
- **Open amount (tip jar, donations):** it can be paid many times, with any amount.

## Why Arc

- **USDC is the gas token.** The payer needs only one asset. There is no "buy ETH for gas first" step, which kills most stablecoin checkouts.
- **Sub-second finality** makes a payment feel like a card tap.
- **Arc's dual USDC decimals are handled correctly.** Native `msg.value` uses 18 decimals and the UI shows 6. The contract only ever uses native value and never mixes it with the ERC-20 interface at `0x3600…0000`.

## Judges' quick tour (2 minutes)

1. Open the **live app**, connect a wallet on Arc, and create a link for `0.10` USDC.
2. Scan the QR code or open the link in another browser or wallet, then pay.
3. The link turns **Paid**, and **My links** shows the total received. Every step links to the Arc explorer.

## Contract — [`contracts/PayLink.sol`](contracts/PayLink.sol)

| Function | What it does |
|---|---|
| `create(amount, expiresAt, memo)` | New link paying `msg.sender`. `amount` is in native units (18 decimals), and `0` means an open amount |
| `pay(id, note)` (payable) | Checks that the link is active, not expired and has the right amount, **updates state first**, then forwards `msg.value` to the payee. Guarded by `nonReentrant` |
| `cancel(id)` | Payee only |
| `getLink(id)`, `linksOf(payee)` | Read-only views |

- Events: `LinkCreated`, `Paid`, `LinkClosed`.
- Custom errors (`WrongAmount`, `Expired`, `Inactive`…) are cheap, and the UI decodes them.
- `receive()` reverts, because the contract never holds funds.
- Compiler: solc 0.8.26, optimizer on, EVM `paris`. The standard JSON input for source verification is in [`verify/`](verify/).

## Run it

```bash
npm install
npm test          # compiles with solc-js and runs 7 contract tests on a local chain
```

### Deploy

**From the browser (recommended; your key never leaves your wallet):** open `web/deploy.html`, connect a wallet holding ~1 USDC on Arc, and click **Deploy**. The page prints the address and the `config.js` to commit.

**From the command line:**

```bash
PRIVATE_KEY=0x... npm run deploy                  # Arc mainnet
NETWORK=testnet PRIVATE_KEY=0x... npm run deploy  # Arc testnet
```

The script checks the chainId and the balance, deploys, and writes `deployments/<network>.json` and `web/config.js`.

### Web app

`web/` is a static site with no build step. `ethers` and the QR library are bundled locally. It is served by GitHub Pages.

## Tested

- **7 contract tests:** exact payments forwarded to the payee with a zero contract balance, wrong amounts rejected, open links with many payments, payee-only cancel, expiry, memo cap, unknown ids, stray transfers refused.
- **End-to-end browser tests** on a local chain with chainId 5042:
  1. deploy from the wallet page;
  2. create a link, which shows a QR code;
  3. pay it from a second account;
  4. check that the link reads **Paid** and that "My links" totals are right.

  No console errors.

## Next

- PDF receipts.
- Split payouts (pay several recipients from one link).
- Webhooks so shops can confirm orders automatically.
- Payment links in local currency, with the USDC amount computed at payment time.

## License

MIT
