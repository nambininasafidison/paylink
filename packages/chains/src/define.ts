// SPDX-License-Identifier: MIT
/** Building blocks shared by the chain definitions in `src/chains/`. */
import { zeroAddress } from "viem";
import { DEPLOYMENT_STATUS } from "./deployment-status.ts";
import type { DeploymentRecord } from "./generated/deployments.ts";
import { DEPLOYMENT_RECORDS } from "./generated/deployments.ts";
import { EMULATED_GAS_LIMITS, FORK_GAS_LIMITS, GAS_PROFILE_PROVENANCE, SNAPSHOT_GAS_LIMITS } from "./generated/gas.ts";
import type { Deployment, DeploymentStatus, GasTable, NativeToken, RelayTiming, TokenListing } from "./types.ts";

/**
 * Gas table of the v2 chains with Ethereum gas prices (Base, Arbitrum): the Foundry snapshot, checked against
 * eth_estimateGas on anvil's Ethereum, Base and London profiles. Provisional until re-measured on the chain.
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
  evidence: `anvil --network monad (hardfork ${GAS_PROFILE_PROVENANCE.monad.hardfork}), mock tokens: packages/chains/data/gas-measurements.json`,
  limits: EMULATED_GAS_LIMITS.monad,
};

/**
 * Gas table of Mezo testnet: eth_estimateGas on an anvil fork of Mezo testnet (ADR 0017), with MUSD and native BTC as
 * the chain holds them, the canonical CREATE2 factory, and the repository's mocks only where Mezo has nothing to measure
 * (an EIP-3009 token, an ERC-1271 payee). anvil prices gas like Ethereum (L for mezod, whose estimate of the CREATE2
 * deployment equals the fork's). Mezo charges at least half of the limit, which these bounds keep below the gas used.
 */
export const MEZO_GAS_TABLE: GasTable = {
  source: "fork",
  provisional: true,
  evidence: `anvil fork of Mezo testnet at block ${String(GAS_PROFILE_PROVENANCE.mezo.forkBlock)} (hardfork ${GAS_PROFILE_PROVENANCE.mezo.hardfork}), MUSD and native BTC: packages/chains/data/fork-gas-measurements.json`,
  limits: FORK_GAS_LIMITS.mezo,
};

/**
 * Gas table of Ethereum Sepolia: eth_estimateGas on an anvil fork of the chain under its own rules (hardfork Amsterdam,
 * whose state-creation gas, EIP-8037, prices every new storage slot near 98,000 gas and the PayLinkV2 deployment near
 * 19.2 million), with Circle USDC and native Sepolia ETH as the chain holds them and the repository's Wallet1271 for an
 * ERC-1271 payee (tools/deploy-page/scripts/sepolia-fork.ts --measure). Ethereum's own schedule before Amsterdam (the
 * snapshot) priced a first payment at about a third of what Sepolia now charges, so its ceilings would refuse every
 * payment and cancellation there.
 */
export const SEPOLIA_GAS_TABLE: GasTable = {
  source: "fork",
  provisional: true,
  evidence: `anvil fork of Ethereum Sepolia at block ${String(GAS_PROFILE_PROVENANCE.sepolia.forkBlock)} (hardfork ${GAS_PROFILE_PROVENANCE.sepolia.hardfork}), Circle USDC and native ETH: packages/chains/data/fork-gas-measurements.json`,
  limits: FORK_GAS_LIMITS.sepolia,
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
