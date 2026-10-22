// SPDX-License-Identifier: MIT
import { DEFAULT_RELAY_TIMING, recordedDeployment, SEPOLIA_GAS_TABLE } from "../define.ts";
import type { ChainDefinition } from "../types.ts";

/**
 * Ethereum Sepolia (11155111): the PayPal edition's chain (ADR 0018, decision D-CHAIN of 2026-10-21). Every fact below
 * was read on chain through the registry's RPC on 2026-10-21 (block 11,958,755; docs/research/paypal/sepolia.md);
 * confidence C unless a note says otherwise.
 *
 * Disabled for every other edition, and offered by the PayPal edition only (it takes the chain explicitly, as the Mezo
 * edition takes Mezo testnet): `/`, `/monad/`, `/base/` and `/mezo/` do not change. No PayLinkV2 deployment is recorded
 * yet: the owner deploys the release at its CREATE2 address with the deploy kit, and until
 * `protocol/deployments/11155111.json` exists the chain reads "not deployed yet" and nothing can be signed or paid there.
 * No relayer serves it (D-SCOPE cut): payers pay their own Sepolia gas.
 */
export const ethereumSepolia: ChainDefinition = {
  chainId: 11155111,
  caip2: "eip155:11155111",
  key: "ethereum-sepolia",
  name: "Ethereum Sepolia",
  label: "ETH",
  testnet: true,
  local: false,
  status: "disabled",
  tier: "later",
  protocol: "v2",
  editions: ["paypal"],
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  // PublicNode's free endpoint: reachable from the build machine and the PayPal edition's only RPC (C). Other public
  // Sepolia RPCs could not be reached from the build machine, so none is listed as a fallback (UNVERIFIED).
  rpc: [{ url: "https://ethereum-sepolia-rpc.publicnode.com", confidence: "C" }],
  // "exceed maximum block range: 50000", read live. Some backends of the pool answer "pruned history unavailable" for
  // logs older than about 10,000 blocks (about 33 hours), so old logs read only some of the time (C, research note).
  rpcLimits: { maxLogBlockRange: 50_000 },
  // Etherscan's Sepolia explorer (the owner's faucet transfer was checked there, 2026-10-20); EIP-3091 layout (L).
  explorers: [{ name: "Etherscan", url: "https://sepolia.etherscan.io", confidence: "C" }],
  tokens: [
    {
      kind: "erc20",
      symbol: "USDC",
      name: "USDC (Circle)",
      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      decimals: 6,
      capabilities: { eip3009: true, eip2612: true, native: false },
      // name() "USDC", version() "2"; DOMAIN_SEPARATOR() equals the recomputation; no ERC-5267 eip712Domain().
      eip712Domain: { name: "USDC", version: "2" },
      listing: "default",
      confidence: "C",
      pendingVerification: [],
      note: "Circle FiatToken (ZeppelinOS proxy; receiveWithAuthorization and permit in its implementation). Test USDC from faucet.circle.com.",
    },
    {
      kind: "erc20",
      symbol: "PYUSD",
      name: "PayPal USD (Paxos)",
      address: "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9",
      decimals: 6,
      capabilities: { eip3009: true, eip2612: true, native: false },
      // name() "PayPal USD"; version() and eip712Domain() revert: version "1" is proven by DOMAIN_SEPARATOR() (the SDK
      // accepts it only that way, packages/sdk/src/token-domain.ts).
      eip712Domain: { name: "PayPal USD", version: "1" },
      listing: "listed",
      confidence: "C",
      pendingVerification: [],
      note: "Paxos PaxosTokenV2 behind an upgradeable proxy: Paxos can pause it and freeze any address, including PayLinkV2's. An already-used EIP-3009 nonce returns without a transfer (PayLinkV2 then reverts ReceivedMismatch).",
    },
  ],
  deniedTokens: [],
  contracts: {
    create2Deployer: {
      address: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
      confidence: "C",
      note: "Canonical runtime, checked live: PayLinkV2 deploys at 0x448e…5082 (rehearsed on an anvil fork).",
    },
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11", confidence: "C", note: "Code present, checked live." },
  },
  gasModel: { chargesGasLimit: false },
  // Measured on an anvil fork of Sepolia under its own rules (Amsterdam, EIP-8037 state gas), not Ethereum's schedule
  // before it: tools/deploy-page/scripts/sepolia-fork.ts --measure, both tokens then rehearsed within these bounds.
  gas: SEPOLIA_GAS_TABLE,
  relay: DEFAULT_RELAY_TIMING,
  deployment: recordedDeployment(11155111),
  v1: null,
  indexing: null,
  confidence: { chainId: "C", rpc: "C", explorers: "C" },
  notes: [
    "Gas is Sepolia ETH, paid by the payer: no relayer serves this chain (ADR 0018). eth_getLogs spans at most 50,000 blocks (C).",
    "Logs older than about 10,000 blocks may read as unavailable on the public RPC (C): retry, or read from the payment's receipt.",
    "PYUSD: test tokens from faucet.paxos.com or the Google Cloud Web3 faucet (U); Paxos can pause the token or freeze an address.",
  ],
};
