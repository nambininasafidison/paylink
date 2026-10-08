// SPDX-License-Identifier: MIT
/**
 * The editions end to end (PAYLINK-V2-SPEC §4.2, tier T1): the production build of `all`, `monad` and `base` (chains
 * swapped for local ones, as in fixtures/app.ts) under their real `_headers`, two anvil chains with the PayLinkV2 release
 * at its CREATE2 address, the gasless relayer itself (apps/relayer through its Node adapter, a separate process), and
 * Chromium's WebAuthn virtual authenticator with the PRF extension for the Monad edition's PayLink keys (Mera).
 *
 * - Monad testnet's identity (10143): the release, Mock3009 as AUSD, and MockAusdFaucet as the AUSD faucet the relayer's
 *   onboarding calls.
 * - Base Sepolia's identity (84532): the release and Mock3009 as USDC (EIP-3009 + EIP-2612, domain version "2").
 *
 * The app keeps its production `/config.json`: the relayer is https://paylink-relayer.raherizonambinina.workers.dev,
 * and the test routes that origin to the local relayer, as it routes the registry RPCs to anvil. The relayer's key is
 * anvil's public test account 5, derived here from anvil's public mnemonic; it holds value on no real chain.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page, Route } from "@playwright/test";
import { bytesToHex, encodeDeployData, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { ACCOUNTS, artifact, PAYLINK, send, startAppChain, TOKEN } from "./app.ts";
import type { AppChain } from "./app.ts";
import { freePort } from "./anvil.ts";
import { REPO } from "./server.ts";

export const MONAD = 10143;
export const BASE = 84532;
/** The production relayer origin of apps/web/public/config.json, routed to the local relayer by `routeRelayer`. */
export const RELAYER_ORIGIN = "https://paylink-relayer.raherizonambinina.workers.dev";
/** What MockAusdFaucet drips (10,000 AUSD at 6 decimals, the live faucet's amount) and its cooldown. */
export const DRIP = 10_000_000_000n;
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
/** anvil's public default account 5: the local relayer's key (never funded on any real chain). */
const RELAYER_INDEX = 5;

export const USDC_DOMAIN = { name: "USDC (local)", version: "2" } as const;

/** The `PAYLINK_E2E_CHAINS` override of the editions build: both chains genuine, local tokens. */
export function editionsChains(): string {
  const recorded = { txHash: `0x${"0".repeat(63)}1`, blockNumber: "1", deployer: ACCOUNTS.deployer };
  const ausd = { symbol: "AUSD", name: TOKEN.name, address: TOKEN.address, decimals: 6, eip3009: true, eip2612: true, domain: TOKEN.domain };
  const usdc = { symbol: "USDC", name: "USDC (local)", address: TOKEN.address, decimals: 6, eip3009: true, eip2612: true, domain: USDC_DOMAIN };
  return JSON.stringify([
    { base: MONAD, rpcUrl: "https://testnet-rpc.monad.xyz", chargesGasLimit: true, tokens: [ausd], deployment: { ...recorded, address: PAYLINK } },
    { base: BASE, rpcUrl: "https://sepolia.base.org", tokens: [usdc], deployment: { ...recorded, address: PAYLINK } },
  ]);
}

/** Builds `all`, `monad` and `base` into apps/web/dist-e2e-editions (about fifteen seconds). */
export async function buildEditionsSite(): Promise<string> {
  const app = join(REPO, "apps/web");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=@paylink/source", "scripts/build.ts", "--e2e"], {
      cwd: app,
      env: { ...process.env, PAYLINK_E2E_CHAINS: editionsChains(), PAYLINK_EDITIONS: "all,monad,base", PAYLINK_E2E_OUT: "dist-e2e-editions" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`the editions build exited with ${String(code)}`));
      }
    });
  });
  return join(app, "dist-e2e-editions");
}

export interface EditionChains {
  readonly monad: AppChain;
  readonly base: AppChain;
  readonly faucet: Address;
}

/** Both chains, and the AUSD faucet on Monad's. Base's token is a second Mock3009 deployed the same way (USDC domain). */
export async function startEditionChains(): Promise<EditionChains> {
  const [monad, base] = await Promise.all([startAppChain(MONAD), startAppChain(BASE, USDC_DOMAIN, "USDC")]);
  const faucet = artifact("MockAusdFaucet.sol/MockAusdFaucet.json");
  const deployed = await send(monad.anvil, ACCOUNTS.deployer, null, encodeDeployData({ abi: faucet.abi, bytecode: faucet.bytecode, args: [TOKEN.address, DRIP, 60n] }));
  if (deployed.contractAddress === null) {
    throw new Error("the faucet did not deploy");
  }
  return { monad, base, faucet: getAddress(deployed.contractAddress) };
}

export interface LocalRelayer {
  readonly url: string;
  readonly address: Address;
  stop(): Promise<void>;
}

/** The relayer (apps/relayer `start:local`) serving both anvil chains, for the e2e server's origin only. */
export async function startRelayer(chains: EditionChains, siteOrigin: string): Promise<LocalRelayer> {
  const dir = mkdtempSync(join(tmpdir(), "paylink-relayer-"));
  const config = join(dir, "local.json");
  const port = await freePort();
  const token = (domain: { name: string; version: string }, symbol: string) => ({ address: TOKEN.address, symbol, decimals: 6, eip3009: true, eip2612: true, eip712Domain: domain });
  writeFileSync(
    config,
    JSON.stringify({
      allowedOrigins: [siteOrigin],
      chains: [
        { chainId: MONAD, rpcUrl: chains.monad.anvil.url, deployment: PAYLINK, gas: "monad", tokens: [token(TOKEN.domain, "AUSD")], faucet: chains.faucet },
        { chainId: BASE, rpcUrl: chains.base.anvil.url, deployment: PAYLINK, gas: "snapshot", tokens: [token(USDC_DOMAIN, "USDC")] },
      ],
    }),
  );
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: RELAYER_INDEX });
  const key = account.getHdKey().privateKey;
  if (key === null) {
    throw new Error("no relayer key");
  }
  const child: ChildProcess = spawn(process.execPath, ["--conditions=@paylink/source", "src/node/main.ts", "--config", config, "--port", String(port)], {
    cwd: join(REPO, "apps/relayer"),
    env: { ...process.env, RELAYER_PK: bytesToHex(key) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = `http://127.0.0.1:${String(port)}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the local relayer did not start"));
    }, 30_000);
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
    url,
    address: account.address,
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

/** Sends the page's requests for the production relayer to the local one (CORS answered by the relayer itself). */
export async function routeRelayer(context: BrowserContext, relayer: LocalRelayer): Promise<{ method: string; path: string; status: number }[]> {
  const log: { method: string; path: string; status: number }[] = [];
  await context.route(`${RELAYER_ORIGIN}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers: Record<string, string> = {};
    for (const name of ["origin", "content-type", "accept", "access-control-request-method", "access-control-request-headers"]) {
      const value = request.headers()[name];
      if (value !== undefined) {
        headers[name] = value;
      }
    }
    const body = request.method() === "POST" ? (request.postData() ?? "") : undefined;
    const response = await fetch(`${relayer.url}${url.pathname}`, { method: request.method(), headers, ...(body === undefined ? {} : { body }) });
    log.push({ method: request.method(), path: url.pathname, status: response.status });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) });
  });
  return log;
}

/** Chromium's virtual authenticator with user verification and PRF (proven in Chromium 141), one per page. */
export async function addAuthenticator(context: BrowserContext, page: Page): Promise<{ readonly cdp: CDPSession; readonly id: string; credentials(): Promise<number> }> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  return {
    cdp,
    id: authenticatorId,
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length,
  };
}

export type { Hex };
