// SPDX-License-Identifier: MIT
/**
 * One deployment, three record writers, one file: Foundry (`Deploy.s.sol` run() then record()), the deploy page in
 * verify-only mode (the CREATE2 address is already occupied, as after a deployment from another route), and
 * tools/verify-deployment. All three must produce the same bytes for protocol/deployments/<chainId>.json.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Hex } from "viem";
import { main as verifyCli } from "../../tools/verify-deployment/verify-deployment.mjs";
import { ANVIL_ACCOUNTS, foundryBinary, startAnvil } from "../fixtures/anvil.ts";
import { REPO, serveWeb, WEB_ROOT } from "../fixtures/server.ts";
import { installWallet, routeRegistry } from "../fixtures/wallet.ts";

const CHAIN_ID = 84532;
const PROTOCOL = join(REPO, "protocol");
/**
 * A scratch copy of the Foundry project (sources, scripts, vendored forge-std, the release lock, OpenZeppelin by
 * symlink), so forge writes its broadcast and record there and never into protocol/: the suite can run next to
 * `forge test` and the generators, and whatever protocol/deployments holds (real records) is never touched.
 */
function scratchProtocol(): string {
  const work = mkdtempSync(join(tmpdir(), "paylink-forge-"));
  for (const entry of ["foundry.toml", "src", "script", "lib", "deployments/release.json"]) {
    cpSync(join(PROTOCOL, entry), join(work, entry), { recursive: true });
  }
  mkdirSync(join(work, "node_modules/@openzeppelin"), { recursive: true });
  symlinkSync(realpathSync(join(PROTOCOL, "node_modules/@openzeppelin/contracts")), join(work, "node_modules/@openzeppelin/contracts"));
  return work;
}

const release = JSON.parse(readFileSync(join(WEB_ROOT, "v2/deploy/data/release.json"), "utf8")) as { sourceCommit: string; release: { create2: { address: string } } };

test("forge record(), the deploy page and tools/verify-deployment write the same record", async ({ page, context }) => {
  const work = scratchProtocol();
  const recordPath = join(work, `deployments/${String(CHAIN_ID)}.json`);
  const anvil = await startAnvil({ chainId: CHAIN_ID, factory: "default" });
  const server = await serveWeb();
  try {
    // 1. Foundry deploys through the proxy from anvil's account 0 and writes the record.
    let forgeRecord: string;
    try {
      const forge = foundryBinary("forge");
      const env = { ...process.env, FOUNDRY_OFFLINE: "true", PAYLINK_GIT_COMMIT: release.sourceCommit };
      execFileSync(forge, ["script", "script/Deploy.s.sol", "--rpc-url", anvil.url, "--broadcast", "--unlocked", "--sender", ANVIL_ACCOUNTS.forge], { cwd: work, env, stdio: "pipe" });
      execFileSync(forge, ["script", "script/Deploy.s.sol", "--rpc-url", anvil.url, "--sig", "record()"], { cwd: work, env, stdio: "pipe" });
      forgeRecord = readFileSync(recordPath, "utf8");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    const { address, deployment } = JSON.parse(forgeRecord) as { address: string; deployment: { txHash: Hex; deployer: string } };
    expect(address).toBe(release.release.create2.address);
    expect(deployment.deployer).toBe(ANVIL_ACCOUNTS.forge);

    // 2. The page finds the CREATE2 address occupied, verifies instead of deploying, and prints the record once it has
    //    the deployment transaction.
    const wallet = await installWallet(page, { account: ANVIL_ACCOUNTS.wallet, chainId: CHAIN_ID, endpoints: new Map([[CHAIN_ID, anvil.url]]), known: [CHAIN_ID] });
    await routeRegistry(context, new Map([[CHAIN_ID, anvil.url]]));
    await page.goto(`${server.origin}/v2/deploy/`);
    await page.getByRole("button", { name: /PayLink Test Wallet/ }).click();
    await expect(page.locator("#review-kind")).toHaveText("Already deployed");
    const key = page.locator("#deploy");
    await expect(key).toHaveText("Verify the deployed contract");
    await key.click();
    await expect(page.locator("#status")).toContainText("is the PayLinkV2 release. Add its transaction hash to print the record.");
    await expect(page.locator("#checks li[data-ok=true]")).toHaveCount(6);
    await page.locator("#txhash").fill(deployment.txHash);
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.locator("#checks li[data-ok=true]")).toHaveCount(10);
    const pageRecord = (await page.locator("#record-json").textContent()) ?? "";
    expect(pageRecord).toBe(forgeRecord);
    expect(wallet.sent()).toHaveLength(0);

    // 3. The CLI re-verifies on its own, prints the same bytes and confirms the page's download byte for byte.
    const dir = mkdtempSync(join(tmpdir(), "paylink-parity-"));
    const downloaded = join(dir, `${String(CHAIN_ID)}.json`);
    writeFileSync(downloaded, pageRecord);
    let stdout = "";
    let stderr = "";
    const code = await verifyCli(["--chain", String(CHAIN_ID), "--address", address, "--tx", deployment.txHash, "--rpc", anvil.url, "--out", "-", "--compare", downloaded], {
      stdout: (s: string) => (stdout += s),
      stderr: (s: string) => (stderr += s),
    });
    rmSync(dir, { recursive: true, force: true });
    expect(code, stderr).toBe(0);
    expect(stdout).toBe(forgeRecord);
    expect(stderr).toContain("is byte-identical to the verified record");
  } finally {
    await server.close();
    await anvil.stop();
  }
});
