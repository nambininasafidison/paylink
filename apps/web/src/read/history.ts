// SPDX-License-Identifier: MIT
/**
 * Reading the chain's history within the public RPCs' limits (spec §3.8: Monad's public `eth_getLogs` is capped at
 * 100 blocks, about 40 s). Two primitives, both on the registry's RPCs, never on the indexer:
 *
 * - `blockAtTime`: the first block stamped at or after a time. Block headers are served by every RPC (historical state
 *   often is not), and timestamps never decrease, so a search over them is exact: a few probes back from the head to
 *   bracket the time, then interpolation alternating with bisection (logarithmic in the worst case).
 * - `scanLogs`: one log filter over a block range, in requests no longer than the chain accepts, newest first,
 *   stopping at the first log the caller accepts;
 * - `findInWindow`: both together, for a log that can only be in blocks stamped inside a time window (an EIP-3009
 *   authorisation is usable only before its `validBefore`).
 *
 * No runtime import: callers load this module on first use, and it adds nothing to the pages' shared chunk.
 */
import type { ChainDefinition } from "@paylink/chains";
import type { Address, Hex, RpcLog } from "viem";
import type { ChainClient } from "../core/clients.ts";

export type HistoryClient = Pick<ChainClient, "getBlock" | "getBlockNumber" | "getLogs">;

/** Blocks per `eth_getLogs` request when the chain states no cap of its own. */
export const DEFAULT_LOG_RANGE = 100;

/** Blocks per `eth_getLogs` request on `chain` (Monad testnet: 100). */
export function logRange(chain: Pick<ChainDefinition, "rpcLimits">): bigint {
  return BigInt(Math.max(1, chain.rpcLimits.maxLogBlockRange ?? DEFAULT_LOG_RANGE));
}

export interface BlockStamp {
  readonly number: bigint;
  readonly timestamp: bigint;
}

/** The latest block, with its number (a `latest` header may omit it on some RPCs). */
export async function headBlock(client: HistoryClient): Promise<BlockStamp> {
  const number = await client.getBlockNumber();
  return { number, timestamp: (await client.getBlock({ blockNumber: number })).timestamp };
}

/**
 * The first block stamped at or after `timestamp`, at most `head.number + 1` (no block yet). Recent times are the
 * common case, so the time is first bracketed by probes 256, 1,024, 4,096… blocks back from the head.
 */
export async function blockAtTime(client: Pick<HistoryClient, "getBlock">, timestamp: bigint, head: BlockStamp): Promise<bigint> {
  if (head.timestamp < timestamp) {
    return head.number + 1n;
  }
  const stamp = async (number: bigint): Promise<bigint> => (await client.getBlock({ blockNumber: number })).timestamp;
  let hi = head.number;
  let hiTime = head.timestamp;
  let lo: bigint;
  let loTime: bigint;
  for (let step = 256n; ; step *= 4n) {
    const probe = head.number > step ? head.number - step : 0n;
    const time = await stamp(probe);
    if (time < timestamp) {
      lo = probe;
      loTime = time;
      break;
    }
    hi = probe;
    hiTime = time;
    if (probe === 0n) {
      return 0n;
    }
  }
  // loTime < timestamp <= hiTime and lo < hi. Interpolation converges in a few probes when blocks are regular;
  // alternating with bisection keeps the worst case logarithmic.
  for (let round = 0; hi - lo > 1n; round += 1) {
    let probe = round % 2 === 0 && hiTime > loTime ? lo + ((timestamp - loTime) * (hi - lo)) / (hiTime - loTime) : lo + (hi - lo) / 2n;
    if (probe <= lo) {
      probe = lo + 1n;
    } else if (probe >= hi) {
      probe = hi - 1n;
    }
    const time = await stamp(probe);
    if (time < timestamp) {
      lo = probe;
      loTime = time;
    } else {
      hi = probe;
      hiTime = time;
    }
  }
  return hi;
}

/**
 * Scans `[from, to]` with one filter, `range` blocks per request, newest first, and returns the first value `accept`
 * gives for a log (in the order the RPC returns them, newest request first), or `null`.
 */
export async function scanLogs<T>(
  client: Pick<HistoryClient, "getLogs">,
  filter: { readonly address: Address; readonly topics: readonly (Hex | null)[] },
  span: { readonly from: bigint; readonly to: bigint; readonly range: bigint },
  accept: (log: RpcLog) => Promise<T | null>,
): Promise<T | null> {
  const range = span.range < 1n ? 1n : span.range;
  for (let to = span.to; to >= span.from; to -= range) {
    const from = to - range + 1n > span.from ? to - range + 1n : span.from;
    const logs = await client.getLogs({ address: filter.address, fromBlock: from, toBlock: to, topics: filter.topics });
    for (const log of [...logs].reverse()) {
      const value = await accept(log);
      if (value !== null) {
        return value;
      }
    }
    if (from === 0n) {
      break;
    }
  }
  return null;
}

/**
 * Searches the blocks stamped in `[opens, closes)` (or, with `after`, only those after that block) for a log matching
 * `filter`, newest first, and returns the first value `accept` gives, or `null`.
 */
export async function findInWindow<T>(
  client: HistoryClient,
  chain: Pick<ChainDefinition, "rpcLimits">,
  filter: { readonly address: Address; readonly topics: readonly (Hex | null)[] },
  window: { readonly opens: bigint; readonly closes: bigint; readonly after: bigint | null },
  accept: (log: RpcLog) => Promise<T | null>,
): Promise<T | null> {
  const head = await headBlock(client);
  const from = window.after === null ? await blockAtTime(client, window.opens, head) : window.after + 1n;
  const to = head.timestamp < window.closes ? head.number : (await blockAtTime(client, window.closes, head)) - 1n;
  if (to < (from < 0n ? 0n : from)) {
    return null;
  }
  return await scanLogs(client, filter, { from: from < 0n ? 0n : from, to, range: logRange(chain) }, accept);
}
