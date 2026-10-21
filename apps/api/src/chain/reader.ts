// SPDX-License-Identifier: MIT
/**
 * The chain reader over a registry and a read-only viem client (src/chain/types.ts).
 *
 * One read of N twins costs one `eth_call`: Multicall3's `aggregate3` (registry address
 * `0xcA11bde05977b3631167028862bE2a173976CA11`, code checked live on Sepolia, packages/chains) carrying PayLinkV2's
 * `statesOf(keys)` (≤ 256 keys per call, the contract's `BatchTooLarge(256)`), `getCurrentBlockTimestamp()` and
 * `getBlockNumber()`. A state is then, in this order:
 *
 * - `paid`: `payments ≥ 1` (money moved; PayLinkV2 twins are one-payment invoices). Its evidence is the `Paid` event
 *   for K: found with `eth_getLogs` filtered by the contract and the indexed key, over a window estimated from
 *   `lastPaidAt` (Ethereum makes at most one block per 12-second slot, so the block is at most `Δt / 12` blocks back) and
 *   bounded by the registry's `maxLogBlockRange` (50,000 on Sepolia); decoded by the SDK's strict `decodePaidLog`; kept
 *   only if it was emitted by the canonical deployment for this key, payee, allowlisted token equal to the invoice's,
 *   and exact amount, at least `MIN_CONFIRMATIONS` deep. A payment verified once is reused while the state stays paid.
 * - `cancelled`; `expired` (`validUntil` passed on **chain** time); otherwise `payable`.
 *
 * Failure is explicit: a failed `eth_call` reads every twin `unreadable`; a failed or pruned log lookup (Sepolia's
 * public pool answers "pruned history unavailable" for older blocks some of the time, docs/research/paypal/sepolia.md §3)
 * is retried, then reads that twin `unreadable`; a log not found yet leaves `paid` with no verified payment (the
 * situation table waits, then hands off).
 *
 * Owner: reconciler workstream.
 */
import type { InvoiceKey } from "@paylink/api-contract";
import type { Registry } from "@paylink/chains";
import { decodePaidLog, INVOICE_CANCELLED_TOPIC, PAID_TOPIC, payLinkV2Abi, STATES_OF_MAX_BATCH } from "@paylink/sdk";
import type { LogLike } from "@paylink/sdk";
import { decodeFunctionResult, encodeFunctionData, numberToHex, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import type { ChainObservation, ChainPayment } from "../reconciler/types.ts";
import type { ChainReader, ChainTwin, ObserveOptions } from "./types.ts";

/** A `Paid` log must be this many blocks deep (its block and one more) before it counts (E). */
export const MIN_CONFIRMATIONS = 2;
/** Seconds per slot on Ethereum (at most one block per slot). */
export const SLOT_SECONDS = 12;
/** Blocks added below the estimated window, for clock skew between `lastPaidAt` and the latest block (E). */
const WINDOW_MARGIN = 16;
/** Attempts of one log lookup (a pruned answer from one backend of the pool is often served by the next one). */
export const LOG_ATTEMPTS = 3;
/** Event lookups per read, unless the caller says otherwise. */
export const DEFAULT_LOG_LOOKUPS = 4;

const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
  "function getBlockNumber() view returns (uint256 blockNumber)",
]);

/** What the reader needs from a client: `eth_call` and raw JSON-RPC (viem's `PublicClient` satisfies it). */
export interface ReaderClient {
  call(parameters: { to: Address; data: Hex }): Promise<{ data?: Hex | undefined }>;
  request(parameters: { method: "eth_getLogs"; params: [{ address: Address; topics: (Hex | null)[]; fromBlock: Hex; toBlock: Hex }] }): Promise<readonly RawLog[]>;
}

/** A log as `eth_getLogs` answers it (hex quantities). */
export interface RawLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: Hex | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: Hex | null;
  readonly removed?: boolean;
}

interface Head {
  readonly states: readonly { readonly payments: number; readonly cancelled: boolean; readonly lastPaidAt: bigint }[];
  readonly time: number;
  readonly block: number;
}

const OBS = (state: ChainObservation["state"], extra: Partial<ChainObservation> = {}): ChainObservation => ({ state, payments: [], paidAt: null, chainTime: null, ...extra });
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function createReader(options: { readonly registry: Registry; readonly chainId: number; readonly client: ReaderClient }): ChainReader {
  const { registry, chainId, client } = options;
  const target = registry.v2Target(chainId);
  const chain = registry.get(chainId);
  const multicall = chain?.contracts.multicall3?.address;
  const maxRange = chain?.rpcLimits.maxLogBlockRange ?? 10_000;

  /** One `eth_call`: the states of every key (in batches of 256 inside the same aggregate) and the chain's head. */
  async function head(contract: Address, keys: readonly InvoiceKey[]): Promise<Head> {
    if (multicall === undefined) {
      throw new Error(`chain ${String(chainId)} has no Multicall3 in the registry`);
    }
    const batches: (readonly InvoiceKey[])[] = [];
    for (let i = 0; i < keys.length; i += STATES_OF_MAX_BATCH) {
      batches.push(keys.slice(i, i + STATES_OF_MAX_BATCH));
    }
    const calls = [
      ...batches.map((batch) => ({ target: contract, allowFailure: false, callData: encodeFunctionData({ abi: payLinkV2Abi, functionName: "statesOf", args: [batch] }) })),
      { target: multicall, allowFailure: false, callData: encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp" }) },
      { target: multicall, allowFailure: false, callData: encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "getBlockNumber" }) },
    ];
    const answer = await client.call({ to: multicall, data: encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "aggregate3", args: [calls] }) });
    const results = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", data: answer.data ?? "0x" });
    if (results.length !== calls.length || results.some((r) => !r.success)) {
      throw new Error("aggregate3 answered a failed call");
    }
    const states = batches.flatMap((batch, i) => {
      const decoded = decodeFunctionResult({ abi: payLinkV2Abi, functionName: "statesOf", data: results[i]?.returnData ?? "0x" });
      if (decoded.length !== batch.length) {
        throw new Error("statesOf answered another number of states");
      }
      return decoded;
    });
    const time = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp", data: results[batches.length]?.returnData ?? "0x" });
    const block = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "getBlockNumber", data: results[batches.length + 1]?.returnData ?? "0x" });
    return { states, time: Number(time), block: Number(block) };
  }

  /** `eth_getLogs` for one event and key over [from, to], retried; throws when every attempt fails. */
  async function logs(contract: Address, topic: Hex, key: InvoiceKey, from: number, to: number): Promise<readonly RawLog[]> {
    let last: unknown = null;
    for (let attempt = 0; attempt < LOG_ATTEMPTS; attempt += 1) {
      try {
        const found = await client.request({ method: "eth_getLogs", params: [{ address: contract, topics: [topic, key], fromBlock: numberToHex(from), toBlock: numberToHex(to) }] });
        return found.filter((l) => l.removed !== true);
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error("eth_getLogs failed");
  }

  /** The block window that must hold an event of `at` (unix seconds) seen from the head. */
  function window(at: number, headTime: number, headBlock: number, floor: number): { from: number; to: number } {
    const back = Math.max(0, Math.floor((headTime - at) / SLOT_SECONDS));
    const from = Math.max(floor, headBlock - back - WINDOW_MARGIN, 0);
    return { from, to: Math.min(headBlock, from + maxRange - 1) };
  }

  /** The verified payment of a paid twin, or null when its log is not found or not deep enough yet. */
  async function payment(contract: Address, twin: ChainTwin, paidAt: number, h: Head, floor: number): Promise<ChainPayment | null> {
    const { from, to } = window(paidAt, h.time, h.block, floor);
    for (const raw of await logs(contract, PAID_TOPIC, twin.key, from, to)) {
      const log: LogLike = { address: raw.address, topics: raw.topics, data: raw.data, logIndex: raw.logIndex === null ? null : Number(raw.logIndex) };
      const event = decodePaidLog(log);
      const blockNumber = raw.blockNumber === null ? null : Number(raw.blockNumber);
      if (
        event === null ||
        raw.transactionHash === null ||
        blockNumber === null ||
        event.logIndex === null ||
        !same(event.contract, contract) ||
        event.key !== twin.key.toLowerCase() ||
        !same(event.payee, twin.payee) ||
        !same(event.token, twin.token) ||
        registry.findToken(chainId, event.token) === undefined ||
        event.amount.toString() !== twin.amountBase ||
        h.block - blockNumber + 1 < MIN_CONFIRMATIONS
      ) {
        continue;
      }
      return { txHash: raw.transactionHash.toLowerCase() as Hex, logIndex: event.logIndex, blockNumber, timestamp: paidAt, payer: event.payer, amount: event.amount.toString(), token: twin.token, rail: twin.rail };
    }
    return null;
  }

  async function observeMany(twins: readonly ChainTwin[], options: ObserveOptions = {}): Promise<ReadonlyMap<InvoiceKey, ChainObservation>> {
    const out = new Map<InvoiceKey, ChainObservation>();
    if (twins.length === 0) {
      return out;
    }
    if (target === undefined) {
      for (const twin of twins) {
        out.set(twin.key, OBS("not-deployed"));
      }
      return out;
    }
    const contract = target.deployment.address;
    const floor = Number(target.deployment.blockNumber);
    let h: Head;
    try {
      h = await head(contract, twins.map((t) => t.key));
    } catch {
      for (const twin of twins) {
        out.set(twin.key, OBS("unreadable"));
      }
      return out;
    }
    let lookups = options.logLookups ?? DEFAULT_LOG_LOOKUPS;
    for (const [i, twin] of twins.entries()) {
      const state = h.states[i];
      if (state === undefined) {
        out.set(twin.key, OBS("unreadable"));
        continue;
      }
      const chainTime = h.time;
      const paidAt = state.payments > 0 ? Number(state.lastPaidAt) : null;
      if (paidAt !== null) {
        const cached = twin.chainPayment;
        if (cached !== null && cached.amount === twin.amountBase && same(cached.token, twin.token)) {
          out.set(twin.key, OBS("paid", { payments: [cached], paidAt, chainTime }));
          continue;
        }
        if (lookups <= 0) {
          out.set(twin.key, OBS("paid", { paidAt, chainTime }));
          continue;
        }
        lookups -= 1;
        try {
          const found = await payment(contract, twin, paidAt, h, floor);
          out.set(twin.key, OBS("paid", { payments: found === null ? [] : [found], paidAt, chainTime }));
        } catch {
          out.set(twin.key, OBS("unreadable"));
        }
        continue;
      }
      if (state.cancelled) {
        let cancelTx: Hex | undefined;
        if (lookups > 0) {
          lookups -= 1;
          try {
            // Information only (the state decides): the latest window, where a cancel the desk asked for will be.
            const found = await logs(contract, INVOICE_CANCELLED_TOPIC, twin.key, Math.max(floor, h.block - maxRange + 1, 0), h.block);
            cancelTx = found.at(-1)?.transactionHash?.toLowerCase() as Hex | undefined;
          } catch {
            cancelTx = undefined;
          }
        }
        out.set(twin.key, OBS("cancelled", { chainTime, ...(cancelTx === undefined ? {} : { cancelTx }) }));
        continue;
      }
      out.set(twin.key, OBS(twin.validUntil !== 0 && chainTime > twin.validUntil ? "expired" : "payable", { chainTime }));
    }
    return out;
  }

  return {
    chainId,
    deployed: target !== undefined,
    observe: async (twin, options) => (await observeMany([twin], options)).get(twin.key) ?? OBS("unreadable"),
    observeMany,
  };
}
