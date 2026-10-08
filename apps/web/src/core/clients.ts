// SPDX-License-Identifier: MIT
/**
 * Read clients (read model rank 1, ADR 0009): one client per chain over the registry's RPCs in fallback order (threat
 * T-16), with any preferred RPCs from `/config.json` tried first. Every read that gates or proves a payment goes
 * through these clients, never through the wallet's own RPC and never through the indexer.
 *
 * The client exposes exactly the reads the app makes (the SDK's structural client interfaces are satisfied as is),
 * built on viem's tree-shakeable actions rather than `createPublicClient`, whose full action set would not fit the pay
 * route's 110 kB budget (PAYLINK-V2-SPEC §4.4).
 */
import type { ChainDefinition } from "@paylink/chains";
import { rpcTransport, toViemChain } from "@paylink/chains";
import { createClient, decodeFunctionResult, encodeFunctionData, erc20Abi, hexToBigInt, numberToHex, TransactionReceiptNotFoundError } from "viem";
import type { Address, Hex, RpcLog, TransactionReceipt } from "viem";
import { call, getBlock, getBlockNumber, getCode, getTransactionReceipt, sendRawTransaction } from "viem/actions";
import type { RuntimeConfig } from "./config.ts";

export interface CallParameters {
  readonly to: Address;
  readonly data: Hex;
  readonly account?: Address;
  readonly value?: bigint;
  readonly gas?: bigint;
  readonly blockNumber?: bigint;
}

export interface LogFilter {
  readonly address: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly topics: readonly (Hex | null)[];
}

export interface ChainClient {
  readonly chain: ChainDefinition;
  call(parameters: CallParameters): Promise<{ data?: Hex | undefined }>;
  getCode(parameters: { address: Address }): Promise<Hex | undefined>;
  getBlock(parameters: { blockNumber: bigint } | { blockTag: "latest" | "finalized" }): Promise<{ readonly number: bigint | null; readonly timestamp: bigint }>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(parameters: { hash: Hex }): Promise<TransactionReceipt>;
  /** Polls for the receipt until it exists (about once per block) or `timeoutMs` passes. */
  waitForReceipt(hash: Hex, options?: { readonly pollingMs?: number; readonly timeoutMs?: number }): Promise<TransactionReceipt>;
  /** `eth_estimateGas`; a revert surfaces as a viem RPC error carrying the revert data. */
  estimateGas(parameters: { from: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
  getBalance(address: Address): Promise<bigint>;
  erc20(token: Address, functionName: "balanceOf", args: readonly [Address]): Promise<bigint>;
  erc20(token: Address, functionName: "allowance", args: readonly [Address, Address]): Promise<bigint>;
  getLogs(filter: LogFilter): Promise<RpcLog[]>;
  /** The account's next nonce, counting pending transactions (local signers only: passkey accounts). */
  getTransactionCount(address: Address): Promise<number>;
  /** EIP-1559 fees for a transaction sent now: `2 × baseFee + tip`, the tip from `eth_maxPriorityFeePerGas`. */
  estimateFees(): Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }>;
  /** Broadcasts a transaction signed on this device; resolves with its hash. */
  sendRawTransaction(serialized: Hex): Promise<Hex>;
}

const cache = new Map<string, ChainClient>();

/** About one block on the chain, never faster than 250 ms. */
export function pollingIntervalFor(chain: ChainDefinition): number {
  return chain.chainId === 10143 || chain.chainId === 143 ? 400 : chain.local ? 250 : 1000;
}

const quantity = (value: bigint): Hex => numberToHex(value);

export function chainClient(chain: ChainDefinition, config: RuntimeConfig): ChainClient {
  const preferred = config.rpc[String(chain.chainId)] ?? [];
  const id = `${String(chain.chainId)}|${chain.rpc.map((r) => r.url).join(",")}|${preferred.join(",")}`;
  const existing = cache.get(id);
  if (existing !== undefined) {
    return existing;
  }
  const viem = createClient({
    chain: toViemChain(chain),
    transport: rpcTransport(chain, { preferredUrls: preferred, timeoutMs: 10_000, retryCount: 1 }),
    pollingInterval: pollingIntervalFor(chain),
    cacheTime: 0,
  });
  const client: ChainClient = {
    chain,
    call: async (p) =>
      await call(viem, {
        to: p.to,
        data: p.data,
        ...(p.account === undefined ? {} : { account: p.account }),
        ...(p.value === undefined ? {} : { value: p.value }),
        ...(p.gas === undefined ? {} : { gas: p.gas }),
        ...(p.blockNumber === undefined ? {} : { blockNumber: p.blockNumber }),
      }),
    getCode: async ({ address }) => await getCode(viem, { address }),
    getBlock: async (p) => {
      const block = "blockNumber" in p ? await getBlock(viem, { blockNumber: p.blockNumber }) : await getBlock(viem, { blockTag: p.blockTag });
      return { number: block.number, timestamp: block.timestamp };
    },
    getBlockNumber: async () => await getBlockNumber(viem, { cacheTime: 0 }),
    getTransactionReceipt: async ({ hash }) => await getTransactionReceipt(viem, { hash }),
    async waitForReceipt(hash, options = {}) {
      const deadline = Date.now() + (options.timeoutMs ?? 180_000);
      const pause = options.pollingMs ?? pollingIntervalFor(chain);
      for (;;) {
        try {
          return await getTransactionReceipt(viem, { hash });
        } catch (error) {
          if (!(error instanceof TransactionReceiptNotFoundError) || Date.now() > deadline) {
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    },
    estimateGas: async ({ from, to, data, value }) =>
      hexToBigInt(await viem.request({ method: "eth_estimateGas", params: [{ from, to, data, value: quantity(value) }] })),
    getBalance: async (address) => hexToBigInt(await viem.request({ method: "eth_getBalance", params: [address, "latest"] })),
    erc20: async (token: Address, functionName: "balanceOf" | "allowance", args: readonly Address[]) => {
      const data = functionName === "balanceOf"
        ? encodeFunctionData({ abi: erc20Abi, functionName, args: [args[0] ?? "0x"] as const })
        : encodeFunctionData({ abi: erc20Abi, functionName, args: [args[0] ?? "0x", args[1] ?? "0x"] as const });
      const result = await call(viem, { to: token, data });
      return decodeFunctionResult({ abi: erc20Abi, functionName, data: result.data ?? "0x" });
    },
    getLogs: async (filter) =>
      await viem.request({
        method: "eth_getLogs",
        params: [{ address: filter.address, fromBlock: quantity(filter.fromBlock), toBlock: quantity(filter.toBlock), topics: [...filter.topics] }],
      }),
    getTransactionCount: async (address) => Number(hexToBigInt(await viem.request({ method: "eth_getTransactionCount", params: [address, "pending"] }))),
    async estimateFees() {
      const [block, tip] = await Promise.all([
        getBlock(viem, { blockTag: "latest" }),
        viem.request({ method: "eth_maxPriorityFeePerGas" }).then(hexToBigInt).catch(() => 1_000_000_000n),
      ]);
      const baseFee = block.baseFeePerGas ?? 0n;
      return { maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip };
    },
    sendRawTransaction: async (serialized) => await sendRawTransaction(viem, { serializedTransaction: serialized }),
  };
  cache.set(id, client);
  return client;
}

/** The chain's own clock: the latest block's timestamp (spec §2.3: never the device clock for payability). */
export async function chainTime(client: Pick<ChainClient, "getBlock">): Promise<bigint> {
  return (await client.getBlock({ blockTag: "latest" })).timestamp;
}
