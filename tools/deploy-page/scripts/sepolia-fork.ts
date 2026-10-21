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
 *
 * Usage (from tools/deploy-page; anvil on PATH, `forge build` in protocol/, egress to ethereum-sepolia-rpc.publicnode.com):
 *   NODE_USE_ENV_PROXY=1 node --conditions=@paylink/source scripts/sepolia-fork.ts [--block <n>] [--json]
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry, defineLocalChain, ethereumSepolia, RELEASE, toViemChain } from "@paylink/chains";
import type { ChainDefinition, Deployment, Erc20Token, PayLinkFunction, Registry } from "@paylink/chains";
import {
  authorizePayment,
  decodeError,
  decodeInvoiceFragment,
  decodePaidLog,
  domainSeparator,
  gasLimitFor,
  issueInvoice,
  payCall,
  payerAccountKind,
  payWithAuthorizationCall,
  preparePermitPayment,
  readLinkState,
  resolveTokenDomain,
  selectPaymentPath,
  verifyReceipt,
} from "@paylink/sdk";
import type { CallRequest, DecodedInvoiceLink, Route } from "@paylink/sdk";
import { createPublicClient, createWalletClient, hexToBytes, http, keccak256, numberToHex, parseAbi, stringToHex, TransactionReceiptNotFoundError } from "viem";
import type { Address, Hex, PublicClient, TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { main as verifyCli } from "../../verify-deployment/verify-deployment.mjs";
import { chainOrThrow, clampGasLimit, parseChainsData, parseReleaseData, planDeployment } from "../../../web/v2/deploy/lib/core.js";
import { httpRpc, reader } from "../../../web/v2/deploy/lib/rpc.js";
import { verifyDeployment } from "../../../web/v2/deploy/lib/verify.js";
import { startFork } from "./mezo-fork.ts";
import type { Fork } from "./mezo-fork.ts";

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
async function deployWithKit(fork: Fork, client: PublicClient, deployer: PrivateKeyAccount): Promise<Rehearsal["deployment"] & { readonly deploymentRecord: Deployment }> {
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
  const gasLimit = clampGasLimit(estimate, plan.gas);
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
function forkRegistry(fork: Fork, deployment: Deployment): { registry: Registry; chain: ChainDefinition } {
  const chain = defineLocalChain({
    chainId: SEPOLIA.chainId,
    rpcUrl: fork.url,
    name: "Ethereum Sepolia (anvil fork)",
    editions: ["paypal"],
    tokens: ethereumSepolia.tokens,
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
  const fork = await startFork({ rpc: SEPOLIA.rpc, ...(block === undefined ? {} : { block }) });
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
  const r = await rehearse(block === undefined ? {} : { block });
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(r, bigintJson, 2)}\n` : summary(r));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
