// SPDX-License-Identifier: MIT
/**
 * Ethereum Sepolia as the API's tests see it: the shipped registry entry with a fixture deployment of PayLinkV2 at its
 * CREATE2 address (the release's, packages/chains RELEASE; the owner's real one is recorded in
 * protocol/deployments/11155111.json, and no test here depends on its values), and a scripted RPC
 * that answers `aggregate3` (statesOf, the clock, the block number) and `eth_getLogs` for `Paid` and `InvoiceCancelled`
 * from a small in-memory chain.
 */
import type { InvoiceKey } from "@paylink/api-contract";
import { createRegistry, ethereumSepolia, RELEASE } from "@paylink/chains";
import type { Deployment, Registry } from "@paylink/chains";
import { INVOICE_CANCELLED_TOPIC, PAID_TOPIC, payLinkV2Abi } from "@paylink/sdk";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, numberToHex, pad, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { createReader } from "../../src/chain/reader.ts";
import { chainClient } from "../../src/chain/client.ts";
import type { ChainReader } from "../../src/chain/types.ts";
import { RpcError, rpcFake } from "./rpc.ts";
import type { RpcFake } from "./rpc.ts";

export const PAYLINK: Address = RELEASE.create2.address;
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const DEPLOY_BLOCK = 11_959_000;

export const DEPLOYMENT: Deployment = {
  address: PAYLINK,
  status: "active",
  release: RELEASE.release,
  method: "CREATE2",
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  txHash: `0x${"de".repeat(32)}`,
  blockNumber: BigInt(DEPLOY_BLOCK),
  initCodeHash: RELEASE.initCodeHash,
  maskedRuntimeHash: RELEASE.maskedRuntimeHash,
  runtimeCodeHash: `0x${"00".repeat(32)}`,
};

/** The shipped Sepolia entry with the deployment recorded. */
export const DEPLOYED_REGISTRY: Registry = createRegistry([{ ...ethereumSepolia, deployment: DEPLOYMENT }]);

const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
  "function getBlockNumber() view returns (uint256 blockNumber)",
]);

export interface FakeLog {
  readonly topic: "paid" | "cancelled";
  readonly key: InvoiceKey;
  readonly payee: Address;
  readonly payer?: Address;
  readonly token?: Address;
  readonly amount?: bigint;
  readonly txHash: Hex;
  readonly block: number;
  readonly logIndex: number;
  /** Emitted by another contract (an impostor). */
  readonly address?: Address;
}

/** A tiny chain: states by key, logs, a clock and a head; plus switches for failures. */
export interface FakeChain {
  readonly states: Map<string, { payments: number; cancelled: boolean; lastPaidAt: bigint }>;
  readonly logs: FakeLog[];
  time: number;
  block: number;
  failCall: boolean;
  /** `eth_getLogs` answers "pruned history unavailable" this many times before answering. */
  prunedAnswers: number;
}

export function fakeChain(time: number): FakeChain {
  return { states: new Map(), logs: [], time, block: DEPLOY_BLOCK + 10_000, failCall: false, prunedAnswers: 0 };
}

function rawLog(log: FakeLog): Record<string, unknown> {
  const topics =
    log.topic === "paid"
      ? [PAID_TOPIC, log.key, pad(log.payee.toLowerCase() as Hex), pad((log.payer ?? "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC").toLowerCase() as Hex)]
      : [INVOICE_CANCELLED_TOPIC, log.key, pad(log.payee.toLowerCase() as Hex)];
  const data =
    log.topic === "paid"
      ? encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "bytes32" }], [log.token ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", log.amount ?? 0n, 0, `0x${"00".repeat(32)}`])
      : "0x";
  return { address: (log.address ?? PAYLINK).toLowerCase(), topics, data, blockNumber: numberToHex(log.block), transactionHash: log.txHash, logIndex: numberToHex(log.logIndex), removed: false };
}

/** The RPC of `chain`, as a `fetch`. */
export function sepoliaRpc(chain: FakeChain): RpcFake {
  return rpcFake((method, params) => {
    if (method === "eth_call") {
      if (chain.failCall) {
        throw new RpcError(-32000, "header not found");
      }
      const { to, data } = params[0] as { to: string; data: Hex };
      if (to.toLowerCase() !== MULTICALL3.toLowerCase()) {
        throw new RpcError(-32000, "execution reverted");
      }
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data });
      const results = (args[0] as readonly { target: Address; callData: Hex }[]).map((call) => {
        if (call.target.toLowerCase() === PAYLINK.toLowerCase()) {
          const decoded = decodeFunctionData({ abi: payLinkV2Abi, data: call.callData });
          const keys = decoded.args[0] as readonly Hex[];
          const states = keys.map((k) => ({ total: 0n, ...(chain.states.get(k.toLowerCase()) ?? { payments: 0, cancelled: false, lastPaidAt: 0n }) }));
          return { success: true, returnData: encodeFunctionResult({ abi: payLinkV2Abi, functionName: "statesOf", result: states }) };
        }
        const fn = decodeFunctionData({ abi: MULTICALL3_ABI, data: call.callData }).functionName;
        const value = fn === "getCurrentBlockTimestamp" ? BigInt(chain.time) : BigInt(chain.block);
        return { success: true, returnData: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: fn, result: value }) };
      });
      return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result: results });
    }
    if (method === "eth_getLogs") {
      if (chain.prunedAnswers > 0) {
        chain.prunedAnswers -= 1;
        throw new RpcError(4444, "pruned history unavailable");
      }
      const filter = params[0] as { address: string; topics: (string | null)[]; fromBlock: Hex; toBlock: Hex };
      const from = Number(filter.fromBlock);
      const to = Number(filter.toBlock);
      if (to - from + 1 > 50_000) {
        throw new RpcError(-32602, "exceed maximum block range: 50000");
      }
      // A log with its own `address` stands for a lying RPC: answered whatever the filter's address.
      return chain.logs
        .filter((l) => l.block >= from && l.block <= to && (l.address !== undefined || filter.address.toLowerCase() === PAYLINK.toLowerCase()))
        .map(rawLog)
        .filter((l) => (l["topics"] as string[])[0] === filter.topics[0] && (l["topics"] as string[])[1] === filter.topics[1]);
    }
    throw new RpcError(-32601, `method not scripted: ${method}`);
  });
}

/** A reader over the deployed registry and the scripted chain, through a real viem client. */
export function fakeReader(chain: FakeChain, registry: Registry = DEPLOYED_REGISTRY): { readonly reader: ChainReader; readonly rpc: RpcFake } {
  const rpc = sepoliaRpc(chain);
  const client = chainClient({ fetch: rpc.fetch }, ethereumSepolia);
  return { reader: createReader({ registry, chainId: 11155111, client }), rpc };
}
