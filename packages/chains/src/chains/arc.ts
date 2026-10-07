// SPDX-License-Identifier: MIT
import { nativeToken } from "../define.ts";
import { V1_CONFIG } from "../generated/v1.ts";
import type { ChainDefinition } from "../types.ts";

/**
 * Arc mainnet (5042): PayLink **v1** only, the Arc Microgrants entry (PAYLINK-V2-SPEC §2.3, ADR 0010).
 * There is no v2 deployment, so the SDK refuses v2 links on this chain. The v1 facts (RPC, explorer and
 * contract address) are generated from the frozen `web/config.js`. Confidence C (spec §3.4); the explorer
 * comes from the v1 config only (U).
 */
export const arc: ChainDefinition = {
  chainId: V1_CONFIG.chainId,
  caip2: "eip155:5042",
  key: "arc",
  name: "Arc mainnet",
  label: "ARC",
  testnet: false,
  local: false,
  status: "enabled",
  tier: null,
  protocol: "v1",
  editions: [],
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpc: [{ url: V1_CONFIG.rpc, confidence: "C" }],
  rpcLimits: {},
  explorers: [],
  tokens: [
    nativeToken({
      symbol: "USDC",
      name: "USDC (native)",
      decimals: 18,
      listing: "default",
      confidence: "C",
      note: "Native USDC with 18 decimals, paid as msg.value. v1 uses native value only.",
    }),
    {
      kind: "erc20",
      symbol: "USDC",
      name: "USDC (ERC-20 interface)",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
      capabilities: { eip3009: true, eip2612: false, native: false },
      eip712Domain: { name: "USDC", version: "2" },
      listing: "hidden",
      confidence: "C",
      pendingVerification: [],
      note: "ERC-20 view of the same native USDC balance, with 6 decimals: never add amounts across the two representations.",
    },
  ],
  deniedTokens: [],
  contracts: {
    create2Deployer: { address: "0x4e59b44847b379578588920cA78FbF26c0B4956C", confidence: "C" },
  },
  gasModel: { chargesGasLimit: false },
  gas: null,
  relay: null,
  deployment: null,
  v1: {
    address: V1_CONFIG.address,
    rpc: V1_CONFIG.rpc,
    explorer: V1_CONFIG.explorer,
    app: "https://nambininasafidison.github.io/paylink/web/",
    tag: "arc-microgrants-v1",
  },
  indexing: null,
  confidence: { chainId: "C", rpc: "C", explorers: "U" },
  notes: [
    "Gas is paid in native USDC. The v1 deployment is estimated at 920,964 gas (spec §2.3).",
    "Multicall3, Permit2 and the CREATE2 deployer exist on Arc mainnet (C).",
  ],
};
