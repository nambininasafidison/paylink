// SPDX-License-Identifier: MIT
/**
 * Where a tester gets test BTC and test MUSD on Mezo testnet: Mezo's own pages only (docs/research/mezo.md §8).
 *
 * - Faucet: Mezo's developer guide and x402 quickstart; `@x402/paywall` 2.28.0 maps `eip155:31611` to it. A captcha
 *   guards it; its drip and cooldown are UNVERIFIED (the page cannot be reached from the build machine).
 * - Discord: Mezo's docs, `#testnet` channel.
 * - Borrow: test MUSD has no faucet, it is borrowed against test BTC at https://testnet.mezo.org/feature/borrow. Mezo's
 *   user guide "How to Borrow & Mint MUSD" (mezo-org/documentation 8713c16a, `mint-musd.mdx` lines 32 and 47) calls that
 *   the testnet page and https://mezo.org/feature/borrow the Mainnet one, where real BTC backs real MUSD: never linked.
 */
export const MEZO_LINKS = {
  faucet: "https://faucet.test.mezo.org",
  discord: "https://discord.com/invite/mezo",
  borrow: "https://testnet.mezo.org/feature/borrow",
} as const;
