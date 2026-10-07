// SPDX-License-Identifier: MIT
/**
 * Local chains for the e2e suite: anvil started with a deploy target's chain id (spec §4.2), with or without the
 * deterministic-deployment proxy, which is installed either by its canonical presigned transaction or by
 * anvil_setCode. anvil's unlocked default accounts stand in for the user's wallet; no real key is used anywhere.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** Foundry binaries: PATH (the sandbox's env.sh) or the default foundryup location. */
export function foundryBinary(name: "anvil" | "forge" | "cast"): string {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    const candidate = join(dir, name);
    if (dir !== "" && existsSync(candidate)) {
      return candidate;
    }
  }
  const fallback = join(homedir(), ".foundry", "bin", name);
  if (existsSync(fallback)) {
    return fallback;
  }
  throw new Error(`${name} not found: install Foundry 1.8.5 (scripts/bootstrap-sandbox.sh)`);
}

/** The deterministic-deployment proxy's canonical presigned deployment (tools/deploy-page/scripts/generate.ts). */
export const PROXY = {
  factory: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
  signer: "0x3fAB184622Dc19b6109349B94811493BF2a45362",
  rawTransaction:
    "0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222",
  runtime: "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3",
} as const;

/** anvil's public default accounts (mnemonic "test test … junk"); unlocked on every anvil. */
export const ANVIL_ACCOUNTS = {
  forge: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
} as const;

export interface AnvilOptions {
  readonly chainId: number;
  /** How the CREATE2 proxy gets there: anvil's own predeploy, the presigned transaction, anvil_setCode, or not at all. */
  readonly factory: "default" | "presigned" | "setCode" | "none";
  readonly args?: readonly string[];
}

export interface Anvil {
  readonly chainId: number;
  readonly url: string;
  rpc<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
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

let rpcId = 0;
export async function jsonRpc<T = unknown>(url: string, method: string, params: readonly unknown[] = []): Promise<T> {
  rpcId += 1;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }) });
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error !== undefined) {
    throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
  }
  return body.result as T;
}

export async function startAnvil(options: AnvilOptions): Promise<Anvil> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const args = ["--port", String(port), "--chain-id", String(options.chainId), "--silent", ...(options.factory === "default" ? [] : ["--disable-default-create2-deployer"]), ...(options.args ?? [])];
  const child: ChildProcess = spawn(foundryBinary("anvil"), args, { stdio: "ignore" });
  const rpc = async <T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> => await jsonRpc<T>(url, method, params);
  for (let i = 0; ; i += 1) {
    try {
      await rpc("eth_chainId");
      break;
    } catch (error) {
      if (i > 100) {
        child.kill();
        throw error;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (options.factory === "presigned") {
    // Fund the one-time signer for 100,000 gas at 100 gwei, then replay the canonical pre-EIP-155 transaction.
    await rpc("anvil_setBalance", [PROXY.signer, "0x2386f26fc10000"]);
    const hash = await rpc<string>("eth_sendRawTransaction", [PROXY.rawTransaction]);
    let receipt: { status: string; contractAddress: string } | null = null;
    for (let i = 0; i < 100 && receipt === null; i += 1) {
      receipt = await rpc<{ status: string; contractAddress: string } | null>("eth_getTransactionReceipt", [hash]);
      if (receipt === null) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (receipt?.status !== "0x1" || receipt.contractAddress.toLowerCase() !== PROXY.factory.toLowerCase()) {
      throw new Error("the presigned proxy deployment did not land at the canonical factory address");
    }
  } else if (options.factory === "setCode") {
    await rpc("anvil_setCode", [PROXY.factory, PROXY.runtime]);
  }
  const code = await rpc<string>("eth_getCode", [PROXY.factory, "latest"]);
  if ((options.factory === "none") !== (code === "0x")) {
    throw new Error(`unexpected proxy state on chain ${String(options.chainId)}: ${code.slice(0, 20)}`);
  }
  return {
    chainId: options.chainId,
    url,
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
