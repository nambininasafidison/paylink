// SPDX-License-Identifier: MIT
import { DEFAULT_RELAY_TIMING, MEZO_GAS_TABLE, nativeToken, recordedDeployment } from "../define.ts";
import type { ChainDefinition } from "../types.ts";

/**
 * Mezo testnet (31611, "matsnet"): the Mezo edition (PAYLINK-V2-SPEC §9, ADR 0017). Facts from
 * docs/research/mezo.md, re-read on chain on 2026-10-13; confidence C unless a note says otherwise.
 *
 * Disabled until the Mezo edition goes live (ADR 0017): the deploy kit already targets it, because the deployment
 * has to exist first. MUSD supports EIP-2612 only, so MUSD payments use `payWithPermit` (the payer pays BTC gas) or
 * approve + pay; with PayLinkV2 no relayer can make them gasless (ADR 0017).
 */
export const mezoTestnet: ChainDefinition = {
  chainId: 31611,
  caip2: "eip155:31611",
  key: "mezo-testnet",
  name: "Mezo testnet",
  label: "MEZO",
  testnet: true,
  local: false,
  status: "disabled",
  tier: "later",
  protocol: "v2",
  editions: ["all", "mezo"],
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpc: [{ url: "https://rpc.test.mezo.org", confidence: "C" }],
  // "maximum [from, to] blocks distance: 10000", read live.
  rpcLimits: { maxLogBlockRange: 10_000 },
  // Mezo's Blockscout explorer: /address/ links are in Mezo's docs (C); /tx/ and /block/ follow Blockscout's EIP-3091
  // layout (L). The explorer could not be reached from the build machine.
  explorers: [{ name: "Mezo Explorer", url: "https://explorer.test.mezo.org", confidence: "C" }],
  tokens: [
    {
      kind: "erc20",
      symbol: "MUSD",
      name: "MUSD (Mezo)",
      address: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
      decimals: 18,
      capabilities: { eip3009: false, eip2612: true, native: false },
      // ERC-5267 eip712Domain() on chain; DOMAIN_SEPARATOR() matches the recomputation.
      eip712Domain: { name: "Mezo USD", version: "1" },
      listing: "default",
      confidence: "C",
      pendingVerification: [],
      note: "Mezo's Bitcoin-backed dollar. OpenZeppelin ERC20Permit: ECDSA permits only (smart accounts approve), no EIP-3009, no fee, hook, pause or blocklist, not upgradeable. Its owner can let any address burn MUSD from any account (issuer risk). Test MUSD is borrowed against test BTC (at least 2,000 MUSD of debt), not dispensed by a faucet.",
    },
    nativeToken({ symbol: "BTC", name: "Bitcoin (native)", decimals: 18, listing: "listed", confidence: "C", note: "The gas coin, paid with payNative (run on an anvil fork; L against mezod itself)." }),
  ],
  deniedTokens: [],
  contracts: {
    create2Deployer: {
      address: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
      confidence: "C",
      note: "The canonical deterministic-deployment proxy runtime (keccak 0x2fa8…4989, as on Base Sepolia and Monad testnet): PayLinkV2 deploys at the release address 0x448e…5082.",
    },
    btcErc20: {
      address: "0x7b7C000000000000000000000000000000000000",
      confidence: "L",
      note: "BTC ERC-20 precompile; not on the token allowlist (L).",
    },
  },
  // Mezo charges max(gas used, 50 % of the limit): mezod MinGasMultiplier 0.5, seen on a live transaction.
  gasModel: { chargesGasLimit: false, minChargedPercentOfLimit: 50 },
  // Measured on an anvil fork of Mezo testnet with MUSD (tools/deploy-page/scripts/mezo-fork.ts).
  gas: MEZO_GAS_TABLE,
  relay: DEFAULT_RELAY_TIMING,
  deployment: recordedDeployment(31611),
  v1: null,
  indexing: null,
  confidence: { chainId: "C", rpc: "C", explorers: "C" },
  notes: [
    "Gas is test BTC (18 decimals) at about 130 to 300 wei per gas; blocks every 4.5 to 4.9 s (C).",
    "Mezo charges max(gas used, 50 % of the gas limit) (C): send clamp(estimate x 1.10, floor, ceiling), never a wallet default.",
    "The chain runs Cancun opcodes (C, live probes) although Mezo's docs say london; the paris artifact runs either way.",
    "eth_getLogs spans at most 10,000 blocks per request (C).",
    "MUSD payments cannot be gasless with PayLinkV2: MUSD has no EIP-3009, and payWithPermit and pay pay from msg.sender (ADR 0017).",
    "Test BTC from faucet.test.mezo.org (captcha); test MUSD is borrowed against it at testnet.mezo.org (docs/runbooks/faucets.md).",
    "Mezo mainnet is 31612 (MUSD at a different address); not in this registry.",
  ],
};
