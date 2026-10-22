// SPDX-License-Identifier: MIT
/**
 * The deploy page (web/v2/deploy) on Mezo testnet (31611, ADR 0017), under its production CSP, with the mock EIP-1193
 * wallet announced through EIP-6963:
 * - offline, on anvil with Mezo testnet's chain id, Mezo's 130 wei base fee and the canonical CREATE2 proxy installed by
 *   its presigned transaction (Mezo testnet has the canonical runtime): the wallet does not know Mezo and adds it from
 *   the registry; the page reads the registry RPC (https://rpc.test.mezo.org, allowed by its CSP), says that Mezo
 *   charges at least half the gas limit, sends exactly Deploy.s.sol's CREATE2 transaction with the clamped limit,
 *   verifies, and prints protocol/deployments/31611.json byte for byte as tools/verify-deployment does, while the RPC
 *   answers null to lookups of the mined deployment as Mezo testnet's does (fixtures/null-lookups.ts);
 * - with PAYLINK_FORK_MEZO=1 (egress to rpc.test.mezo.org), the same against an anvil fork of Mezo testnet itself: the
 *   page deploys through Mezo's own factory, from a fork-only account. Nothing is sent to Mezo testnet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { concat, numberToHex } from "viem";
import type { Address, Hex } from "viem";
import { main as verifyCli } from "../../tools/verify-deployment/verify-deployment.mjs";
import { startFork } from "../capture/fork.ts";
import type { Fork } from "../capture/fork.ts";
import { ANVIL_ACCOUNTS, PROXY, startAnvil } from "../fixtures/anvil.ts";
import type { Anvil } from "../fixtures/anvil.ts";
import { axe } from "../fixtures/axe.ts";
import { serveWeb, WEB_ROOT } from "../fixtures/server.ts";
import type { StaticServer } from "../fixtures/server.ts";
import { withoutRecord } from "../fixtures/deploy-data.ts";
import { nullLookups } from "../fixtures/null-lookups.ts";
import type { NullLookups } from "../fixtures/null-lookups.ts";
import { installWallet, routeRegistry } from "../fixtures/wallet.ts";

const MEZO = 31611;
const chainsData = JSON.parse(readFileSync(join(WEB_ROOT, "v2/deploy/data/chains.json"), "utf8")) as {
  chains: { chainId: number; deployGas: { create2: { floor: string; ceiling: string } } }[];
};
const releaseData = JSON.parse(readFileSync(join(WEB_ROOT, "v2/deploy/data/release.json"), "utf8")) as {
  initCode: Hex;
  release: { create2: { factory: Address; salt: Hex; address: Address } };
};
const CREATE2_ADDRESS = releaseData.release.create2.address;
const PAYLOAD = concat([releaseData.release.create2.salt, releaseData.initCode]);

const mezoBounds = (): { floor: bigint; ceiling: bigint } => {
  const c = chainsData.chains.find((x) => x.chainId === MEZO);
  if (c === undefined) {
    throw new Error("Mezo testnet is not in the deploy kit's chain data");
  }
  return { floor: BigInt(c.deployGas.create2.floor), ceiling: BigInt(c.deployGas.create2.ceiling) };
};
/** clamp(ceil(estimate × 1.10), floor, ceiling), restated (spec §3.3.6). */
const clamp = (estimate: bigint, b: { floor: bigint; ceiling: bigint }): bigint => {
  const margin = (estimate * 110n + 99n) / 100n;
  return margin < b.floor ? b.floor : margin > b.ceiling ? b.ceiling : margin;
};
const grouped = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const code = await verifyCli(args, { stdout: (s: string) => (stdout += s), stderr: () => undefined });
  return { code, stdout };
}

let server: StaticServer;
const anvils: Anvil[] = [];
const forks: Fork[] = [];

test.beforeAll(async () => {
  server = await serveWeb();
});
test.afterAll(async () => {
  await server.close();
});
test.afterEach(async () => {
  await Promise.all([
    ...anvils.splice(0).map(async (a) => {
      await a.stop();
    }),
    ...forks.splice(0).map(async (f) => {
      await f.stop();
    }),
  ]);
});

/**
 * Connects the wallet, which starts on Ethereum mainnet and does not know Mezo testnet, picks Mezo testnet, lets the page
 * add it to the wallet from the registry, deploys, and returns the printed record and the transaction the wallet sent.
 */
async function deployOnMezo(page: Page, context: BrowserContext, rpc: (method: string, params: unknown[]) => Promise<unknown>, url: string, account: Address, nulls?: NullLookups): Promise<{ record: string; limit: bigint }> {
  const wallet = await installWallet(page, { account, chainId: 1, endpoints: new Map<number, string | null>([[1, null], [MEZO, url]]), known: [1] });
  const registryLog = await routeRegistry(context, new Map([[MEZO, url]]), nulls === undefined ? {} : { nulls });
  // Once protocol/deployments/31611.json ships, the page only verifies Mezo's record; the fresh flow stays covered.
  await withoutRecord(context, MEZO);

  await page.goto(`${server.origin}/v2/deploy/?chain=mezo`);
  await expect(page.getByRole("radio", { name: /Mezo testnet/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-bind=chain-count]")).toHaveText("5");
  await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
  await page.getByRole("button", { name: "Switch wallet to Mezo testnet" }).click();
  await expect(page.locator("#network-status")).toContainText("Mezo testnet added to the wallet and selected.");
  expect(wallet.requests.find((r) => r.method === "wallet_addEthereumChain")?.params[0]).toEqual({
    chainId: "0x7b7b",
    chainName: "Mezo testnet",
    nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
    rpcUrls: ["https://rpc.test.mezo.org"],
    blockExplorerUrls: ["https://explorer.test.mezo.org"],
  });

  const deploy = page.locator("#deploy");
  await expect(deploy).toBeEnabled();
  await expect(deploy).toHaveText("Deploy PayLinkV2 to Mezo testnet");
  const estimate = BigInt((await rpc("eth_estimateGas", [{ from: account, to: PROXY.factory, data: PAYLOAD, value: "0x0" }])) as string);
  const limit = clamp(estimate, mezoBounds());
  const readings = page.locator("#readings");
  await expect(readings).toContainText("CREATE2");
  await expect(readings.locator(".is-address .hex")).toHaveAttribute("data-value", CREATE2_ADDRESS);
  await expect(readings).toContainText(grouped(limit));
  await expect(readings).toContainText("at least 50 % of the gas limit on Mezo testnet");
  await expect(readings).toContainText("BTC");
  // The page's CSP lets it read Mezo through the registry's own RPC, not only through the wallet.
  await expect(page.locator("#lamps")).toContainText("Read from the registry RPC rpc.test.mezo.org");
  await expect(page.locator("#lamps li[data-lamp=err]")).toHaveCount(0);
  expect(await axe(page)).toEqual([]);

  await deploy.click();
  await expect(page.locator("#status")).toContainText("PayLinkV2 deployed and verified on Mezo testnet", { timeout: 90_000 });
  await expect(page.locator("#checks li[data-ok=false]")).toHaveCount(0);
  await expect(page.locator("#checks li[data-ok=true]")).toHaveCount(10);
  // Exactly one transaction, Deploy.s.sol's: salt ++ init code to the proxy, with the clamped limit.
  const sent = wallet.sent();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.params[0]).toEqual({ from: account, to: PROXY.factory, data: PAYLOAD, gas: numberToHex(limit), value: "0x0" });
  expect(await rpc("eth_getCode", [CREATE2_ADDRESS, "latest"])).not.toBe("0x");
  expect(registryLog.filter((l) => l.chainId === MEZO && l.method === "eth_getCode").length).toBeGreaterThan(2);
  await expect(page.locator("#record-path")).toHaveText("protocol/deployments/31611.json");
  expect(await axe(page)).toEqual([]);
  return { record: (await page.locator("#record-json").textContent()) ?? "", limit };
}

test("Mezo testnet 31611: the wallet adds Mezo from the registry, CREATE2 through the canonical proxy, verified, exact record", async ({ page, context }) => {
  const mezo = await startAnvil({ chainId: MEZO, factory: "presigned", args: ["--block-base-fee-per-gas", "130"] });
  anvils.push(mezo);
  const account = ANVIL_ACCOUNTS.wallet;
  // anvil prices the tip in gwei (Mezo testnet's is 16 wei), so the wallet holds enough for anvil's prices.
  await mezo.rpc("anvil_setBalance", [account, numberToHex(10n ** 18n)]);

  // Mezo testnet's RPC answers null for mined transactions (research §2): the deployment's receipt comes back on the
  // 4th poll, and the verification's lookups of it and of its transaction each answer null three times first.
  const nulls = nullLookups("NNNRNNNR");
  const { record } = await deployOnMezo(page, context, async (method, params) => await mezo.rpc(method, params), mezo.url, account, nulls);
  expect(nulls.nulled()).toBe(9);
  const parsed = JSON.parse(record) as { chainId: number; network: string; address: string; deployment: { method: string; deployer: string; txHash: Hex; factory: string }; explorers: { name: string; tx: string }[] };
  expect(parsed).toMatchObject({ chainId: MEZO, network: "Mezo testnet", address: CREATE2_ADDRESS, deployment: { method: "CREATE2", deployer: account, factory: PROXY.factory } });
  expect(parsed.explorers.map((e) => e.name)).toEqual(["Mezo Explorer"]);
  expect(parsed.explorers[0]?.tx).toBe(`https://explorer.test.mezo.org/tx/${parsed.deployment.txHash}`);
  const verified = await cli(["--chain", String(MEZO), "--address", CREATE2_ADDRESS, "--tx", parsed.deployment.txHash, "--rpc", mezo.url, "--out", "-"]);
  expect(verified.code).toBe(0);
  expect(verified.stdout).toBe(record);
  await page.screenshot({ path: test.info().outputPath("mezo-done-1280.png"), fullPage: true });
});

test("Mezo testnet fork (PAYLINK_FORK_MEZO=1): the page deploys through Mezo's own factory at the release address", async ({ page, context }) => {
  test.skip(process.env["PAYLINK_FORK_MEZO"] !== "1", "forks Mezo testnet: set PAYLINK_FORK_MEZO=1 where rpc.test.mezo.org is reachable");
  test.setTimeout(300_000);
  const fork = await startFork(MEZO, process.env["PAYLINK_MEZO_RPC"] ?? "https://rpc.test.mezo.org");
  forks.push(fork);
  const account = fork.accounts[0];
  if (account === undefined) {
    throw new Error("the fork has no account");
  }
  // The release is not on Mezo testnet yet (if it is by now, this rehearsal no longer applies).
  test.skip((await fork.rpc<string>("eth_getCode", [CREATE2_ADDRESS, "latest"])) !== "0x", "PayLinkV2 is already deployed on Mezo testnet: verify it with tools/verify-deployment instead");
  expect(await fork.rpc<string>("eth_getCode", [PROXY.factory, "latest"])).toBe(PROXY.runtime);
  await fork.rpc("anvil_setBalance", [account, numberToHex(10n ** 18n)]);

  const { record } = await deployOnMezo(page, context, async (method, params) => await fork.rpc(method, params), fork.url, account);
  const parsed = JSON.parse(record) as { network: string; address: string; deployment: { txHash: Hex; blockNumber: number } };
  expect(parsed).toMatchObject({ network: "Mezo testnet", address: CREATE2_ADDRESS });
  expect(BigInt(parsed.deployment.blockNumber)).toBeGreaterThan(fork.forkBlock);
  const verified = await cli(["--chain", String(MEZO), "--address", CREATE2_ADDRESS, "--tx", parsed.deployment.txHash, "--rpc", fork.url, "--out", "-"]);
  expect(verified.stdout).toBe(record);
});
