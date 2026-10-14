// SPDX-License-Identifier: MIT
/**
 * Mezo testnet's RPC answers `null` to a lookup by hash (`eth_getTransactionReceipt`, `eth_getTransactionByHash`) for a
 * transaction that is mined, about one time in two, while the same request answers it a moment later
 * (docs/research/mezo.md §2, ADR 0017). An anvil fork always answers, so the specs that route the registry's RPC to one
 * rewrite its answers the same way, deterministically: for each method and hash, the i-th lookup of a transaction the
 * node has (its answer is not `null`) is answered `null` when `pattern[i]` is `N`; later lookups answer.
 */
const BY_HASH = new Set(["eth_getTransactionReceipt", "eth_getTransactionByHash"]);

export interface NullLookups {
  /** The answer to send for `body` (one JSON-RPC call) given the node's own `answer` text. */
  rewrite(body: string, answer: string): string;
  /** How many answers were turned into `null` so far. */
  nulled(): number;
}

export function nullLookups(pattern: string): NullLookups {
  if (!/^[NR]*$/.test(pattern)) {
    throw new Error(`a null-lookup pattern is made of N (null) and R (real answer), not ${pattern}`);
  }
  const seen = new Map<string, number>();
  let nulled = 0;
  return {
    rewrite(body, answer) {
      let call: { id?: unknown; method?: string; params?: string[] };
      let reply: { result?: unknown };
      try {
        call = JSON.parse(body) as typeof call;
        reply = JSON.parse(answer) as typeof reply;
      } catch {
        return answer;
      }
      if (Array.isArray(call) || call.method === undefined || !BY_HASH.has(call.method) || reply.result === null || reply.result === undefined) {
        return answer;
      }
      const key = `${call.method}:${(call.params?.[0] ?? "").toLowerCase()}`;
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      if (pattern[index] !== "N") {
        return answer;
      }
      nulled += 1;
      return JSON.stringify({ jsonrpc: "2.0", id: call.id, result: null });
    },
    nulled: () => nulled,
  };
}
