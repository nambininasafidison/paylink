// SPDX-License-Identifier: MIT
import { DEFAULT_RELAY_TIMING, MONAD_GAS_TABLE, recordedDeployment } from "../define.ts";
import type { ChainDefinition } from "../types.ts";

/**
 * Monad mainnet (143): ready but disabled, tier T2 (PAYLINK-V2-SPEC §2.1, §3.4, §6.6). Registry only:
 * the spec gives the token addresses (C) but no RPC, explorer, decimals or capabilities for this chain.
 * Decimals are assumed equal to the issuers' testnet deployments and must be confirmed on chain before the
 * chain is enabled (`createRegistry` refuses an enabled chain with pending verifications).
 */
export const monad: ChainDefinition = {
  chainId: 143,
  caip2: "eip155:143",
  key: "monad",
  name: "Monad mainnet",
  label: "MONAD",
  testnet: false,
  local: false,
  status: "disabled",
  tier: "T2",
  protocol: "v2",
  editions: ["all", "monad"],
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpc: [],
  rpcLimits: {},
  explorers: [],
  tokens: [
    {
      kind: "erc20",
      symbol: "AUSD",
      name: "AUSD (Agora)",
      address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
      decimals: 6,
      capabilities: { eip3009: false, eip2612: false, native: false },
      eip712Domain: null,
      listing: "default",
      confidence: "C",
      pendingVerification: ["decimals", "capabilities", "eip712Domain"],
    },
    {
      kind: "erc20",
      symbol: "USDC",
      name: "USDC (Circle)",
      address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      decimals: 6,
      capabilities: { eip3009: false, eip2612: false, native: false },
      eip712Domain: null,
      listing: "hidden",
      confidence: "C",
      pendingVerification: ["decimals", "capabilities", "eip712Domain"],
    },
  ],
  deniedTokens: [],
  contracts: {},
  gasModel: { chargesGasLimit: true, reserveBalance: 10n * 10n ** 18n },
  gas: MONAD_GAS_TABLE,
  relay: DEFAULT_RELAY_TIMING,
  deployment: recordedDeployment(143),
  v1: null,
  indexing: null,
  confidence: { chainId: "UV", rpc: "U", explorers: "U" },
  notes: [
    "Deployed only on demand (spec §6.6): about 0.3-0.5 MON for the deployment.",
    "Monad charges the gas limit, not the gas used (C); an EOA must keep a 10 MON reserve balance (C).",
  ],
};
