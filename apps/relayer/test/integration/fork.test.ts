// SPDX-License-Identifier: MIT
/**
 * The relayer against the real Monad testnet contracts, on an anvil fork (opt-in: `RELAYER_FORK_MONAD=1`, needs
 * egress to testnet-rpc.monad.xyz). PayLinkV2 (release build) is deployed on the fork; everything else is what the
 * registry names on Monad testnet: Agora's AUSD with its own EIP-3009 implementation and EIP-712 domain, and the
 * AUSD faucet behind its proxy. The relayer onboards a payer from the real faucet, then relays a gasless AUSD payment.
 *
 * It answers what the mocks cannot: that the real AUSD accepts PayLinkV2's `receiveWithAuthorization` call and the
 * SDK's signature over its domain, that the faucet answers the relayer's call, and what both cost under Monad's gas
 * schedule (anvil forks chain 10143 as network "monad", MonadTen) against the registry's gas bounds.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRegistry, monadTestnet } from "@paylink/chains";
import type { ChainDefinition, Registry } from "@paylink/chains";
import { authorizePayment, decodeInvoiceFragment, expiresIn, gasBounds, issueInvoice, verifyReceipt } from "@paylink/sdk";
import type { RelayPayRequestJson } from "@paylink/sdk";
import { createPublicClient, createWalletClient, getAddress, http, isAddressEqual, parseAbi, zeroHash } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NodeRelayer } from "../../src/node/server.ts";
import { startNodeRelayer } from "../../src/node/server.ts";
import { anvilBinary, bytecode, freePort } from "../fixtures/chain.ts";
import { post } from "../fixtures/http.ts";

const enabled = process.env["RELAYER_FORK_MONAD"] === "1" && anvilBinary() !== undefined;
const AUSD = monadTestnet.tokens.find((token) => token.symbol === "AUSD");
const BALANCE = parseAbi(["function balanceOf(address) view returns (uint256)"]);

describe.skipIf(!enabled)("relayer on a fork of Monad testnet: real AUSD and the real faucet", () => {
  let anvil: ChildProcess;
  let client: PublicClient;
  let relayer: NodeRelayer;
  let registry: Registry;
  let payLink: Address;
  const lines: string[] = [];
  // Fresh keys for every run, never anvil's public ones: on Monad testnet those accounts carry EIP-7702 delegations
  // set by strangers (public keys can be delegated by anyone), and the relayer rightly refuses to sign from an
  // account with code (observed on 2026-10-07). These keys exist only in this process and the throwaway fork.
  const keys = { deployer: generatePrivateKey(), payee: generatePrivateKey(), payer: generatePrivateKey(), relayer: generatePrivateKey() };
  const payee = privateKeyToAccount(keys.payee);
  const payer = privateKeyToAccount(keys.payer);

  beforeAll(async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${String(port)}`;
    anvil = spawn(anvilBinary() ?? "anvil", ["--fork-url", monadTestnet.rpc[0]?.url ?? "", "--port", String(port), "--silent"], { stdio: "ignore" });
    client = createPublicClient({ transport: http(url), pollingInterval: 100 });
    for (let i = 0; i < 300; i += 1) {
      try {
        await client.getChainId();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    for (const key of [keys.deployer, keys.relayer]) {
      await client.request({ method: "anvil_setBalance" as never, params: [privateKeyToAccount(key).address, "0x8ac7230489e80000"] as never });
    }
    const deployer = privateKeyToAccount(keys.deployer);
    const hash = await createWalletClient({ account: deployer, transport: http(url) }).sendTransaction({ account: deployer, chain: null, data: bytecode("PayLinkV2.sol/PayLinkV2.json") });
    payLink = getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress ?? "0x");
    // Monad testnet as the registry describes it, except that its RPC is the fork and PayLinkV2 is deployed there.
    const fork: ChainDefinition = {
      ...monadTestnet,
      key: "local",
      local: true,
      rpc: [{ url, confidence: "C" }],
      deployment: { address: payLink, status: "active", release: "2.0.0", method: "CREATE", deployer: deployer.address, txHash: hash, blockNumber: 0n, initCodeHash: zeroHash, maskedRuntimeHash: zeroHash, runtimeCodeHash: zeroHash },
    };
    registry = createRegistry([fork]);
    relayer = await startNodeRelayer({ registry, privateKey: keys.relayer, autoTrack: false, log: (line) => lines.push(line) });
    // The faucet's cooldown is global: let anyone's last drip expire on the fork.
    await client.request({ method: "evm_increaseTime" as never, params: [61] as never });
    await client.request({ method: "evm_mine" as never });
  }, 180_000);

  afterAll(async () => {
    await relayer.close();
    anvil.kill();
  });

  it("runs Monad's gas schedule on the fork", async () => {
    const info = await client.request<{ Method: "anvil_nodeInfo"; Parameters?: undefined; ReturnType: { network: string; hardFork: string } }>({ method: "anvil_nodeInfo" });
    expect([info.network, info.hardFork]).toEqual(["monad", "MonadTen"]);
  });

  it("onboards the payer from the real AUSD faucet within the registry's gas bounds", async () => {
    const token = AUSD?.address ?? "0x";
    const before = await client.readContract({ address: token, abi: BALANCE, functionName: "balanceOf", args: [payer.address] });
    const reply = await post(relayer.url, "/v1/10143/onboard", { chainId: 10143, address: payer.address });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const receipt = await client.waitForTransactionReceipt({ hash: reply.body["txHash"] as Hex });
    expect(receipt.status).toBe("success");
    const after = await client.readContract({ address: token, abi: BALANCE, functionName: "balanceOf", args: [payer.address] });
    expect(after - before).toBe(10_000_000_000n);
    const gas = (await client.getTransaction({ hash: receipt.transactionHash })).gas;
    const bounds = monadTestnet.contracts.ausdFaucet?.gas;
    expect(gas).toBeGreaterThanOrEqual(bounds?.floor ?? 0n);
    expect(gas).toBeLessThanOrEqual(bounds?.ceiling ?? 0n);
    console.log(`faucet requestFunds on the Monad fork: gasUsed ${receipt.gasUsed.toString()}, limit ${gas.toString()}`);
    await relayer.tick();
  });

  it("relays a gasless AUSD payment: the real token accepts PayLinkV2's receiveWithAuthorization", async () => {
    const t = (await client.getBlock()).timestamp;
    const issued = await issueInvoice({
      registry,
      chainId: 10143,
      draft: { payee: payee.address, token: AUSD?.address ?? "0x", amount: 12_500_000n, maxPayments: 1, validAfter: t - 60n, expiry: expiresIn(t), memo: "Fork check" },
      signer: payee,
      client,
    });
    const link = decodeInvoiceFragment(issued.fragment, registry);
    const authorized = await authorizePayment({ outstanding: null, link, signer: payer, now: (await client.getBlock()).timestamp, client });
    const body = JSON.parse(JSON.stringify(authorized.request)) as RelayPayRequestJson;
    const payeeBefore = await client.readContract({ address: AUSD?.address ?? "0x", abi: BALANCE, functionName: "balanceOf", args: [payee.address] });
    const reply = await post(relayer.url, "/v1/10143/pay", body);
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const receipt = await client.waitForTransactionReceipt({ hash: reply.body["txHash"] as Hex });
    expect(receipt.status).toBe("success");
    const payeeAfter = await client.readContract({ address: AUSD?.address ?? "0x", abi: BALANCE, functionName: "balanceOf", args: [payee.address] });
    expect(payeeAfter - payeeBefore).toBe(12_500_000n);
    const paid = receipt.logs.find((log) => isAddressEqual(log.address, payLink));
    expect(await verifyReceipt({ registry, client, reference: { chainId: 10143, txHash: receipt.transactionHash, logIndex: paid?.logIndex ?? -1 }, paid: link })).toMatchObject({ valid: true });
    const gas = (await client.getTransaction({ hash: receipt.transactionHash })).gas;
    const bounds = gasBounds(monadTestnet, "payWithAuthorization");
    expect(gas).toBeLessThanOrEqual(bounds.ceiling);
    console.log(`payWithAuthorization with the real AUSD on the Monad fork: gasUsed ${receipt.gasUsed.toString()}, limit ${gas.toString()}, registry bounds [${bounds.floor.toString()}, ${bounds.ceiling.toString()}]`);
    await relayer.tick();
    expect(lines.join("\n")).not.toContain(keys.relayer.slice(2));
  });
});
