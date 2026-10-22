// SPDX-License-Identifier: MIT
/**
 * L3, the two PayPal rails end to end (docs/paypal/SPEC.md §15.2, e2e/specs/paypal-rails.spec.ts). Nothing is mocked
 * between the page and the chain or PayPal's API surface:
 *
 * - **The chain:** an anvil fork of the real Ethereum Sepolia (chain 11155111, its RPC
 *   https://ethereum-sepolia-rpc.publicnode.com). PayLinkV2 is not deployed there yet (decision D-CHAIN), so the fork
 *   deploys it exactly as the owner's deploy kit will: through the CREATE2 factory 0x4e59…956C with the committed
 *   release init code (web/v2/deploy/data/release.json), at the release address. Once the owner has deployed it on
 *   Sepolia and recorded protocol/deployments/11155111.json, the fork carries the real one and the suite uses it. The
 *   payer holds real Circle USDC on the fork (`anvil_dealERC20`), and pays it by its own EIP-3009 authorisation, with
 *   its own gas (no relayer in this edition).
 * - **The API:** apps/api's offline Node entry (`src/node/main.ts --offline`) with the PayPal fake: its webhook
 *   deliveries are RSA-signed and verified by the API through P10, the truth is P5 (`GET`), and its chain reads go to the
 *   fork through the registry's own RPC URL (`--local-chain`). For the injection case, test/e2e/serve.ts runs the same
 *   entry with the obedient model of test/e2e/obedient.ts in place of the Workers AI binding.
 * - **The browser:** the production build of the `all` and `paypal` editions under their real `_headers`, with Ethereum
 *   Sepolia's deployment taken from the fork (`PAYLINK_E2E_CHAINS`); the page's requests for the production API origin
 *   go to the local API, those for Sepolia's RPC to the fork, and those for PayPal's sandbox payer pages
 *   (https://www.sandbox.paypal.com, the host the pay page pins) to the fake's payer page served by the API.
 * - **The wallets:** e2e/fixtures/wallet.ts (EIP-6963), whose unlocked anvil accounts sign and send on the fork.
 *
 * The anvil default accounts are public keys: on the real Sepolia, strangers have delegated them (EIP-7702 code
 * `0xef0100…`, read on 2026-10-22). The fork clears that code, so they are the plain accounts the suite means. Nothing is
 * ever sent to the real Sepolia or to PayPal.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page, Route } from "@playwright/test";
import { concat, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import type { InvoiceKey } from "../../packages/api-contract/src/index.ts";
import { foundryBinary, freePort, jsonRpc } from "./anvil.ts";
import type { Anvil } from "./anvil.ts";
import { ACCOUNTS } from "./app.ts";
import { API_ORIGIN, SEPOLIA_RPC } from "./paypal.ts";
import { routeSepolia } from "./paypal-ui.ts";
import { REPO } from "./server.ts";
import { installWallet } from "./wallet.ts";
import type { MockWallet } from "./wallet.ts";

export { ACCOUNTS, API_ORIGIN, SEPOLIA_RPC };

export const SEPOLIA = 11155111;
/** The origin of PayPal's sandbox payer pages: the only host the pay page sends a payer to (apps/web rails.ts). */
export const PAYER_ORIGIN = "https://www.sandbox.paypal.com";

/** Ethereum Sepolia's tokens as the registry records them (packages/chains/src/chains/ethereum-sepolia.ts). */
export const USDC = { symbol: "USDC", name: "USDC (Circle)", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6, eip3009: true, eip2612: true, domain: { name: "USDC", version: "2" } } as const;
export const PYUSD = { symbol: "PYUSD", name: "PayPal USD (Paxos)", address: "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9", decimals: 6, eip3009: true, eip2612: true, domain: { name: "PayPal USD", version: "1" } } as const;
/** USDC the payer holds on the fork (1,000.00). */
export const PAYER_USDC = 1_000_000_000n;

interface ReleaseData {
  readonly initCode: Hex;
  readonly release: { readonly create2: { readonly factory: Address; readonly salt: Hex; readonly address: Address }; readonly bytecode: { readonly initCodeHash: Hex } };
}
const release = JSON.parse(readFileSync(join(REPO, "web/v2/deploy/data/release.json"), "utf8")) as ReleaseData;
/** PayLinkV2's release address (CREATE2), the same on every chain. */
export const PAYLINK = release.release.create2.address;

const PAYLINK_ABI = parseAbi(["function statesOf(bytes32[] keys) view returns ((uint32 payments, bool cancelled, uint64 lastPaidAt, uint128 total)[] states)", "function cancel((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv)", "function payWithAuthorization((address,address,uint128,uint64,uint64,uint32,bytes32,bytes32) inv, bytes payeeSig, (address,uint128,bytes32,uint256,uint256,bytes32,uint8,bytes32,bytes32) auth)"]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
export { PAYLINK_ABI };

export interface Deployment {
  readonly address: Address;
  readonly txHash: Hex;
  readonly blockNumber: string;
  readonly deployer: Address;
}

export interface SepoliaFork extends Anvil {
  /** PayLinkV2 on the fork: deployed by this fixture, or the real one once recorded. */
  readonly deployment: Deployment;
  readonly deployedHere: boolean;
  usdcOf(owner: Address): Promise<bigint>;
  stateOf(key: Hex): Promise<{ readonly payments: number; readonly cancelled: boolean }>;
  /** Mines `blocks` blocks (a `Paid` log counts 2 blocks deep, apps/api src/chain/reader.ts). */
  mine(blocks: number): Promise<void>;
}

async function receipt(url: string, hash: Hex): Promise<{ status: string; blockNumber: Hex }> {
  for (let i = 0; i < 600; i += 1) {
    const r = await jsonRpc<{ status: string; blockNumber: Hex } | null>(url, "eth_getTransactionReceipt", [hash]);
    if (r !== null) {
      if (r.status !== "0x1") {
        throw new Error(`transaction ${hash} reverted`);
      }
      return r;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

/** The fork (module comment). Needs Foundry's anvil and egress to Sepolia's public RPC. */
export async function startSepoliaFork(): Promise<SepoliaFork> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const child: ChildProcess = spawn(foundryBinary("anvil"), ["--fork-url", SEPOLIA_RPC, "--port", String(port), "--silent"], { stdio: "ignore" });
  const rpc = async <T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> => await jsonRpc<T>(url, method, params);
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
  };
  try {
    for (let i = 0; ; i += 1) {
      try {
        if ((await rpc<string>("eth_chainId")) !== "0xaa36a7") {
          throw new Error("the fork is not Ethereum Sepolia");
        }
        break;
      } catch (error) {
        if (i > 1200 || child.exitCode !== null) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    for (const account of [ACCOUNTS.deployer, ACCOUNTS.payee, ACCOUNTS.payer]) {
      await rpc("anvil_setCode", [account, "0x"]);
      await rpc("anvil_setBalance", [account, "0x56bc75e2d63100000"]);
    }
    let deployment: Deployment;
    let deployedHere = false;
    const record = join(REPO, "protocol/deployments/11155111.json");
    if ((await rpc<Hex>("eth_getCode", [PAYLINK, "latest"])) !== "0x") {
      // Deployed on Sepolia by the owner: the fork carries it; the record says where it came from.
      if (!existsSync(record)) {
        throw new Error("PayLinkV2 is on Sepolia but protocol/deployments/11155111.json does not record it yet");
      }
      const recorded = JSON.parse(readFileSync(record, "utf8")) as { deployment: { txHash: Hex; blockNumber: number; deployer: Address } };
      deployment = { address: PAYLINK, txHash: recorded.deployment.txHash, blockNumber: String(recorded.deployment.blockNumber), deployer: recorded.deployment.deployer };
    } else {
      if (keccak256(release.initCode) !== release.release.bytecode.initCodeHash) {
        throw new Error("the committed init code does not hash to the release's initCodeHash");
      }
      const { create2 } = release.release;
      // The chain's own price of the deployment (eth_estimateGas on the fork, which runs Sepolia's current rules), with
      // the kit's 10 % margin.
      const tx = { from: ACCOUNTS.deployer, to: create2.factory, data: concat([create2.salt, release.initCode]) };
      const estimate = BigInt(await rpc<Hex>("eth_estimateGas", [tx]));
      const hash = await rpc<Hex>("eth_sendTransaction", [{ ...tx, gas: `0x${((estimate * 110n) / 100n).toString(16)}` }]);
      const mined = await receipt(url, hash);
      if ((await rpc<Hex>("eth_getCode", [PAYLINK, "latest"])) === "0x") {
        throw new Error("PayLinkV2 did not land at its release address");
      }
      deployment = { address: PAYLINK, txHash: hash, blockNumber: BigInt(mined.blockNumber).toString(), deployer: ACCOUNTS.deployer };
      deployedHere = true;
    }
    await rpc("anvil_dealERC20", [ACCOUNTS.payer, USDC.address, `0x${PAYER_USDC.toString(16)}`]);
    const call = async (to: Address, data: Hex): Promise<Hex> => await rpc<Hex>("eth_call", [{ to, data }, "latest"]);
    return {
      chainId: SEPOLIA,
      url,
      rpc,
      stop,
      deployment,
      deployedHere,
      usdcOf: async (owner) => BigInt(await call(USDC.address, encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }))),
      stateOf: async (key) => {
        const data = await call(PAYLINK, encodeFunctionData({ abi: PAYLINK_ABI, functionName: "statesOf", args: [[key]] }));
        const [state] = decodeFunctionResult({ abi: PAYLINK_ABI, functionName: "statesOf", data });
        return { payments: state?.payments ?? 0, cancelled: state?.cancelled ?? false };
      },
      mine: async (blocks) => {
        await rpc("anvil_mine", [`0x${blocks.toString(16)}`]);
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** `PAYLINK_E2E_CHAINS`: Ethereum Sepolia's identity, RPC URL and tokens, with the fork's deployment. */
export function railsE2eChains(deployment: Deployment): string {
  const token = (t: typeof USDC | typeof PYUSD): object => ({ symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals, eip3009: t.eip3009, eip2612: t.eip2612, domain: t.domain });
  return JSON.stringify([{ base: SEPOLIA, rpcUrl: SEPOLIA_RPC, tokens: [token(USDC), token(PYUSD)], deployment }]);
}

/** Builds `all` and `paypal` with the fork's deployment into apps/web/dist-e2e-rails. */
export async function buildRailsSite(deployment: Deployment): Promise<string> {
  const app = join(REPO, "apps/web");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=@paylink/source", "scripts/build.ts", "--e2e"], {
      cwd: app,
      env: { ...process.env, PAYLINK_EDITIONS: "all,paypal", PAYLINK_E2E_OUT: "dist-e2e-rails", PAYLINK_E2E_CHAINS: railsE2eChains(deployment) },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`the rails e2e build exited with ${String(code)}`));
      }
    });
  });
  return join(app, "dist-e2e-rails");
}

// ------------------------------------------------------------------------------------------- the API

export interface RailsApi {
  readonly url: string;
  /** Every JSON log line the API printed (no secret: the offline entry has none). */
  readonly lines: readonly Readonly<Record<string, unknown>>[];
  /** The obedient model's requests (injection case only), one per call. */
  aiRequests(): readonly string[];
  /** The fake PayPal's invoices, as PayPal's JSON. */
  invoices(): Promise<readonly PayPalInvoice[]>;
  invoice(paypalId: string): Promise<PayPalInvoice>;
  /** The payer pays on PayPal with a note of their own (the fake's control: PayPal's page has a note field, S). */
  payWithNote(paypalId: string, note: string): Promise<void>;
  stop(): Promise<void>;
}

export interface PayPalInvoice {
  readonly id: string;
  readonly status: string;
  readonly detail: { readonly reference?: string; readonly invoice_number?: string };
  readonly items?: readonly { readonly name: string }[];
  readonly payments?: { readonly paid_amount?: { readonly value: string }; readonly transactions?: readonly { readonly payment_id?: string; readonly method?: string; readonly note?: string; readonly amount?: { readonly value: string } }[] };
}

/**
 * The API on the fork: `src/node/main.ts --offline` (`obedient: false`), or test/e2e/serve.ts with the obedient model
 * (`obedient: true`). The minute cron is off, so every reconciliation in the suite has a cause it can name (a webhook,
 * a till read, Check my invoices).
 */
export async function startRailsApi(siteOrigin: string, fork: SepoliaFork, options: { readonly obedient?: boolean } = {}): Promise<RailsApi> {
  const port = await freePort();
  const localChain = JSON.stringify({ forkUrl: fork.url, deployment: fork.deployment });
  const aiLog = options.obedient === true ? join(mkdtempSync(join(tmpdir(), "paylink-rails-")), "ai.jsonl") : null;
  const args =
    aiLog === null
      ? ["--conditions=@paylink/source", "src/node/main.ts", "--offline", "--port", String(port), "--origin", siteOrigin, "--local-chain", localChain, "--payer-origin", PAYER_ORIGIN, "--cron-seconds", "0"]
      : ["--conditions=@paylink/source", "test/e2e/serve.ts", "--port", String(port), "--origin", siteOrigin, "--local-chain", localChain, "--payer-origin", PAYER_ORIGIN, "--ai-log", aiLog];
  const child: ChildProcess = spawn(process.execPath, args, { cwd: join(REPO, "apps/api"), env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "inherit"] });
  const lines: Record<string, unknown>[] = [];
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the API did not start"));
    }, 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          lines.push(parsed);
          if (parsed["event"] === "listening") {
            clearTimeout(timer);
            resolve();
          }
        } catch {
          // not a log line
        }
        end = buffer.indexOf("\n");
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the API exited with ${String(code)}`));
    });
  });
  const url = `http://127.0.0.1:${String(port)}`;
  const fake = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetch(`${url}/__paypal${path}`, init);
    if (!response.ok) {
      throw new Error(`PayPal fake ${path}: ${String(response.status)}`);
    }
    return (await response.json()) as unknown;
  };
  const invoices = async (): Promise<readonly PayPalInvoice[]> => ((await fake("/__fake/invoices")) as { items: PayPalInvoice[] }).items;
  return {
    url,
    lines,
    aiRequests: () => (aiLog === null ? [] : readFileSync(aiLog, "utf8").split("\n").filter((l) => l !== "")),
    invoices,
    invoice: async (id) => {
      const found = (await invoices()).find((i) => i.id === id);
      if (found === undefined) {
        throw new Error(`no PayPal invoice ${id}`);
      }
      return found;
    },
    payWithNote: async (id, note) => {
      await fake(`/__fake/invoices/${id}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }) });
    },
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    },
  };
}

// ------------------------------------------------------------------------------------------- the browser

/** One request the page made to the API. */
export interface ApiSeen {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

/**
 * Routes a context: the production API origin to the local API (which answers CORS itself), Sepolia's RPC to the fork,
 * and PayPal's sandbox payer pages to the fake's payer page under the API's `/__paypal` (redirects passed through as
 * they are, so the browser follows them to the same routed origin). Returns the API requests seen.
 */
export async function routeRails(context: BrowserContext, api: RailsApi, fork: SepoliaFork): Promise<ApiSeen[]> {
  const seen: ApiSeen[] = [];
  /**
   * Answers `route` with what `target` answers. A redirect to PayPal's payer origin (the fake's 303 after a payment) is
   * followed here, through the API's `/__paypal` mount, because a fulfilled redirect does not navigate in Chromium; the
   * page then shows the final answer under the URL it posted to.
   */
  const forward = async (route: Route, target: string): Promise<number> => {
    const request = route.request();
    const headers: Record<string, string> = {};
    for (const name of ["origin", "content-type", "accept", "authorization", "access-control-request-method", "access-control-request-headers"]) {
      const value = request.headers()[name];
      if (value !== undefined) {
        headers[name] = value;
      }
    }
    const raw = request.method() === "POST" ? request.postDataBuffer() : null;
    const body = raw === null ? undefined : new Uint8Array(raw);
    let response = await fetch(target, { method: request.method(), headers, redirect: "manual", ...(body === undefined ? {} : { body }) });
    for (let hops = 0; hops < 3 && response.status >= 300 && response.status < 400; hops += 1) {
      const location = new URL(response.headers.get("location") ?? "", PAYER_ORIGIN);
      if (location.origin !== PAYER_ORIGIN) {
        throw new Error(`the PayPal fake redirected outside its payer origin: ${location.href}`);
      }
      response = await fetch(`${api.url}/__paypal${location.pathname}${location.search}`, { redirect: "manual" });
    }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) });
    return response.status;
  };
  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const status = await forward(route, `${api.url}${url.pathname}${url.search}`);
    seen.push({ method: route.request().method(), path: url.pathname, status });
  });
  await context.route(`${PAYER_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    await forward(route, `${api.url}/__paypal${url.pathname}${url.search}`);
  });
  await routeSepolia(context, fork);
  return seen;
}

export interface Actor {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly wallet: MockWallet;
  readonly api: ApiSeen[];
  /** Page errors and Content-Security-Policy violations. */
  readonly problems: string[];
}

export async function railsActor(browser: Browser, api: RailsApi, fork: SepoliaFork, account: Address): Promise<Actor> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const seen = await routeRails(context, api, fork);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations?: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const wallet = await installWallet(page, { account, chainId: SEPOLIA, endpoints: new Map([[SEPOLIA, fork.url]]), known: [SEPOLIA] });
  return { page, context, wallet, api: seen, problems };
}

/** No page error and no CSP violation on the PayLink pages this actor opened. */
export async function clean(a: Actor): Promise<void> {
  if (a.page.url().startsWith(PAYER_ORIGIN)) {
    expect(a.problems).toEqual([]);
    return;
  }
  expect(await a.page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []), "CSP violations").toEqual([]);
  expect(a.problems).toEqual([]);
}

/** Signs an invoice on the create terminal (USDC, one payment) and returns its payment link. */
export async function createInvoice(a: Actor, site: string, amount: string, memo: string): Promise<string> {
  const { page } = a;
  await page.goto(`${site}/paypal/`);
  await page.locator("#amount").fill(amount);
  await page.locator("#memo").fill(memo);
  await page.locator(".view-create > .key-primary").click();
  await expect(page.locator(".signing")).toBeVisible();
  await page.locator(".signing + .key-row .key-primary").click();
  await expect(page.locator(".ticket")).toBeVisible({ timeout: 30_000 });
  return await page.locator(".share input").inputValue();
}

/** The key of the invoice this device signed last (the device store, as the ledger reads it). */
export async function lastKey(page: Page): Promise<InvoiceKey> {
  return await page.evaluate(
    async () =>
      await new Promise<InvoiceKey>((resolve, reject) => {
        const open = indexedDB.open("paylink");
        open.onerror = () => {
          reject(new Error("no device store"));
        };
        open.onsuccess = () => {
          const read = open.result.transaction("invoices").objectStore("invoices").getAll();
          read.onsuccess = () => {
            const records = (read.result as { key: InvoiceKey; createdAt: number }[]).sort((x, y) => y.createdAt - x.createdAt);
            open.result.close();
            if (records[0] === undefined) {
              reject(new Error("no invoice on this device"));
            } else {
              resolve(records[0].key);
            }
          };
        };
      }),
  );
}

/** Makes the PayPal twin of the invoice just signed, through the API and the fake; returns its PayPal invoice number. */
export async function makeTwin(a: Actor, key: InvoiceKey, client: string): Promise<string> {
  const panel = a.page.locator("section.twin");
  await panel.locator("#twin-name").fill(client);
  await panel.locator("[data-action=make-twin]").click();
  await expect(panel).toHaveAttribute("data-state", "created", { timeout: 60_000 });
  const number = `PL-${String(SEPOLIA)}-${key.slice(2, 14)}`;
  await expect(panel.locator(".twin-readout .twin-number")).toHaveText(number);
  await expect(panel.locator(".twin-readout")).toHaveAttribute("data-status", "SHARED");
  return number;
}

/** Opens the desk: connects the wallet if needed, then signs the desk session (no transaction). */
export async function openDesk(a: Actor, site: string): Promise<Locator> {
  const { page } = a;
  await page.goto(`${site}/paypal/desk/`);
  const view = page.locator(".view-desk");
  await expect
    .poll(
      async () => {
        const state = await view.getAttribute("data-desk");
        const action = state === "no-wallet" ? "connect" : state === "no-session" ? "open-session" : null;
        if (action !== null) {
          await view.locator(`[data-action=${action}]:enabled`).click({ timeout: 1_000 }).catch(() => undefined);
        }
        return state;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe("ready");
  return view;
}

/** Check my invoices: every open twin read again on PayPal and the chain, then the assistant once. */
export async function sweep(view: Locator): Promise<void> {
  await view.locator("[data-action=sweep]").click();
  await expect(view).toHaveAttribute("data-desk", "ready", { timeout: 60_000 });
  await expect(view.locator("[data-meta]")).toContainText("read again");
}

/** The open desk card of `kind` for the PayPal invoice `number`. */
export function card(view: Locator, kind: string, number: string): Locator {
  return view.locator(`li.desk-card[data-kind=${kind}]`).filter({ has: view.page().locator(`[data-exact] [data-label=invoice][data-value="${number}"]`) });
}
