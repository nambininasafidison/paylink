// SPDX-License-Identifier: MIT
/**
 * Ethereum Sepolia (11155111) rehearsed on an anvil fork (ADR 0018): what the owner will do with the deploy kit, then
 * what payers of the PayPal edition will do with Circle USDC and PayPal USD, against the chain's real state (the
 * CREATE2 factory, both tokens as deployed), with nothing sent to Sepolia. Every key is derived from a public label and
 * lives only on the fork.
 *
 * 1. Facts. The fork is chain 11155111; the factory holds the canonical runtime; each token's `DOMAIN_SEPARATOR()` is
 *    the registry's stated domain; PYUSD has neither `eip712Domain()` nor `version()`, and the SDK still resolves its
 *    domain (proven against the separator, packages/sdk/src/token-domain.ts).
 * 2. Deploy. The kit's own planning (web/v2/deploy/lib/core.js) plans CREATE2 to the release address; the transaction
 *    carries the kit's gas clamp; the kit's verifier and tools/verify-deployment, reading the fork on their own, print
 *    the same record.
 * 3. Pay. With no relayer on this chain (ADR 0018), the router offers a code-less payer `self-authorization` (EIP-3009,
 *    the payer submits) then `permit`. Each token is paid both ways with @paylink/sdk, exactly as the web app's rails
 *    do; each payment moves exactly the amount, leaves PayLinkV2 empty, verifies with `verifyReceipt`, fits the
 *    registry's gas bounds (`gasLimitFor` refuses an estimate above the ceiling), and a second payment of the
 *    one-payment invoice is `SoldOut`. PYUSD's silent no-op on a used EIP-3009 nonce is shown to fail closed
 *    (PayLinkV2 reverts `ReceivedMismatch`).
 * 4. Measure (`--measure`). The gas of every entry point, scenario by scenario as packages/sdk/scripts/measure-gas.ts
 *    measures it (eth_estimateGas, then the receipt's gas used), with Circle USDC and native Sepolia ETH as the chain
 *    holds them and the repository's Wallet1271 for an ERC-1271 payee; the deployment as the kit sends it, without its
 *    clamp. Written as the `sepolia` profile of packages/chains/data/fork-gas-measurements.json (the other profiles
 *    kept), from which the registry derives Ethereum Sepolia's gas table and the kit its deployment bounds.
 *
 * The fork runs the chain's own EVM rules for its block: no `--hardfork` pin. Ethereum Sepolia runs Amsterdam
 * (anvil's `anvil_nodeInfo` on the fork; the chain's blocks carry `blockAccessListHash`, EIP-7928), whose state-creation
 * gas (EIP-8037, `CPSB` 1530 gas per new state byte) makes the deployment cost about 19.2 million gas and every first
 * write of a storage slot about 98,000: a rehearsal pinned to Prague would price neither (read 2026-10-22: Sepolia's own
 * eth_estimateGas of the CREATE2 deployment, 19,249,557).
 *
 * Usage (from tools/deploy-page; anvil on PATH, `forge build` in protocol/, egress to ethereum-sepolia-rpc.publicnode.com):
 *   NODE_USE_ENV_PROXY=1 node --conditions=@paylink/source scripts/sepolia-fork.ts [--block <n>] [--json] [--measure]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry, defineLocalChain, ethereumSepolia, nativeToken, RELEASE, toViemChain } from "@paylink/chains";
import type { ChainDefinition, Deployment, Erc20Token, PayLinkFunction, Registry, Token } from "@paylink/chains";
import {
  approveCall,
  authorizePayment,
  cancelBySigCall,
  cancelCall,
  decodeError,
  decodeInvoiceFragment,
  decodePaidLog,
  domainSeparator,
  gasLimitFor,
  issueInvoice,
  payCall,
  payerAccountKind,
  payNativeCall,
  payWithAuthorizationCall,
  preparePermitPayment,
  readLinkState,
  resolveTokenDomain,
  selectPaymentPath,
  signCancel,
  verifyReceipt,
} from "@paylink/sdk";
import type { CallRequest, DecodedInvoiceLink, Route, TypedDataSigner } from "@paylink/sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  numberToHex,
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
import { anvilVersion, currentMeasurements, forkMeasurementsFile, OUTPUT, startFork } from "./mezo-fork.ts";
import type { Fork, Measurement } from "./mezo-fork.ts";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(PACKAGE_DIR, "../..");

const token = (symbol: string): Erc20Token => {
  const found = ethereumSepolia.tokens.find((t): t is Erc20Token => t.kind === "erc20" && t.symbol === symbol);
  if (found === undefined) {
    throw new Error(`sepolia-fork: ${symbol} is not in the registry's Ethereum Sepolia entry`);
  }
  return found;
};

/** What the rehearsal relies on, each checked on the fork before it is used. */
export const SEPOLIA = {
  chainId: 11155111,
  /** The registry's RPC (packages/chains/src/chains/ethereum-sepolia.ts). */
  rpc: ethereumSepolia.rpc[0]?.url ?? "https://ethereum-sepolia-rpc.publicnode.com",
  usdc: token("USDC"),
  pyusd: token("PYUSD"),
} as const;

const TOKEN_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

const DAY = 86_400n;
/** One unit of a 6-decimal dollar token. */
const DOLLAR = 1_000_000n;
/** apps/web/src/rails/wallet.ts PERMIT_TTL_SECONDS. */
const PERMIT_TTL_SECONDS = 20n * 60n;

const labelKey = (label: string): Hex => {
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  return `0x${((BigInt(keccak256(stringToHex(label))) % (n - 1n)) + 1n).toString(16).padStart(64, "0")}`;
};
/** A fork-only account derived from a public label (never a real key, never used outside the fork). */
const account = (label: string): PrivateKeyAccount => privateKeyToAccount(labelKey(`paylink.sepolia-fork.${label}`));
const salt = (label: string): Hex => keccak256(stringToHex(`paylink.sepolia-fork.salt.${label}`));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(REPO_DIR, path), "utf8"));
const artifact = (path: string): Hex => (JSON.parse(readFileSync(join(REPO_DIR, "protocol/out", path), "utf8")) as { bytecode: { object: Hex } }).bytecode.object;

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`sepolia-fork: ${message}`);
  }
}

export interface TokenFacts {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** `DOMAIN_SEPARATOR()` equals the hash of the registry's stated domain on this chain. */
  readonly separatorMatchesRegistry: boolean;
  /** What `version()` answered, or null when it reverts or answers nothing. */
  readonly version: string | null;
  /** ERC-5267 `eip712Domain()` answers. */
  readonly erc5267: boolean;
  /** The domain the SDK resolves with a client (null when it refuses), as `name/version`. */
  readonly sdkDomain: string | null;
}

export interface PaymentProof {
  readonly symbol: string;
  readonly route: "self-authorization" | "permit";
  readonly amount: bigint;
  readonly txHash: Hex;
  readonly estimate: bigint;
  readonly gasLimit: bigint;
  readonly gasUsed: bigint;
  /** The registry's ceiling for the entry point on this chain. */
  readonly ceiling: bigint;
  readonly payeeDelta: bigint;
  readonly payerDelta: bigint;
  readonly payLinkBalance: bigint;
  readonly allowanceAfter: bigint;
  readonly receipt: { readonly valid: boolean; readonly amount: bigint | null };
  readonly linkState: { readonly payments: number; readonly total: bigint };
  /** The decoded error of a second payment of the same one-payment invoice. */
  readonly secondPayment: string | null;
}

export interface Rehearsal {
  readonly fork: { readonly rpc: string; readonly block: bigint; readonly blockHash: Hex; readonly hardfork: string };
  readonly chainId: number;
  readonly factory: { readonly address: Address; readonly runtimeIsCanonical: boolean };
  readonly tokens: readonly TokenFacts[];
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
  };
  readonly route: Route;
  readonly payments: readonly PaymentProof[];
  /** PYUSD's used-nonce no-op: the second submission of one authorisation on an unlimited link. */
  readonly pyusdReplay: { readonly firstPaid: boolean; readonly replayError: string | null };
}

interface Context {
  readonly fork: Fork;
  readonly client: PublicClient;
  readonly chain: ChainDefinition;
  readonly registry: Registry;
  readonly payLink: Address;
}

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
  throw new Error(`sepolia-fork: ${hash} was not mined within 60 s`);
}

async function send(ctx: Pick<Context, "fork" | "client">, from: PrivateKeyAccount, call: { readonly to: Address | null; readonly data: Hex }, gas: bigint): Promise<TransactionReceipt> {
  const chain = toViemChain(defineLocalChain({ chainId: SEPOLIA.chainId, rpcUrl: ctx.fork.url, tokens: [], deployment: null }));
  const wallet = createWalletClient({ account: from, chain, transport: http(ctx.fork.url) });
  const hash = await wallet.sendTransaction({ account: from, chain, data: call.data, gas, ...(call.to === null ? {} : { to: call.to }) });
  return await mined(ctx.client, hash);
}

const read = async (ctx: Pick<Context, "client">, address: Address, functionName: "balanceOf" | "nonces", owner: Address): Promise<bigint> =>
  await ctx.client.readContract({ address, abi: TOKEN_ABI, functionName, args: [owner] });

/** Fork-only accounts: fresh on Sepolia too (no code), with test ETH for gas. */
async function fund(fork: Fork, client: PublicClient, accounts: readonly PrivateKeyAccount[]): Promise<void> {
  for (const a of accounts) {
    expect((await client.getCode({ address: a.address })) === undefined, `${a.address} has code on Sepolia; pick another label`);
    await fork.rpc("anvil_setBalance", [a.address, "0xde0b6b3a7640000"]);
  }
}

/** Test dollars on the fork: anvil writes the token's own balance slot (`anvil_dealERC20`), nothing is minted on Sepolia. */
async function deal(ctx: Pick<Context, "fork" | "client">, holder: Address, tokenAddress: Address, amount: bigint): Promise<void> {
  await ctx.fork.rpc("anvil_dealERC20", [holder, tokenAddress, numberToHex(amount)]);
  expect((await read(ctx, tokenAddress, "balanceOf", holder)) === amount, `anvil_dealERC20 did not set ${tokenAddress}'s balance`);
}

async function tokenFacts(client: PublicClient, t: Erc20Token): Promise<TokenFacts> {
  const call = async (signature: string): Promise<Hex | null> => {
    try {
      const result = await client.call({ to: t.address, data: keccak256(stringToHex(signature)).slice(0, 10) as Hex });
      return result.data === undefined || result.data === "0x" ? null : result.data;
    } catch {
      return null;
    }
  };
  const [name, decimals, separator] = await Promise.all([
    client.readContract({ address: t.address, abi: TOKEN_ABI, functionName: "name" }),
    client.readContract({ address: t.address, abi: TOKEN_ABI, functionName: "decimals" }),
    client.readContract({ address: t.address, abi: TOKEN_ABI, functionName: "DOMAIN_SEPARATOR" }),
  ]);
  const versionData = await call("version()");
  let version: string | null = null;
  if (versionData !== null) {
    version = await client.readContract({ address: t.address, abi: parseAbi(["function version() view returns (string)"]), functionName: "version" });
  }
  const stated = t.eip712Domain;
  expect(stated !== null, `${t.symbol} has no stated domain`);
  let sdkDomain: string | null;
  try {
    const resolved = await resolveTokenDomain({ chainId: SEPOLIA.chainId, token: t, client });
    sdkDomain = `${resolved.name}/${resolved.version}`;
  } catch {
    sdkDomain = null;
  }
  return {
    symbol: t.symbol,
    name,
    decimals,
    separatorMatchesRegistry: separator === domainSeparator({ name: stated.name, version: stated.version, chainId: SEPOLIA.chainId, verifyingContract: t.address }),
    version,
    erc5267: (await call("eip712Domain()")) !== null,
    sdkDomain,
  };
}

/** The PayLinkV2 release on the fork, deployed exactly as the deploy kit plans it, verified by the kit and the CLI. */
async function deployWithKit(fork: Fork, client: PublicClient, deployer: PrivateKeyAccount, clamp = true): Promise<Rehearsal["deployment"] & { readonly deploymentRecord: Deployment }> {
  const data = parseReleaseData(readJson("web/v2/deploy/data/release.json"));
  const chains = parseChainsData(readJson("web/v2/deploy/data/chains.json"));
  const chain = { ...chainOrThrow(chains, SEPOLIA.chainId), deployment: null };
  const rpc = reader(httpRpc([fork.url], { timeoutMs: 60_000 }));
  expect((await rpc.chainId()) === SEPOLIA.chainId, "the fork is not chain 11155111");
  const [factoryCode, create2Code, nonce] = await Promise.all([rpc.code(data.release.create2.factory), rpc.code(data.release.create2.address), rpc.pendingNonce(deployer.address)]);
  const plan = planDeployment({ data, chain, factoryCode, create2Code, recordedCode: null, deployer: deployer.address, nonce });
  expect(
    plan.kind === "deploy" && plan.method === "CREATE2",
    `the kit plans ${plan.kind} ${plan.method} on the fork, not a CREATE2 deployment: if PayLinkV2 is already on Sepolia, pass --block <a block before its deployment>, or verify it with tools/verify-deployment`,
  );
  expect(plan.expectedAddress === RELEASE.create2.address, `the kit expects ${plan.expectedAddress}, not the release address`);
  const estimate = await rpc.estimateGas({ from: deployer.address, to: plan.to, data: plan.data });
  // Measuring (`clamp` false): the kit's 10 % margin without its measured bounds, which this run is about to replace.
  const gasLimit = clamp ? clampGasLimit(estimate, plan.gas) : (estimate * 110n + 99n) / 100n;
  const receipt = await send({ fork, client }, deployer, { to: plan.to, data: plan.data }, gasLimit);
  expect(receipt.status === "success", "the deployment transaction reverted on the fork");
  const verification = await verifyDeployment({ read: rpc, data, chain, address: plan.expectedAddress, txHash: receipt.transactionHash });
  expect(verification.record !== null, `the kit's verifier refused the deployment: ${verification.checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}`);
  let stdout = "";
  const status = await verifyCli(["--chain", String(SEPOLIA.chainId), "--address", plan.expectedAddress, "--tx", receipt.transactionHash, "--rpc", fork.url, "--out", "-"], {
    stdout: (s: string) => (stdout += s),
    stderr: () => undefined,
  });
  const code = (await client.getCode({ address: plan.expectedAddress })) ?? "0x";
  return {
    planned: { kind: plan.kind, method: plan.method, address: plan.expectedAddress },
    txHash: receipt.transactionHash,
    estimate,
    gasLimit,
    gasUsed: receipt.gasUsed,
    address: plan.expectedAddress,
    checks: verification.checks.map((c) => ({ id: c.id, ok: c.ok })),
    verified: verification.ok,
    record: verification.record,
    cliRecordIdentical: status === 0 && stdout === verification.record,
    deploymentRecord: {
      address: plan.expectedAddress,
      status: "active",
      release: RELEASE.release,
      method: "CREATE2",
      deployer: deployer.address,
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      initCodeHash: RELEASE.initCodeHash,
      maskedRuntimeHash: RELEASE.maskedRuntimeHash,
      runtimeCodeHash: keccak256(code),
    },
  };
}

/** The registry the SDK sees on the fork: Sepolia's own tokens and gas table, the fork's RPC and deployment. */
function forkRegistry(fork: Fork, deployment: Deployment, extraTokens: readonly Token[] = []): { registry: Registry; chain: ChainDefinition } {
  const chain = defineLocalChain({
    chainId: SEPOLIA.chainId,
    rpcUrl: fork.url,
    name: "Ethereum Sepolia (anvil fork)",
    editions: ["paypal"],
    tokens: [...ethereumSepolia.tokens, ...extraTokens],
    deployment,
    ...(ethereumSepolia.gas === null ? {} : { gas: ethereumSepolia.gas }),
    chargesGasLimit: ethereumSepolia.gasModel.chargesGasLimit,
  });
  const registry = createRegistry([chain]);
  return { registry, chain: registry.getOrThrow(SEPOLIA.chainId) };
}

async function issue(ctx: Context, payee: PrivateKeyAccount, t: Erc20Token, amount: bigint, maxPayments: number, label: string): Promise<DecodedInvoiceLink> {
  const issued = await issueInvoice({
    registry: ctx.registry,
    chainId: SEPOLIA.chainId,
    draft: { payee: payee.address, token: t.address, amount, maxPayments, validAfter: 0n, expiry: { kind: "at", validUntil: ctx.fork.timestamp + 7n * DAY }, memo: `Sepolia fork rehearsal: ${label}`, salt: salt(label) },
    signer: payee,
    client: ctx.client,
  });
  return decodeInvoiceFragment(issued.fragment, ctx.registry);
}

/** Pays one invoice on one route, as the web app's self-authorization and wallet rails do, and proves the receipt. */
async function payAndProve(ctx: Context, route: PaymentProof["route"], link: DecodedInvoiceLink, payer: PrivateKeyAccount, payee: Address): Promise<PaymentProof> {
  const tokenAddress = link.invoice.token;
  const amount = link.invoice.amount;
  const before = { payer: await read(ctx, tokenAddress, "balanceOf", payer.address), payee: await read(ctx, tokenAddress, "balanceOf", payee) };
  let call: CallRequest;
  let fn: PayLinkFunction;
  if (route === "self-authorization") {
    const auth = await authorizePayment({ link, signer: payer, now: ctx.fork.timestamp, outstanding: null, client: ctx.client, random: () => hexToBytes(salt(`payer.${link.key}`)) });
    call = payWithAuthorizationCall(ctx.payLink, link.invoice, link.signature, auth.authorization);
    fn = "payWithAuthorization";
  } else {
    const prepared = await preparePermitPayment({ link, signer: payer, client: ctx.client, deadline: ctx.fork.timestamp + PERMIT_TTL_SECONDS + DAY });
    call = prepared.call;
    fn = "payWithPermit";
  }
  const estimate = await ctx.client.estimateGas({ account: payer.address, to: call.to, data: call.data });
  // The registry's bounds on Ethereum Sepolia: E_GAS_ABOVE_CEILING if the estimate exceeds the ceiling.
  const gasLimit = gasLimitFor(ctx.chain, fn, estimate);
  const receipt = await send(ctx, payer, call, gasLimit);
  expect(receipt.status === "success", `${link.token.symbol} ${fn} reverted`);
  const log = receipt.logs.find((l) => {
    const event = l.address.toLowerCase() === ctx.payLink.toLowerCase() ? decodePaidLog({ address: l.address, topics: [...l.topics], data: l.data, logIndex: l.logIndex }) : null;
    return event?.key === link.key.toLowerCase();
  });
  expect(log !== undefined, "the payment emitted no Paid event for this invoice");
  const verification = await verifyReceipt({ registry: ctx.registry, client: ctx.client, reference: { chainId: SEPOLIA.chainId, txHash: receipt.transactionHash, logIndex: log.logIndex }, paid: link });
  const state = await readLinkState(ctx.client, ctx.payLink, link.key);
  let secondPayment: string | null = null;
  try {
    await ctx.client.estimateGas({ account: payer.address, ...payCall(ctx.payLink, link.invoice, link.signature, amount) });
  } catch (error) {
    secondPayment = decodeError(error).name;
  }
  const ceiling = ctx.chain.gas?.limits[fn].ceiling ?? 0n;
  return {
    symbol: link.token.symbol,
    route,
    amount,
    txHash: receipt.transactionHash,
    estimate,
    gasLimit,
    gasUsed: receipt.gasUsed,
    ceiling,
    payeeDelta: (await read(ctx, tokenAddress, "balanceOf", payee)) - before.payee,
    payerDelta: before.payer - (await read(ctx, tokenAddress, "balanceOf", payer.address)),
    payLinkBalance: await read(ctx, tokenAddress, "balanceOf", ctx.payLink),
    allowanceAfter: await ctx.client.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: "allowance", args: [payer.address, ctx.payLink] }),
    receipt: verification.valid ? { valid: true, amount: verification.proof.amount } : { valid: false, amount: null },
    linkState: { payments: state.payments, total: state.total },
    secondPayment,
  };
}

/** Runs the whole rehearsal on a fresh fork of Ethereum Sepolia. */
export async function rehearse(options: { readonly block?: bigint } = {}): Promise<Rehearsal> {
  // Once PayLinkV2 is recorded on Sepolia, rehearse at the block before it (the RPC must still serve that state).
  const recorded = ethereumSepolia.deployment;
  const block = options.block ?? (recorded === null ? undefined : recorded.blockNumber - 1n);
  const fork = await startFork({ rpc: SEPOLIA.rpc, hardfork: null, ...(block === undefined ? {} : { block }) });
  try {
    const viemChain = toViemChain(defineLocalChain({ chainId: SEPOLIA.chainId, rpcUrl: fork.url, tokens: [], deployment: null }));
    const client = createPublicClient({ chain: viemChain, transport: http(fork.url), pollingInterval: 50 }) as PublicClient;
    const deployer = account("deployer");
    await fund(fork, client, [deployer]);

    const factoryRuntime = parseReleaseData(readJson("web/v2/deploy/data/release.json")).factoryRuntime.toLowerCase();
    const factoryCode = ((await client.getCode({ address: RELEASE.create2.factory })) ?? "0x").toLowerCase();
    const tokens = [await tokenFacts(client, SEPOLIA.usdc), await tokenFacts(client, SEPOLIA.pyusd)];

    const deployment = await deployWithKit(fork, client, deployer);
    const { registry, chain } = forkRegistry(fork, deployment.deploymentRecord);
    const ctx: Context = { fork, client, chain, registry, payLink: deployment.address };

    const payer = account("payer");
    const payees = ["usdc.auth", "usdc.permit", "pyusd.auth", "pyusd.permit", "pyusd.replay"].map((l) => account(`payee.${l}`));
    await fund(fork, client, [payer, ...payees]);
    await deal(ctx, payer.address, SEPOLIA.usdc.address, 1_000n * DOLLAR);
    await deal(ctx, payer.address, SEPOLIA.pyusd.address, 1_000n * DOLLAR);

    const route = selectPaymentPath({ capabilities: SEPOLIA.pyusd.capabilities, account: payerAccountKind(await client.getCode({ address: payer.address })), relayerHealthy: false, outstanding: null });
    const [usdcAuth, usdcPermit, pyusdAuth, pyusdPermit, pyusdReplayPayee] = payees as [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
    const payments: PaymentProof[] = [
      await payAndProve(ctx, "self-authorization", await issue(ctx, usdcAuth, SEPOLIA.usdc, 120n * DOLLAR, 1, "USDC, self-authorization"), payer, usdcAuth.address),
      await payAndProve(ctx, "permit", await issue(ctx, usdcPermit, SEPOLIA.usdc, 45_500_000n, 1, "USDC, permit"), payer, usdcPermit.address),
      await payAndProve(ctx, "self-authorization", await issue(ctx, pyusdAuth, SEPOLIA.pyusd, 120n * DOLLAR, 1, "PYUSD, self-authorization"), payer, pyusdAuth.address),
      await payAndProve(ctx, "permit", await issue(ctx, pyusdPermit, SEPOLIA.pyusd, 45_500_000n, 1, "PYUSD, permit"), payer, pyusdPermit.address),
    ];

    // PYUSD returns silently (no transfer) on an already-used EIP-3009 nonce, where USDC reverts: on a link that accepts
    // many payments, the same authorisation submitted twice must fail in PayLinkV2 (ReceivedMismatch), never pay twice.
    const unlimited = await issue(ctx, pyusdReplayPayee, SEPOLIA.pyusd, 0n, 0, "PYUSD, open amount, replayed authorisation");
    const auth = await authorizePayment({ link: unlimited, signer: payer, now: fork.timestamp, outstanding: null, client, amount: 5n * DOLLAR, random: () => hexToBytes(salt("payer.replay")) });
    const replayCall = payWithAuthorizationCall(ctx.payLink, unlimited.invoice, unlimited.signature, auth.authorization);
    const first = await send(ctx, payer, replayCall, gasLimitFor(chain, "payWithAuthorization", await client.estimateGas({ account: payer.address, ...replayCall })));
    let replayError: string | null = null;
    try {
      await client.estimateGas({ account: payer.address, ...replayCall });
    } catch (error) {
      replayError = decodeError(error).name;
    }

    return {
      fork: { rpc: SEPOLIA.rpc, block: fork.block, blockHash: fork.blockHash, hardfork: fork.hardfork },
      chainId: await client.getChainId(),
      factory: { address: RELEASE.create2.factory, runtimeIsCanonical: factoryCode === factoryRuntime },
      tokens,
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
      },
      route,
      payments,
      pyusdReplay: { firstPaid: first.status === "success", replayError },
    };
  } finally {
    await fork.stop();
  }
}

/** What `--measure` read on the fork. */
export interface Measured {
  readonly fork: { readonly rpc: string; readonly block: bigint; readonly blockHash: Hex; readonly timestamp: bigint; readonly hardfork: string; readonly network: string };
  readonly chainId: number;
  readonly measurements: Readonly<Record<string, Measurement>>;
}

/**
 * The gas of every entry point on the fork, scenario by scenario as packages/sdk/scripts/measure-gas.ts measures it:
 * eth_estimateGas (what a client clamps), then the transaction sent with exactly that limit and its receipt's gas used.
 * Circle USDC and native Sepolia ETH as the chain holds them; the repository's Wallet1271 for an ERC-1271 payee.
 */
async function measureEntryPoints(base: Context, deployer: PrivateKeyAccount, deployment: Pick<Rehearsal["deployment"], "estimate" | "gasUsed">): Promise<Record<string, Measurement>> {
  const measurements: Record<string, Measurement> = {};
  const payer = account("measure.payer");
  const relayer = account("measure.relayer");
  const walletOwner = account("measure.wallet.owner");
  const payees = Array.from({ length: 10 }, (_, i) => account(`measure.payee.${String(i + 1)}`));
  await fund(base.fork, base.client, [payer, relayer, walletOwner, ...payees]);
  await deal(base, payer.address, SEPOLIA.usdc.address, 10_000n * DOLLAR);

  const estimateOf = async (from: Address, call: { readonly to: Address | null; readonly data: Hex; readonly value?: bigint }): Promise<bigint> =>
    await base.client.estimateGas({ account: from, data: call.data, value: call.value ?? 0n, ...(call.to === null ? {} : { to: call.to }) });
  const sendWith = async (from: PrivateKeyAccount, call: { readonly to: Address | null; readonly data: Hex; readonly value?: bigint }, gas: bigint): Promise<TransactionReceipt> => {
    const chain = toViemChain(defineLocalChain({ chainId: SEPOLIA.chainId, rpcUrl: base.fork.url, tokens: [], deployment: null }));
    const wallet = createWalletClient({ account: from, chain, transport: http(base.fork.url) });
    const hash = await wallet.sendTransaction({ account: from, chain, data: call.data, value: call.value ?? 0n, gas, ...(call.to === null ? {} : { to: call.to }) });
    return await mined(base.client, hash);
  };
  // The repository's ERC-1271 wallet, where Sepolia has nothing of the kind to measure against.
  const walletInit = encodeDeployData({ abi: parseAbi(["constructor(address)"]), bytecode: artifact("Wallet1271.sol/Wallet1271.json"), args: [walletOwner.address] });
  const walletReceipt = await sendWith(deployer, { to: null, data: walletInit }, await estimateOf(deployer.address, { to: null, data: walletInit }));
  expect(walletReceipt.status === "success" && walletReceipt.contractAddress !== null && walletReceipt.contractAddress !== undefined, "Wallet1271 deployment failed");
  const wallet1271 = getAddress(walletReceipt.contractAddress);
  // Native Sepolia ETH, for payNative: PayLinkV2 accepts it, though the registry offers no native token on Sepolia.
  const eth = nativeToken({ symbol: "ETH", name: "Sepolia Ether (measurement only)", decimals: 18, listing: "listed", confidence: "C" });
  const record = base.chain.deployment;
  expect(record !== null, "no deployment to measure against");
  const { registry, chain } = forkRegistry(base.fork, record, [eth]);
  const ctx: Context = { ...base, registry, chain };
  const usdc = SEPOLIA.usdc.address;

  const measure = async (name: string, from: PrivateKeyAccount, call: CallRequest): Promise<void> => {
    const est = await estimateOf(from.address, call);
    const sent = await sendWith(from, call, est);
    expect(sent.status === "success", `${name} reverted`);
    measurements[name] = { estimate: Number(est), gasUsed: Number(sent.gasUsed) };
  };
  const now = ctx.fork.timestamp;
  const link = async (label: string, signer: TypedDataSigner, tokenAddress: Address, amount: bigint, maxPayments: number): Promise<DecodedInvoiceLink> => {
    const issued = await issueInvoice({
      registry,
      chainId: SEPOLIA.chainId,
      draft: { payee: signer.address, token: tokenAddress, amount, maxPayments, validAfter: 0n, expiry: { kind: "at", validUntil: now + 7n * DAY }, salt: salt(`measure.${label}`) },
      signer,
      client: ctx.client,
    });
    return decodeInvoiceFragment(issued.fragment, registry);
  };
  const p = (i: number): PrivateKeyAccount => payees[i - 1] ?? payer;
  const authorize = async (l: DecodedInvoiceLink, label: string, amount?: bigint): Promise<CallRequest> => {
    const auth = await authorizePayment({ link: l, signer: payer, now, ttlSeconds: DAY, outstanding: null, client: ctx.client, ...(amount === undefined ? {} : { amount }), random: () => hexToBytes(salt(`measure.payer.${label}`)) });
    return payWithAuthorizationCall(ctx.payLink, l.invoice, l.signature, auth.authorization);
  };
  const smart: TypedDataSigner = { address: wallet1271, signTypedData: async (t) => await walletOwner.signTypedData(t) };

  // payWithAuthorization with USDC: a first payment (payee new to USDC), a later one on an unlimited link, an ERC-1271 payee.
  await measure("payWithAuthorization_first", relayer, await authorize(await link("3009.first", p(1), usdc, 25n * DOLLAR, 1), "3009.first"));
  const unlimited3009 = await link("3009.repeat", p(2), usdc, 0n, 0);
  const warm = await authorize(unlimited3009, "3009.warmup", 7n * DOLLAR);
  await sendWith(relayer, warm, await estimateOf(relayer.address, warm));
  await measure("payWithAuthorization_repeat", relayer, await authorize(unlimited3009, "3009.repeat", 7n * DOLLAR));
  await measure("payWithAuthorization_erc1271Payee", relayer, await authorize(await link("3009.1271", smart, usdc, 25n * DOLLAR, 1), "3009.1271"));

  // pay with USDC (allowance): exact approve first, then pay.
  const payWithAllowance = async (name: string | null, l: DecodedInvoiceLink, amount: bigint): Promise<void> => {
    const approve = approveCall(usdc, ctx.payLink, amount);
    await sendWith(payer, approve, await estimateOf(payer.address, approve));
    const call = payCall(ctx.payLink, l.invoice, l.signature, amount);
    if (name === null) {
      await sendWith(payer, call, await estimateOf(payer.address, call));
    } else {
      await measure(name, payer, call);
    }
  };
  await payWithAllowance("pay_first", await link("pay.first", p(4), usdc, 15n * DOLLAR, 1), 15n * DOLLAR);
  const unlimitedPay = await link("pay.repeat", p(5), usdc, 0n, 0);
  await payWithAllowance(null, unlimitedPay, DOLLAR);
  await payWithAllowance("pay_repeat", unlimitedPay, DOLLAR);

  // payWithPermit with USDC: one transaction, permit nonce 0 -> 1, payee new to USDC.
  const permitted = await preparePermitPayment({ link: await link("permit.first", p(6), usdc, 2n * DOLLAR, 1), signer: payer, client: ctx.client, deadline: now + DAY });
  await measure("payWithPermit_first", payer, permitted.call);

  // payNative in Sepolia ETH: first payment to an account with no balance, then a later one.
  const nativeOnce = await link("native.first", account("measure.native.payee.empty"), zeroAddress, 10n ** 15n, 1);
  await measure("payNative_first", payer, payNativeCall(ctx.payLink, nativeOnce.invoice, nativeOnce.signature, 10n ** 15n));
  const nativeMany = await link("native.repeat", p(8), zeroAddress, 0n, 0);
  const firstNative = payNativeCall(ctx.payLink, nativeMany.invoice, nativeMany.signature, 10n ** 15n);
  await sendWith(payer, firstNative, await estimateOf(payer.address, firstNative));
  await measure("payNative_repeat", payer, payNativeCall(ctx.payLink, nativeMany.invoice, nativeMany.signature, 10n ** 15n));

  // cancel by the payee, cancelBySig sent by a third party, and for an ERC-1271 payee (USDC invoices).
  await measure("cancel", p(9), cancelCall(ctx.payLink, (await link("cancel", p(9), usdc, 25n * DOLLAR, 1)).invoice));
  const target = { chainId: SEPOLIA.chainId, verifyingContract: ctx.payLink };
  const bySig = await link("cancelBySig", p(10), usdc, 25n * DOLLAR, 1);
  await measure("cancelBySig", relayer, cancelBySigCall(ctx.payLink, await signCancel({ signer: p(10), deployment: target, invoice: bySig.invoice, deadline: now + DAY })));
  const bySig1271 = await link("cancelBySig.1271", smart, usdc, 25n * DOLLAR, 1);
  await measure("cancelBySig_erc1271Payee", relayer, cancelBySigCall(ctx.payLink, await signCancel({ signer: smart, deployment: target, invoice: bySig1271.invoice, deadline: now + DAY, client: ctx.client })));

  // Deployments: CREATE2 as the kit sent it, and a plain CREATE from a fresh account (Deploy.s.sol's fallback).
  measurements["deploy_create2"] = { estimate: Number(deployment.estimate), gasUsed: Number(deployment.gasUsed) };
  const creator = account("measure.creator");
  await fund(ctx.fork, ctx.client, [creator]);
  const initCode = artifact("PayLinkV2.sol/PayLinkV2.json");
  expect(keccak256(initCode) === RELEASE.initCodeHash, "protocol/out is not the release build of PayLinkV2 (run forge build)");
  const createEstimate = await estimateOf(creator.address, { to: null, data: initCode });
  const created = await sendWith(creator, { to: null, data: initCode }, createEstimate);
  expect(created.status === "success", "the CREATE deployment reverted");
  measurements["deploy_create"] = { estimate: Number(createEstimate), gasUsed: Number(created.gasUsed) };
  return Object.fromEntries(Object.entries(measurements).sort(([a], [b]) => a.localeCompare(b)));
}

/** Measures every entry point on a fresh fork of Ethereum Sepolia (`--measure`). */
export async function measure(options: { readonly block?: bigint } = {}): Promise<Measured> {
  const recorded = ethereumSepolia.deployment;
  const block = options.block ?? (recorded === null ? undefined : recorded.blockNumber - 1n);
  const fork = await startFork({ rpc: SEPOLIA.rpc, hardfork: null, ...(block === undefined ? {} : { block }) });
  try {
    const viemChain = toViemChain(defineLocalChain({ chainId: SEPOLIA.chainId, rpcUrl: fork.url, tokens: [], deployment: null }));
    const client = createPublicClient({ chain: viemChain, transport: http(fork.url), pollingInterval: 50 }) as PublicClient;
    const deployer = account("deployer");
    await fund(fork, client, [deployer]);
    const deployment = await deployWithKit(fork, client, deployer, false);
    const { registry, chain } = forkRegistry(fork, deployment.deploymentRecord);
    const measurements = await measureEntryPoints({ fork, client, chain, registry, payLink: deployment.address }, deployer, deployment);
    return {
      fork: { rpc: SEPOLIA.rpc, block: fork.block, blockHash: fork.blockHash, timestamp: fork.timestamp, hardfork: fork.hardfork, network: fork.network },
      chainId: await client.getChainId(),
      measurements,
    };
  } finally {
    await fork.stop();
  }
}

/** packages/chains/data/fork-gas-measurements.json with this measurement as its `sepolia` profile (the others kept). */
export function sepoliaMeasurementsFile(m: Measured, tool: string, existing: string | null = currentMeasurements()): string {
  return forkMeasurementsFile(
    existing,
    "sepolia",
    {
      chainId: m.chainId,
      fork: { rpc: m.fork.rpc, block: Number(m.fork.block), blockHash: m.fork.blockHash, timestamp: Number(m.fork.timestamp) },
      hardfork: m.fork.hardfork,
      network: m.fork.network,
      appliesTo: [SEPOLIA.chainId],
      tokens: `Circle USDC ${SEPOLIA.usdc.address} (payWithAuthorization, pay, payWithPermit, cancel, cancelBySig) and native Sepolia ETH (payNative) as Ethereum Sepolia holds them; protocol/test/mocks Wallet1271 (ERC-1271 payee), deployed on the fork`,
      measurements: m.measurements,
    },
    tool,
  );
}

function summary(r: Rehearsal): string {
  const lines = [
    `Ethereum Sepolia fork at block ${r.fork.block.toString()} (${r.fork.blockHash}), chain ${String(r.chainId)}, anvil hardfork ${r.fork.hardfork}`,
    `factory ${r.factory.address}: canonical runtime ${String(r.factory.runtimeIsCanonical)}`,
    ...r.tokens.map(
      (t) =>
        `${t.symbol}: name "${t.name}", ${String(t.decimals)} decimals, version() ${t.version ?? "reverts"}, ERC-5267 ${String(t.erc5267)}, DOMAIN_SEPARATOR = registry domain ${String(t.separatorMatchesRegistry)}, SDK resolves ${t.sdkDomain ?? "nothing"}`,
    ),
    `deploy: kit planned ${r.deployment.planned.kind} ${r.deployment.planned.method} -> ${String(r.deployment.planned.address)}; estimate ${r.deployment.estimate.toString()}, limit ${r.deployment.gasLimit.toString()}, used ${r.deployment.gasUsed.toString()}`,
    `deploy: ${String(r.deployment.checks.filter((c) => c.ok).length)}/${String(r.deployment.checks.length)} kit checks pass; verified ${String(r.deployment.verified)}; CLI record byte-identical ${String(r.deployment.cliRecordIdentical)}`,
    `route without a relayer (EOA payer): ${r.route.available ? [r.route.path, ...r.route.fallbacks].join(" > ") : "none"}`,
    ...r.payments.map(
      (p) =>
        `${p.symbol} ${p.route}: ${p.amount.toString()} asked; payee +${p.payeeDelta.toString()}, payer -${p.payerDelta.toString()}, PayLink ${p.payLinkBalance.toString()}; receipt valid ${String(p.receipt.valid)}; estimate ${p.estimate.toString()}, limit ${p.gasLimit.toString()} (ceiling ${p.ceiling.toString()}), used ${p.gasUsed.toString()}; second payment: ${p.secondPayment ?? "accepted"}`,
    ),
    `PYUSD replayed authorisation: first paid ${String(r.pyusdReplay.firstPaid)}, replay ${r.pyusdReplay.replayError ?? "accepted"}`,
  ];
  return `${lines.join("\n")}\n`;
}

const bigintJson = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

async function main(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf("--block");
  const block = at === -1 ? undefined : BigInt(argv[at + 1] ?? "");
  if (argv.includes("--measure")) {
    const m = await measure(block === undefined ? {} : { block });
    process.stdout.write(`${JSON.stringify(m, bigintJson, 2)}\n`);
    writeFileSync(OUTPUT, sepoliaMeasurementsFile(m, `anvil ${await anvilVersion()}`));
    process.stderr.write(`wrote ${OUTPUT}; next: pnpm --filter @paylink/chains run generate, then pnpm --filter @paylink/deploy-page run generate\n`);
    return 0;
  }
  const r = await rehearse(block === undefined ? {} : { block });
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(r, bigintJson, 2)}\n` : summary(r));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
