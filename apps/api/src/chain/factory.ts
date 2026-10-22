// SPDX-License-Identifier: MIT
/**
 * Builds the chain reader for the edition's chain (Ethereum Sepolia, decision D-CHAIN) from the runtime's registry (the
 * shipped `@paylink/chains` one in the Worker: RPC, Multicall3, PayLinkV2's recorded deployment), read-only, over the
 * runtime's `fetch`. Until
 * `protocol/deployments/11155111.json` is recorded, `deployed` is false and every read answers `not-deployed` without a
 * request.
 *
 * Owner: reconciler workstream.
 */
import type { FactoryDeps } from "../core/runtime.ts";
import { chainClient } from "./client.ts";
import { createReader } from "./reader.ts";
import type { ReaderClient } from "./reader.ts";
import type { ChainReader } from "./types.ts";

export function createChainReader(deps: FactoryDeps): ChainReader {
  const chainId = deps.runtime.config.chainId;
  const { registry } = deps.runtime;
  const chain = registry.get(chainId);
  if (chain === undefined) {
    throw new Error(`chain ${String(chainId)} is not in the registry`);
  }
  // The client is created on the first read only: a deployment that never reads the chain makes no RPC client.
  let client: ReaderClient | null = null;
  const lazy: ReaderClient = {
    call: async (parameters) => {
      client ??= chainClient(deps.runtime, chain);
      return await client.call(parameters);
    },
    request: async (parameters) => {
      client ??= chainClient(deps.runtime, chain);
      return await client.request(parameters);
    },
  };
  return createReader({ registry, chainId, client: lazy });
}
