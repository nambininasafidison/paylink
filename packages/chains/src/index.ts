// SPDX-License-Identifier: MIT
/**
 * `@paylink/chains`: the PayLink chain registry (PAYLINK-V2-SPEC §3.4, invoice spec §4.2).
 *
 * @packageDocumentation
 */
import { CHAIN_DEFINITIONS } from "./chains/index.ts";
import { createRegistry } from "./registry.ts";
import type { Registry } from "./registry.ts";

export { arbitrumSepolia, arc, baseSepolia, CHAIN_DEFINITIONS, mezoTestnet, monad, monadTestnet } from "./chains/index.ts";
export { DEFAULT_RELAY_TIMING, deploymentFromRecord, MONAD_GAS_TABLE, nativeToken, SNAPSHOT_GAS_TABLE } from "./define.ts";
export { explorerAddressUrl, explorerBlockUrl, explorerTxUrl } from "./explorers.ts";
export { DEPLOYMENT_RECORDS } from "./generated/deployments.ts";
export type { DeploymentRecord } from "./generated/deployments.ts";
export { EMULATED_GAS_LIMITS, GAS_MEASUREMENTS, GAS_SNAPSHOT_MEASUREMENTS, SNAPSHOT_GAS_LIMITS } from "./generated/gas.ts";
export { RELEASE } from "./generated/release.ts";
export { V1_CONFIG } from "./generated/v1.ts";
export { defineLocalChain } from "./local.ts";
export type { LocalChainOptions } from "./local.ts";
export { createRegistry, RegistryError, scopeToEdition, toChecksumAddress, UnknownChainError } from "./registry.ts";
export type { Registry, V2Target } from "./registry.ts";
export type * from "./types.ts";
export { rpcTransport, toViemChain } from "./viem.ts";
export type { RpcTransportOptions } from "./viem.ts";

/** The shipped registry: every chain of PAYLINK-V2-SPEC §3.4 used by the product, validated at load. */
export const registry: Registry = createRegistry(CHAIN_DEFINITIONS);
