// SPDX-License-Identifier: MIT
import { DEFAULT_RELAY_TIMING, nativeToken, recordedDeployment, SNAPSHOT_GAS_TABLE } from "../define.ts";
import type { ChainDefinition } from "../types.ts";

/**
 * Mezo testnet (31611): the Mezo edition, from Oct 16 after the go/no-go (PAYLINK-V2-SPEC §2.6, §3.4, §9).
 * Disabled until then. Confidence C, except the EVM level ("london", L): the paris artifact runs there
 * (protocol/test/toolchain/EvmTarget.t.sol). MUSD supports EIP-2612 only, so MUSD payments use
 * `payWithPermit` (the payer pays BTC gas) or approve + pay.
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
  rpcLimits: {},
  explorers: [{ name: "Mezo Explorer", url: "https://explorer.test.mezo.org", confidence: "C" }],
  tokens: [
    {
      kind: "erc20",
      symbol: "MUSD",
      name: "MUSD (Mezo)",
      address: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
      decimals: 18,
      capabilities: { eip3009: false, eip2612: true, native: false },
      eip712Domain: null,
      listing: "default",
      confidence: "C",
      pendingVerification: [],
      note: "EIP-2612 only, no EIP-3009. Test MUSD cannot come from a faucet: it is borrowed (at least 2,000 MUSD).",
    },
    nativeToken({ symbol: "BTC", name: "Bitcoin (native)", decimals: 18, listing: "listed", confidence: "C" }),
  ],
  deniedTokens: [],
  contracts: {
    btcErc20: {
      address: "0x7b7C000000000000000000000000000000000000",
      confidence: "L",
      note: "BTC ERC-20 precompile; not on the token allowlist (L).",
    },
  },
  gasModel: { chargesGasLimit: false },
  gas: SNAPSHOT_GAS_TABLE,
  relay: DEFAULT_RELAY_TIMING,
  deployment: recordedDeployment(31611),
  v1: null,
  indexing: null,
  confidence: { chainId: "C", rpc: "C", explorers: "C" },
  notes: [
    "EVM level reported as london (L): the paris artifact contains no PUSH0, MCOPY or transient-storage opcodes.",
    "Gas is paid in test BTC from faucet.test.mezo.org (captcha).",
    "Mezo mainnet is 31612 (MUSD at a different address); not in this registry.",
  ],
};
