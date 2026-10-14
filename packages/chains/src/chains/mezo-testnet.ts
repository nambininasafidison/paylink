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
  // "maximum [from, to] blocks distance: 10000", read live. Lookups by hash answer null for mined transactions about
  // one time in two (C, research §2): a null is "ask again" (txLookupRetryMs).
  rpcLimits: { maxLogBlockRange: 10_000, inconsistentTxIndex: true },
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
      note: "EIP-2612 with ECDSA permits only, no EIP-3009, no fee or hook, not upgradeable; its owner can let any address burn MUSD (issuer risk). Borrowed against test BTC (at least 2,000 MUSD of debt), never from a faucet.",
    },
    // The gas coin, paid with payNative (run on an anvil fork; L against mezod itself).
    nativeToken({ symbol: "BTC", name: "Bitcoin (native)", decimals: 18, listing: "listed", confidence: "C" }),
  ],
  deniedTokens: [],
  contracts: {
    create2Deployer: {
      address: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
      confidence: "C",
      note: "Canonical runtime, checked live: PayLinkV2 deploys at 0x448e…5082.",
    },
    btcErc20: {
      address: "0x7b7C000000000000000000000000000000000000",
      confidence: "L",
      note: "BTC ERC-20 precompile; not on the token allowlist (L).",
    },
    // MUSD's BorrowerOperations (proxy), mezo-org/musd matsnet artifact at aa25fd6; on chain its musd() is MUSD, and it
    // names its PriceFeed and TroveManager. Read only, never sent to: the Mezo edition's borrow estimate
    // (apps/web/src/editions/mezo/borrow.ts). No `note`: every edition bundles the registry, and none shows it.
    musdBorrowerOperations: { address: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5", confidence: "C" },
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
    "Gas is test BTC at about 130 to 300 wei; at least 50 % of the gas limit is charged (C): send clamp(estimate x 1.10, floor, ceiling).",
    "Cancun opcodes run (C), not London as Mezo's docs say; the paris artifact runs either way. eth_getLogs spans at most 10,000 blocks (C).",
    "No gasless MUSD payment with PayLinkV2: MUSD has no EIP-3009 (ADR 0017). Test BTC: faucet.test.mezo.org; test MUSD is borrowed against it.",
  ],
};
