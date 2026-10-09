// SPDX-License-Identifier: MIT
/**
 * Submission captures (docs/submissions/README.md): the production build of the site, served at its production origin,
 * against anvil forks of the two testnets where PayLinkV2 2.0.0 is deployed.
 *
 * - The site is `apps/web/dist`, exactly what Cloudflare Pages serves (production registry, production `/config.json`,
 *   the passkey rpId pinned to paylink-mg.pages.dev), answered by `fixtures/pages.ts` under its real `_headers` and
 *   reached at `https://paylink-mg.pages.dev` through request routing, so the page runs on its real origin.
 * - The registry RPCs go to anvil forks of Monad testnet (10143) and Base Sepolia (84532), taken at the latest block:
 *   the PayLinkV2 deployment at its CREATE2 address, Agora's AUSD and its faucet, and Circle's USDC are the real
 *   contracts as the networks hold them. Nothing is sent to either network: transactions exist only on the forks.
 * - The relayer is `apps/relayer` through its Node adapter, with a key generated for this run only, funded on the fork
 *   with `anvil_setBalance`; the production relayer origin of `/config.json` is routed to it.
 *
 * Forks need egress to testnet-rpc.monad.xyz and sepolia.base.org. Fork accounts come from a random mnemonic
 * (`--mnemonic-random`), because anvil's public accounts carry EIP-7702 delegations on public testnets.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Route } from "@playwright/test";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundryBinary, freePort, jsonRpc } from "../fixtures/anvil.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { REPO } from "../fixtures/server.ts";

export const ORIGIN = "https://paylink-mg.pages.dev";
export const RELAYER_ORIGIN = "https://paylink-relayer.raherizonambinina.workers.dev";

/** What the registry (`@paylink/chains`) names on each network; the forks hold the deployed contracts at these addresses. */
export const MONAD = {
  chainId: 10143,
  rpc: process.env["PAYLINK_CAPTURE_MONAD_RPC"] ?? "https://testnet-rpc.monad.xyz",
  payLink: getAddress("0x448eCce9711860502806A3d5B021a4f9Ba715082"),
  ausd: getAddress("0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC"),
  faucet: getAddress("0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C"),
} as const;
export const BASE = {
  chainId: 84532,
  rpc: process.env["PAYLINK_CAPTURE_BASE_RPC"] ?? "https://sepolia.base.org",
  payLink: getAddress("0x448eCce9711860502806A3d5B021a4f9Ba715082"),
  usdc: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
} as const;

export interface Fork {
  readonly chainId: number;
  readonly url: string;
  /** The network block the fork was taken at. */
  readonly forkBlock: bigint;
  /** Unlocked fork accounts (random mnemonic). */
  readonly accounts: readonly Address[];
  rpc<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
  stop(): Promise<void>;
}

export async function startFork(chainId: number, rpcUrl: string): Promise<Fork> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const child: ChildProcess = spawn(foundryBinary("anvil"), ["--fork-url", rpcUrl, "--port", String(port), "--mnemonic-random", "--silent"], { stdio: "ignore" });
  const rpc = async <T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> => await jsonRpc<T>(url, method, params);
  for (let i = 0; ; i += 1) {
    try {
      await rpc("eth_chainId");
      break;
    } catch (error) {
      if (i > 600) {
        child.kill();
        throw error;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const id = Number(await rpc<string>("eth_chainId"));
  if (id !== chainId) {
    child.kill();
    throw new Error(`the fork of ${rpcUrl} is chain ${String(id)}, not ${String(chainId)}`);
  }
  const forkBlock = BigInt(await rpc<string>("eth_blockNumber"));
  const accounts = (await rpc<string[]>("eth_accounts")).map((a) => getAddress(a));
  return {
    chainId,
    url,
    forkBlock,
    accounts,
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

async function mined(fork: Fork, hash: Hex): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const receipt = await fork.rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt !== null) {
      if (receipt.status !== "0x1") {
        throw new Error(`transaction ${hash} reverted on the fork of ${String(fork.chainId)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

/** Sends a transaction on the fork from an unlocked or impersonated account. */
export async function sendOnFork(fork: Fork, from: Address, to: Address, data: Hex): Promise<void> {
  await mined(fork, await fork.rpc<Hex>("eth_sendTransaction", [{ from, to, data }]));
}

/**
 * Circle's USDC on the Base Sepolia fork: the token's master minter (read from the token) makes a fork account a
 * minter, which mints `amount` to `to`. Fork-only state; nothing reaches Base Sepolia.
 */
export async function mintUsdc(fork: Fork, to: Address, amount: bigint): Promise<void> {
  const abi = parseAbi([
    "function masterMinter() view returns (address)",
    "function configureMinter(address minter, uint256 allowance) returns (bool)",
    "function mint(address to, uint256 amount) returns (bool)",
  ]);
  const raw = await fork.rpc<Hex>("eth_call", [{ to: BASE.usdc, data: encodeFunctionData({ abi, functionName: "masterMinter" }) }, "latest"]);
  const master = getAddress(`0x${raw.slice(-40)}`);
  const minter = fork.accounts[9];
  if (minter === undefined) {
    throw new Error("the fork has no tenth account");
  }
  await fork.rpc("anvil_impersonateAccount", [master]);
  await fork.rpc("anvil_setBalance", [master, "0xde0b6b3a7640000"]);
  await sendOnFork(fork, master, BASE.usdc, encodeFunctionData({ abi, functionName: "configureMinter", args: [minter, amount] }));
  await fork.rpc("anvil_stopImpersonatingAccount", [master]);
  await sendOnFork(fork, minter, BASE.usdc, encodeFunctionData({ abi, functionName: "mint", args: [to, amount] }));
}

export interface ForkRelayer {
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * The relayer (apps/relayer `start:local`) on both forks, answering the production origin only. Its key is generated
 * for this run and funded on the forks; it exists nowhere else.
 */
export async function startForkRelayer(monad: Fork, base: Fork): Promise<ForkRelayer> {
  const dir = mkdtempSync(join(tmpdir(), "paylink-capture-relayer-"));
  const config = join(dir, "local.json");
  const port = await freePort();
  writeFileSync(
    config,
    JSON.stringify({
      allowedOrigins: [ORIGIN],
      chains: [
        { chainId: MONAD.chainId, rpcUrl: monad.url, deployment: MONAD.payLink, gas: "monad", tokens: [{ address: MONAD.ausd, symbol: "AUSD", decimals: 6, eip3009: true, eip2612: true }], faucet: MONAD.faucet },
        { chainId: BASE.chainId, rpcUrl: base.url, deployment: BASE.payLink, gas: "snapshot", tokens: [{ address: BASE.usdc, symbol: "USDC", decimals: 6, eip3009: true, eip2612: false, eip712Domain: { name: "USDC", version: "2" } }] },
      ],
    }),
  );
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  for (const fork of [monad, base]) {
    await fork.rpc("anvil_setBalance", [address, "0x8ac7230489e80000"]);
  }
  const child: ChildProcess = spawn(process.execPath, ["--conditions=@paylink/source", "src/node/main.ts", "--config", config, "--port", String(port)], {
    cwd: join(REPO, "apps/relayer"),
    env: { ...process.env, RELAYER_PK: key },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the local relayer did not start"));
    }, 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes('"event":"listening"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the local relayer exited with ${String(code)}`));
    });
  });
  child.stdout?.resume();
  return {
    url: `http://127.0.0.1:${String(port)}`,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Forwards a routed request to a local server, keeping method, body and the headers that matter (CORS included). */
async function forward(route: Route, target: string): Promise<void> {
  const request = route.request();
  const headers: Record<string, string> = {};
  for (const name of ["origin", "content-type", "accept", "access-control-request-method", "access-control-request-headers"]) {
    const value = request.headers()[name];
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  const body = request.method() === "POST" ? (request.postData() ?? "") : undefined;
  const response = await fetch(target, { method: request.method(), headers, redirect: "manual", ...(body === undefined ? {} : { body }) });
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) });
}

/** The site at its production origin, answered by the local Pages server (its `_headers` included). */
export async function routeSite(context: BrowserContext, site: StaticServer): Promise<void> {
  await context.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    await forward(route, `${site.origin}${url.pathname}${url.search}`);
  });
}

/** The production relayer origin, answered by the local relayer. */
export async function routeForkRelayer(context: BrowserContext, relayer: ForkRelayer): Promise<void> {
  await context.route(`${RELAYER_ORIGIN}/**`, async (route: Route) => {
    await forward(route, `${relayer.url}${new URL(route.request().url()).pathname}`);
  });
}
