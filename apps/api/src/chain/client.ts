// SPDX-License-Identifier: MIT
/**
 * A read-only viem client for a registry chain, over the runtime's `fetch` (so tests and the Node entry can answer RPC
 * calls without a network) with the registry's RPC endpoints in order. Read-only by construction: a public client has no
 * account and cannot sign or send (invariant AI-1; no wallet client is imported anywhere in apps/api).
 *
 * Owner: reconciler workstream.
 */
import type { ChainDefinition } from "@paylink/chains";
import { toViemChain } from "@paylink/chains";
import { createPublicClient, fallback, http } from "viem";
import type { PublicClient } from "viem";
import type { ApiRuntime } from "../core/runtime.ts";

/** Per-request timeout and retries of a chain read (E: a Worker request should not wait on one RPC for long). */
export const RPC_TIMEOUT_MS = 8_000;
export const RPC_RETRIES = 1;

export function chainClient(runtime: Pick<ApiRuntime, "fetch">, chain: ChainDefinition, urls: readonly string[] = chain.rpc.map((r) => r.url)): PublicClient {
  const transports = urls.map((url) => http(url, { fetchFn: runtime.fetch, timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRIES, batch: false }));
  const [only] = transports;
  if (only === undefined) {
    throw new Error(`chain ${String(chain.chainId)} has no RPC endpoint in the registry`);
  }
  return createPublicClient({ chain: toViemChain(chain), transport: transports.length === 1 ? only : fallback(transports, { rank: false }), batch: { multicall: false } });
}
