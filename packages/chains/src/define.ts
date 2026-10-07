// SPDX-License-Identifier: MIT
/** Building blocks shared by the chain definitions in `src/chains/`. */
import { zeroAddress } from "viem";
import { DEPLOYMENT_STATUS } from "./deployment-status.ts";
import type { DeploymentRecord } from "./generated/deployments.ts";
import { DEPLOYMENT_RECORDS } from "./generated/deployments.ts";
import { EMULATED_GAS_LIMITS, GAS_MEASUREMENTS, SNAPSHOT_GAS_LIMITS } from "./generated/gas.ts";
import type { Deployment, DeploymentStatus, GasTable, NativeToken, RelayTiming, TokenListing } from "./types.ts";

/**
 * Gas table of the v2 chains with Ethereum gas prices (Base, Arbitrum, Mezo): the Foundry snapshot, checked
 * against eth_estimateGas on anvil's Ethereum, Base and London profiles. Provisional until re-measured on the chain.
 */
export const SNAPSHOT_GAS_TABLE: GasTable = {
  source: "snapshot",
  provisional: true,
  evidence: "protocol/snapshots/PayLinkV2.json (forge, mock tokens), covered by anvil estimates (packages/chains/data/gas-measurements.json)",
  limits: SNAPSHOT_GAS_LIMITS,
};

/**
 * Gas table of Monad: eth_estimateGas on anvil's Monad emulation (hardfork MonadTen), because Monad prices cold
 * state and ecrecover differently and charges the gas limit. Provisional (L) until re-measured on Monad testnet.
 */
export const MONAD_GAS_TABLE: GasTable = {
  source: "emulated",
  provisional: true,
  evidence: `anvil --network monad (hardfork ${GAS_MEASUREMENTS.monad.hardfork}), mock tokens: packages/chains/data/gas-measurements.json`,
  limits: EMULATED_GAS_LIMITS.monad,
};

/**
 * Relay timing of the v2 chains until inclusion latency is measured on each (invoice spec §13.3, audit finding
 * A-04): 120 s, four times the relayer's 30 s stuck-transaction replacement interval (PAYLINK-V2-SPEC §3.7). That
 * covers the pre-broadcast re-simulation, the broadcast and up to three fee-bump replacements on chains whose
 * blocks take seconds or less, and leaves 480 s of the recommended 600 s authorization window (invoice spec §8.3)
 * for the request to reach the relayer.
 */
export const DEFAULT_RELAY_TIMING: RelayTiming = {
  minRemainingSeconds: 120,
  provisional: true,
  basis: "4 x the relayer's 30 s stuck-transaction replacement interval (PAYLINK-V2-SPEC §3.7): re-simulation, broadcast and up to three fee bumps; re-measure on the chain",
};

/** Turns a generated deployment record into a registry deployment with its lifecycle status (default `active`). */
export function deploymentFromRecord(
  record: DeploymentRecord | undefined,
  status: DeploymentStatus | undefined,
): Deployment | null {
  if (record === undefined) {
    return null;
  }
  return {
    address: record.address,
    status: status ?? "active",
    release: record.release,
    method: record.method,
    deployer: record.deployer,
    txHash: record.txHash,
    blockNumber: record.blockNumber,
    initCodeHash: record.initCodeHash,
    maskedRuntimeHash: record.maskedRuntimeHash,
    runtimeCodeHash: record.runtimeCodeHash,
  };
}

/** The recorded canonical deployment of `chainId`, or `null` when none is recorded yet. */
export function recordedDeployment(chainId: number): Deployment | null {
  return deploymentFromRecord(DEPLOYMENT_RECORDS[chainId], DEPLOYMENT_STATUS[chainId]);
}

/** A native-coin token entry (`Invoice.token = address(0)`, paid through `payNative`). */
export function nativeToken(fields: {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly listing: TokenListing;
  readonly confidence: NativeToken["confidence"];
  readonly note?: string;
}): NativeToken {
  return {
    kind: "native",
    address: zeroAddress,
    capabilities: { eip3009: false, eip2612: false, native: true },
    pendingVerification: [],
    ...fields,
  };
}
