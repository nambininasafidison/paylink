// SPDX-License-Identifier: MIT
/**
 * Mezo testnet (31611) rehearsed on an anvil fork (ADR 0017): what the owner will do with the deploy kit, then what
 * payers will do with MUSD, against the chain's real state (the CREATE2 factory, MUSD), with nothing sent to Mezo
 * testnet. Every key is derived from a public label and lives only on the fork.
 *
 * 1. Deploy. The kit's own planning (web/v2/deploy/lib/core.js) reads the fork's factory and plans CREATE2 to the
 *    release address; the transaction carries the kit's gas clamp with the registry's measured bounds; the kit's
 *    verifier (lib/verify.js) checks code, masked runtime hash, CBOR metadata, the EIP-712 immutables and
 *    eip712Domain(), and tools/verify-deployment, reading the fork on its own, writes the same record.
 * 2. Pay. MUSD invoices are issued and paid with @paylink/sdk exactly as the web app's wallet rail does
 *    (apps/web/src/rails/wallet.ts): the router offers permit, then approve-pay, never an authorisation; payWithPermit
 *    and approve + pay each move exactly the amount; every receipt verifies with `verifyReceipt`; an EIP-3009
 *    authorisation is refused by the SDK, and a hand-built payWithAuthorization reverts on chain. A native BTC
 *    invoice is paid with payNative, and a payee's signed cancellation is sent by a third party (cancelBySig).
 * 3. Measure (`--measure`). The gas of every entry point, scenario by scenario as packages/sdk/scripts/measure-gas.ts
 *    measures it (eth_estimateGas, then the receipt's gas used), with MUSD and native BTC where Mezo has them, and
 *    the repository's mocks where it has none (an EIP-3009 token, an ERC-1271 payee). Written to
 *    packages/chains/data/fork-gas-measurements.json, from which the registry derives Mezo's gas table.
 *
 * Optional live cross-check (read-only, `--live-estimate`): Mezo testnet's own eth_estimateGas for the CREATE2
 * deployment, compared with the fork's.
 *
 * Usage (from tools/deploy-page; anvil on PATH, `forge build` in protocol/, egress to rpc.test.mezo.org):
 *   NODE_USE_ENV_PROXY=1 node --conditions=@paylink/source scripts/mezo-fork.ts [--block <n>] [--measure] [--live-estimate] [--json]
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry, defineLocalChain, mezoTestnet, RELEASE, toViemChain } from "@paylink/chains";
import type { ChainDefinition, Deployment, Erc20Token, PayLinkFunction, Registry, Token } from "@paylink/chains";
import {
  approveCall,
  authorizePayment,
  cancelBySigCall,
  cancelCall,
  decodeError,
  decodeInvoiceFragment,
  decodePaidLog,
  gasLimitFor,
  isPayLinkError,
  issueInvoice,
  payCall,
  payerAccountKind,
  payNativeCall,
  payWithAuthorizationCall,
  preparePermitPayment,
  readLinkState,
  selectPaymentPath,
  signCancel,
  signReceiveAuthorization,
  verifyReceipt,
} from "@paylink/sdk";
import type { CallRequest, DecodedInvoiceLink, Route, TypedDataSigner } from "@paylink/sdk";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  TransactionReceiptNotFoundError,
  zeroAddress,
} from "viem";
import type { Address, Hex, PublicClient, TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { main as verifyCli } from "../../verify-deployment/verify-deployment.mjs";
import { chainOrThrow, clampGasLimit, parseChainsData, parseReleaseData, planDeployment } from "../../../web/v2/deploy/lib/core.js";
import { httpRpc, reader } from "../../../web/v2/deploy/lib/rpc.js";
import { verifyDeployment } from "../../../web/v2/deploy/lib/verify.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(PACKAGE_DIR, "../..");
export const OUTPUT = join(REPO_DIR, "packages/chains/data/fork-gas-measurements.json");

/** What the rehearsal relies on, each checked on the fork before it is used. */
export const MEZO = {
  chainId: 31611,
  /** The registry's RPC (packages/chains/src/chains/mezo-testnet.ts). */
  rpc: mezoTestnet.rpc[0]?.url ?? "https://rpc.test.mezo.org",
  /** The registry's MUSD (C: four sources and the chain agree, docs/research/mezo.md §4). */
  musd: getAddress("0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503"),
  /**
   * MUSD's BorrowerOperations on matsnet (github.com/mezo-org/musd, solidity/artifacts/deployments/matsnet/
   * BorrowerOperations.json at aa25fd6): on MUSD's `mintList`, so impersonating it on the fork mints test MUSD the way
   * a borrow does. Checked on the fork (`mintList(it)` and `it.musd()`) before use.
   */
  borrowerOperations: getAddress("0xCdF7028ceAB81fA0C6971208e83fa7872994beE5"),
} as const;

const MUSD_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function mint(address,uint256)",
  "function mintList(address) view returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])",
]);
const BORROWER_OPERATIONS_ABI = parseAbi(["function musd() view returns (address)"]);
const MOCK_ABI = parseAbi(["function mint(address,uint256)"]);

/** One MUSD (18 decimals). */
const MUSD = 10n ** 18n;
const DAY = 86_400n;
/** apps/web/src/rails/wallet.ts PERMIT_TTL_SECONDS. */
const PERMIT_TTL_SECONDS = 20n * 60n;

const labelKey = (label: string): Hex => {
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  return `0x${((BigInt(keccak256(stringToHex(label))) % (n - 1n)) + 1n).toString(16).padStart(64, "0")}`;
};
/** A fork-only account derived from a public label (never a real key, never used outside the fork). */
const account = (label: string): PrivateKeyAccount => privateKeyToAccount(labelKey(`paylink.mezo-fork.${label}`));
const salt = (label: string): Hex => keccak256(stringToHex(`paylink.mezo-fork.salt.${label}`));
const artifact = (path: string): Hex => (JSON.parse(readFileSync(join(REPO_DIR, "protocol/out", path), "utf8")) as { bytecode: { object: Hex } }).bytecode.object;
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(REPO_DIR, path), "utf8"));

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`mezo-fork: ${message}`);
  }
}

function anvilBinary(): string {
  const found = [...(process.env["PATH"] ?? "").split(":").filter((d) => d !== "").map((d) => join(d, "anvil")), join(homedir(), ".foundry/bin/anvil")].find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error("anvil not found (source ~/.paylink-toolchain/env.sh, or install Foundry 1.8.5)");
  }
  return found;
}

async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        done(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

let rpcId = 0;
async function jsonRpc<T>(url: string, method: string, params: readonly unknown[] = []): Promise<T> {
  rpcId += 1;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }) });
  const body = (await response.json()) as { result?: T; error?: { message: string; data?: unknown } };
  if (body.error !== undefined) {
    throw Object.assign(new Error(`${method}: ${body.error.message}`), { data: body.error.data });
  }
  return body.result as T;
}

export interface Fork {
  readonly url: string;
  readonly block: bigint;
  readonly blockHash: Hex;
  readonly timestamp: bigint;
  readonly hardfork: string;
  readonly network: string;
  rpc<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
  stop(): Promise<void>;
}

/**
 * The EVM rules anvil applies on the fork. Not anvil's default for an unknown chain (Bpo1), which needs the blob-gas
 * fields that Mezo's blocks do not carry ("Excess blob gas not set"): Prague, because Mezo runs Cancun opcodes (C, live
 * probes) and its estimator charges EIP-7702 authorizations (L). For PayLink's calls Cancun and Prague price alike, and
 * Mezo testnet's own estimate of the CREATE2 deployment equals the fork's (`--live-estimate`).
 */
export const FORK_HARDFORK = "prague";

/** anvil forking Mezo testnet at `block` (default: the latest block). Nothing it executes reaches the network. */
export async function startFork(options: { readonly rpc?: string; readonly block?: bigint } = {}): Promise<Fork> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const args = [
    "--fork-url",
    options.rpc ?? MEZO.rpc,
    "--hardfork",
    FORK_HARDFORK,
    "--port",
    String(port),
    "--silent",
    ...(options.block === undefined ? [] : ["--fork-block-number", options.block.toString()]),
  ];
  const child: ChildProcess = spawn(anvilBinary(), args, { stdio: "ignore" });
  const rpc = async <T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> => await jsonRpc<T>(url, method, params);
  for (let i = 0; ; i += 1) {
    try {
      await rpc("eth_chainId");
      break;
    } catch (error) {
      if (i > 600 || child.exitCode !== null) {
        child.kill();
        throw error;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const info = await rpc<{ hardFork: string; network: string; forkConfig: { forkBlockNumber: number } }>("anvil_nodeInfo");
  const forkBlock = BigInt(info.forkConfig.forkBlockNumber);
  const block = await rpc<{ hash: Hex; timestamp: Hex }>("eth_getBlockByNumber", [`0x${forkBlock.toString(16)}`, false]);
  return {
    url,
    block: forkBlock,
    blockHash: block.hash,
    timestamp: BigInt(block.timestamp),
    hardfork: info.hardFork,
    network: info.network,
    rpc,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited;
      }
    },
  };
}

export interface Measurement {
  readonly estimate: number;
  readonly gasUsed: number;
}

export interface Balances {
  readonly payer: bigint;
  readonly payee: bigint;
  readonly payLink: bigint;
}

export interface PaymentProof {
  readonly route: "permit" | "approve-pay" | "native";
  readonly amount: bigint;
  readonly txHash: Hex;
  readonly gasLimit: bigint;
  readonly gasUsed: bigint;
  /** gasUsed × effectiveGasPrice, in BTC base units: what the payer paid the chain on top of the amount. */
  readonly gasFee: bigint;
  readonly before: Balances;
  readonly after: Balances;
  readonly allowanceAfter: bigint | null;
  readonly permitNonce: { readonly before: bigint; readonly after: bigint } | null;
  readonly receipt: { readonly valid: boolean; readonly amount: bigint | null; readonly payer: Address | null; readonly payee: Address | null; readonly key: Hex | null };
  readonly linkState: { readonly payments: number; readonly total: bigint };
  /** The decoded error of a second payment of the same one-payment invoice (`SoldOut`), or null if it would pass. */
  readonly secondPayment: string | null;
}

export interface Rehearsal {
  readonly fork: { readonly rpc: string; readonly block: bigint; readonly blockHash: Hex; readonly timestamp: bigint; readonly hardfork: string; readonly network: string };
  readonly chainId: number;
  readonly factory: { readonly address: Address; readonly runtimeIsCanonical: boolean };
  readonly musd: { readonly domainSeparatorMatches: boolean; readonly name: string; readonly version: string; readonly borrowerOperationsMints: boolean };
  readonly deployment: {
    readonly planned: { readonly kind: string; readonly method: string; readonly address: Address | null };
    readonly txHash: Hex;
    readonly estimate: bigint;
    readonly gasLimit: bigint;
    readonly gasUsed: bigint;
    readonly address: Address;
    readonly checks: readonly { readonly id: string; readonly ok: boolean }[];
    readonly verified: boolean;
    readonly record: string;
    readonly cliRecordIdentical: boolean;
    readonly liveEstimate: bigint | null;
  };
  readonly routes: { readonly eoa: Route; readonly smartAccount: Route; readonly authorizationRefusedBySdk: string | null };
  readonly payments: readonly PaymentProof[];
  readonly authorization: { readonly reverted: boolean; readonly revertData: string | null };
  readonly cancelBySig: { readonly txHash: Hex; readonly sender: Address; readonly cancelled: boolean; readonly gasUsed: bigint };
  readonly measurements: Readonly<Record<string, Measurement>> | null;
}

interface Context {
  readonly fork: Fork;
  readonly client: PublicClient;
  readonly chain: ChainDefinition;
  readonly registry: Registry;
  readonly payLink: Address;
}

/**
 * The receipt of a transaction anvil accepted. Polled directly: anvil answers eth_sendRawTransaction before it mines,
 * and with automine no later block comes to wake a block-driven waiter (viem's waitForTransactionReceipt) that read
 * the chain in between.
 */
async function mined(client: PublicClient, hash: Hex): Promise<TransactionReceipt> {
  for (let i = 0; i < 1_200; i += 1) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) {
        throw error;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`mezo-fork: ${hash} was not mined within 60 s`);
}

/** Sends a transaction from a fork-only key with an explicit gas limit and waits for its receipt. */
async function send(
  ctx: Pick<Context, "fork" | "client">,
  from: PrivateKeyAccount,
  call: { readonly to: Address | null; readonly data: Hex; readonly value?: bigint },
  gas: bigint,
): Promise<{ hash: Hex; gasUsed: bigint; gasFee: bigint; status: string; logs: readonly { address: Address; topics: readonly Hex[]; data: Hex; logIndex: number }[] }> {
  const chain = toViemChain(defineLocalChain({ chainId: MEZO.chainId, rpcUrl: ctx.fork.url, tokens: [], deployment: null }));
  const wallet = createWalletClient({ account: from, chain, transport: http(ctx.fork.url) });
  const hash = await wallet.sendTransaction({ account: from, chain, data: call.data, value: call.value ?? 0n, gas, ...(call.to === null ? {} : { to: call.to }) });
  const receipt = await mined(ctx.client, hash);
  return {
    hash,
    gasUsed: receipt.gasUsed,
    gasFee: receipt.gasUsed * receipt.effectiveGasPrice,
    status: receipt.status,
    logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })),
  };
}

async function estimate(ctx: Pick<Context, "client">, from: Address, call: { readonly to: Address | null; readonly data: Hex; readonly value?: bigint }): Promise<bigint> {
  return await ctx.client.estimateGas({ account: from, data: call.data, value: call.value ?? 0n, ...(call.to === null ? {} : { to: call.to }) });
}

const erc20Read = async (ctx: Pick<Context, "client">, token: Address, functionName: "balanceOf" | "nonces", args: readonly [Address]): Promise<bigint> =>
  await ctx.client.readContract({ address: token, abi: MUSD_ABI, functionName, args });

const balances = async (ctx: Context, token: Address, payer: Address, payee: Address): Promise<Balances> =>
  token === zeroAddress
    ? { payer: await ctx.client.getBalance({ address: payer }), payee: await ctx.client.getBalance({ address: payee }), payLink: await ctx.client.getBalance({ address: ctx.payLink }) }
    : { payer: await erc20Read(ctx, token, "balanceOf", [payer]), payee: await erc20Read(ctx, token, "balanceOf", [payee]), payLink: await erc20Read(ctx, token, "balanceOf", [ctx.payLink]) };

/** Mints test MUSD the way a borrow does: BorrowerOperations, which is on MUSD's mintList, calls `mint`. */
async function mintMusd(ctx: Pick<Context, "fork" | "client">, to: Address, amount: bigint): Promise<void> {
  await ctx.fork.rpc("anvil_impersonateAccount", [MEZO.borrowerOperations]);
  await ctx.fork.rpc("anvil_setBalance", [MEZO.borrowerOperations, "0xde0b6b3a7640000"]);
  const hash = await ctx.fork.rpc<Hex>("eth_sendTransaction", [{ from: MEZO.borrowerOperations, to: MEZO.musd, data: encodeFunctionData({ abi: MUSD_ABI, functionName: "mint", args: [to, amount] }) }]);
  const receipt = await mined(ctx.client, hash);
  await ctx.fork.rpc("anvil_stopImpersonatingAccount", [MEZO.borrowerOperations]);
  expect(receipt.status === "success", "minting test MUSD through BorrowerOperations failed");
}

async function fund(fork: Fork, client: PublicClient, accounts: readonly PrivateKeyAccount[]): Promise<void> {
  for (const a of accounts) {
    // Fork-only accounts must be fresh on Mezo testnet too: no code (an EIP-7702 delegation would change every route).
    expect((await client.getCode({ address: a.address })) === undefined, `${a.address} has code on Mezo testnet; pick another label`);
    await fork.rpc("anvil_setBalance", [a.address, "0xde0b6b3a7640000"]);
  }
}

/** The PayLinkV2 release on the fork, deployed exactly as the deploy kit plans it, verified by the kit and the CLI. */
async function deployWithKit(fork: Fork, client: PublicClient, deployer: PrivateKeyAccount, liveEstimate: boolean): Promise<Rehearsal["deployment"] & { readonly deploymentRecord: Deployment }> {
  const data = parseReleaseData(readJson("web/v2/deploy/data/release.json"));
  const chains = parseChainsData(readJson("web/v2/deploy/data/chains.json"));
  // The kit's chain entry for Mezo testnet, as it plans before any record ships (the e2e suite does the same).
  const chain = { ...chainOrThrow(chains, MEZO.chainId), deployment: null };
  const read = reader(httpRpc([fork.url], { timeoutMs: 60_000 }));
  expect((await read.chainId()) === MEZO.chainId, "the fork is not chain 31611");
  const factory = data.release.create2.factory;
  const [factoryCode, create2Code, nonce] = await Promise.all([read.code(factory), read.code(data.release.create2.address), read.pendingNonce(deployer.address)]);
  const plan = planDeployment({ data, chain, factoryCode, create2Code, recordedCode: null, deployer: deployer.address, nonce });
  expect(plan.kind === "deploy" && plan.method === "CREATE2", `the kit plans ${plan.kind} ${plan.method} on the fork, not a CREATE2 deployment`);
  expect(plan.expectedAddress === RELEASE.create2.address, `the kit expects ${plan.expectedAddress}, not the release address`);
  const est = await read.estimateGas({ from: deployer.address, to: plan.to, data: plan.data });
  const gasLimit = clampGasLimit(est, plan.gas);
  let live: bigint | null = null;
  if (liveEstimate) {
    // Read-only: Mezo testnet's own estimator, for the same call from the same (empty) account.
    live = BigInt(await jsonRpc<Hex>(MEZO.rpc, "eth_estimateGas", [{ from: deployer.address, to: plan.to, data: plan.data, value: "0x0" }]));
  }
  const sent = await send({ fork, client }, deployer, { to: plan.to, data: plan.data }, gasLimit);
  expect(sent.status === "success", "the deployment transaction reverted on the fork");
  const verification = await verifyDeployment({ read, data, chain, address: plan.expectedAddress, txHash: sent.hash });
  expect(verification.record !== null, `the kit's verifier refused the deployment: ${verification.checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}`);
  let stdout = "";
  const status = await verifyCli(["--chain", String(MEZO.chainId), "--address", plan.expectedAddress, "--tx", sent.hash, "--rpc", fork.url, "--out", "-"], {
    stdout: (s: string) => (stdout += s),
    stderr: () => undefined,
  });
  const block = await client.getTransactionReceipt({ hash: sent.hash });
  const code = (await client.getCode({ address: plan.expectedAddress })) ?? "0x";
  return {
    planned: { kind: plan.kind, method: plan.method, address: plan.expectedAddress },
    txHash: sent.hash,
    estimate: est,
    gasLimit,
    gasUsed: sent.gasUsed,
    address: plan.expectedAddress,
    checks: verification.checks.map((c) => ({ id: c.id, ok: c.ok })),
    verified: verification.ok,
    record: verification.record,
    cliRecordIdentical: status === 0 && stdout === verification.record,
    liveEstimate: live,
    deploymentRecord: {
      address: plan.expectedAddress,
      status: "active",
      release: RELEASE.release,
      method: "CREATE2",
      deployer: deployer.address,
      txHash: sent.hash,
      blockNumber: block.blockNumber,
      initCodeHash: RELEASE.initCodeHash,
      maskedRuntimeHash: RELEASE.maskedRuntimeHash,
      runtimeCodeHash: keccak256(code),
    },
  };
}

/** The Paid log this transaction emitted for this invoice and payer (apps/web/src/rails/wallet.ts paidLogIndex). */
function paidLogIndex(logs: readonly { address: Address; topics: readonly Hex[]; data: Hex; logIndex: number }[], payLink: Address, link: DecodedInvoiceLink, payer: Address): number {
  for (const log of logs) {
    if (log.address.toLowerCase() !== payLink.toLowerCase()) {
      continue;
    }
    const event = decodePaidLog({ address: log.address, topics: [...log.topics], data: log.data, logIndex: log.logIndex });
    if (event?.key === link.key.toLowerCase() && event.payer.toLowerCase() === payer.toLowerCase()) {
      return log.logIndex;
    }
  }
  throw new Error("mezo-fork: the transaction emitted no Paid event for this invoice");
}

async function issue(ctx: Context, payee: PrivateKeyAccount, token: Address, amount: bigint, maxPayments: number, label: string): Promise<DecodedInvoiceLink> {
  const issued = await issueInvoice({
    registry: ctx.registry,
    chainId: MEZO.chainId,
    draft: { payee: payee.address, token, amount, maxPayments, validAfter: 0n, expiry: { kind: "at", validUntil: ctx.fork.timestamp + 7n * DAY }, memo: `Mezo fork rehearsal: ${label}`, salt: salt(label) },
    signer: payee,
    client: ctx.client,
  });
  return decodeInvoiceFragment(issued.fragment, ctx.registry);
}

/** Pays one invoice on one wallet-rail route, as apps/web/src/rails/wallet.ts does, and proves the receipt. */
async function payAndProve(ctx: Context, route: PaymentProof["route"], link: DecodedInvoiceLink, payer: PrivateKeyAccount, payee: Address): Promise<PaymentProof> {
  const token = link.invoice.token;
  const amount = link.invoice.amount;
  const before = await balances(ctx, token, payer.address, payee);
  const nonceBefore = route === "permit" ? await erc20Read(ctx, token, "nonces", [payer.address]) : null;
  let call: CallRequest;
  let fn: PayLinkFunction;
  if (route === "permit") {
    const prepared = await preparePermitPayment({ link, signer: payer, client: ctx.client, deadline: ctx.fork.timestamp + PERMIT_TTL_SECONDS + DAY });
    call = prepared.call;
    fn = "payWithPermit";
  } else if (route === "approve-pay") {
    const approve = approveCall(token, ctx.payLink, amount);
    const approveEstimate = await estimate(ctx, payer.address, approve);
    const approved = await send(ctx, payer, approve, (approveEstimate * 110n + 99n) / 100n);
    expect(approved.status === "success", "approve reverted");
    call = payCall(ctx.payLink, link.invoice, link.signature, amount);
    fn = "pay";
  } else {
    call = payNativeCall(ctx.payLink, link.invoice, link.signature, amount);
    fn = "payNative";
  }
  // The registry's bounds for this function on Mezo testnet: refused (E_GAS_ABOVE_CEILING) if the estimate exceeds them.
  const gasLimit = gasLimitFor(ctx.chain, fn, await estimate(ctx, payer.address, call));
  const sent = await send(ctx, payer, call, gasLimit);
  expect(sent.status === "success", `${fn} reverted`);
  const logIndex = paidLogIndex(sent.logs, ctx.payLink, link, payer.address);
  const verification = await verifyReceipt({ registry: ctx.registry, client: ctx.client, reference: { chainId: MEZO.chainId, txHash: sent.hash, logIndex }, paid: link });
  const after = await balances(ctx, token, payer.address, payee);
  const state = await readLinkState(ctx.client, ctx.payLink, link.key);
  // A second payment of this one-payment invoice: refused by PayLinkV2 itself (SoldOut), checked before any token pull.
  let secondPayment: string | null = null;
  try {
    await estimate(ctx, payer.address, route === "native" ? call : payCall(ctx.payLink, link.invoice, link.signature, amount));
  } catch (error) {
    secondPayment = decodeError(error).name;
  }
  return {
    route,
    amount,
    txHash: sent.hash,
    gasLimit,
    gasUsed: sent.gasUsed,
    gasFee: sent.gasFee,
    before,
    after,
    allowanceAfter: token === zeroAddress ? null : await ctx.client.readContract({ address: token, abi: MUSD_ABI, functionName: "allowance", args: [payer.address, ctx.payLink] }),
    permitNonce: nonceBefore === null ? null : { before: nonceBefore, after: await erc20Read(ctx, token, "nonces", [payer.address]) },
    receipt: verification.valid
      ? { valid: true, amount: verification.proof.amount, payer: verification.proof.payer, payee: verification.proof.payee, key: verification.proof.key }
      : { valid: false, amount: null, payer: null, payee: null, key: null },
    linkState: { payments: state.payments, total: state.total },
    secondPayment,
  };
}

/** The registry the SDK sees on the fork: Mezo testnet's own tokens and gas table, the fork's RPC and deployment. */
function forkRegistry(fork: Fork, deployment: Deployment, extraTokens: readonly Token[] = []): { registry: Registry; chain: ChainDefinition } {
  const chain = defineLocalChain({
    chainId: MEZO.chainId,
    rpcUrl: fork.url,
    name: "Mezo testnet (anvil fork)",
    editions: ["mezo"],
    tokens: [...mezoTestnet.tokens, ...extraTokens],
    deployment,
    ...(mezoTestnet.gas === null ? {} : { gas: mezoTestnet.gas }),
    chargesGasLimit: mezoTestnet.gasModel.chargesGasLimit,
  });
  const registry = createRegistry([chain]);
  return { registry, chain: registry.getOrThrow(MEZO.chainId) };
}

/**
 * The gas of every entry point on the fork, scenario by scenario as packages/sdk/scripts/measure-gas.ts measures it:
 * eth_estimateGas (what a client clamps), then the transaction sent with exactly that limit and its receipt's gas used.
 */
async function measureEntryPoints(base: Context, deployer: PrivateKeyAccount, deployment: Pick<Rehearsal["deployment"], "estimate" | "gasUsed">): Promise<Record<string, Measurement>> {
  const measurements: Record<string, Measurement> = {};
  const payer = account("measure.payer");
  const relayer = account("measure.relayer");
  const walletOwner = account("measure.wallet.owner");
  const payees = Array.from({ length: 10 }, (_, i) => account(`measure.payee.${String(i + 1)}`));
  await fund(base.fork, base.client, [payer, relayer, walletOwner, ...payees]);
  await mintMusd(base, payer.address, 1_000n * MUSD);

  // The repository's mocks where Mezo has nothing to measure against: an EIP-3009 token, an ERC-1271 payee.
  const deployMock = async (data: Hex): Promise<Address> => {
    const est = await estimate(base, deployer.address, { to: null, data });
    const sent = await send(base, deployer, { to: null, data }, est);
    const receipt = await base.client.getTransactionReceipt({ hash: sent.hash });
    expect(sent.status === "success" && receipt.contractAddress !== null && receipt.contractAddress !== undefined, "mock deployment failed");
    return getAddress(receipt.contractAddress);
  };
  const usdc = await deployMock(encodeDeployData({ abi: parseAbi(["constructor(string,string,string,uint8)"]), bytecode: artifact("Mock3009.sol/Mock3009.json"), args: ["USD Coin", "USDC", "2", 6] }));
  const wallet1271 = await deployMock(encodeDeployData({ abi: parseAbi(["constructor(address)"]), bytecode: artifact("Wallet1271.sol/Wallet1271.json"), args: [walletOwner.address] }));
  const minted = await send(base, deployer, { to: usdc, data: encodeFunctionData({ abi: MOCK_ABI, functionName: "mint", args: [payer.address, 10n ** 12n] }) }, 100_000n);
  expect(minted.status === "success", "Mock3009 mint failed");
  const mock3009: Erc20Token = {
    kind: "erc20",
    symbol: "USDC",
    name: "Mock3009 (measurement only)",
    address: usdc,
    decimals: 6,
    capabilities: { eip3009: true, eip2612: true, native: false },
    eip712Domain: { name: "USD Coin", version: "2" },
    listing: "listed",
    confidence: "C",
    pendingVerification: [],
  };
  const record = base.chain.deployment;
  expect(record !== null, "no deployment to measure against");
  const { registry, chain } = forkRegistry(base.fork, record, [mock3009]);
  const ctx: Context = { ...base, registry, chain };

  const measure = async (name: string, from: PrivateKeyAccount, call: CallRequest): Promise<void> => {
    const est = await estimate(ctx, from.address, call);
    const sent = await send(ctx, from, call, est);
    expect(sent.status === "success", `${name} reverted`);
    measurements[name] = { estimate: Number(est), gasUsed: Number(sent.gasUsed) };
  };
  const now = ctx.fork.timestamp;
  const link = async (label: string, signer: TypedDataSigner, token: Address, amount: bigint, maxPayments: number): Promise<DecodedInvoiceLink> => {
    const issued = await issueInvoice({
      registry,
      chainId: MEZO.chainId,
      draft: { payee: signer.address, token, amount, maxPayments, validAfter: 0n, expiry: { kind: "at", validUntil: now + 7n * DAY }, salt: salt(`measure.${label}`) },
      signer,
      client: ctx.client,
    });
    return decodeInvoiceFragment(issued.fragment, registry);
  };
  const p = (i: number): PrivateKeyAccount => payees[i - 1] ?? payer;
  const authorize = async (l: DecodedInvoiceLink, label: string, amount?: bigint): Promise<CallRequest> => {
    const auth = await authorizePayment({ link: l, signer: payer, now, ttlSeconds: DAY, outstanding: null, ...(amount === undefined ? {} : { amount }), random: () => hexToBytes(salt(`measure.payer.${label}`)) });
    return payWithAuthorizationCall(ctx.payLink, l.invoice, l.signature, auth.authorization);
  };
  const smart: TypedDataSigner = { address: wallet1271, signTypedData: async (t) => await walletOwner.signTypedData(t) };

  // payWithAuthorization (Mock3009: Mezo lists no EIP-3009 token): first payment, a later one on an unlimited link, an ERC-1271 payee.
  await measure("payWithAuthorization_first", relayer, await authorize(await link("3009.first", p(1), usdc, 25_000_000n, 1), "3009.first"));
  const unlimited3009 = await link("3009.repeat", p(2), usdc, 0n, 0);
  await send(ctx, relayer, await authorize(unlimited3009, "3009.warmup", 7_000_000n), 300_000n);
  await measure("payWithAuthorization_repeat", relayer, await authorize(unlimited3009, "3009.repeat", 7_000_000n));
  await measure("payWithAuthorization_erc1271Payee", relayer, await authorize(await link("3009.1271", smart, usdc, 25_000_000n, 1), "3009.1271"));

  // pay with MUSD (allowance): exact approve first, then pay.
  const payWithAllowance = async (name: string | null, l: DecodedInvoiceLink, amount: bigint): Promise<void> => {
    const approve = approveCall(MEZO.musd, ctx.payLink, amount);
    await send(ctx, payer, approve, 100_000n);
    const call = payCall(ctx.payLink, l.invoice, l.signature, amount);
    if (name === null) {
      await send(ctx, payer, call, 300_000n);
    } else {
      await measure(name, payer, call);
    }
  };
  await payWithAllowance("pay_first", await link("pay.first", p(4), MEZO.musd, 1_500_000_000_000_000_000n, 1), 1_500_000_000_000_000_000n);
  const unlimitedPay = await link("pay.repeat", p(5), MEZO.musd, 0n, 0);
  await payWithAllowance(null, unlimitedPay, MUSD);
  await payWithAllowance("pay_repeat", unlimitedPay, MUSD);

  // payWithPermit with MUSD: one transaction, permit nonce 0 -> 1, payee new to MUSD.
  const permitted = await preparePermitPayment({ link: await link("permit.first", p(6), MEZO.musd, 2n * MUSD, 1), signer: payer, client: ctx.client, deadline: now + DAY });
  await measure("payWithPermit_first", payer, permitted.call);

  // payNative in BTC: first payment to an account with no balance, then a later one.
  const nativeOnce = await link("native.first", account("measure.native.payee.empty"), zeroAddress, 10n ** 15n, 1);
  await measure("payNative_first", payer, payNativeCall(ctx.payLink, nativeOnce.invoice, nativeOnce.signature, 10n ** 15n));
  const nativeMany = await link("native.repeat", p(8), zeroAddress, 0n, 0);
  await send(ctx, payer, payNativeCall(ctx.payLink, nativeMany.invoice, nativeMany.signature, 10n ** 15n), 200_000n);
  await measure("payNative_repeat", payer, payNativeCall(ctx.payLink, nativeMany.invoice, nativeMany.signature, 10n ** 15n));

  // cancel by the payee, cancelBySig sent by a third party, and for an ERC-1271 payee (MUSD invoices).
  await measure("cancel", p(9), cancelCall(ctx.payLink, (await link("cancel", p(9), MEZO.musd, 25n * MUSD, 1)).invoice));
  const target = { chainId: MEZO.chainId, verifyingContract: ctx.payLink };
  const bySig = await link("cancelBySig", p(10), MEZO.musd, 25n * MUSD, 1);
  await measure("cancelBySig", relayer, cancelBySigCall(ctx.payLink, await signCancel({ signer: p(10), deployment: target, invoice: bySig.invoice, deadline: now + DAY })));
  const bySig1271 = await link("cancelBySig.1271", smart, MEZO.musd, 25n * MUSD, 1);
  await measure("cancelBySig_erc1271Payee", relayer, cancelBySigCall(ctx.payLink, await signCancel({ signer: smart, deployment: target, invoice: bySig1271.invoice, deadline: now + DAY, client: ctx.client })));

  // Deployments: CREATE2 as the kit sent it (above), and a plain CREATE from a fresh account (Deploy.s.sol's fallback).
  measurements["deploy_create2"] = { estimate: Number(deployment.estimate), gasUsed: Number(deployment.gasUsed) };
  const creator = account("measure.creator");
  await fund(ctx.fork, ctx.client, [creator]);
  const initCode = artifact("PayLinkV2.sol/PayLinkV2.json");
  expect(keccak256(initCode) === RELEASE.initCodeHash, "protocol/out is not the release build of PayLinkV2 (run forge build)");
  const createEstimate = await estimate(ctx, creator.address, { to: null, data: initCode });
  const created = await send(ctx, creator, { to: null, data: initCode }, createEstimate);
  expect(created.status === "success", "the CREATE deployment reverted");
  measurements["deploy_create"] = { estimate: Number(createEstimate), gasUsed: Number(created.gasUsed) };
  return Object.fromEntries(Object.entries(measurements).sort(([a], [b]) => a.localeCompare(b)));
}

/** Runs the whole rehearsal on a fresh fork. */
export async function rehearse(options: { readonly block?: bigint; readonly measure?: boolean; readonly liveEstimate?: boolean } = {}): Promise<Rehearsal> {
  const fork = await startFork(options.block === undefined ? {} : { block: options.block });
  try {
    const viemChain = toViemChain(defineLocalChain({ chainId: MEZO.chainId, rpcUrl: fork.url, tokens: [], deployment: null }));
    const client = createPublicClient({ chain: viemChain, transport: http(fork.url), pollingInterval: 50 }) as PublicClient;
    const deployer = account("deployer");
    await fund(fork, client, [deployer]);

    // Facts the rehearsal relies on, read on the fork (that is, from Mezo testnet's state at the fork block).
    const factoryRuntime = (parseReleaseData(readJson("web/v2/deploy/data/release.json")).factoryRuntime).toLowerCase();
    const factoryCode = ((await client.getCode({ address: RELEASE.create2.factory })) ?? "0x").toLowerCase();
    const [, domainName, domainVersion, domainChainId, domainContract] = await client.readContract({ address: MEZO.musd, abi: MUSD_ABI, functionName: "eip712Domain" });
    const separator = await client.readContract({ address: MEZO.musd, abi: MUSD_ABI, functionName: "DOMAIN_SEPARATOR" });
    const recomputed = keccak256(
      concat([
        keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(stringToHex(domainName)),
        keccak256(stringToHex(domainVersion)),
        `0x${domainChainId.toString(16).padStart(64, "0")}`,
        `0x${domainContract.slice(2).toLowerCase().padStart(64, "0")}`,
      ]),
    );
    const mints = (await client.readContract({ address: MEZO.musd, abi: MUSD_ABI, functionName: "mintList", args: [MEZO.borrowerOperations] })) && (await client.readContract({ address: MEZO.borrowerOperations, abi: BORROWER_OPERATIONS_ABI, functionName: "musd" })) === MEZO.musd;
    expect(mints, "BorrowerOperations is not on MUSD's mintList at the fork block");

    // 1. Deploy with the kit.
    const deployment = await deployWithKit(fork, client, deployer, options.liveEstimate === true);
    const { registry, chain } = forkRegistry(fork, deployment.deploymentRecord);
    const ctx: Context = { fork, client, chain, registry, payLink: deployment.address };

    // 2. Pay MUSD invoices by every route the token allows, and prove each payment.
    const payer = account("payer");
    const payeeA = account("payee.a");
    const payeeB = account("payee.b");
    const payeeC = account("payee.c");
    const payeeD = account("payee.d");
    const payeeE = account("payee.e");
    const relayer = account("relayer");
    await fund(fork, client, [payer, payeeA, payeeB, payeeC, payeeD, payeeE, relayer]);
    await mintMusd(ctx, payer.address, 100n * MUSD);

    const permitLink = await issue(ctx, payeeA, MEZO.musd, 125n * MUSD / 10n, 1, "invoice A, permit");
    const eoa = selectPaymentPath({ capabilities: permitLink.token.capabilities, account: payerAccountKind(await client.getCode({ address: payer.address })), relayerHealthy: true, outstanding: null });
    const smartAccount = selectPaymentPath({ capabilities: permitLink.token.capabilities, account: "smart-account", relayerHealthy: true, outstanding: null });
    let authorizationRefusedBySdk: string | null = null;
    try {
      await authorizePayment({ link: permitLink, signer: payer, now: fork.timestamp, outstanding: null });
    } catch (error) {
      authorizationRefusedBySdk = isPayLinkError(error) ? error.code : String(error);
    }
    const payments: PaymentProof[] = [];
    payments.push(await payAndProve(ctx, "permit", permitLink, payer, payeeA.address));
    payments.push(await payAndProve(ctx, "approve-pay", await issue(ctx, payeeB, MEZO.musd, 125n * MUSD / 10n, 1, "invoice B, approve then pay"), payer, payeeB.address));
    payments.push(await payAndProve(ctx, "native", await issue(ctx, payeeE, zeroAddress, 10n ** 14n, 1, "invoice E, native BTC"), payer, payeeE.address));

    // payWithAuthorization: signed under MUSD's own domain anyway, it cannot settle (MUSD has no receiveWithAuthorization).
    const authLink = await issue(ctx, payeeC, MEZO.musd, 125n * MUSD / 10n, 1, "invoice C, authorisation");
    const signed = await signReceiveAuthorization({
      signer: payer,
      tokenDomain: { name: domainName, version: domainVersion, chainId: MEZO.chainId, verifyingContract: MEZO.musd },
      verifyingContract: ctx.payLink,
      key: authLink.key,
      amount: authLink.invoice.amount,
      validBefore: fork.timestamp + 600n,
      payerSalt: salt("invoice C payer salt"),
    });
    const authCall = payWithAuthorizationCall(ctx.payLink, authLink.invoice, authLink.signature, signed.authorization);
    let revertData: string | null = null;
    let reverted = false;
    try {
      await fork.rpc("eth_call", [{ from: relayer.address, to: authCall.to, data: authCall.data }, "latest"]);
    } catch (error) {
      reverted = true;
      const data = (error as { data?: unknown }).data;
      revertData = typeof data === "string" ? data : null;
    }

    // cancelBySig: the payee signs, a third party sends (what the relayer could do for merchants on Mezo).
    const cancelLink = await issue(ctx, payeeD, MEZO.musd, 10n * MUSD, 1, "invoice D, cancelled by signature");
    const cancel = await signCancel({ signer: payeeD, deployment: { chainId: MEZO.chainId, verifyingContract: ctx.payLink }, invoice: cancelLink.invoice, deadline: fork.timestamp + DAY, client });
    const cancelCallRequest = cancelBySigCall(ctx.payLink, cancel);
    const cancelSent = await send(ctx, relayer, cancelCallRequest, gasLimitFor(chain, "cancelBySig", await estimate(ctx, relayer.address, cancelCallRequest)));
    const cancelled = (await readLinkState(client, ctx.payLink, cancelLink.key)).cancelled;

    // 3. Measure every entry point (optional).
    const measurements = options.measure === true ? await measureEntryPoints(ctx, deployer, deployment) : null;

    return {
      fork: { rpc: MEZO.rpc, block: fork.block, blockHash: fork.blockHash, timestamp: fork.timestamp, hardfork: fork.hardfork, network: fork.network },
      chainId: await client.getChainId(),
      factory: { address: RELEASE.create2.factory, runtimeIsCanonical: factoryCode === factoryRuntime },
      musd: { domainSeparatorMatches: separator === recomputed, name: domainName, version: domainVersion, borrowerOperationsMints: mints },
      deployment: {
        planned: deployment.planned,
        txHash: deployment.txHash,
        estimate: deployment.estimate,
        gasLimit: deployment.gasLimit,
        gasUsed: deployment.gasUsed,
        address: deployment.address,
        checks: deployment.checks,
        verified: deployment.verified,
        record: deployment.record,
        cliRecordIdentical: deployment.cliRecordIdentical,
        liveEstimate: deployment.liveEstimate,
      },
      routes: { eoa, smartAccount, authorizationRefusedBySdk },
      payments,
      authorization: { reverted, revertData },
      cancelBySig: { txHash: cancelSent.hash, sender: relayer.address, cancelled, gasUsed: cancelSent.gasUsed },
      measurements,
    };
  } finally {
    await fork.stop();
  }
}

/** packages/chains/data/fork-gas-measurements.json, in the format scripts/generate.ts of @paylink/chains reads. */
export function measurementsFile(r: Rehearsal, tool: string): string {
  if (r.measurements === null) {
    throw new Error("mezo-fork: run with measure: true");
  }
  return `${JSON.stringify(
    {
      schema: "paylink.fork-gas-measurements/1",
      generator: "tools/deploy-page/scripts/mezo-fork.ts",
      tool,
      initCodeHash: RELEASE.initCodeHash,
      profiles: {
        mezo: {
          chainId: r.chainId,
          fork: { rpc: r.fork.rpc, block: Number(r.fork.block), blockHash: r.fork.blockHash, timestamp: Number(r.fork.timestamp) },
          hardfork: r.fork.hardfork,
          network: r.fork.network,
          appliesTo: [MEZO.chainId],
          tokens:
            "MUSD 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 (pay, payWithPermit, cancel, cancelBySig) and native BTC (payNative) as Mezo testnet holds them; protocol/test/mocks Mock3009 (payWithAuthorization: Mezo lists no EIP-3009 token) and Wallet1271 (ERC-1271 payee), deployed on the fork",
          measurements: r.measurements,
        },
      },
    },
    null,
    2,
  )}\n`;
}

const bigintJson = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

function summary(r: Rehearsal): string {
  const lines = [
    `Mezo testnet fork at block ${r.fork.block.toString()} (${r.fork.blockHash}), chain ${String(r.chainId)}, anvil hardfork ${r.fork.hardfork}`,
    `factory ${r.factory.address}: canonical runtime ${String(r.factory.runtimeIsCanonical)}`,
    `MUSD domain ${r.musd.name}/${r.musd.version}, DOMAIN_SEPARATOR recomputed: ${String(r.musd.domainSeparatorMatches)}`,
    `deploy: kit planned ${r.deployment.planned.kind} ${r.deployment.planned.method} -> ${String(r.deployment.planned.address)}; estimate ${r.deployment.estimate.toString()}, limit ${r.deployment.gasLimit.toString()}, used ${r.deployment.gasUsed.toString()}${r.deployment.liveEstimate === null ? "" : `; Mezo testnet's own estimate ${r.deployment.liveEstimate.toString()}`}`,
    `deploy: ${String(r.deployment.checks.filter((c) => c.ok).length)}/${String(r.deployment.checks.length)} kit checks pass; verified ${String(r.deployment.verified)}; CLI record byte-identical ${String(r.deployment.cliRecordIdentical)}`,
    `routes: EOA ${r.routes.eoa.available ? [r.routes.eoa.path, ...r.routes.eoa.fallbacks].join(" > ") : "none"}; smart account ${r.routes.smartAccount.available ? [r.routes.smartAccount.path, ...r.routes.smartAccount.fallbacks].join(" > ") : "none"}; SDK authorisation: ${r.routes.authorizationRefusedBySdk ?? "allowed"}`,
    ...r.payments.map(
      (p) =>
        `pay ${p.route}: ${p.amount.toString()} asked; payee +${(p.after.payee - p.before.payee).toString()}, payer -${(p.before.payer - p.after.payer - (p.route === "native" ? p.gasFee : 0n)).toString()}${p.route === "native" ? " (after its gas fee)" : ""}, PayLink ${p.after.payLink.toString()}; receipt valid ${String(p.receipt.valid)}; gas ${p.gasUsed.toString()} of ${p.gasLimit.toString()} (fee ${p.gasFee.toString()} wei of BTC); second payment: ${p.secondPayment ?? "accepted"}`,
    ),
    `payWithAuthorization with MUSD: reverted ${String(r.authorization.reverted)} (${r.authorization.revertData ?? "no data"})`,
    `cancelBySig sent by a third party: cancelled ${String(r.cancelBySig.cancelled)}, gas ${r.cancelBySig.gasUsed.toString()}`,
  ];
  return `${lines.join("\n")}\n`;
}

async function anvilVersion(): Promise<string> {
  return await new Promise<string>((done) => {
    const child = spawn(anvilBinary(), ["--version"]);
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.on("close", () => {
      done(/anvil Version: (\S+)/.exec(text)?.[1] ?? "unknown");
    });
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf("--block");
  const block = at === -1 ? undefined : BigInt(argv[at + 1] ?? "");
  const measure = argv.includes("--measure");
  const r = await rehearse({ ...(block === undefined ? {} : { block }), measure, liveEstimate: argv.includes("--live-estimate") });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(r, bigintJson, 2));
  } else {
    process.stdout.write(summary(r));
  }
  if (measure) {
    writeFileSync(OUTPUT, measurementsFile(r, `anvil ${await anvilVersion()}`));
    console.error(`wrote ${OUTPUT}; next: pnpm --filter @paylink/chains run generate`);
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
