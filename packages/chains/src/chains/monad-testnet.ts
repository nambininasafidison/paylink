// SPDX-License-Identifier: MIT
import { DEFAULT_RELAY_TIMING, MONAD_GAS_TABLE, recordedDeployment } from "../define.ts";
import type { ChainDefinition } from "../types.ts";

/**
 * Monad testnet (10143): the Monad Metropolis edition, tier T0 (PAYLINK-V2-SPEC §2.1, §3.4).
 * Confidence: chainId C; RPC L; explorers C; AUSD C; USDC C; helpers L.
 */
export const monadTestnet: ChainDefinition = {
  chainId: 10143,
  caip2: "eip155:10143",
  key: "monad-testnet",
  name: "Monad testnet",
  label: "MONAD",
  testnet: true,
  local: false,
  status: "enabled",
  tier: "T0",
  protocol: "v2",
  editions: ["all", "monad"],
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpc: [
    { url: "https://testnet-rpc.monad.xyz", rateLimitRps: 50, confidence: "L" },
    { url: "https://rpc-testnet.monadinfra.com", rateLimitRps: 20, confidence: "L" },
  ],
  rpcLimits: { maxLogBlockRange: 100 },
  explorers: [
    { name: "MonadVision", url: "https://testnet.monadvision.com", confidence: "C" },
    { name: "Monadscan", url: "https://testnet.monadscan.com", confidence: "C" },
  ],
  tokens: [
    {
      kind: "erc20",
      symbol: "AUSD",
      name: "AUSD (Agora)",
      address: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
      decimals: 6,
      capabilities: { eip3009: true, eip2612: true, native: false },
      eip712Domain: null,
      listing: "default",
      confidence: "C",
      pendingVerification: [],
      note: "Default token of the Monad edition. The EIP-712 domain is read from the chain (not stated in the spec).",
    },
    {
      kind: "erc20",
      symbol: "USDC",
      name: "USDC (Circle)",
      address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      decimals: 6,
      capabilities: { eip3009: true, eip2612: false, native: false },
      eip712Domain: { name: "USDC", version: "2" },
      listing: "hidden",
      confidence: "C",
      pendingVerification: [],
      note: "Circle USDC, hidden in the demo. The spec lists EIP-3009 only; EIP-2612 stays off until fork-nightly confirms it.",
    },
  ],
  deniedTokens: [
    {
      address: "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea",
      reason: "Not Circle's USDC: never use (PAYLINK-V2-SPEC §3.4).",
      confidence: "C",
    },
  ],
  contracts: {
    ausdFaucet: {
      address: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
      confidence: "C",
      note:
        "AUSD faucet proxy, requestFunds(address): 10,000 AUSD per drip; relayer onboarding only. Checked from the sandbox on 2026-10-07: " +
        "an OZ transparent proxy whose implementation exposes requestFunds(address) (0x544c7cf9) and token() = AUSD; on an anvil fork the " +
        "60 s cooldown is global (any second request within 60 s reverts with error 0x20e5bc67, whoever sends it and whoever it funds).",
      // eth_estimateGas on an anvil 1.8.5 fork of Monad testnet (network monad, MonadTen): 129,791 for a first-time recipient,
      // 112,521 for a repeat one (gasUsed 128,414). Same rule as the entry points: floor = max rounded up to 1,000, ceiling = 1.5 x floor.
      gas: { floor: 130_000n, ceiling: 195_000n },
    },
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11", confidence: "L" },
    permit2: { address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", confidence: "L", note: "Not used before Oct 12 (spec §2.7)." },
    agoraInstantSettlement: {
      address: "0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae",
      confidence: "L",
      note: "Agora Instant Settlement AUSD/CTK, tier T2.",
    },
    agoraWhitelister: { address: "0x7c10F56d6f04a51376393a1C3670e966863F6BD5", confidence: "L", note: "Tier T2." },
  },
  gasModel: { chargesGasLimit: true, txGasCap: 30_000_000n, reserveBalance: 10n * 10n ** 18n },
  gas: MONAD_GAS_TABLE,
  relay: DEFAULT_RELAY_TIMING,
  deployment: recordedDeployment(10143),
  v1: null,
  indexing: { hypersync: ["https://monad-testnet.hypersync.xyz", "https://10143.hypersync.xyz"], confidence: "L" },
  confidence: { chainId: "C", rpc: "L", explorers: "C" },
  notes: [
    "Monad charges the gas limit, not the gas used (C): send clamp(estimate x 1.10, floor, ceiling).",
    "An EOA must keep a 10 MON reserve balance (C); the relayer never sends value.",
    "Public RPC eth_getLogs is capped at 100 blocks (L); the per-transaction gas cap is 30M (L).",
    "Cold SLOAD/SSTORE cost 8,100 gas and cold account access 10,100 (L): gas bounds come from anvil's Monad emulation (MonadTen) and must be re-measured on testnet with AUSD.",
  ],
};
