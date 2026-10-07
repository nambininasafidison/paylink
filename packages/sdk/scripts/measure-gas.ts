// SPDX-License-Identifier: MIT
/**
 * Measures the gas of every PayLinkV2 entry point as real transactions built by this SDK, on anvil nodes
 * that emulate each network's gas schedule, and writes packages/chains/data/gas-measurements.json.
 *
 * Why: the Foundry snapshot (protocol/snapshots/PayLinkV2.json) prices gas like Ethereum. Monad does not
 * (cold SLOAD 8,100, cold account access 10,100, ecrecover 6,000, no refunds) and charges the gas **limit**,
 * so its bounds must come from Monad-priced estimates. anvil 1.8.5 emulates Monad with `--network monad`
 * (hardfork "MonadTen"); the result is evidence of confidence L until re-measured on Monad testnet with the
 * real tokens (spec §3.3.6).
 *
 * For each profile it records, per scenario, `estimate` (eth_estimateGas: the smallest gas limit that
 * succeeds, which is what a client clamps and what Monad charges) and `gasUsed` (the receipt). Inputs are
 * fixed (salts, times, amounts, keys from public labels), so a re-run with the same tools and artifacts
 * gives the same file.
 *
 * Needs anvil (PATH or ~/.foundry/bin) and the Foundry artifacts in protocol/out (`forge build`).
 * Usage (from packages/sdk):  node --conditions=@paylink/source scripts/measure-gas.ts
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry, defineLocalChain, nativeToken, RELEASE, toViemChain } from "@paylink/chains";
import type { Erc20Token, Registry } from "@paylink/chains";
import {
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
  zeroAddress,
} from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  approveCall,
  authorizePayment,
  cancelBySigCall,
  cancelCall,
  decodeInvoiceFragment,
  issueInvoice,
  payCall,
  payNativeCall,
  payWithAuthorizationCall,
  preparePermitPayment,
  signCancel,
} from "../src/index.ts";
import type { CallRequest, DecodedInvoiceLink, TypedDataSigner } from "../src/index.ts";

const PACKAGE_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = resolve(PACKAGE_DIR, "../../protocol/out");
export const OUTPUT = resolve(PACKAGE_DIR, "../chains/data/gas-measurements.json");

/** 2026-10-05T00:00:00Z: invoices are valid for 7 days from it; the chains start one hour later. */
const T0 = 1_791_158_400n;
const DAY = 86_400n;

export interface Profile {
  readonly name: "ethereum" | "monad" | "base" | "london";
  readonly chainId: number;
  readonly anvilArgs: readonly string[];
  readonly appliesTo: readonly number[];
}

export const PROFILES: readonly Profile[] = [
  { name: "ethereum", chainId: 31337, anvilArgs: [], appliesTo: [421614] },
  { name: "monad", chainId: 10143, anvilArgs: ["--network", "monad"], appliesTo: [10143, 143] },
  { name: "base", chainId: 84532, anvilArgs: ["--network", "base"], appliesTo: [84532] },
  { name: "london", chainId: 31611, anvilArgs: ["--hardfork", "london"], appliesTo: [31611] },
];

const labelKey = (label: string): Hex => {
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  return `0x${((BigInt(keccak256(stringToHex(label))) % (n - 1n)) + 1n).toString(16).padStart(64, "0")}`;
};
const account = (label: string): PrivateKeyAccount => privateKeyToAccount(labelKey(`paylink.gas.${label}`));
const salt = (label: string): Hex => keccak256(stringToHex(`paylink.gas.salt.${label}`));
const artifact = (path: string): { bytecode: Hex } => {
  const json = JSON.parse(readFileSync(join(OUT, path), "utf8")) as { bytecode: { object: Hex } };
  return { bytecode: json.bytecode.object };
};

function anvilBinary(): string {
  const candidates = [join(homedir(), ".foundry", "bin", "anvil"), "/usr/local/bin/anvil", "/usr/bin/anvil"];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) {
    throw new Error("anvil not found (install Foundry 1.8.5: scripts/bootstrap-sandbox.sh)");
  }
  return found;
}

export interface Measurement {
  readonly estimate: number;
  readonly gasUsed: number;
}

export interface ProfileResult {
  readonly chainId: number;
  readonly anvilArgs: readonly string[];
  readonly hardfork: string;
  readonly network: string;
  readonly appliesTo: readonly number[];
  readonly measurements: Readonly<Record<string, Measurement>>;
}

async function measureProfile(profile: Profile, port: number): Promise<ProfileResult> {
  const rpc = `http://127.0.0.1:${port}`;
  const node: ChildProcess = spawn(anvilBinary(), ["--port", String(port), "--chain-id", String(profile.chainId), "--timestamp", String(T0 + 3600n), "--silent", ...profile.anvilArgs], {
    stdio: "ignore",
  });
  try {
    const probe = createPublicClient({ transport: http(rpc) });
    for (let i = 0; i < 100; i += 1) {
      try {
        await probe.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const info = await probe.request<{ Method: "anvil_nodeInfo"; Parameters?: undefined; ReturnType: { hardFork: string; network: string } }>({ method: "anvil_nodeInfo" });
    const chain = toViemChain(defineLocalChain({ chainId: profile.chainId, rpcUrl: rpc, tokens: [], deployment: null }));
    const client = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
    const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const payer = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    const relayer = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

    const sendRaw = async (from: PrivateKeyAccount, call: Partial<CallRequest> & { data: Hex }, gas?: bigint): Promise<{ gasUsed: bigint; contractAddress: Address | null }> => {
      const wallet = createWalletClient({ account: from, chain, transport: http(rpc) });
      const hash = await wallet.sendTransaction({ account: from, chain, data: call.data, ...(call.to === undefined ? {} : { to: call.to }), value: call.value ?? 0n, ...(gas === undefined ? {} : { gas }) });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`transaction reverted on ${profile.name}`);
      }
      return { gasUsed: receipt.gasUsed, contractAddress: receipt.contractAddress ?? null };
    };
    const deploy = async (data: Hex): Promise<Address> => {
      const { contractAddress } = await sendRaw(deployer, { data });
      if (contractAddress === null) {
        throw new Error("deployment returned no address");
      }
      return getAddress(contractAddress);
    };

    const payLinkInit = artifact("PayLinkV2.sol/PayLinkV2.json").bytecode;
    if (keccak256(payLinkInit) !== RELEASE.initCodeHash) {
      throw new Error("protocol/out is not the release build of PayLinkV2 (initCodeHash differs from release.json)");
    }
    const payLink = await deploy(payLinkInit);
    const usdc = await deploy(
      encodeDeployData({ abi: parseAbi(["constructor(string,string,string,uint8)"]), bytecode: artifact("Mock3009.sol/Mock3009.json").bytecode, args: ["USD Coin", "USDC", "2", 6] }),
    );
    const musd = await deploy(encodeDeployData({ abi: parseAbi(["constructor(string,string)"]), bytecode: artifact("MockPermit.sol/MockPermit.json").bytecode, args: ["Mezo USD", "MUSD"] }));
    const walletOwner = account("wallet.owner");
    const wallet1271 = await deploy(encodeDeployData({ abi: parseAbi(["constructor(address)"]), bytecode: artifact("Wallet1271.sol/Wallet1271.json").bytecode, args: [walletOwner.address] }));
    const mint = parseAbi(["function mint(address,uint256)"]);
    await sendRaw(deployer, { to: usdc, data: encodeFunctionData({ abi: mint, functionName: "mint", args: [payer.address, 10n ** 12n] }) });
    await sendRaw(deployer, { to: musd, data: encodeFunctionData({ abi: mint, functionName: "mint", args: [payer.address, 10n ** 24n] }) });

    const erc20 = (address: Address, symbol: string, decimals: number, eip3009: boolean, domain: Erc20Token["eip712Domain"]): Erc20Token => ({
      kind: "erc20",
      symbol,
      name: symbol,
      address,
      decimals,
      capabilities: { eip3009, eip2612: true, native: false },
      eip712Domain: domain,
      listing: symbol === "USDC" ? "default" : "listed",
      confidence: "C",
      pendingVerification: [],
    });
    const registry: Registry = createRegistry([
      defineLocalChain({
        chainId: profile.chainId,
        rpcUrl: rpc,
        tokens: [
          erc20(usdc, "USDC", 6, true, { name: "USD Coin", version: "2" }),
          erc20(musd, "MUSD", 18, false, null),
          nativeToken({ symbol: "ETH", name: "Ether", decimals: 18, listing: "listed", confidence: "C" }),
        ],
        deployment: {
          address: payLink,
          status: "active",
          release: RELEASE.release,
          method: "CREATE",
          deployer: deployer.address,
          txHash: `0x${"00".repeat(32)}`,
          blockNumber: 1n,
          initCodeHash: RELEASE.initCodeHash,
          maskedRuntimeHash: RELEASE.maskedRuntimeHash,
          runtimeCodeHash: `0x${"00".repeat(32)}`,
        },
      }),
    ]);

    const measurements: Record<string, Measurement> = {};
    const measure = async (name: string, from: PrivateKeyAccount, call: CallRequest): Promise<void> => {
      const estimate = await client.estimateGas({ account: from.address, to: call.to, data: call.data, value: call.value });
      const { gasUsed } = await sendRaw(from, call, estimate);
      measurements[name] = { estimate: Number(estimate), gasUsed: Number(gasUsed) };
    };
    const link = async (label: string, signer: TypedDataSigner, token: Address, amount: bigint, maxPayments: number): Promise<DecodedInvoiceLink> => {
      const issued = await issueInvoice({
        registry,
        chainId: profile.chainId,
        draft: { payee: signer.address, token, amount, maxPayments, validAfter: T0, expiry: { kind: "at", validUntil: T0 + 7n * DAY }, salt: salt(label) },
        signer,
        client,
      });
      return decodeInvoiceFragment(issued.fragment, registry);
    };
    const authorize = async (l: DecodedInvoiceLink, label: string, amount?: bigint): Promise<CallRequest> => {
      const auth = await authorizePayment({ link: l, signer: payer, now: T0, ttlSeconds: DAY, outstanding: null, ...(amount === undefined ? {} : { amount }), random: () => hexToBytes(salt(`payer.${label}`)) });
      return payWithAuthorizationCall(payLink, l.invoice, l.signature, auth.authorization);
    };
    const smart: TypedDataSigner = { address: wallet1271, signTypedData: (t) => walletOwner.signTypedData(t) };

    // payWithAuthorization: first payment to a payee new to the token; later payment on an unlimited link; ERC-1271 payee.
    await measure("payWithAuthorization_first", relayer, await authorize(await link("3009.first", account("payee.1"), usdc, 25_000_000n, 1), "3009.first"));
    const unlimited3009 = await link("3009.repeat", account("payee.2"), usdc, 0n, 0);
    await sendRaw(relayer, await authorize(unlimited3009, "3009.warmup", 7_000_000n));
    await measure("payWithAuthorization_repeat", relayer, await authorize(unlimited3009, "3009.repeat", 7_000_000n));
    await measure("payWithAuthorization_erc1271Payee", relayer, await authorize(await link("3009.1271", smart, usdc, 25_000_000n, 1), "3009.1271"));

    // pay (allowance): exact approve first, then pay.
    const payWithAllowance = async (name: string | null, l: DecodedInvoiceLink, amount: bigint): Promise<void> => {
      await sendRaw(payer, approveCall(musd, payLink, amount));
      const call = payCall(payLink, l.invoice, l.signature, amount);
      if (name === null) {
        await sendRaw(payer, call);
      } else {
        await measure(name, payer, call);
      }
    };
    await payWithAllowance("pay_first", await link("pay.first", account("payee.4"), musd, 1_500_000_000_000_000_000n, 1), 1_500_000_000_000_000_000n);
    const unlimitedPay = await link("pay.repeat", account("payee.5"), musd, 0n, 0);
    await payWithAllowance(null, unlimitedPay, 10n ** 18n);
    await payWithAllowance("pay_repeat", unlimitedPay, 10n ** 18n);

    // payWithPermit: one transaction, permit nonce 0 -> 1, payee new to the token.
    const permitted = await preparePermitPayment({ link: await link("permit.first", account("payee.6"), musd, 2n * 10n ** 18n, 1), signer: payer, client, deadline: T0 + DAY });
    await measure("payWithPermit_first", payer, permitted.call);

    // payNative: first payment to an account with no balance (new-account charge), then a later one.
    const nativeOnce = await link("native.first", account("payee.7"), zeroAddress, 10n ** 15n, 1);
    await measure("payNative_first", payer, payNativeCall(payLink, nativeOnce.invoice, nativeOnce.signature, 10n ** 15n));
    const nativeMany = await link("native.repeat", account("payee.8"), zeroAddress, 0n, 0);
    await sendRaw(payer, payNativeCall(payLink, nativeMany.invoice, nativeMany.signature, 10n ** 15n));
    await measure("payNative_repeat", payer, payNativeCall(payLink, nativeMany.invoice, nativeMany.signature, 10n ** 15n));

    // cancel by the payee (funded for gas), cancelBySig relayed, and relayed for an ERC-1271 payee.
    const canceller = account("payee.9");
    await probe.request({ method: "anvil_setBalance" as never, params: [canceller.address, "0xde0b6b3a7640000"] as never });
    const toCancel = await link("cancel", canceller, usdc, 25_000_000n, 1);
    await measure("cancel", canceller, cancelCall(payLink, toCancel.invoice));
    const deployment = { chainId: profile.chainId, verifyingContract: payLink };
    const bySig = await link("cancelBySig", account("payee.10"), usdc, 25_000_000n, 1);
    await measure("cancelBySig", relayer, cancelBySigCall(payLink, await signCancel({ signer: account("payee.10"), deployment, invoice: bySig.invoice, deadline: T0 + DAY })));
    const bySig1271 = await link("cancelBySig.1271", smart, usdc, 25_000_000n, 1);
    await measure("cancelBySig_erc1271Payee", relayer, cancelBySigCall(payLink, await signCancel({ signer: smart, deployment, invoice: bySig1271.invoice, deadline: T0 + DAY, client })));

    return { chainId: profile.chainId, anvilArgs: profile.anvilArgs, hardfork: info.hardFork, network: info.network, appliesTo: profile.appliesTo, measurements };
  } finally {
    node.kill();
  }
}

export interface MeasurementsFile {
  readonly schema: "paylink.gas-measurements/1";
  readonly generator: string;
  readonly tool: string;
  readonly initCodeHash: Hex;
  readonly tokens: string;
  readonly profiles: Readonly<Record<Profile["name"], ProfileResult>>;
}

async function main(): Promise<void> {
  const version = await new Promise<string>((done) => {
    const child = spawn(anvilBinary(), ["--version"]);
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.on("close", () => { done(/anvil Version: (\S+)/.exec(text)?.[1] ?? "unknown"); });
  });
  const profiles = {} as Record<Profile["name"], ProfileResult>;
  for (const [i, profile] of PROFILES.entries()) {
    profiles[profile.name] = await measureProfile(profile, 18_600 + i);
    console.log(`measured ${profile.name}`);
  }
  const file: MeasurementsFile = {
    schema: "paylink.gas-measurements/1",
    generator: "packages/sdk/scripts/measure-gas.ts",
    tool: `anvil ${version}`,
    initCodeHash: RELEASE.initCodeHash,
    tokens: "protocol/test/mocks: Mock3009 (FiatToken-like EIP-3009 + EIP-2612, 6 decimals), MockPermit (OpenZeppelin ERC20Permit, 18 decimals), Wallet1271",
    profiles,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`wrote ${OUTPUT}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
