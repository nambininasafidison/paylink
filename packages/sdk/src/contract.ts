// SPDX-License-Identifier: MIT
/** Reads of PayLinkV2 state through `eth_call` (`stateOf`, `statesOf` in batches of at most 256). */
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import { payLinkV2Abi } from "./abi.ts";
import { STATES_OF_MAX_BATCH } from "./constants.ts";
import type { CallReader } from "./signature.ts";
import type { LinkState } from "./types.ts";

const toState = (s: { payments: number; cancelled: boolean; lastPaidAt: bigint; total: bigint }): LinkState => ({
  payments: s.payments,
  cancelled: s.cancelled,
  lastPaidAt: s.lastPaidAt,
  total: s.total,
});

/** `stateOf(key)`: all zeros for a key never paid or cancelled. */
export async function readLinkState(client: CallReader, contract: Address, key: Hex): Promise<LinkState> {
  const data = encodeFunctionData({ abi: payLinkV2Abi, functionName: "stateOf", args: [key] });
  const result = await client.call({ to: contract, data });
  return toState(decodeFunctionResult({ abi: payLinkV2Abi, functionName: "stateOf", data: result.data ?? "0x" }));
}

/**
 * The states of any number of keys, in order, with one `statesOf` call per 256 keys (the contract's limit,
 * `BatchTooLarge(256)`). Calls run one after another to stay within public RPC rate limits.
 */
export async function readLinkStates(client: CallReader, contract: Address, keys: readonly Hex[]): Promise<LinkState[]> {
  const states: LinkState[] = [];
  for (let start = 0; start < keys.length; start += STATES_OF_MAX_BATCH) {
    const batch = keys.slice(start, start + STATES_OF_MAX_BATCH);
    const data = encodeFunctionData({ abi: payLinkV2Abi, functionName: "statesOf", args: [batch] });
    const result = await client.call({ to: contract, data });
    const decoded = decodeFunctionResult({ abi: payLinkV2Abi, functionName: "statesOf", data: result.data ?? "0x" });
    if (decoded.length !== batch.length) {
      throw new Error(`statesOf returned ${decoded.length} states for ${batch.length} keys`);
    }
    states.push(...decoded.map(toState));
  }
  return states;
}
