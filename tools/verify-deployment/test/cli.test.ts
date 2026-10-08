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
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

async function rpcAt<T>(endpoint: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result: T; error?: { message: string } };
  if (body.error !== undefined) {
    throw new Error(body.error.message);
  }
  return body.result;
}

const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => await rpcAt<T>(url, method, params);

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => {
        resolve(typeof a === "object" && a !== null ? a.port : 0);
      });
    });
  });
}

/** Starts anvil with Base Sepolia's chain id (it predeploys the CREATE2 proxy and runs Prague: EIP-7702). */
async function startAnvil(): Promise<{ process: ChildProcess; url: string }> {
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${String(port)}`;
  const child = spawn(anvilBinary(), ["--port", String(port), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i += 1) {
    try {
      await rpcAt(endpoint, "eth_chainId");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return { process: child, url: endpoint };
}

async function mined(endpoint: string, hash: string): Promise<{ status: string; blockNumber: string }> {
  for (let i = 0; i < 200; i += 1) {
    const receipt = await rpcAt<{ status: string; blockNumber: string } | null>(endpoint, "eth_getTransactionReceipt", [hash]);
    if (receipt !== null) {
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${hash} not mined`);
}

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(args, { stdout: (s: string) => (stdout += s), stderr: (s: string) => (stderr += s) });
  return { code, stdout, stderr };
}

beforeAll(async () => {
  ({ process: anvil, url } = await startAnvil());
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

/**
 * A deployment relayed the way MetaMask's smart account (EIP-7702) relays it, on its own anvil chain (one release
 * deployment per chain): the user signs an authorization delegating their account to a forwarder; a relayer sends a
 * type-4 transaction to a "manager" contract, whose input names the user's account and carries the factory call
 * packed as factory ‖ salt ‖ initCode; the manager calls the user's account, which calls the factory. The manager
 * swallows failures, as a batching entry point may, so a transaction can succeed although its inner deployment did not.
 */
describe("relayed deployment (EIP-7702 smart account)", () => {
  // Forwarder: CALL(gas, calldata[0:20], 0, calldata[20:]) and revert on failure. Swallower: the same without the revert.
  const FORWARDER = "0x60143603806014600037600060008260006000600035" + "60601c5af1" + "602357" + "60006000fd" + "5b00";
  const SWALLOWER = "0x60143603806014600037600060008260006000600035" + "60601c5af1" + "00";
  const DELEGATE = "0x00000000000000000000000000000000000d0001";
  const MANAGER = "0x00000000000000000000000000000000000d0002";
  const user = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // anvil account 2
  const RELAYER = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906"); // anvil account 3 (unlocked)
  let chain: { process: ChildProcess; url: string };
  let relayedTx = "";
  let noopTx = "";
  let lateTx = "";
  const input = `0x${user.address.slice(2)}${data.release.create2.factory.slice(2)}${data.release.create2.salt.slice(2)}${data.initCode.slice(2)}`;
  const send = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const hash = await rpcAt<string>(chain.url, "eth_sendTransaction", [{ from: RELAYER, to: MANAGER, data: input, gas: "0x500000", ...extra }]);
    expect((await mined(chain.url, hash)).status).toBe("0x1");
    return hash;
  };
  const verify = async (tx: string, ...more: string[]) => await run("--chain", String(CHAIN_ID), "--address", CREATE2, "--tx", tx, "--rpc", chain.url, ...more);

  beforeAll(async () => {
    chain = await startAnvil();
    await rpcAt(chain.url, "anvil_setCode", [DELEGATE, FORWARDER]);
    await rpcAt(chain.url, "anvil_setCode", [MANAGER, SWALLOWER]);
    // 1. Before the user's account is delegated, the manager's call to it does nothing: success, payload, no contract.
    noopTx = await send();
    // 2. The relayed deployment: type 4, with the user's authorization.
    const auth = await user.signAuthorization({ chainId: CHAIN_ID, address: DELEGATE, nonce: 0 });
    relayedTx = await send({ authorizationList: [{ chainId: `0x${CHAIN_ID.toString(16)}`, address: DELEGATE, nonce: "0x0", yParity: `0x${String(auth.yParity ?? 0)}`, r: auth.r, s: auth.s }] });
    // 3. The same call again: the CREATE2 collides, the forwarder reverts, the manager swallows it: success, no creation.
    lateTx = await send();
  });

  afterAll(() => {
    chain.process.kill();
  });

  it("records the relayed deployment: CREATE2 by the factory, the user as deployer, the relayer as submitter", async () => {
    const out = join(dir, "relayed.json");
    const r = await verify(relayedTx, "--out", out);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("[ok] Relayed transaction: EIP-7702 set-code transaction (type 4)");
    expect(r.stderr).toContain("[ok] Input carries the factory call (salt ‖ release init code)");
    expect(r.stderr).toMatch(/\[ok\] Code created in the transaction's block: no code at block \d+, code at block \d+ \(historical eth_getCode\)/);
    // anvil serves debug_traceTransaction: the trace confirms the CREATE2 and names the factory's caller.
    expect(r.stderr).toContain(`[ok] Trace shows the factory's CREATE2: debug_traceTransaction (callTracer): ${user.address} called the factory`);
    expect(r.stderr).toContain(`route: relayed, method CREATE2, deployer ${user.address}, submitted by ${RELAYER}`);
    expect(r.stderr).toContain("trace: debug_traceTransaction (callTracer), confirms the factory's CREATE2");
    const record = readFileSync(out, "utf8");
    expect(JSON.parse(record)).toMatchObject({
      chainId: CHAIN_ID,
      address: CREATE2,
      deployment: {
        method: "CREATE2",
        deployer: user.address,
        txHash: relayedTx,
        factory: data.release.create2.factory,
        route: "relayed",
        submitter: RELAYER,
        authorization: [{ chainId: CHAIN_ID, address: getAddress(DELEGATE), nonce: 0, authority: user.address }],
      },
    });
    expect((await verify(relayedTx, "--out", out, "--check")).code).toBe(0);
    const json = await verify(relayedTx, "--out", "-", "--json");
    expect(json.stdout.startsWith(record)).toBe(true);
    expect(JSON.parse(json.stdout.slice(record.length))).toMatchObject({
      ok: true,
      route: "relayed",
      deployer: user.address,
      submitter: RELAYER,
      endpoints: [{ evidence: { codeBefore: { code: "empty" }, codeAfter: { code: "12045 bytes" }, trace: { source: "debug_traceTransaction (callTracer)", confirmed: true } } }],
    });
  });

  it("rejects a relayed transaction that carries the payload but created nothing", async () => {
    const out = join(dir, "noop.json");
    const r = await verify(noopTx, "--out", out);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/\[FAIL\] Code created in the transaction's block: no code at the address at block \d+/);
    expect(r.stderr).toContain("[FAIL] Trace shows the factory's CREATE2");
    expect(existsSync(out)).toBe(false);
  });

  it("rejects a relayed transaction sent after the contract already existed", async () => {
    const out = join(dir, "late.json");
    const r = await verify(lateTx, "--out", out);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("this transaction did not create it");
    expect(r.stderr).toContain("[FAIL] Trace shows the factory's CREATE2");
    expect(existsSync(out)).toBe(false);
  });
});
