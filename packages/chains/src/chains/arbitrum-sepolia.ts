// SPDX-License-Identifier: MIT
import { DEFAULT_RELAY_TIMING, recordedDeployment, SNAPSHOT_GAS_TABLE } from "../define.ts";
import type { ChainDefinition } from "../types.ts";

/**
 * Arbitrum Sepolia (421614): optional chain of the Colosseum edition, tier T1 if Sepolia ETH reaches the
 * deployer (PAYLINK-V2-SPEC §2.2, §3.4). Confidence C. The spec states USDC's decimals but not its
 * capabilities, so EIP-3009 and EIP-2612 stay off (payers use approve + pay) until fork-nightly confirms them.
 */
export const arbitrumSepolia: ChainDefinition = {
  chainId: 421614,
  caip2: "eip155:421614",
  key: "arbitrum-sepolia",
  name: "Arbitrum Sepolia",
  label: "ARB",
  testnet: true,
  local: false,
  status: "enabled",
  tier: "T1",
  protocol: "v2",
  editions: ["all", "base"],
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpc: [{ url: "https://sepolia-rollup.arbitrum.io/rpc", confidence: "C" }],
  rpcLimits: {},
  explorers: [
    { name: "Arbiscan", url: "https://sepolia.arbiscan.io", confidence: "C" },
    { name: "Blockscout", url: "https://arbitrum-sepolia.blockscout.com", confidence: "C" },
  ],
  tokens: [
    {
      kind: "erc20",
      symbol: "USDC",
      name: "USDC (Circle)",
      address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      decimals: 6,
      capabilities: { eip3009: false, eip2612: false, native: false },
      eip712Domain: null,
      listing: "default",
      confidence: "C",
      pendingVerification: [],
      note: "Capabilities not stated in spec §3.4: approve + pay only until fork-nightly confirms EIP-3009/EIP-2612.",
    },
  ],
  deniedTokens: [],
  contracts: {},
  gasModel: { chargesGasLimit: false },
  gas: SNAPSHOT_GAS_TABLE,
  relay: DEFAULT_RELAY_TIMING,
  deployment: recordedDeployment(421614),
  v1: null,
  indexing: null,
  confidence: { chainId: "C", rpc: "C", explorers: "C" },
  notes: [
    "Same PayLinkV2 artifact as Base; added only if Sepolia ETH reaches the deployer by Oct 9 (spec §2.2).",
    "Arbitrum's eth_estimateGas includes the L1 posting cost in L2 gas units (L): the snapshot ceilings cover execution only, so re-measure before relaying there.",
  ],
};
