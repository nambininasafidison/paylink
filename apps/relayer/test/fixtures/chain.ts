// SPDX-License-Identifier: MIT
/**
 * A local chain for the relayer's integration suites: anvil with Monad testnet's chain id (10143, so anvil 1.8.5
 * runs Monad's gas schedule, MonadTen), the release build of PayLinkV2, the FiatToken-like Mock3009 and the
 * MockAusdFaucet, all from protocol/out. Keys are anvil's public test accounts; nothing here is a real key.
 *
 * Needs Foundry's anvil and a `forge build` in protocol/; without them the suites are skipped.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRegistry, defineLocalChain, MONAD_GAS_TABLE, monadTestnet } from "@paylink/chains";
import type { ChainDefinition, Erc20Token, Registry } from "@paylink/chains";
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress, http, parseAbi, zeroHash } from "viem";
import type { Address, Hex, PrivateKeyAccount, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const OUT = new URL("../../../../protocol/out/", import.meta.url);

/** anvil's public default accounts 0 to 5 (mnemonic "test test … junk"). Test keys only, never funded on any real chain. */
export const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  payee: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  payer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  relayer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  payer2: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  payer3: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const satisfies Record<string, Hex>;

export const CHAIN_ID = 10143;

export function anvilBinary(): string | undefined {
  const fromPath = (process.env["PATH"] ?? "").split(":").map((dir) => join(dir, "anvil"));
  return [...fromPath, join(homedir(), ".foundry", "bin", "anvil"), "/usr/local/bin/anvil"].find((path) => path !== "anvil" && existsSync(path));
}

export const ARTIFACTS = ["PayLinkV2.sol/PayLinkV2.json", "Mock3009.sol/Mock3009.json", "MockAusdFaucet.sol/MockAusdFaucet.json"] as const;

/** True when anvil and the Foundry artifacts are available. */
export function chainAvailable(): boolean {
  return anvilBinary() !== undefined && ARTIFACTS.every((artifact) => existsSync(new URL(artifact, OUT)));
}

export const bytecode = (artifact: (typeof ARTIFACTS)[number]): Hex => (JSON.parse(readFileSync(new URL(artifact, OUT), "utf8")) as { bytecode: { object: Hex } }).bytecode.object;

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

export interface LocalChain {
  readonly url: string;
  readonly client: PublicClient;
  readonly payLink: Address;
  readonly token: Address;
  readonly faucet: Address;
  /** A local registry entry (http://127.0.0.1, `local: true`) for the Node adapter. */
  readonly local: ChainDefinition;
  readonly registry: Registry;
  readonly accounts: Readonly<Record<keyof typeof KEYS, PrivateKeyAccount>>;
  rpc<T>(method: string, params?: readonly unknown[]): Promise<T>;
  send(account: PrivateKeyAccount, call: { to: Address; data: Hex; value?: bigint }, gas?: bigint): Promise<Hex>;
  now(): Promise<bigint>;
  balanceOf(account: Address): Promise<bigint>;
  /** Toggles anvil's automine (off: transactions wait in the mempool until `mine`). */
  automine(on: boolean): Promise<void>;
  mine(): Promise<void>;
  stop(): void;
}

export const TOKEN_ABI = parseAbi(["function mint(address to, uint256 value)", "function balanceOf(address) view returns (uint256)"]);

export function tokenEntry(address: Address): Erc20Token {
  return {
    kind: "erc20",
    symbol: "USDC",
    name: "Mock3009",
    address,
    decimals: 6,
    capabilities: { eip3009: true, eip2612: true, native: false },
    eip712Domain: { name: "USD Coin", version: "2" },
    listing: "default",
    confidence: "C",
    pendingVerification: [],
  };
}

/** Starts anvil, deploys PayLinkV2, Mock3009 ("USD Coin", version "2", 6 decimals) and the mock faucet, funds payers. */
export async function startChain(): Promise<LocalChain> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const anvil: ChildProcess = spawn(anvilBinary() ?? "anvil", ["--port", String(port), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  const client = createPublicClient({ transport: http(url), pollingInterval: 50 });
  for (let i = 0; i < 100; i += 1) {
    try {
      await client.getChainId();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const accounts = Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name, privateKeyToAccount(key)])) as Record<keyof typeof KEYS, PrivateKeyAccount>;
  const rpc = async <T>(method: string, params: readonly unknown[] = []): Promise<T> => await client.request<{ Method: string; Parameters: readonly unknown[]; ReturnType: T }>({ method, params });
  const send = async (account: PrivateKeyAccount, call: { to: Address; data: Hex; value?: bigint }, gas?: bigint): Promise<Hex> => {
    const wallet = createWalletClient({ account, transport: http(url) });
    const hash = await wallet.sendTransaction({ account, chain: null, to: call.to, data: call.data, value: call.value ?? 0n, ...(gas === undefined ? {} : { gas }) });
    await client.waitForTransactionReceipt({ hash });
    return hash;
  };
  const deploy = async (data: Hex): Promise<Address> => {
    const wallet = createWalletClient({ account: accounts.deployer, transport: http(url) });
    const hash = await wallet.sendTransaction({ account: accounts.deployer, chain: null, data });
    const receipt = await client.waitForTransactionReceipt({ hash });
    return getAddress(receipt.contractAddress ?? "0x");
  };
  const payLink = await deploy(bytecode("PayLinkV2.sol/PayLinkV2.json"));
  const token = await deploy(encodeDeployData({ abi: parseAbi(["constructor(string name, string symbol, string version, uint8 decimals)"]), bytecode: bytecode("Mock3009.sol/Mock3009.json"), args: ["USD Coin", "USDC", "2", 6] }));
  const faucet = await deploy(encodeDeployData({ abi: parseAbi(["constructor(address token, uint256 drip, uint256 cooldown)"]), bytecode: bytecode("MockAusdFaucet.sol/MockAusdFaucet.json"), args: [token, 10_000_000_000n, 60n] }));
  for (const payer of [accounts.payer, accounts.payer2, accounts.payer3]) {
    await send(accounts.deployer, { to: token, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "mint", args: [payer.address, 1_000_000_000n] }) });
  }
  const faucetGas = monadTestnet.contracts.ausdFaucet?.gas;
  const local: ChainDefinition = {
    ...defineLocalChain({
      chainId: CHAIN_ID,
      rpcUrl: url,
      chargesGasLimit: true,
      gas: MONAD_GAS_TABLE,
      tokens: [tokenEntry(token)],
      deployment: {
        address: payLink,
        status: "active",
        release: "2.0.0",
        method: "CREATE",
        deployer: accounts.deployer.address,
        txHash: zeroHash,
        blockNumber: 1n,
        initCodeHash: zeroHash,
        maskedRuntimeHash: zeroHash,
        runtimeCodeHash: zeroHash,
      },
    }),
    contracts: faucetGas === undefined ? {} : { ausdFaucet: { address: faucet, confidence: "C", gas: faucetGas } },
  };
  return {
    url,
    client,
    payLink,
    token,
    faucet,
    local,
    registry: createRegistry([local]),
    accounts,
    rpc,
    send,
    now: async () => (await client.getBlock()).timestamp,
    balanceOf: async (account) => await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [account] }),
    automine: async (on) => {
      await rpc("evm_setAutomine", [on]);
    },
    mine: async () => {
      await rpc("evm_mine");
    },
    stop: () => {
      anvil.kill();
    },
  };
}
