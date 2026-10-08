// SPDX-License-Identifier: MIT
/**
 * The web app (apps/web) against a local chain: anvil with Monad testnet's chain id, the PayLinkV2 release deployed
 * through the CREATE2 proxy exactly as Deploy.s.sol does (so at the release address, 0x448e…5082), and a 6-decimal
 * EIP-2612 + EIP-3009 token standing in for AUSD (protocol/test/mocks/Mock3009.sol, from protocol/out).
 *
 * The app trusts only its registry, so an end-to-end build (`scripts/build.ts --e2e`, into apps/web/dist-e2e) swaps
 * that chain's token list and deployment for these local ones through `PAYLINK_E2E_CHAINS`; the RPC URL stays the
 * registry's own (https://testnet-rpc.monad.xyz) and the test routes it to anvil. Production builds refuse the
 * variable, and their bundles are checked for the e2e marker.
 *
 * A second chain, Base Sepolia's id, is the impostor case: its registry entry (in the e2e build only) names an address
 * that holds other code (a second token contract), not PayLinkV2's, so the payer's "Genuine PayLink contract" lamp
 * must turn red.
 *
 * Accounts are anvil's public, unlocked defaults; no real key is used anywhere.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { concat, encodeDeployData, encodeFunctionData, getCreateAddress, parseUnits } from "viem";
import type { Abi, Address, Hex } from "viem";
import { startAnvil } from "./anvil.ts";
import type { Anvil } from "./anvil.ts";
import { REPO } from "./server.ts";

/** anvil's default accounts #0–#3 (mnemonic "test test … junk"). */
export const ACCOUNTS = {
  /** Deploys PayLinkV2 through the CREATE2 proxy. */
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  /** The payee: signs invoices on the create terminal and keeps the books. */
  payee: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  /** Deploys the token (nonce 0, so its address is known before the chain starts). */
  tokenOwner: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  /** The payer: holds the token and pays the link. */
  payer: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
} as const satisfies Record<string, Address>;

export const CHAIN_ID = 10143;
export const REGISTRY_RPC = "https://testnet-rpc.monad.xyz";
/** The impostor chain: Base Sepolia's id and RPC URL, with a "deployment" that is not PayLinkV2. */
export const FOREIGN_CHAIN_ID = 84532;
export const FOREIGN_RPC = "https://sepolia.base.org";
export const TOKEN = {
  symbol: "AUSD",
  name: "AUSD (local)",
  /** EIP-712 domain of Mock3009: its name, and the version passed to its constructor. */
  domain: { name: "AUSD (local)", version: "1" },
  decimals: 6,
  address: getCreateAddress({ from: ACCOUNTS.tokenOwner, nonce: 0n }),
} as const;
/** What the payer holds: enough for every spec, few enough to read on screen. */
export const PAYER_FUNDS = parseUnits("500", TOKEN.decimals);

interface ReleaseData {
  readonly initCode: Hex;
  readonly release: { readonly create2: { readonly factory: Address; readonly salt: Hex; readonly address: Address } };
}
const release = JSON.parse(readFileSync(join(REPO, "web/v2/deploy/data/release.json"), "utf8")) as ReleaseData;
export const PAYLINK = release.release.create2.address;
/** On the impostor chain: the deployer's first contract, a Mock3009 that the e2e registry calls "PayLinkV2". */
export const IMPOSTOR = getCreateAddress({ from: ACCOUNTS.deployer, nonce: 0n });

/**
 * `PAYLINK_E2E_CHAINS` for the build: Monad testnet's identity and RPC URL with the local token and the real
 * deployment, and Base Sepolia's with an impostor contract standing in as the deployment.
 */
export function e2eChains(): string {
  const token = { symbol: TOKEN.symbol, name: TOKEN.name, address: TOKEN.address, decimals: TOKEN.decimals, eip3009: true, eip2612: true, domain: TOKEN.domain };
  const recorded = { txHash: `0x${"0".repeat(63)}1`, blockNumber: "1", deployer: ACCOUNTS.deployer };
  return JSON.stringify([
    { base: CHAIN_ID, rpcUrl: REGISTRY_RPC, chargesGasLimit: true, tokens: [token], deployment: { ...recorded, address: PAYLINK } },
    { base: FOREIGN_CHAIN_ID, rpcUrl: FOREIGN_RPC, tokens: [token], deployment: { ...recorded, address: IMPOSTOR } },
  ]);
}

/** Builds apps/web into dist-e2e for this chain (the `all` edition only; about five seconds). */
export function buildE2eSite(): string {
  const app = join(REPO, "apps/web");
  execFileSync(process.execPath, ["--conditions=@paylink/source", "scripts/build.ts", "--e2e"], {
    cwd: app,
    env: { ...process.env, PAYLINK_E2E_CHAINS: e2eChains(), PAYLINK_EDITIONS: "all" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return join(app, "dist-e2e");
}

function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const file = join(REPO, "protocol/out", path);
  if (!existsSync(file)) {
    throw new Error(`${path} missing: run \`forge build\` in protocol/ first`);
  }
  const json = JSON.parse(readFileSync(file, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function mined(chain: Anvil, hash: Hex): Promise<{ status: string; contractAddress: Address | null }> {
  for (let i = 0; i < 200; i += 1) {
    const receipt = await chain.rpc<{ status: string; contractAddress: Address | null } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt !== null) {
      if (receipt.status !== "0x1") {
        throw new Error(`transaction ${hash} reverted`);
      }
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

async function send(chain: Anvil, from: Address, to: Address | null, data: Hex): Promise<{ status: string; contractAddress: Address | null }> {
  const hash = await chain.rpc<Hex>("eth_sendTransaction", [{ from, ...(to === null ? {} : { to }), data }]);
  return await mined(chain, hash);
}

export interface AppChain {
  readonly anvil: Anvil;
  /** Moves the chain clock (and mines a block), for expiry. */
  advance(seconds: number): Promise<void>;
  balanceOf(owner: Address): Promise<bigint>;
}

/** Deploys the token (the first transaction of its owner, so at TOKEN.address on every chain) and funds the payer. */
async function deployToken(anvil: Anvil): Promise<{ abi: Abi; bytecode: Hex }> {
  const mock = artifact("Mock3009.sol/Mock3009.json");
  const deployed = await send(anvil, ACCOUNTS.tokenOwner, null, encodeDeployData({ abi: mock.abi, bytecode: mock.bytecode, args: [TOKEN.domain.name, TOKEN.symbol, TOKEN.domain.version, TOKEN.decimals] }));
  if (deployed.contractAddress?.toLowerCase() !== TOKEN.address.toLowerCase()) {
    throw new Error(`the token landed at ${String(deployed.contractAddress)}, not ${TOKEN.address}`);
  }
  await send(anvil, ACCOUNTS.tokenOwner, TOKEN.address, encodeFunctionData({ abi: mock.abi, functionName: "mint", args: [ACCOUNTS.payer, PAYER_FUNDS] }));
  return mock;
}

/** anvil on 10143 with the release deployed through the CREATE2 proxy and the payer funded. */
export async function startAppChain(): Promise<AppChain> {
  const anvil = await startAnvil({ chainId: CHAIN_ID, factory: "default" });
  const { create2 } = release.release;
  await send(anvil, ACCOUNTS.deployer, create2.factory, concat([create2.salt, release.initCode]));
  if ((await anvil.rpc<Hex>("eth_getCode", [PAYLINK, "latest"])) === "0x") {
    throw new Error("PayLinkV2 is not at the release address");
  }
  const mock = await deployToken(anvil);
  return {
    anvil,
    advance: async (seconds) => {
      await anvil.rpc("evm_increaseTime", [seconds]);
      await anvil.rpc("evm_mine");
    },
    balanceOf: async (owner) => {
      const data = encodeFunctionData({ abi: mock.abi, functionName: "balanceOf", args: [owner] });
      return BigInt(await anvil.rpc<Hex>("eth_call", [{ to: TOKEN.address, data }, "latest"]));
    },
  };
}

/** anvil on 84532 with the token and, at the address the e2e registry names as the deployment, other code. */
export async function startForeignChain(): Promise<Anvil> {
  const anvil = await startAnvil({ chainId: FOREIGN_CHAIN_ID, factory: "default" });
  const mock = await deployToken(anvil);
  const impostor = await send(anvil, ACCOUNTS.deployer, null, encodeDeployData({ abi: mock.abi, bytecode: mock.bytecode, args: ["PayLink", "PL", "2", 6] }));
  if (impostor.contractAddress?.toLowerCase() !== IMPOSTOR.toLowerCase()) {
    throw new Error(`the impostor landed at ${String(impostor.contractAddress)}, not ${IMPOSTOR}`);
  }
  return anvil;
}
