// SPDX-License-Identifier: MIT
import { DEFAULT_RELAY_TIMING, recordedDeployment, SNAPSHOT_GAS_TABLE } from "../define.ts";
import type { ChainDefinition } from "../types.ts";

/** Base Sepolia (84532): the Colosseum edition, tier T0 (PAYLINK-V2-SPEC §2.2, §3.4). Confidence C throughout. */
export const baseSepolia: ChainDefinition = {
  chainId: 84532,
  caip2: "eip155:84532",
  key: "base-sepolia",
  name: "Base Sepolia",
  label: "BASE",
  testnet: true,
  local: false,
  status: "enabled",
  tier: "T0",
  protocol: "v2",
  editions: ["all", "base"],
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpc: [{ url: "https://sepolia.base.org", confidence: "C" }],
  rpcLimits: {},
  explorers: [
    { name: "Basescan", url: "https://sepolia.basescan.org", confidence: "C" },
    { name: "Blockscout", url: "https://base-sepolia.blockscout.com", confidence: "C" },
  ],
  tokens: [
    {
      kind: "erc20",
      symbol: "USDC",
      name: "USDC (Circle)",
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      capabilities: { eip3009: true, eip2612: true, native: false },
      eip712Domain: null,
      listing: "default",
      confidence: "C",
      pendingVerification: [],
      note: "Circle FiatTokenV2_2. Not the ...dCF7c address printed in Base's docs, which fails the EIP-55 check.",
    },
  ],
  deniedTokens: [],
  contracts: {},
  gasModel: { chargesGasLimit: false },
  gas: SNAPSHOT_GAS_TABLE,
  relay: DEFAULT_RELAY_TIMING,
  deployment: recordedDeployment(84532),
  v1: null,
  indexing: null,
  confidence: { chainId: "C", rpc: "C", explorers: "C" },
  notes: ["Gas is paid in Sepolia ETH from faucets (spec §6.2)."],
};
