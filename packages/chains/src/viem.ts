// SPDX-License-Identifier: MIT
/** Adapters from registry chains to viem chains and transports. */
import { defineChain, fallback, http } from "viem";
import type { Chain, FallbackTransport, HttpTransport } from "viem";
import type { ChainDefinition } from "./types.ts";

/** A viem `Chain` built from the registry entry (the registry, not viem's built-in chain list, is authoritative). */
export function toViemChain(chain: ChainDefinition): Chain {
  const [first, ...rest] = chain.rpc;
  if (first === undefined) {
    throw new Error(`chain ${chain.chainId} (${chain.name}) has no RPC endpoint in the registry`);
  }
  const explorer = chain.explorers[0];
  const multicall3 = chain.contracts.multicall3;
  return defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: [first.url, ...rest.map((rpc) => rpc.url)] } },
    testnet: chain.testnet,
    ...(explorer === undefined ? {} : { blockExplorers: { default: { name: explorer.name, url: explorer.url } } }),
    ...(multicall3 === undefined ? {} : { contracts: { multicall3: { address: multicall3.address } } }),
  });
}

export interface RpcTransportOptions {
  /**
   * Extra endpoints tried **before** the registry's, for example from the same-origin `/config.json`
   * (never from URL parameters, spec §3.6). Each must be an https URL.
   */
  readonly preferredUrls?: readonly string[];
  /** Per-request timeout in milliseconds (viem default 10 s). */
  readonly timeoutMs?: number;
  /** Retries per endpoint before falling back (viem default 3). */
  readonly retryCount?: number;
}

/** A viem `fallback()` transport across the chain's RPC endpoints, in registry order (threat T-16). */
export function rpcTransport(chain: ChainDefinition, options: RpcTransportOptions = {}): FallbackTransport<readonly HttpTransport[]> {
  const preferred = options.preferredUrls ?? [];
  for (const url of preferred) {
    if (!url.startsWith("https://")) {
      throw new Error(`preferred RPC ${url} must use https`);
    }
  }
  const urls = [...new Set([...preferred, ...chain.rpc.map((rpc) => rpc.url)])];
  if (urls.length === 0) {
    throw new Error(`chain ${chain.chainId} (${chain.name}) has no RPC endpoint in the registry`);
  }
  const transports = urls.map((url) =>
    http(url, {
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options.retryCount === undefined ? {} : { retryCount: options.retryCount }),
    }),
  );
  return fallback(transports, { rank: false });
}
