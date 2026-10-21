// SPDX-License-Identifier: MIT
/**
 * The API's chain reads against Ethereum Sepolia's real state, on an anvil fork (ADR 0018, decision D-CHAIN): PayLinkV2
 * is deployed at its release CREATE2 address with the committed release init code (web/v2/deploy/data/release.json,
 * checked against RELEASE.initCodeHash), exactly as the owner's deploy kit will; Circle USDC is the real token; one
 * invoice is paid by the payer's own EIP-3009 authorisation (no relayer: D-SCOPE), one is cancelled by the payee, one
 * stays payable, one expires on chain time. The reader must then see each as the reconciler needs it, the paid one with
 * its verified `Paid` event, and the situation table must decide S3, S7, S1 and S7.
 *
 * Needs anvil (Foundry) and egress to ethereum-sepolia-rpc.publicnode.com, so it runs only on request:
 *
 *   PAYLINK_FORK_SEPOLIA=1 NODE_USE_ENV_PROXY=1 pnpm --filter @paylink/api exec vitest run test/chain/fork.test.ts
 *
 * Every key is derived from a public label and lives only on the fork; nothing is sent to Sepolia.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRegistry, ethereumSepolia, RELEASE } from "@paylink/chains";
import type { Registry } from "@paylink/chains";
import { authorizePayment, cancelCall, decodeInvoiceFragment, issueInvoice, payWithAuthorizationCall } from "@paylink/sdk";
import type { DecodedInvoiceLink } from "@paylink/sdk";
import { concat, createPublicClient, createWalletClient, hexToBytes, http, keccak256, stringToHex } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainClient } from "../../src/chain/client.ts";
import { createReader } from "../../src/chain/reader.ts";
import type { ChainTwin } from "../../src/chain/types.ts";
import { reconcile } from "../../src/reconciler/situation.ts";
import type { ChainObservation } from "../../src/reconciler/types.ts";
import { paypal, TWIN as FACTS } from "../reconciler/fixtures.ts";

const enabled = process.env["PAYLINK_FORK_SEPOLIA"] === "1";
const RPC = ethereumSepolia.rpc[0]?.url ?? "https://ethereum-sepolia-rpc.publicnode.com";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const DAY = 86_400n;
const DOLLARS = 1_000_000n;

function anvilBinary(): string {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir !== "" && existsSync(join(dir, "anvil"))) {
      return join(dir, "anvil");
    }
  }
  return join(homedir(), ".foundry", "bin", "anvil");
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

const labelKey = (label: string): Hex => {
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  return `0x${((BigInt(keccak256(stringToHex(`paylink.api-fork.${label}`))) % (n - 1n)) + 1n).toString(16).padStart(64, "0")}`;
};

interface Fork {
  readonly url: string;
  readonly child: ChildProcess;
  rpc<T>(method: string, params?: readonly unknown[]): Promise<T>;
}

async function startFork(): Promise<Fork> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const child = spawn(anvilBinary(), ["--fork-url", RPC, "--hardfork", "prague", "--port", String(port), "--silent"], { stdio: "ignore" });
  let id = 0;
  const rpc = async <T>(method: string, params: readonly unknown[] = []): Promise<T> => {
    id += 1;
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error !== undefined) {
      throw new Error(`${method}: ${body.error.message}`);
    }
    return body.result as T;
  };
  for (let i = 0; ; i += 1) {
    try {
      await rpc("eth_chainId");
      return { url, child, rpc };
    } catch (error) {
      if (i > 600 || child.exitCode !== null) {
        child.kill();
        throw error;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe.skipIf(!enabled)("chain reads on an anvil fork of Ethereum Sepolia", () => {
  let fork: Fork;
  let client: PublicClient;
  let registry: Registry;
  let payee: PrivateKeyAccount;
  let payer: PrivateKeyAccount;
  const links: Record<"paid" | "cancelled" | "payable" | "expiring", DecodedInvoiceLink | null> = { paid: null, cancelled: null, payable: null, expiring: null };
  let paidTx: Hex;
  let observed: ReadonlyMap<string, ChainObservation>;

  const send = async (from: PrivateKeyAccount, to: Address, data: Hex, gas = 500_000n): Promise<Hex> => {
    const wallet = createWalletClient({ account: from, transport: http(fork.url) });
    // Fees well above the fork's base fee: a transaction priced from an estimate can sit in anvil's pool.
    const hash = await wallet.sendTransaction({ account: from, chain: null, to, data, gas, maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 60_000 });
    expect(receipt.status).toBe("success");
    return hash;
  };

  beforeAll(async () => {
    fork = await startFork();
    client = createPublicClient({ transport: http(fork.url) });
    expect(await client.getChainId()).toBe(11155111);
    // 1. Deploy PayLinkV2 through the canonical CREATE2 factory with the committed release init code.
    const release = JSON.parse(readFileSync(new URL("../../../../web/v2/deploy/data/release.json", import.meta.url), "utf8")) as { initCode: Hex };
    expect(keccak256(release.initCode)).toBe(RELEASE.initCodeHash);
    const deployer = privateKeyToAccount(labelKey("deployer"));
    payee = privateKeyToAccount(labelKey("payee"));
    payer = privateKeyToAccount(labelKey("payer"));
    for (const a of [deployer, payee, payer]) {
      expect(await client.getCode({ address: a.address })).toBeUndefined();
      await fork.rpc("anvil_setBalance", [a.address, "0x8ac7230489e80000"]);
    }
    expect(await client.getCode({ address: RELEASE.create2.address })).toBeUndefined();
    // About 2.72M gas on chain (docs/research/paypal/pyusd.md §4); the kit clamps its own estimate, a fixed bound is enough here.
    const deployTx = await send(deployer, RELEASE.create2.factory, concat([RELEASE.create2.salt, release.initCode]), 4_000_000n);
    expect((await client.getCode({ address: RELEASE.create2.address }))?.length).toBe(2 + 2 * RELEASE.runtimeCodeSize);
    const deployBlock = (await client.getTransactionReceipt({ hash: deployTx })).blockNumber;
    registry = createRegistry([
      {
        ...ethereumSepolia,
        deployment: { address: RELEASE.create2.address, status: "active", release: RELEASE.release, method: "CREATE2", deployer: deployer.address, txHash: deployTx, blockNumber: deployBlock, initCodeHash: RELEASE.initCodeHash, maskedRuntimeHash: RELEASE.maskedRuntimeHash, runtimeCodeHash: keccak256((await client.getCode({ address: RELEASE.create2.address })) ?? "0x") },
      },
    ]);
    // 2. Four $120 USDC invoices signed by the payee.
    const now = (await client.getBlock()).timestamp;
    const issue = async (label: string, validUntil: bigint): Promise<DecodedInvoiceLink> => {
      const issued = await issueInvoice({
        registry,
        chainId: 11155111,
        draft: { payee: payee.address, token: USDC, amount: 120n * DOLLARS, maxPayments: 1, validAfter: 0n, expiry: { kind: "at", validUntil }, memo: `api fork: ${label}`, salt: keccak256(stringToHex(`paylink.api-fork.salt.${label}`)) },
        signer: payee,
        client,
      });
      return decodeInvoiceFragment(issued.fragment, registry);
    };
    links.paid = await issue("paid", now + 7n * DAY);
    links.cancelled = await issue("cancelled", now + 7n * DAY);
    links.payable = await issue("payable", now + 7n * DAY);
    links.expiring = await issue("expiring", now + 120n);
    // 3. The payer pays the first by its own EIP-3009 authorisation and pays the gas (no relayer on Sepolia).
    await fork.rpc("anvil_dealERC20", [payer.address, USDC, `0x${(120n * DOLLARS).toString(16)}`]);
    const auth = await authorizePayment({ link: links.paid, signer: payer, now, outstanding: null, client, random: () => hexToBytes(keccak256(stringToHex("paylink.api-fork.payer"))) });
    const pay = payWithAuthorizationCall(RELEASE.create2.address, links.paid.invoice, links.paid.signature, auth.authorization);
    paidTx = await send(payer, pay.to, pay.data);
    // 4. The payee cancels the second; time passes beyond the fourth's validity; two more blocks confirm.
    const cancel = cancelCall(RELEASE.create2.address, links.cancelled.invoice);
    await send(payee, cancel.to, cancel.data);
    await fork.rpc("evm_increaseTime", [600]);
    await fork.rpc("anvil_mine", ["0x2"]);
    // 5. The API's reader, through the runtime-style client pointed at the fork.
    const reader = createReader({ registry, chainId: 11155111, client: chainClient({ fetch }, ethereumSepolia, [fork.url]) });
    const twin = (link: DecodedInvoiceLink): ChainTwin => ({ key: link.key, payee: payee.address, token: USDC, rail: "USDC", amountBase: (120n * DOLLARS).toString(), validUntil: Number(link.invoice.validUntil), chainPayment: null });
    observed = await reader.observeMany([twin(links.paid), twin(links.cancelled), twin(links.payable), twin(links.expiring)]);
  }, 600_000);

  afterAll(() => {
    fork.child.kill();
  });

  it("reads the paid invoice as paid, with its Paid event verified at the exact amount", () => {
    const paid = observed.get(links.paid?.key ?? "0x");
    expect(paid?.state).toBe("paid");
    expect(paid?.payments).toEqual([expect.objectContaining({ txHash: paidTx.toLowerCase(), amount: "120000000", token: USDC, rail: "USDC", payer: payer.address })]);
  });

  it("reads the cancelled invoice as cancelled, with its InvoiceCancelled transaction; the others payable and expired", () => {
    expect(observed.get(links.cancelled?.key ?? "0x")).toMatchObject({ state: "cancelled", cancelTx: expect.stringMatching(/^0x[0-9a-f]{64}$/u) as unknown });
    expect(observed.get(links.payable?.key ?? "0x")?.state).toBe("payable");
    expect(observed.get(links.expiring?.key ?? "0x")?.state).toBe("expired");
  });

  it("feeds the situation table: S3 (record the chain payment), S7 (close PayPal), S1, S7", () => {
    const decide = (link: DecodedInvoiceLink | null) => {
      const chain = observed.get(link?.key ?? "0x");
      if (link === null || chain === undefined) {
        throw new Error("missing observation");
      }
      return reconcile({ twin: { ...FACTS, key: link.key, payee: payee.address }, paypal: paypal("SHARED", { reference: link.key }), chain, now: Date.now() }).situation;
    };
    expect([decide(links.paid), decide(links.cancelled), decide(links.payable), decide(links.expiring)]).toEqual(["S3", "S7", "S1", "S7"]);
  });
});
