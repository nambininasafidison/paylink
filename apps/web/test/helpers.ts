// SPDX-License-Identifier: MIT
/**
 * Fixtures for the web app's unit tests: a local registry (chain 31337, one 6-decimal EIP-2612 + EIP-3009 token, an
 * active deployment), invoices signed by a key generated for the test run (no key is stored anywhere), and a fake
 * chain client that answers the reads the app makes from in-memory state.
 */
import { createRegistry, defineLocalChain } from "@paylink/chains";
import type { ChainDefinition, Deployment, Erc20Token, Registry } from "@paylink/chains";
import { decodeInvoiceFragment, encodeInvoiceFragment, expiresIn, issueInvoice, payLinkV2Abi, toSignedInvoiceJson } from "@paylink/sdk";
import type { DecodedInvoiceLink, IssuedInvoice, LinkState, SignedInvoiceJson } from "@paylink/sdk";
import { decodeFunctionData, encodeFunctionResult, erc20Abi } from "viem";
import type { Address, Hex, RpcLog, TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { CallParameters, ChainClient } from "../src/core/clients.ts";
import { invoiceId } from "../src/store/db.ts";
import type { InvoiceRecord } from "../src/store/db.ts";

export const CHAIN_ID = 31337;
/** A `javascript:` URL, built at run time: the guards under test must refuse it. */
export const SCRIPT_URL = ["javascript", "alert(1)"].join(":");
export const CONTRACT: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const TOKEN_ADDRESS: Address = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
/** Chain time of the fixtures: 2026-10-08T00:00:00Z. */
export const NOW = 1_791_417_600n;

export const token: Erc20Token = {
  kind: "erc20",
  symbol: "AUSD",
  name: "Local dollar",
  address: TOKEN_ADDRESS,
  decimals: 6,
  capabilities: { eip3009: true, eip2612: true, native: false },
  eip712Domain: { name: "AUSD", version: "1" },
  listing: "default",
  confidence: "C",
  pendingVerification: [],
};

export const deployment: Deployment = {
  address: CONTRACT,
  status: "active",
  release: "2.0.0",
  method: "CREATE",
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  txHash: `0x${"11".repeat(32)}`,
  blockNumber: 1n,
  initCodeHash: `0x${"22".repeat(32)}`,
  maskedRuntimeHash: `0x${"33".repeat(32)}`,
  runtimeCodeHash: `0x${"44".repeat(32)}`,
};

export function localChain(): ChainDefinition {
  return defineLocalChain({ chainId: CHAIN_ID, rpcUrl: "http://127.0.0.1:8545", tokens: [token], deployment });
}

export const registry: Registry = createRegistry([localChain()]);

/** A fresh payee for each test file: the key exists only in memory for the run. */
export const payee = privateKeyToAccount(generatePrivateKey());
export const payer = privateKeyToAccount(generatePrivateKey());

export interface Issued {
  readonly issued: IssuedInvoice;
  readonly link: DecodedInvoiceLink;
  readonly record: InvoiceRecord;
  readonly json: SignedInvoiceJson;
}

/** Signs an invoice for `amount` base units (0: open amount) the way the create terminal does. */
export async function issue(options: { amount?: bigint; memo?: string | null; maxPayments?: number; createdAt?: number } = {}): Promise<Issued> {
  const issued = await issueInvoice({
    registry,
    chainId: CHAIN_ID,
    signer: payee,
    draft: {
      payee: payee.address,
      token: TOKEN_ADDRESS,
      amount: options.amount ?? 25_500_000n,
      maxPayments: options.maxPayments ?? 1,
      expiry: expiresIn(NOW, 7n * 86_400n),
      memo: options.memo === undefined ? "Logo design, invoice 042" : options.memo,
    },
  });
  const json = toSignedInvoiceJson(issued.signed, issued.key);
  const record: InvoiceRecord = {
    id: invoiceId(CHAIN_ID, issued.key),
    chainId: CHAIN_ID,
    key: issued.key,
    signed: json,
    role: "issued",
    createdAt: options.createdAt ?? 1_000,
  };
  return { issued, link: decodeInvoiceFragment(encodeInvoiceFragment(issued.signed), registry), record, json };
}

export interface FakeChain {
  readonly client: ChainClient;
  /** Link states by key (absent: never paid). */
  readonly states: Map<Hex, LinkState>;
  /** Code by address (absent: no code). */
  readonly code: Map<string, Hex>;
  readonly balances: Map<string, bigint>;
  readonly allowances: Map<string, bigint>;
  readonly calls: CallParameters[];
  /** Makes every read fail like an unreachable RPC. */
  down: boolean;
  now: bigint;
}

const ZERO_STATE: LinkState = { payments: 0, cancelled: false, lastPaidAt: 0n, total: 0n };

/** A chain client over in-memory state: PayLinkV2 `stateOf`/`statesOf`, ERC-20 `balanceOf`/`allowance`, code and time. */
export function fakeChain(chain: ChainDefinition = localChain()): FakeChain {
  const fake: FakeChain = {
    client: undefined as unknown as ChainClient,
    states: new Map(),
    code: new Map(),
    balances: new Map(),
    allowances: new Map(),
    calls: [],
    down: false,
    now: NOW,
  };
  /** Answers like an RPC: a rejected promise, never a synchronous throw, when the chain is down. */
  const read = <T>(answer: () => T): Promise<T> =>
    new Promise<T>((resolve) => {
      if (fake.down) {
        throw Object.assign(new Error("HTTP request failed"), { name: "HttpRequestError" });
      }
      resolve(answer());
    });
  const allowance = (owner: string, spender: string): bigint => fake.allowances.get(`${owner.toLowerCase()}:${spender.toLowerCase()}`) ?? 0n;
  const noReceipt = (): never => {
    throw new Error("no receipt in the fake chain");
  };
  const client: ChainClient = {
    chain,
    call: (p) =>
      read(() => {
        fake.calls.push(p);
        if (p.to.toLowerCase() === CONTRACT.toLowerCase()) {
          const decoded = decodeFunctionData({ abi: payLinkV2Abi, data: p.data });
          if (decoded.functionName === "stateOf") {
            return { data: encodeFunctionResult({ abi: payLinkV2Abi, functionName: "stateOf", result: fake.states.get(decoded.args[0]) ?? ZERO_STATE }) };
          }
          if (decoded.functionName === "statesOf") {
            return { data: encodeFunctionResult({ abi: payLinkV2Abi, functionName: "statesOf", result: decoded.args[0].map((k) => fake.states.get(k) ?? ZERO_STATE) }) };
          }
        }
        const erc20 = decodeFunctionData({ abi: erc20Abi, data: p.data });
        if (erc20.functionName === "balanceOf") {
          return { data: encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: fake.balances.get(erc20.args[0].toLowerCase()) ?? 0n }) };
        }
        if (erc20.functionName === "allowance") {
          return { data: encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: allowance(erc20.args[0], erc20.args[1]) }) };
        }
        throw new Error(`unexpected call ${erc20.functionName}`);
      }),
    getCode: ({ address }) => read(() => fake.code.get(address.toLowerCase())),
    getBlock: () => read(() => ({ number: 100n, timestamp: fake.now })),
    getBlockNumber: () => read(() => 100n),
    getTransactionReceipt: () => read(noReceipt),
    waitForReceipt: (): Promise<TransactionReceipt> => read(noReceipt),
    estimateGas: () => read(() => 100_000n),
    getBalance: (address) => read(() => fake.balances.get(`native:${address.toLowerCase()}`) ?? 0n),
    erc20: (_token: Address, functionName: "balanceOf" | "allowance", args: readonly Address[]) =>
      read(() => (functionName === "balanceOf" ? (fake.balances.get((args[0] ?? "").toLowerCase()) ?? 0n) : allowance(args[0] ?? "", args[1] ?? ""))),
    getLogs: (): Promise<RpcLog[]> => read(() => []),
    getTransactionCount: () => read(() => 0),
    estimateFees: () => read(() => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })),
    sendRawTransaction: (): Promise<Hex> => read(() => { throw new Error("no broadcast in the fake chain"); }),
  };
  (fake as { client: ChainClient }).client = client;
  return fake;
}
