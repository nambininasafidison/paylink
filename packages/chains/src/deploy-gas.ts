// SPDX-License-Identifier: MIT
/**
 * Deployment gas of PayLinkV2 per chain (PAYLINK-V2-SPEC §3.3.6, §3.3.7), for the deploy page and any other
 * deployer that must set a gas limit itself. Monad charges the gas **limit**, so a wallet default is not good enough.
 */
import { DEPLOY_GAS, GAS_MEASUREMENTS } from "./generated/gas.ts";
import type { DeployGasTable } from "./types.ts";

type ProfileName = keyof typeof DEPLOY_GAS;

/**
 * The deployment gas table of `chainId`: the anvil profile whose `appliesTo` lists the chain, or `null` when no
 * profile measures it (v1-only chains, local chains, unknown chains). Every v2 chain of the registry has exactly one.
 */
export function deployGasFor(chainId: number): DeployGasTable | null {
  for (const name of Object.keys(DEPLOY_GAS) as ProfileName[]) {
    const deploy = DEPLOY_GAS[name];
    if ((deploy.appliesTo as readonly number[]).includes(chainId)) {
      const measured = GAS_MEASUREMENTS[name];
      return {
        profile: name,
        hardfork: measured.hardfork,
        network: measured.network,
        provisional: true,
        evidence: `anvil profile "${name}" (hardfork ${measured.hardfork}, network ${measured.network}): packages/chains/data/gas-measurements.json`,
        create: deploy.create,
        create2: deploy.create2,
      };
    }
  }
  return null;
}
