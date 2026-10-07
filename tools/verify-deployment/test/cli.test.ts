// SPDX-License-Identifier: MIT
/**
 * tools/verify-deployment against a local anvil chain that uses Base Sepolia's chain id (anvil predeploys the
 * deterministic-deployment proxy). The release is deployed exactly as Deploy.s.sol does it: salt ++ init code sent to
 * the proxy from an unlocked anvil account. No real key, no network beyond loopback.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, USAGE } from "../verify-deployment.mjs";

const repo = (path: string): string => new URL(`../../../${path}`, import.meta.url).pathname;
const data = JSON.parse(readFileSync(repo("web/v2/deploy/data/release.json"), "utf8")) as {
  initCode: string;
  release: { create2: { factory: string; salt: string; address: string } };
};
const CHAIN_ID = 84532;
const SENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil account 1 (public test account, unlocked)
const CREATE2 = data.release.create2.address;

function anvilBinary(): string {
  const found = [...(process.env["PATH"] ?? "").split(":").map((d) => join(d, "anvil")), join(homedir(), ".foundry/bin/anvil")].find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error("anvil not found");
  }
  return found;
}

let anvil: ChildProcess;
let url = "";
let deployTx = "";
let otherTx = "";
let dir = "";

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result: T; error?: { message: string } };
  if (body.error !== undefined) {
    throw new Error(body.error.message);
  }
  return body.result;
}

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(args, { stdout: (s: string) => (stdout += s), stderr: (s: string) => (stderr += s) });
  return { code, stdout, stderr };
}

beforeAll(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => {
        resolve(typeof a === "object" && a !== null ? a.port : 0);
      });
    });
  });
  url = `http://127.0.0.1:${String(port)}`;
  anvil = spawn(anvilBinary(), ["--port", String(port), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i += 1) {
    try {
      await rpc("eth_chainId");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  deployTx = await rpc<string>("eth_sendTransaction", [{ from: SENDER, to: data.release.create2.factory, data: `${data.release.create2.salt}${data.initCode.slice(2)}` }]);
  otherTx = await rpc<string>("eth_sendTransaction", [{ from: SENDER, to: SENDER, value: "0x1" }]);
  for (let i = 0; i < 100 && (await rpc<unknown>("eth_getTransactionReceipt", [otherTx])) === null; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  dir = mkdtempSync(join(tmpdir(), "verify-deployment-"));
});

afterAll(() => {
  anvil.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("usage", () => {
  it.each([
    [[], /--chain <chainId> is required/],
    [["--chain", "84532"], /--address <0x…> is required/],
    [["--chain", "84532", "--address", "0x448ecce9711860502806A3d5B021a4f9Ba715082"], /mixed-case checksum that is wrong/],
    [["--chain", "84532", "--address", CREATE2, "--tx", "0x12"], /--tx must be/],
    [["--chain", "84532", "--address", CREATE2, "--rpc", "https://sepolia.base.org"], /loopback/],
    [["--chain", "84532", "--address", CREATE2, "--commit", "abc"], /--commit must be/],
    [["--chain", "84532", "--address", CREATE2, "--bogus"], /Unknown option/],
  ])("refuses %j", async (args, message) => {
    const r = await run(...args);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
  });

  it("refuses chains that are not deployment targets", async () => {
    for (const chain of ["1", "143", "5042", "31337"]) {
      const r = await run("--chain", chain, "--address", CREATE2, "--rpc", url);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`chain ${chain} is not a PayLink v2 deployment target (allowed: 10143, 84532, 421614)`);
    }
  });

  it("prints its usage", async () => {
    const r = await run("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(USAGE);
  });
});

describe("verification and record", () => {
  it("verifies without --tx but writes nothing", async () => {
    const out = join(dir, "no-tx.json");
    const r = await run("--chain", String(CHAIN_ID), "--address", CREATE2.toLowerCase(), "--rpc", url, "--out", out);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("pass --tx <deployment transaction> to write the record");
    expect(existsSync(out)).toBe(false);
  });

  it("writes the record, finds it up to date, and protects it", async () => {
    const out = join(dir, `${String(CHAIN_ID)}.json`);
    const first = await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", deployTx, "--rpc", url, "--out", out);
    expect(first.code, first.stderr).toBe(0);
    const record = readFileSync(out, "utf8");
    expect(JSON.parse(record)).toMatchObject({ chainId: CHAIN_ID, address: CREATE2, deployment: { method: "CREATE2", deployer: SENDER, txHash: deployTx } });
    expect(first.stderr).toContain("[ok] Lands on the CREATE2 address");

    expect((await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", deployTx, "--rpc", url, "--out", out)).stderr).toContain("is up to date");
    expect((await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", deployTx, "--rpc", url, "--out", out, "--check")).code).toBe(0);

    writeFileSync(out, record.replace(deployTx, `0x${"ab".repeat(32)}`));
    const refused = await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", deployTx, "--rpc", url, "--out", out);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("one deployment per chain");
    expect((await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", deployTx, "--rpc", url, "--out", out, "--check")).code).toBe(1);
    expect((await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", deployTx, "--rpc", url, "--out", out, "--force")).code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(record);

    const printed = await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", deployTx, "--rpc", url, "--out", "-", "--json");
    expect(printed.stdout.startsWith(record)).toBe(true);
    expect(JSON.parse(printed.stdout.slice(record.length))).toMatchObject({ ok: true, chainId: CHAIN_ID, action: "printed" });
  });

  it("compares with a given file byte for byte", async () => {
    const other = join(dir, "other.json");
    writeFileSync(other, "{}\n");
    const r = await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", deployTx, "--rpc", url, "--out", "-", "--compare", other);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("differs from the verified record");
  });

  it("rejects copied code: the genuine runtime at another address", async () => {
    const code = await rpc<string>("eth_getCode", [CREATE2, "latest"]);
    const copy = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    await rpc("anvil_setCode", [copy, code]);
    const r = await run("--chain", String(CHAIN_ID), "--address", copy, "--rpc", url);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[FAIL] EIP-712 immutables bound to this chain and address");
  });

  it("rejects a transaction that did not deploy the contract", async () => {
    const out = join(dir, "wrong-tx.json");
    const r = await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", otherTx, "--rpc", url, "--out", out);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[FAIL] Deployment transaction");
    expect(existsSync(out)).toBe(false);
  });

  it("rejects an RPC that serves another chain", async () => {
    const r = await run("--chain", "10143", "--address", CREATE2, "--rpc", url);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[FAIL] RPC is on the expected chain: chain 84532, expected 10143");
  });

  it("rejects an address without code", async () => {
    const r = await run("--chain", String(CHAIN_ID), "--address", "0x000000000000000000000000000000000000dEaD", "--rpc", url);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[FAIL] Contract code present");
  });
});
