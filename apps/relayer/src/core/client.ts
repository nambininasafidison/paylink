// SPDX-License-Identifier: MIT
/** The viem client a ChainSender reads and broadcasts through: the registry's RPC endpoints, in order, with fallback. */
import type { ChainDefinition } from "@paylink/chains";
import { rpcTransport, toViemChain } from "@paylink/chains";
import { createPublicClient } from "viem";
import type { PublicClient, Transport } from "viem";

/**
 * Timeouts and retries are tight on purpose: every RPC call is a subrequest of a Worker invocation (bounded per
 * invocation), and a slow endpoint should fail over to the next one rather than hold the chain's send section.
 */
export const RPC_TIMEOUT_MS = 8_000;
export const RPC_RETRY_COUNT = 1;

export function chainClient(chain: ChainDefinition, transport?: Transport): PublicClient {
  return createPublicClient({
    chain: toViemChain(chain),
    transport: transport ?? rpcTransport(chain, { timeoutMs: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }),
    // Never batch through multicall: every read must hit the block tag it names.
    batch: { multicall: false },
    cacheTime: 0,
  });
}
