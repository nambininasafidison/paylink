// SPDX-License-Identifier: MIT
/**
 * The deploy page (web/v2/deploy) end to end, under its production CSP, against anvil chains that use the deploy
 * targets' chain ids, with a mock EIP-1193 wallet announced through EIP-6963:
 * - Monad testnet 10143 (anvil's Monad gas emulation, 100 gwei base fee, the user's 5 MON): CREATE2 through the proxy
 *   installed by its canonical presigned transaction;
 * - Base Sepolia 84532: the wallet does not know the chain (4902), the page adds it from the registry; proxy installed
 *   with anvil_setCode;
 * - Arbitrum Sepolia 421614 without the proxy: CREATE fallback, then resume after a reload;
 * - refusals: unknown chains, tampered release data, foreign code at the proxy address, an empty wallet, a declined
 *   signature.
 * Every printed record is compared byte for byte with tools/verify-deployment's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { concat, getCreateAddress, numberToHex } from "viem";
import type { Address, Hex } from "viem";
import { main as verifyCli } from "../../tools/verify-deployment/verify-deployment.mjs";
import { ANVIL_ACCOUNTS, PROXY, startAnvil } from "../fixtures/anvil.ts";
import type { Anvil } from "../fixtures/anvil.ts";
import { axe } from "../fixtures/axe.ts";
import { serveWeb, WEB_ROOT } from "../fixtures/server.ts";
import type { StaticServer } from "../fixtures/server.ts";
import { withoutRecord } from "../fixtures/deploy-data.ts";
import { brokenWords } from "../fixtures/layout.ts";
import { installWallet, routeRegistry } from "../fixtures/wallet.ts";

interface Bounds {
  readonly estimate: string;
  readonly floor: string;
  readonly ceiling: string;
}
const chainsData = JSON.parse(readFileSync(join(WEB_ROOT, "v2/deploy/data/chains.json"), "utf8")) as {
  chains: { chainId: number; name: string; deployGas: { create: Bounds; create2: Bounds } }[];
};
const releaseData = JSON.parse(readFileSync(join(WEB_ROOT, "v2/deploy/data/release.json"), "utf8")) as {
  initCode: Hex;
  release: { create2: { factory: Address; salt: Hex; address: Address }; bytecode: { initCodeHash: Hex } };
};
const CREATE2_ADDRESS = releaseData.release.create2.address;
const ACCOUNT = ANVIL_ACCOUNTS.wallet;

const bounds = (chainId: number, method: "create" | "create2"): { floor: bigint; ceiling: bigint } => {
  const c = chainsData.chains.find((x) => x.chainId === chainId);
  if (c === undefined) {
    throw new Error(`no chain ${String(chainId)}`);
  }
  return { floor: BigInt(c.deployGas[method].floor), ceiling: BigInt(c.deployGas[method].ceiling) };
};
/** clamp(ceil(estimate × 1.10), floor, ceiling), restated (spec §3.3.6). */
const clamp = (estimate: bigint, b: { floor: bigint; ceiling: bigint }): bigint => {
  const margin = (estimate * 110n + 99n) / 100n;
  return margin < b.floor ? b.floor : margin > b.ceiling ? b.ceiling : margin;
};
const grouped = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Runs tools/verify-deployment in-process against an anvil chain. */
async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await verifyCli(args, { stdout: (s: string) => (stdout += s), stderr: (s: string) => (stderr += s) });
  return { code, stdout, stderr };
}

let server: StaticServer;
const anvils: Anvil[] = [];
const chain = async (options: Parameters<typeof startAnvil>[0]): Promise<Anvil> => {
  const a = await startAnvil(options);
  anvils.push(a);
  return a;
};

test.beforeAll(async () => {
  server = await serveWeb();
});
test.afterAll(async () => {
  await server.close();
});
test.afterEach(async () => {
  await Promise.all(
    anvils.splice(0).map(async (a) => {
      await a.stop();
    }),
  );
});

test("Monad testnet 10143: CREATE2 through the presigned proxy, verified, exact record", async ({ page, context }) => {
  const monad = await chain({ chainId: 10143, factory: "presigned", args: ["--network", "monad", "--block-base-fee-per-gas", "100000000000"] });
  await monad.rpc("anvil_setBalance", [ACCOUNT, numberToHex(5n * 10n ** 18n)]);
  const wallet = await installWallet(page, { account: ACCOUNT, chainId: 10143, endpoints: new Map([[10143, monad.url]]), known: [10143] });
  const registryLog = await routeRegistry(context, new Map([[10143, monad.url]]));
  await withoutRecord(context, 10143);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });

  await page.goto(`${server.origin}/v2/deploy/`);
  // The release identity is on screen before any wallet prompt.
  await expect(page.locator("[data-bind=create2Address] .hex")).toHaveAttribute("data-value", CREATE2_ADDRESS);
  await expect(page.locator("[data-bind=initCodeHash] .hex")).toHaveAttribute("data-value", releaseData.release.bytecode.initCodeHash);
  await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
  await expect(page.getByRole("radio", { name: /Monad testnet/ })).toHaveAttribute("aria-checked", "true");

  const deploy = page.locator("#deploy");
  await expect(deploy).toBeEnabled();
  await expect(deploy).toHaveText("Deploy PayLinkV2 to Monad testnet");
  const data = concat([releaseData.release.create2.salt, releaseData.initCode]);
  const estimate = BigInt(await monad.rpc<string>("eth_estimateGas", [{ from: ACCOUNT, to: PROXY.factory, data, value: "0x0" }]));
  const limit = clamp(estimate, bounds(10143, "create2"));
  const readings = page.locator("#readings");
  await expect(readings).toContainText("CREATE2");
  await expect(readings.locator(".is-address .hex")).toHaveAttribute("data-value", CREATE2_ADDRESS);
  await expect(readings).toContainText(grouped(limit));
  await expect(readings).toContainText("Monad testnet charges the whole gas limit");
  // Monad charges the limit: limit × (100 gwei base + tip).
  await expect(page.locator("#lamps li[data-lamp=err]")).toHaveCount(0);
  await expect(page.locator("#lamps")).toContainText("Read from the registry RPC testnet-rpc.monad.xyz");
  await page.screenshot({ path: test.info().outputPath("monad-review-1280.png"), fullPage: true });
  expect(await axe(page)).toEqual([]);

  await deploy.click();
  await expect(page.locator("#status")).toContainText("PayLinkV2 deployed and verified on Monad testnet", { timeout: 60_000 });
  await expect(page.locator("#checks li[data-ok=false]")).toHaveCount(0);
  await expect(page.locator("#checks li[data-ok=true]")).toHaveCount(10);

  // Exactly one transaction, the one Deploy.s.sol sends: salt ++ init code to the proxy, with the clamped limit.
  const sent = wallet.sent();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.params[0]).toEqual({ from: ACCOUNT, to: PROXY.factory, data, gas: numberToHex(limit), value: "0x0" });
  expect(await monad.rpc<string>("eth_getCode", [CREATE2_ADDRESS, "latest"])).not.toBe("0x");
  // Reads went to the registry RPC (routed to anvil), not to the wallet.
  expect(registryLog.filter((l) => l.method === "eth_getCode").length).toBeGreaterThan(2);
  expect(wallet.requests.filter((r) => r.method === "eth_getCode")).toHaveLength(0);

  const record = (await page.locator("#record-json").textContent()) ?? "";
  const parsed = JSON.parse(record) as { address: string; chainId: number; network: string; deployment: { method: string; deployer: string; txHash: Hex; factory: string }; explorers: { name: string }[] };
  expect(parsed).toMatchObject({ address: CREATE2_ADDRESS, chainId: 10143, network: "Monad testnet", deployment: { method: "CREATE2", deployer: ACCOUNT, factory: PROXY.factory } });
  expect(parsed.explorers.map((e) => e.name)).toEqual(["MonadVision", "Monadscan"]);
  await expect(page.locator("#record-path")).toHaveText("protocol/deployments/10143.json");

  // tools/verify-deployment, reading the chain on its own, writes the same bytes.
  const verified = await cli(["--chain", "10143", "--address", CREATE2_ADDRESS, "--tx", parsed.deployment.txHash, "--rpc", monad.url, "--out", "-"]);
  expect(verified.code).toBe(0);
  expect(verified.stdout).toBe(record);

  // Copy and download hand over the same bytes.
  await page.locator("#copy").click();
  await expect(page.locator("#copy")).toHaveText("Copied");
  expect(await page.evaluate(async () => await navigator.clipboard.readText())).toBe(record);
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download").click()]);
  expect(download.suggestedFilename()).toBe("10143.json");
  expect(readFileSync(await download.path(), "utf8")).toBe(record);

  await page.screenshot({ path: test.info().outputPath("monad-done-1280.png"), fullPage: true });
  expect(await axe(page)).toEqual([]);
});

test("Monad testnet 10143 as shipped: the recorded deployment is verified, never deployed again", async ({ page, context }) => {
  const monad = await chain({ chainId: 10143, factory: "presigned", args: ["--network", "monad", "--block-base-fee-per-gas", "100000000000"] });
  await monad.rpc("anvil_setBalance", [ACCOUNT, numberToHex(5n * 10n ** 18n)]);
  // The release at its CREATE2 address, as on Monad testnet (protocol/deployments/10143.json).
  await monad.rpc("eth_sendTransaction", [{ from: ANVIL_ACCOUNTS.forge, to: PROXY.factory, data: concat([releaseData.release.create2.salt, releaseData.initCode]) }]);
  await expect.poll(async () => await monad.rpc<string>("eth_getCode", [CREATE2_ADDRESS, "latest"])).not.toBe("0x");
  const shipped = chainsData.chains.find((c) => c.chainId === 10143) as { deployment: { address: string; status: string } | null } | undefined;
  expect(shipped?.deployment).toMatchObject({ address: CREATE2_ADDRESS, status: "active" });
  const wallet = await installWallet(page, { account: ACCOUNT, chainId: 10143, endpoints: new Map([[10143, monad.url]]), known: [10143] });
  await routeRegistry(context, new Map([[10143, monad.url]]));
  await page.goto(`${server.origin}/v2/deploy/`);
  await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
  await expect(page.getByRole("radio", { name: /Monad testnet/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#lamps")).toContainText("Recorded deployment: verify only");
  await expect(page.locator("#readings")).toContainText("recorded in protocol/deployments");
  await expect(page.locator("#deploy")).not.toHaveText("Deploy PayLinkV2 to Monad testnet");
  expect(wallet.sent()).toHaveLength(0);
  expect(await axe(page)).toEqual([]);
});

test("Base Sepolia 84532: the wallet adds the chain from the registry, then deploys", async ({ page, context }) => {
  const base = await chain({ chainId: 84532, factory: "setCode" });
  await base.rpc("anvil_setBalance", [ACCOUNT, numberToHex(2n * 10n ** 16n)]);
  // The wallet starts on Ethereum mainnet (chain 1), which is not a deployment target, and does not know Base Sepolia.
  const wallet = await installWallet(page, { account: ACCOUNT, chainId: 1, endpoints: new Map<number, string | null>([[1, null], [84532, base.url]]), known: [1] });
  await withoutRecord(context, 84532);
  await routeRegistry(context, new Map([[84532, base.url]]));

  await page.goto(`${server.origin}/v2/deploy/`);
  await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
  await expect(page.locator("#network-status")).toContainText("chain 1, which is not a PayLink v2 deployment target");
  await expect(page.locator("#deploy")).toBeDisabled();

  await page.getByRole("radio", { name: /Base Sepolia/ }).click();
  await expect(page.locator("#net-balance")).toHaveText("0.0200 ETH");
  await page.getByRole("button", { name: "Switch wallet to Base Sepolia" }).click();
  await expect(page.locator("#network-status")).toContainText("Base Sepolia added to the wallet and selected.");
  const added = wallet.requests.find((r) => r.method === "wallet_addEthereumChain");
  expect(added?.params[0]).toEqual({
    chainId: "0x14a34",
    chainName: "Base Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.base.org"],
    blockExplorerUrls: ["https://sepolia.basescan.org", "https://base-sepolia.blockscout.com"],
  });

  await expect(page.locator("#deploy")).toBeEnabled();
  await expect(page.locator("#readings")).toContainText("Charged on the gas used");
  await page.locator("#deploy").click();
  await expect(page.locator("#status")).toContainText("PayLinkV2 deployed and verified on Base Sepolia", { timeout: 60_000 });
  const record = (await page.locator("#record-json").textContent()) ?? "";
  const parsed = JSON.parse(record) as { address: string; deployment: { txHash: Hex; method: string }; explorers: { name: string; tx: string }[] };
  expect(parsed.address).toBe(CREATE2_ADDRESS);
  expect(parsed.deployment.method).toBe("CREATE2");
  expect(parsed.explorers.map((e) => e.name)).toEqual(["Basescan", "Blockscout"]);
  expect(parsed.explorers[0]?.tx).toBe(`https://sepolia.basescan.org/tx/${parsed.deployment.txHash}`);
  const verified = await cli(["--chain", "84532", "--address", CREATE2_ADDRESS, "--tx", parsed.deployment.txHash, "--rpc", base.url, "--out", "-"]);
  expect(verified.stdout).toBe(record);
});

test("Arbitrum Sepolia 421614 without the proxy: CREATE fallback, then resume after a reload", async ({ page, context }) => {
  const arb = await chain({ chainId: 421614, factory: "none" });
  const nonce = Number(BigInt(await arb.rpc<string>("eth_getTransactionCount", [ACCOUNT, "pending"])));
  const expected = getCreateAddress({ from: ACCOUNT, nonce: BigInt(nonce) });
  await installWallet(page, { account: ACCOUNT, chainId: 421614, endpoints: new Map([[421614, arb.url]]), known: [421614] });
  await routeRegistry(context, new Map([[421614, arb.url]]));

  await page.goto(`${server.origin}/v2/deploy/?chain=arb`);
  await expect(page.getByRole("radio", { name: /Arbitrum Sepolia/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
  await expect(page.locator("#deploy")).toBeEnabled();
  await expect(page.locator("#readings")).toContainText("no deterministic proxy on Arbitrum Sepolia");
  await expect(page.locator("#readings .is-address .hex")).toHaveAttribute("data-value", expected);
  await expect(page.locator("#lamps li[data-lamp=wait]")).toContainText("plain CREATE");
  await page.locator("#deploy").click();
  await expect(page.locator("#status")).toContainText("deployed and verified", { timeout: 60_000 });
  const record = (await page.locator("#record-json").textContent()) ?? "";
  const parsed = JSON.parse(record) as { address: string; deployment: { method: string; factory: null; salt: null; txHash: Hex } };
  expect(parsed).toMatchObject({ address: expected, deployment: { method: "CREATE", factory: null, salt: null } });
  const verified = await cli(["--chain", "421614", "--address", expected, "--tx", parsed.deployment.txHash, "--rpc", arb.url, "--out", "-"]);
  expect(verified.stdout).toBe(record);

  // A reload (closed tab, phone browser restart) does not lose the deployment, and does not invite a second one.
  await page.reload();
  await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
  await page.getByRole("button", { name: "Check that transaction" }).click();
  await expect(page.locator("#status")).toContainText("deployed and verified", { timeout: 60_000 });
  expect(await page.locator("#record-json").textContent()).toBe(record);
});

test("refuses what it must: unknown chains, tampered release data, foreign proxy code, empty wallet, declined signature", async ({ page, context }) => {
  await test.step("an unknown chain in the URL", async () => {
    await page.goto(`${server.origin}/v2/deploy/?chain=1`);
    await expect(page.locator("#banner")).toContainText("“1” is not a PayLink v2 deployment target");
    await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  });

  await test.step("release data whose init code does not hash to the release", async () => {
    await context.route("**/v2/deploy/data/release.json", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { initCode: string };
      body.initCode = `${body.initCode.slice(0, -2)}${body.initCode.endsWith("00") ? "01" : "00"}`;
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${server.origin}/v2/deploy/`);
    await expect(page.locator("#banner")).toContainText("failed its integrity check");
    await expect(page.locator("body")).toHaveAttribute("data-phase", "fatal");
    await expect(page.locator("#deploy")).toBeDisabled();
    await context.unroute("**/v2/deploy/data/release.json");
  });

  const base = await chain({ chainId: 84532, factory: "none" });
  const wallet = await installWallet(page, { account: ACCOUNT, chainId: 84532, endpoints: new Map([[84532, base.url]]), known: [84532] });
  await routeRegistry(context, new Map([[84532, base.url]]));
  await withoutRecord(context, 84532);

  await test.step("foreign code at the proxy address", async () => {
    await base.rpc("anvil_setCode", [PROXY.factory, "0x6080604052348015600f57600080fd5b50"]);
    await page.goto(`${server.origin}/v2/deploy/`);
    await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
    await expect(page.locator("#readings")).toContainText("unexpected code at the CREATE2 factory");
    await expect(page.locator("#deploy")).toBeDisabled();
    await base.rpc("anvil_setCode", [PROXY.factory, PROXY.runtime]);
  });

  await test.step("an empty wallet", async () => {
    await base.rpc("anvil_setBalance", [ACCOUNT, "0x0"]);
    await page.reload();
    await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
    await expect(page.locator("#lamps li[data-lamp=err]")).toContainText("Needs ≈");
    await expect(page.locator("#deploy")).toBeDisabled();
  });

  await test.step("a declined signature", async () => {
    await base.rpc("anvil_setBalance", [ACCOUNT, numberToHex(10n ** 18n)]);
    await page.reload();
    await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
    await expect(page.locator("#deploy")).toBeEnabled();
    wallet.failNext("eth_sendTransaction", 4001, "User rejected the request.");
    await page.locator("#deploy").click();
    await expect(page.locator("#status")).toHaveText("You declined the request in your wallet. Nothing was sent.");
    await expect(page.locator("#deploy")).toBeEnabled();
    expect(await base.rpc<string>("eth_getCode", [CREATE2_ADDRESS, "latest"])).toBe("0x");
  });
});

test("phone, dark: 390 px without horizontal scrolling, and no axe violations", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const page = await context.newPage();
  const monad = await chain({ chainId: 10143, factory: "presigned", args: ["--network", "monad", "--block-base-fee-per-gas", "100000000000"] });
  await monad.rpc("anvil_setBalance", [ACCOUNT, numberToHex(5n * 10n ** 18n)]);
  await installWallet(page, { account: ACCOUNT, chainId: 10143, endpoints: new Map([[10143, monad.url]]), known: [10143] });
  await routeRegistry(context, new Map([[10143, monad.url]]));
  await withoutRecord(context, 10143);
  // Measured against the configured width: a phone's layout viewport grows to fit overflowing content, so
  // window.innerWidth would hide the very overflow this checks.
  const overflow = async (width = 390): Promise<number> => await page.evaluate((w) => document.documentElement.scrollWidth - w, width);
  // A chain chosen from a link (create and status pages link here with ?chain=): the primary key names it in full,
  // and that sentence wraps inside the key at 320 and 390 px (spec §3.10 reflow).
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${server.origin}/v2/deploy/?chain=monad`);
    await expect(page.locator("#deploy")).toContainText("Monad testnet");
    expect(await overflow(width), `?chain=monad at ${String(width)} px`).toBeLessThanOrEqual(0);
    expect(await brokenWords(page), `?chain=monad at ${String(width)} px`).toEqual([]);
  }
  await page.goto(`${server.origin}/v2/deploy/`);
  await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
  await expect(page.locator("#deploy")).toBeEnabled();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath("monad-review-390-dark.png"), fullPage: true });
  await page.locator("#step-review").screenshot({ path: test.info().outputPath("monad-review-step-390-dark.png") });
  expect(await axe(page)).toEqual([]);
  await page.locator("#deploy").click();
  await expect(page.locator("#status")).toContainText("deployed and verified", { timeout: 60_000 });
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath("monad-done-390-dark.png"), fullPage: true });
  await page.locator("#step-record").screenshot({ path: test.info().outputPath("monad-record-step-390-dark.png") });
  await page.locator("#step-wallet").screenshot({ path: test.info().outputPath("monad-wallet-step-390-dark.png") });
  expect(await axe(page)).toEqual([]);
  await context.close();
});
