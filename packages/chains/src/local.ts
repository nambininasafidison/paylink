// SPDX-License-Identifier: MIT
/**
 * Local development chains (anvil) for tests, e2e and demo recording (spec §4.2). They may use
 * `http://127.0.0.1` RPCs and test tokens; the registry still validates every other rule.
 */
import { DEFAULT_RELAY_TIMING, SNAPSHOT_GAS_TABLE } from "./define.ts";
import type { ChainDefinition, Deployment, Edition, GasTable, RelayTiming, Token } from "./types.ts";

export interface LocalChainOptions {
  /** anvil's `--chain-id` (31337 by default; e2e also uses 10143, 84532 and 31611). */
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly tokens: readonly Token[];
  readonly deployment: Deployment | null;
  readonly name?: string;
  readonly editions?: readonly Edition[];
  readonly gas?: GasTable;
  /** Mimic Monad's gas-limit charging in client logic. */
  readonly chargesGasLimit?: boolean;
  /** Relay timing (default `DEFAULT_RELAY_TIMING`, as on the shipped v2 chains). */
  readonly relay?: RelayTiming;
}

export function defineLocalChain(options: LocalChainOptions): ChainDefinition {
  return {
    chainId: options.chainId,
    caip2: `eip155:${options.chainId}`,
    key: "local",
    name: options.name ?? `Local (anvil ${options.chainId})`,
    label: "LOCAL",
    testnet: true,
    local: true,
    status: "enabled",
    tier: null,
    protocol: "v2",
    editions: options.editions ?? ["all"],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpc: [{ url: options.rpcUrl, confidence: "C" }],
    rpcLimits: {},
    explorers: [],
    tokens: options.tokens,
    deniedTokens: [],
    contracts: {},
    gasModel: { chargesGasLimit: options.chargesGasLimit ?? false },
    gas: options.gas ?? SNAPSHOT_GAS_TABLE,
    relay: options.relay ?? DEFAULT_RELAY_TIMING,
    deployment: options.deployment,
    v1: null,
    indexing: null,
    confidence: { chainId: "C", rpc: "C", explorers: "C" },
    notes: ["Local anvil chain: test keys and mock tokens only."],
  };
}
