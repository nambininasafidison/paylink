// SPDX-License-Identifier: MIT
/**
 * Builds the chain reader for Ethereum Sepolia from the registry (`@paylink/chains`, RPC and deployment), read-only.
 *
 * Owner: reconciler workstream. Scaffold: reads answer 501 `not-implemented`; `deployed` already follows the registry.
 */
import { registry } from "@paylink/chains";
import { pendingMethod } from "../core/not-implemented.ts";
import type { FactoryDeps } from "../core/runtime.ts";
import type { ChainReader } from "./types.ts";

export function createChainReader(deps: FactoryDeps): ChainReader {
  const chainId = deps.runtime.config.chainId;
  const pending = pendingMethod("chain reads");
  return {
    chainId,
    deployed: registry.v2Target(chainId) !== undefined,
    observe: pending,
    observeMany: pending,
  };
}
