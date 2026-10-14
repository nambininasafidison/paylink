// SPDX-License-Identifier: MIT
/**
 * The Mezo edition end to end (e2e/specs/mezo.spec.ts) against an anvil fork of Mezo testnet itself: the real MUSD
 * (`0x1189…c503`, 18 decimals, EIP-2612, no EIP-3009), the real canonical CREATE2 factory, and PayLinkV2 2.0.0 deployed
 * through that factory on the fork exactly as the deploy kit does (it is not on Mezo testnet yet; if it is by the time
 * this runs, the fork already holds it and nothing is deployed). Nothing is sent to Mezo testnet: every transaction
 * exists only on the fork, from fork accounts made from a random mnemonic for the run.
 *
 * Test MUSD: MUSD's `mint` is open to the addresses on its `mintList`; BorrowerOperations is one (that is how a loan
 * mints MUSD). The fork impersonates it to mint test MUSD to the payers. Address and role, both checked on the fork
 * before use: `solidity/artifacts/deployments/matsnet/BorrowerOperations.json` of github.com/mezo-org/musd at commit
 * aa25fd6defbe6c1385940e183ea7a0a3df4533d8 (docs/research/mezo.md §13); on chain, `BorrowerOperations.musd()` is MUSD
 * and `MUSD.mintList(BorrowerOperations)` is true.
 *
 * The site is the production build of the `all` and `mezo` editions with Mezo testnet's deployment taken from the fork
 * (`PAYLINK_E2E_CHAINS`, as the other e2e builds do); the registry's RPC URL, https://rpc.test.mezo.org, is routed to
 * the fork by the test. The fork needs egress to that RPC (`PAYLINK_MEZO_RPC` overrides it).
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Route } from "@playwright/test";
import { concat, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import type { Fork } from "../capture/fork.ts";
import { foundryBinary, freePort, jsonRpc } from "./anvil.ts";
import type { NullLookups } from "./null-lookups.ts";
import { REPO } from "./server.ts";

export const MEZO = {
  chainId: 31611,
  /** The registry's RPC (what the app calls, routed to the fork) and the upstream the fork is taken from. */
  registryRpc: "https://rpc.test.mezo.org",
  upstream: process.env["PAYLINK_MEZO_RPC"] ?? "https://rpc.test.mezo.org",
  explorer: "https://explorer.test.mezo.org",
  musd: getAddress("0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503"),
  borrowerOperations: getAddress("0xCdF7028ceAB81fA0C6971208e83fa7872994beE5"),
} as const;

/** MUSD's EIP-712 domain as the token reports it (ERC-5267, docs/research/mezo.md §4). */
export const MUSD_DOMAIN = { name: "Mezo USD", version: "1" } as const;

interface ReleaseData {
  readonly initCode: Hex;
  readonly release: { readonly create2: { readonly factory: Address; readonly salt: Hex; readonly address: Address } };
}
const release = JSON.parse(readFileSync(join(REPO, "web/v2/deploy/data/release.json"), "utf8")) as ReleaseData;
export const PAYLINK = getAddress(release.release.create2.address);

const musdAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address account, uint256 amount)",
  "function mintList(address) view returns (bool)",
  "function nonces(address) view returns (uint256)",
]);

async function mined(fork: Fork, hash: Hex): Promise<{ blockNumber: Hex; status: string }> {
  for (let i = 0; i < 400; i += 1) {
    const receipt = await fork.rpc<{ status: string; blockNumber: Hex } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt !== null) {
      if (receipt.status !== "0x1") {
        throw new Error(`transaction ${hash} reverted on the Mezo fork`);
      }
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

export interface MezoFork {
  readonly fork: Fork;
  /**
   * Mezo testnet's own `eth_maxPriorityFeePerGas`, read from the network when the fork starts. anvil answers 1 gwei
   * whatever it forks, which would make every BTC fee the app shows millions of times Mezo's; `routeMezo` answers the
   * page with this one instead (the only answer it does not take from the fork).
   */
  readonly tip: Hex;
  /** PayLinkV2's deployment on the fork, as the e2e registry records it. */
  readonly deployment: { readonly address: Address; readonly txHash: Hex; readonly blockNumber: string; readonly deployer: Address };
  /** Mints test MUSD on the fork (BorrowerOperations, impersonated). */
  mintMusd(to: Address, amount: bigint): Promise<void>;
  musd(functionName: "balanceOf" | "nonces", owner: Address): Promise<bigint>;
  allowance(owner: Address, spender: Address): Promise<bigint>;
  btc(owner: Address): Promise<bigint>;
  setBtc(owner: Address, amount: bigint): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Forks Mezo testnet at its latest block, checks that MUSD and the factory are the ones the facts describe, and puts
 * PayLinkV2 at its release address through the canonical factory (unless the network already holds it there).
 */
/** Mezo testnet's RPC could not be forked from this machine (no egress, or the RPC is down). */
export class MezoUnreachable extends Error {
  constructor(cause: unknown) {
    super(`cannot fork ${MEZO.upstream}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MezoUnreachable";
  }
}

/**
 * anvil forking Mezo testnet at its latest block, with fork accounts from a random mnemonic:
 * `--hardfork prague`: anvil's rules for a chain it does not know need blob-gas fields that Mezo's block headers do not
 * carry ("Excess blob gas not set" on every `eth_call`); Prague runs the Cancun opcodes Mezo executes.
 */
async function forkMezo(): Promise<Fork> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const args = ["--fork-url", MEZO.upstream, "--port", String(port), "--mnemonic-random", "--silent", "--hardfork", "prague"];
  const child: ChildProcess = spawn(foundryBinary("anvil"), args, { stdio: "ignore" });
  const rpc = async <T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> => await jsonRpc<T>(url, method, params);
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
    }
  };
  try {
    for (let i = 0; ; i += 1) {
      try {
        await rpc("eth_chainId");
        break;
      } catch (error) {
        if (i > 600 || child.exitCode !== null) {
          throw error;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const id = Number(await rpc<string>("eth_chainId"));
    if (id !== MEZO.chainId) {
      throw new Error(`the fork of ${MEZO.upstream} is chain ${String(id)}, not ${String(MEZO.chainId)}`);
    }
    const forkBlock = BigInt(await rpc<string>("eth_blockNumber"));
    const accounts = (await rpc<string[]>("eth_accounts")).map((a) => getAddress(a));
    return { chainId: MEZO.chainId, url, forkBlock, accounts, rpc, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function startMezoFork(): Promise<MezoFork> {
  let fork: Fork;
  try {
    fork = await forkMezo();
  } catch (error) {
    throw new MezoUnreachable(error);
  }
  try {
    const tip = await jsonRpc<Hex>(MEZO.upstream, "eth_maxPriorityFeePerGas").catch((): Hex => "0x10");
    return { ...(await prepare(fork)), tip };
  } catch (error) {
    await fork.stop();
    throw error;
  }
}

async function prepare(fork: Fork): Promise<Omit<MezoFork, "tip">> {
  const call = async (to: Address, data: Hex): Promise<Hex> => await fork.rpc<Hex>("eth_call", [{ to, data }, "latest"]);
  const musdCall = async (functionName: "balanceOf" | "nonces", owner: Address): Promise<bigint> =>
    BigInt(await call(MEZO.musd, functionName === "balanceOf" ? encodeFunctionData({ abi: musdAbi, functionName: "balanceOf", args: [owner] }) : encodeFunctionData({ abi: musdAbi, functionName: "nonces", args: [owner] })));
  const listed = decodeFunctionResult({ abi: musdAbi, functionName: "mintList", data: await call(MEZO.musd, encodeFunctionData({ abi: musdAbi, functionName: "mintList", args: [MEZO.borrowerOperations] })) });
  if (!listed) {
    throw new Error("BorrowerOperations is no longer on MUSD's mintList: the fixture cannot mint test MUSD");
  }
  const factoryCode = await fork.rpc<Hex>("eth_getCode", [release.release.create2.factory, "latest"]);
  if (factoryCode === "0x") {
    throw new Error("the canonical CREATE2 factory is missing on Mezo testnet");
  }
  const deployer = fork.accounts[0];
  if (deployer === undefined) {
    throw new Error("the fork has no account");
  }
  let deployment: MezoFork["deployment"];
  if ((await fork.rpc<Hex>("eth_getCode", [PAYLINK, "latest"])) === "0x") {
    const txHash = await fork.rpc<Hex>("eth_sendTransaction", [{ from: deployer, to: release.release.create2.factory, data: concat([release.release.create2.salt, release.initCode]), gas: "0x3d0900" }]);
    const receipt = await mined(fork, txHash);
    if ((await fork.rpc<Hex>("eth_getCode", [PAYLINK, "latest"])) === "0x") {
      throw new Error("PayLinkV2 is not at its release address after the factory call");
    }
    deployment = { address: PAYLINK, txHash, blockNumber: BigInt(receipt.blockNumber).toString(), deployer };
  } else {
    // Deployed on Mezo testnet itself since the facts were written: the fork holds the real one.
    deployment = { address: PAYLINK, txHash: `0x${"0".repeat(63)}1`, blockNumber: fork.forkBlock.toString(), deployer };
  }
  return {
    fork,
    deployment,
    mintMusd: async (to, amount) => {
      await fork.rpc("anvil_impersonateAccount", [MEZO.borrowerOperations]);
      await fork.rpc("anvil_setBalance", [MEZO.borrowerOperations, "0xde0b6b3a7640000"]);
      const hash = await fork.rpc<Hex>("eth_sendTransaction", [{ from: MEZO.borrowerOperations, to: MEZO.musd, data: encodeFunctionData({ abi: musdAbi, functionName: "mint", args: [to, amount] }) }]);
      await mined(fork, hash);
      await fork.rpc("anvil_stopImpersonatingAccount", [MEZO.borrowerOperations]);
    },
    musd: musdCall,
    allowance: async (owner, spender) => BigInt(await call(MEZO.musd, encodeFunctionData({ abi: musdAbi, functionName: "allowance", args: [owner, spender] }))),
    btc: async (owner) => BigInt(await fork.rpc<Hex>("eth_getBalance", [owner, "latest"])),
    setBtc: async (owner, amount) => {
      await fork.rpc("anvil_setBalance", [owner, `0x${amount.toString(16)}`]);
    },
    stop: async () => {
      await fork.stop();
    },
  };
}

/** `PAYLINK_E2E_CHAINS` for the Mezo build: the registry's Mezo testnet with the real MUSD and the fork's deployment. */
export function mezoChains(deployment: MezoFork["deployment"]): string {
  const musd = { symbol: "MUSD", name: "MUSD (Mezo)", address: MEZO.musd, decimals: 18, eip3009: false, eip2612: true, domain: MUSD_DOMAIN };
  return JSON.stringify([{ base: MEZO.chainId, rpcUrl: MEZO.registryRpc, tokens: [musd], deployment }]);
}

/** Builds the `all` and `mezo` editions into apps/web/dist-e2e-mezo (a few seconds). */
export async function buildMezoSite(chains: string): Promise<string> {
  const app = join(REPO, "apps/web");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=@paylink/source", "scripts/build.ts", "--e2e"], {
      cwd: app,
      env: { ...process.env, PAYLINK_E2E_CHAINS: chains, PAYLINK_EDITIONS: "all,mezo", PAYLINK_E2E_OUT: "dist-e2e-mezo" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`the Mezo build exited with ${String(code)}`));
      }
    });
  });
  return join(app, "dist-e2e-mezo");
}

/**
 * Sends the page's requests for the registry's Mezo RPC to the fork, with the CORS answers a public RPC gives; the
 * suggested tip is Mezo testnet's own (`MezoFork.tip`). `nulls`: answer lookups by hash of mined transactions with
 * `null` the way Mezo testnet's RPC does (fixtures/null-lookups.ts), which the fork never does.
 */
export async function routeMezo(context: BrowserContext, mezo: Pick<MezoFork, "fork" | "tip">, options: { readonly nulls?: NullLookups } = {}): Promise<{ method: string }[]> {
  const forkUrl = mezo.fork.url;
  const log: { method: string }[] = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
  await context.route(`${MEZO.registryRpc}/**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const body = request.postData() ?? "{}";
    const parsed = JSON.parse(body) as { id?: unknown; method?: string } | { id?: unknown; method?: string }[];
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    for (const one of calls) {
      log.push({ method: one.method ?? "?" });
    }
    if (!Array.isArray(parsed) && parsed.method === "eth_maxPriorityFeePerGas") {
      await route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: mezo.tip }) });
      return;
    }
    // anvil may close a kept-alive socket between two requests ("other side closed"): one retry on a fresh one.
    const forward = async (): Promise<Response> => await fetch(forkUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
    let response: Response;
    try {
      response = await forward().catch(forward);
    } catch {
      await route.abort("failed").catch(() => undefined);
      return;
    }
    const text = await response.text();
    await route.fulfill({ status: response.status, headers: { ...cors, "content-type": "application/json" }, body: options.nulls === undefined ? text : options.nulls.rewrite(body, text) });
  });
  return log;
}
