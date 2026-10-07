// SPDX-License-Identifier: MIT
/**
 * End to end against the real contract: the release build of PayLinkV2 and the FiatToken-like Mock3009 on an
 * anvil chain that pretends to be Monad testnet (10143). The SDK issues, decodes, authorizes, relays,
 * verifies and cancels; the chain is the judge. This proves, beyond the golden vectors, that every byte the
 * SDK produces is what PayLinkV2 accepts, and that every revert it can see is decoded to the right key.
 *
 * Needs Foundry's anvil (PATH or ~/.foundry/bin) and the Foundry artifacts in protocol/out (`forge build`).
 * Without them the suite is skipped; CI runs it in the contracts job, where both exist.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRegistry, defineLocalChain, MONAD_GAS_TABLE, rpcTransport, toViemChain } from "@paylink/chains";
import type { ChainDefinition, Registry } from "@paylink/chains";
import { createPublicClient, createWalletClient, decodeEventLog, encodeDeployData, encodeFunctionData, getAddress, http, parseAbi } from "viem";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assessOutstanding,
  attributeRelayRevert,
  authorizePayment,
  cancelBySigCall,
  isPayLinkError,
  memoryOutstandingAuthorizationStore,
  outstandingAuthorizationId,
  parseOutstandingAuthorization,
  prepareAuthorizationCancel,
  recordOutstandingAuthorization,
  RelayAdmissionLedger,
  replayRevertData,
  requesterFromIp,
  resubmissionCall,
  selectPaymentPath,
  withCancellation,
  checkRelayCancelRequest,
  checkRelayPayRequest,
  decodeError,
  decodeInvoiceFragment,
  encodeReceiptFragment,
  decodeReceiptFragment,
  expiresIn,
  gasLimitFor,
  isPaymentForArmedInvoice,
  issueInvoice,
  linkStatus,
  parseRelayPayRequest,
  payLinkV2Abi,
  payWithAuthorizationCall,
  predictPayment,
  preparePermitPayment,
  readLinkState,
  signCancel,
  verifyDeploymentCode,
  verifyReceipt,
} from "../../src/index.ts";
import type { CallRequest, RelayPayRequestJson, RelayTicket } from "../../src/index.ts";
import { DEPLOYER_KEY, PAYEE_KEY, PAYER_KEY } from "../helpers.ts";

const OUT = new URL("../../../../protocol/out/", import.meta.url);
const anvilBinary = [join(homedir(), ".foundry", "bin", "anvil"), "/usr/local/bin/anvil", "/usr/bin/anvil"].find((p) => existsSync(p));
const available = anvilBinary !== undefined && existsSync(new URL("PayLinkV2.sol/PayLinkV2.json", OUT)) && existsSync(new URL("Mock3009.sol/Mock3009.json", OUT));
const bytecode = (path: string): Hex => (JSON.parse(readFileSync(new URL(path, OUT), "utf8")) as { bytecode: { object: Hex } }).bytecode.object;

// anvil default account 3, used as the relayer, and accounts 4 and 5 as extra payers (public test keys).
const RELAYER_KEY: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const PAYER_2_KEY: Hex = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const PAYER_3_KEY: Hex = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const CHAIN_ID = 10143;
const PORT = 18545 + (process.pid % 1000);

describe.skipIf(!available)("end to end on anvil (chain 10143) with the release build", () => {
  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const payee = privateKeyToAccount(PAYEE_KEY);
  const payer = privateKeyToAccount(PAYER_KEY);
  const relayer = privateKeyToAccount(RELAYER_KEY);
  const payer2 = privateKeyToAccount(PAYER_2_KEY);
  const payer3 = privateKeyToAccount(PAYER_3_KEY);
  let anvil: ChildProcess | undefined;
  let client: PublicClient;
  let chain: ReturnType<typeof toViemChain>;
  let registry: Registry;
  let local: ChainDefinition;
  let payLink: Address;
  let token: Address;
  let musd: Address;

  const wallet = (account: typeof deployer): WalletClient => createWalletClient({ account, chain, transport: http(`http://127.0.0.1:${PORT}`) });
  const now = async (): Promise<bigint> => (await client.getBlock()).timestamp;
  const send = async (account: typeof deployer, call: CallRequest, gas?: bigint): Promise<Hex> => {
    const hash = await wallet(account).sendTransaction({ account, chain, to: call.to, data: call.data, value: call.value, ...(gas === undefined ? {} : { gas }) });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    return hash;
  };
  const deploy = async (data: Hex): Promise<Address> => {
    const hash = await wallet(deployer).sendTransaction({ account: deployer, chain, data });
    const receipt = await client.waitForTransactionReceipt({ hash });
    return getAddress(receipt.contractAddress ?? "0x");
  };

  beforeAll(async () => {
    anvil = spawn(anvilBinary ?? "anvil", ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
    const probe = createPublicClient({ transport: http(`http://127.0.0.1:${PORT}`) });
    for (let i = 0; i < 100; i += 1) {
      try {
        await probe.getChainId();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const bootstrap = defineLocalChain({ chainId: CHAIN_ID, rpcUrl: `http://127.0.0.1:${PORT}`, tokens: [], deployment: null });
    chain = toViemChain(bootstrap);
    client = createPublicClient({ chain, transport: rpcTransport(bootstrap), pollingInterval: 50 });
    payLink = await deploy(bytecode("PayLinkV2.sol/PayLinkV2.json"));
    const tokenArgs = parseAbi(["constructor(string name, string symbol, string version, uint8 decimals)"]);
    token = await deploy(encodeDeployData({ abi: tokenArgs, bytecode: bytecode("Mock3009.sol/Mock3009.json"), args: ["USD Coin", "USDC", "2", 6] }));
    musd = await deploy(encodeDeployData({ abi: parseAbi(["constructor(string name, string symbol)"]), bytecode: bytecode("MockPermit.sol/MockPermit.json"), args: ["Mezo USD", "MUSD"] }));
    local = defineLocalChain({
      chainId: CHAIN_ID,
      rpcUrl: `http://127.0.0.1:${PORT}`,
      chargesGasLimit: true,
      // anvil 1.8.5 runs chain 10143 as network "monad" (hardfork MonadTen): Monad's gas schedule applies.
      gas: MONAD_GAS_TABLE,
      tokens: [
        {
          kind: "erc20",
          symbol: "USDC",
          name: "Mock3009",
          address: token,
          decimals: 6,
          capabilities: { eip3009: true, eip2612: true, native: false },
          eip712Domain: { name: "USD Coin", version: "2" },
          listing: "default",
          confidence: "C",
          pendingVerification: [],
        },
        {
          kind: "erc20",
          symbol: "MUSD",
          name: "MockPermit",
          address: musd,
          decimals: 18,
          capabilities: { eip3009: false, eip2612: true, native: false },
          eip712Domain: null,
          listing: "listed",
          confidence: "C",
          pendingVerification: [],
        },
      ],
      deployment: {
        address: payLink,
        status: "active",
        release: "2.0.0",
        method: "CREATE",
        deployer: deployer.address,
        txHash: `0x${"00".repeat(32)}`,
        blockNumber: 1n,
        initCodeHash: `0x${"00".repeat(32)}`,
        maskedRuntimeHash: `0x${"00".repeat(32)}`,
        runtimeCodeHash: `0x${"00".repeat(32)}`,
      },
    });
    registry = createRegistry([local]);
    const mint = parseAbi(["function mint(address to, uint256 value)"]);
    for (const account of [payer, payer2, payer3]) {
      await send(deployer, { to: token, data: encodeFunctionData({ abi: mint, functionName: "mint", args: [account.address, 1_000_000_000n] }), value: 0n });
    }
    await send(deployer, { to: musd, data: encodeFunctionData({ abi: mint, functionName: "mint", args: [payer.address, 10n ** 21n] }), value: 0n });
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("runs on anvil's Monad emulation, so gas is priced like Monad", async () => {
    const info = await client.request<{ Method: "anvil_nodeInfo"; Parameters?: undefined; ReturnType: { network: string; hardFork: string } }>({ method: "anvil_nodeInfo" });
    expect([info.network, info.hardFork]).toEqual(["monad", "MonadTen"]);
  });

  it("recognises the deployment as the genuine release (masked hash, immutables, ERC-5267 domain)", async () => {
    expect(await verifyDeploymentCode({ client, chainId: CHAIN_ID, address: payLink })).toEqual({ genuine: true });
    expect(await verifyDeploymentCode({ client, chainId: CHAIN_ID, address: token })).toEqual({ genuine: false, failure: "masked-hash" });
  });

  it("issues, relays and verifies a gasless payment; the till lights; a second payment is predicted and decoded as SoldOut", async () => {
    const t = await now();
    // Payee: issue (signature verified with the contract's dispatch through the live client).
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token, amount: 25_000_000n, maxPayments: 1, validAfter: t - 60n, expiry: expiresIn(t), memo: "Logo design, invoice #12" },
      signer: payee,
      client,
    });
    expect(issued.payeeAccount).toBe("eoa");
    const onChainKey = await client.readContract({ address: payLink, abi: payLinkV2Abi, functionName: "invoiceKey", args: [{ ...issued.signed.invoice }] });
    expect(onChainKey).toBe(issued.key);

    // Payer: decode the link, check it is payable, sign the bound EIP-3009 authorization (token domain read on chain).
    const link = decodeInvoiceFragment(issued.fragment, registry);
    const before = await readLinkState(client, payLink, link.key);
    expect(linkStatus(link.invoice, before, await now())).toBe("payable");
    const authorized = await authorizePayment({ outstanding: null, link, signer: payer, now: await now(), client });
    const onChainNonce = await client.readContract({
      address: payLink,
      abi: payLinkV2Abi,
      functionName: "paymentNonce",
      args: [link.key, payer.address, authorized.authorization.amount, authorized.authorization.payerRef, authorized.authorization.payerSalt],
    });
    expect(onChainNonce).toBe(authorized.nonce);

    // Relayer: parse the JSON body, rebuild the call, clamp the gas limit, send with its own key.
    const body = parseRelayPayRequest(JSON.parse(JSON.stringify(authorized.request)));
    const { call } = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: body, client, now: await now() });
    const estimate = await client.estimateGas({ account: relayer.address, to: call.to, data: call.data });
    const hash = await send(relayer, call, gasLimitFor(local, "payWithAuthorization", estimate));

    // Anyone: verify the receipt on the chain.
    const receipt = await client.getTransactionReceipt({ hash });
    const paidLog = receipt.logs.find((log) => log.address.toLowerCase() === payLink.toLowerCase());
    expect(paidLog).toBeDefined();
    const event = decodeEventLog({ abi: payLinkV2Abi, data: paidLog?.data ?? "0x", topics: paidLog?.topics ?? [] });
    expect(event.eventName).toBe("Paid");
    const receiptFragment = encodeReceiptFragment({ chainId: CHAIN_ID, txHash: hash, logIndex: paidLog?.logIndex ?? -1 }, issued.signed);
    const reference = decodeReceiptFragment(receiptFragment, registry);
    const verified = await verifyReceipt({ registry, client, reference, ...(reference.invoice === null ? {} : { paid: reference.invoice }) });
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.proof).toMatchObject({ payee: payee.address, payer: payer.address, token, amount: 25_000_000n, key: issued.key, index: 0 });
      expect(isPaymentForArmedInvoice(verified.proof, { key: issued.key, invoice: issued.signed.invoice })).toBe(true);
    }
    const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    expect(await client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [payee.address] })).toBe(25_000_000n);
    expect(await client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [payLink] })).toBe(0n);

    // State: paid; a second payment is predicted and, when simulated anyway, decoded as SoldOut.
    const after = await readLinkState(client, payLink, link.key);
    expect(after).toMatchObject({ payments: 1, cancelled: false, total: 25_000_000n });
    expect(linkStatus(link.invoice, after, await now())).toBe("paid");
    const again = await authorizePayment({ outstanding: null, link, signer: payer, now: await now(), client });
    expect(
      predictPayment({ invoice: link.invoice, verifyingContract: payLink, state: after, now: await now(), fn: "payWithAuthorization", amount: 25_000_000n, payer: payer.address, signatureValid: true })?.name,
    ).toBe("SoldOut");
    const second = payWithAuthorizationCall(payLink, link.invoice, link.signature, again.authorization);
    const failure = await client.call({ account: relayer.address, to: second.to, data: second.data }).catch((error: unknown) => error);
    expect(decodeError(failure)).toMatchObject({ name: "SoldOut", i18nKey: "error.contract.soldOut", params: { maxPayments: "1" } });
  });

  it("pays an 18-decimal, permit-only invoice (MUSD-like) in one payWithPermit transaction", async () => {
    const t = await now();
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token: musd, amount: 15n * 10n ** 17n, maxPayments: 1, validAfter: t - 60n, expiry: expiresIn(t) },
      signer: payee,
      client,
    });
    const link = decodeInvoiceFragment(issued.fragment, registry);
    const { call } = await preparePermitPayment({ link, signer: payer, client, deadline: (await now()) + 600n });
    const estimate = await client.estimateGas({ account: payer.address, to: call.to, data: call.data });
    await send(payer, call, gasLimitFor(local, "payWithPermit", estimate));
    expect(await readLinkState(client, payLink, link.key)).toMatchObject({ payments: 1, total: 15n * 10n ** 17n });
    const balanceOf = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    expect(await client.readContract({ address: musd, abi: balanceOf, functionName: "balanceOf", args: [payee.address] })).toBe(15n * 10n ** 17n);
  });

  it("cannot be redirected: a relayer that changes the reference gets the token's signature failure (I8)", async () => {
    const t = await now();
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token, amount: 0n, maxPayments: 0, validAfter: t - 60n, expiry: { kind: "never", confirmed: true } },
      signer: payee,
      client,
    });
    const link = decodeInvoiceFragment(issued.fragment, registry);
    const authorized = await authorizePayment({ outstanding: null, link, signer: payer, now: await now(), amount: 5n, client });
    const payerRef: Hex = `0x${"ee".repeat(32)}`;
    const tampered = { ...authorized.authorization, payerRef };
    const call = payWithAuthorizationCall(payLink, link.invoice, link.signature, tampered);
    const failure = await client.call({ account: relayer.address, to: call.to, data: call.data }).catch((error: unknown) => error);
    expect(decodeError(failure)).toMatchObject({ source: "token", i18nKey: "error.token.authorizationInvalid" });
  });

  it("cancels gaslessly through cancelBySig; payments are then predicted and decoded as Cancelled", async () => {
    const t = await now();
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token, amount: 1_000_000n, maxPayments: 3, validAfter: t - 60n, expiry: expiresIn(t) },
      signer: payee,
      client,
    });
    const deployment = { chainId: CHAIN_ID, verifyingContract: payLink };
    const cancel = await signCancel({ signer: payee, deployment, invoice: issued.signed.invoice, deadline: (await now()) + 3600n, client });
    const relayed = await checkRelayCancelRequest({ registry, pathChainId: CHAIN_ID, request: cancel, client, now: await now() });
    await send(relayer, relayed.call);
    const state = await readLinkState(client, payLink, issued.key);
    expect(state.cancelled).toBe(true);
    const link = decodeInvoiceFragment(issued.fragment, registry);
    const authorized = await authorizePayment({ outstanding: null, link, signer: payer, now: await now(), client });
    const call = payWithAuthorizationCall(payLink, link.invoice, link.signature, authorized.authorization);
    const failure = await client.call({ account: relayer.address, to: call.to, data: call.data }).catch((error: unknown) => error);
    expect(decodeError(failure)).toMatchObject({ name: "Cancelled", i18nKey: "error.contract.cancelled" });
    const replay = await client.call({ account: relayer.address, ...cancelBySigCall(payLink, cancel) }).catch((error: unknown) => error);
    expect(decodeError(replay).name).toBe("Cancelled");
  });
  /** A receive card: open amount, unlimited payments, no expiry, where a retry that re-signs would pay twice. */
  const receiveCard = async () => {
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token, amount: 0n, maxPayments: 0, validAfter: (await now()) - 60n, expiry: { kind: "never", confirmed: true } },
      signer: payee,
      client,
    });
    return decodeInvoiceFragment(issued.fragment, registry);
  };
  const balanceOf = async (account: Address): Promise<bigint> =>
    await client.readContract({ address: token, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account] });

  it("relayer slow, then lands: the retry resubmits the same authorization and the payer is charged once (A-01)", async () => {
    const link = await receiveCard();
    const store = memoryOutstandingAuthorizationStore();
    const id = outstandingAuthorizationId({ chainId: CHAIN_ID, key: link.key, payer: payer.address });
    const payerBefore = await balanceOf(payer.address);
    const payeeBefore = await balanceOf(payee.address);

    // The payer signs 12.34 and the device stores the body before posting it. The relayer accepts and sits on it.
    const signed = await authorizePayment({ outstanding: null, link, signer: payer, now: await now(), amount: 12_340_000n, client });
    await store.put(id, recordOutstandingAuthorization(link, signed));
    const held = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(JSON.parse(JSON.stringify(signed.request))), client, now: await now() });

    // The client gives up waiting (or the page reloads): it looks before it signs.
    const checked = parseOutstandingAuthorization(await store.get(id), registry);
    const live = await assessOutstanding({ client, checked, now: await now() });
    expect(live.state).toBe("live");
    const refused = await authorizePayment({ outstanding: live, link, signer: payer, now: await now(), amount: 12_340_000n, client }).catch((error: unknown) => error);
    expect(isPayLinkError(refused, "E_AUTHORIZATION_OUTSTANDING")).toBe(true);
    const route = selectPaymentPath({ capabilities: link.token.capabilities, account: "eoa", relayerHealthy: false, outstanding: live });
    expect(route).toMatchObject({ available: true, path: "self-authorization", fallbacks: [], resubmit: { withheld: ["permit", "batched-approve-pay", "approve-pay"] } });

    // "Pay with your own gas" resubmits the stored authorization...
    await send(payer, resubmissionCall(checked));
    // ...and the late relay is refused by the token: the nonce is spent.
    const late = await client.call({ account: relayer.address, to: held.call.to, data: held.call.data }).catch((error: unknown) => error);
    expect(decodeError(late)).toMatchObject({ source: "token", i18nKey: "error.token.authorizationUsed" });

    expect(payerBefore - (await balanceOf(payer.address))).toBe(12_340_000n);
    expect((await balanceOf(payee.address)) - payeeBefore).toBe(12_340_000n);
    expect(await readLinkState(client, payLink, link.key)).toMatchObject({ payments: 1, total: 12_340_000n });
    expect(await assessOutstanding({ client, checked, now: await now() })).toEqual({ state: "consumed" });
  });

  it("relayer slow, payer switches to permit only after cancelling the authorization on the token (A-01)", async () => {
    const link = await receiveCard();
    const payerBefore = await balanceOf(payer.address);
    const signed = await authorizePayment({ outstanding: null, link, signer: payer, now: await now(), amount: 25_000_000n, client });
    const record = recordOutstandingAuthorization(link, signed);
    const held = payWithAuthorizationCall(payLink, link.invoice, link.signature, signed.authorization);
    const checked = parseOutstandingAuthorization(record, registry);

    // Permit is withheld while the authorization is live...
    const live = await assessOutstanding({ client, checked, now: await now() });
    expect(selectPaymentPath({ capabilities: link.token.capabilities, account: "eoa", relayerHealthy: false, outstanding: live })).toMatchObject({ resubmit: { withheld: ["permit", "batched-approve-pay", "approve-pay"] } });

    // ...until the payer cancels it with the token's cancelAuthorization, mined with status 1.
    const { call } = await prepareAuthorizationCancel({ checked, signer: payer, client });
    const cancelHash = await send(payer, call);
    const recorded = withCancellation(checked, cancelHash, await client.getTransactionReceipt({ hash: cancelHash }));
    const cancelled = await assessOutstanding({ client, checked: { ...checked, outstanding: recorded }, now: await now() });
    expect(cancelled).toEqual({ state: "cancelled" });
    const route = selectPaymentPath({ capabilities: link.token.capabilities, account: "eoa", relayerHealthy: false, outstanding: cancelled });
    expect(route).toMatchObject({ available: true, path: "self-authorization", fallbacks: ["permit", "approve-pay"], resubmit: null });

    const permit = await preparePermitPayment({ link, signer: payer, client, deadline: (await now()) + 600n, amount: 25_000_000n });
    await send(payer, permit.call);
    const late = await client.call({ account: relayer.address, to: held.to, data: held.data }).catch((error: unknown) => error);
    expect(decodeError(late)).toMatchObject({ source: "token", i18nKey: "error.token.authorizationUsed" });
    expect(payerBefore - (await balanceOf(payer.address))).toBe(25_000_000n);
    expect(await readLinkState(client, payLink, link.key)).toMatchObject({ payments: 1, total: 25_000_000n });
  });

  /** The relayer after a relay was mined with status 0: replay it for revert data, attribute, release (A-04). */
  const settleReverted = async (ledger: RelayAdmissionLedger, ticket: RelayTicket, call: CallRequest, gas: bigint, simulatedAt: bigint, hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("reverted");
    const { timestamp } = await client.getBlock({ blockNumber: receipt.blockNumber });
    const revertData = await replayRevertData({ client, from: relayer.address, call, gas, blockNumber: receipt.blockNumber });
    const attribution = await attributeRelayRevert({ client, registry, ticket, inclusion: { blockNumber: receipt.blockNumber, timestamp }, simulatedAt, revertData });
    return { attribution, released: ledger.release(ticket, attribution, timestamp) };
  };
  /** Checks, simulates and admits one relay at chain time; returns what the relayer keeps until inclusion. */
  const admitRelay = async (ledger: RelayAdmissionLedger, request: RelayPayRequestJson, requester: string) => {
    const t = await now();
    const checked = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(JSON.parse(JSON.stringify(request))), client, now: t });
    await client.call({ account: relayer.address, to: checked.call.to, data: checked.call.data });
    const simulatedAt = await client.getBlockNumber();
    const admission = ledger.admit(checked, requesterFromIp(requester), t);
    if (!admission.admitted) {
      throw new Error(`refused: ${admission.reason}`);
    }
    const gas = gasLimitFor(local, "payWithAuthorization", 150_000n);
    const broadcast = async (): Promise<Hex> => await wallet(relayer).sendTransaction({ account: relayer, chain, to: checked.call.to, data: checked.call.data, value: 0n, gas });
    return { checked, ticket: admission.ticket, simulatedAt, gas, broadcast };
  };

  it("one cancel of a receive card reverts at most one queued relay; the evidence names the payee, who is banned with the card (A-02, A-04)", async () => {
    const link = await receiveCard();
    const ledger = new RelayAdmissionLedger();
    const t = await now();
    const requests = await Promise.all(
      [payer, payer2, payer3].map(async (account) => {
        const { request } = await authorizePayment({ outstanding: null, link, signer: account, now: t, amount: 1n, client });
        return await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(JSON.parse(JSON.stringify(request))), client, now: t });
      }),
    );
    // Every request is genuine and simulates fine, but only one may be in flight for the card.
    for (const checked of requests) {
      await client.call({ account: relayer.address, to: checked.call.to, data: checked.call.data });
    }
    const simulatedAt = await client.getBlockNumber();
    const admissions = requests.map((checked, i) => ledger.admit(checked, requesterFromIp(`198.51.100.${String(i)}`), t));
    expect(admissions.map((a) => (a.admitted ? "admitted" : a.reason))).toEqual(["admitted", "in-flight-key", "in-flight-key"]);

    // The payee cancels the card before the admitted relay is included: it reverts, at the relayer's expense.
    await send(payee, { to: payLink, data: encodeFunctionData({ abi: payLinkV2Abi, functionName: "cancel", args: [{ ...link.invoice }] }), value: 0n });
    const [first] = requests;
    const admitted = admissions[0];
    if (first === undefined || admitted?.admitted !== true) {
      throw new Error("the first request should have been admitted");
    }
    const gas = gasLimitFor(local, "payWithAuthorization", 150_000n);
    const hash = await wallet(relayer).sendTransaction({ account: relayer, chain, to: first.call.to, data: first.call.data, value: 0n, gas });
    const { attribution, released } = await settleReverted(ledger, admitted.ticket, first.call, gas, simulatedAt, hash);
    expect(attribution).toEqual({ cause: "payee", detail: "invoice-cancelled" });
    expect(released.banned).toEqual(["key", "payee"]);
    // The card and its payee are banned for the day: the queue cannot be refilled against them. The payer is not.
    const [, second] = requests;
    expect(second === undefined ? null : ledger.admit(second, requesterFromIp("198.51.100.1"), t + 2n)).toMatchObject({ admitted: false, reason: "banned-key" });
    expect([...ledger.activeBans(t + 2n).keys()].some((dimension) => dimension.startsWith("payer:"))).toBe(false);
  });

  it("the payer's own resubmission lands first: the relay reverts, the payment settled once, nobody is banned (A-04)", async () => {
    const link = await receiveCard();
    const ledger = new RelayAdmissionLedger();
    const payeeBefore = await balanceOf(payee.address);
    const signed = await authorizePayment({ outstanding: null, link, signer: payer, now: await now(), amount: 3_000_000n, client });
    const relay = await admitRelay(ledger, signed.request, "203.0.113.30");
    // Spec §8.6: the client resubmits the same body itself while the relay is slow, and that lands first.
    await send(payer, payWithAuthorizationCall(payLink, link.invoice, link.signature, signed.authorization));
    const { attribution, released } = await settleReverted(ledger, relay.ticket, relay.checked.call, relay.gas, relay.simulatedAt, await relay.broadcast());
    expect(attribution).toEqual({ cause: "superseded", detail: "authorization-settled-this-payment" });
    expect(released).toMatchObject({ banned: [], struck: false });
    expect((await balanceOf(payee.address)) - payeeBefore).toBe(3_000_000n);
    expect(await readLinkState(client, payLink, link.key)).toMatchObject({ payments: 1, total: 3_000_000n });
  });

  it("a payer that cancels its authorization on the token after admission is banned alone; the honest card stays relayable (A-04)", async () => {
    const link = await receiveCard();
    const ledger = new RelayAdmissionLedger();
    const signed = await authorizePayment({ outstanding: null, link, signer: payer2, now: await now(), amount: 1n, client });
    const relay = await admitRelay(ledger, signed.request, "203.0.113.31");
    const checked = parseOutstandingAuthorization(recordOutstandingAuthorization(link, signed), registry);
    await send(payer2, (await prepareAuthorizationCancel({ checked, signer: payer2, client })).call);
    const { attribution, released } = await settleReverted(ledger, relay.ticket, relay.checked.call, relay.gas, relay.simulatedAt, await relay.broadcast());
    expect(attribution).toEqual({ cause: "payer", detail: "authorization-spent-elsewhere" });
    expect(released.banned).toEqual(["payer"]);
    // Another customer of the same card, from another network: admitted.
    const honest = await authorizePayment({ outstanding: null, link, signer: payer3, now: await now(), amount: 2n, client });
    expect((await admitRelay(ledger, honest.request, "198.51.100.40")).ticket.payee).toBe(payee.address);
  });

  it("a one-off invoice paid by another route first is a sold-out race: the key is banned, no party is (A-04)", async () => {
    const t = await now();
    const issued = await issueInvoice({
      registry,
      chainId: CHAIN_ID,
      draft: { payee: payee.address, token, amount: 4_000_000n, maxPayments: 1, validAfter: t - 60n, expiry: expiresIn(t) },
      signer: payee,
      client,
    });
    const link = decodeInvoiceFragment(issued.fragment, registry);
    const ledger = new RelayAdmissionLedger();
    const relay = await admitRelay(ledger, (await authorizePayment({ outstanding: null, link, signer: payer, now: t, client })).request, "203.0.113.32");
    const other = await authorizePayment({ outstanding: null, link, signer: payer3, now: t, client });
    await send(payer3, payWithAuthorizationCall(payLink, link.invoice, link.signature, other.authorization));
    const { attribution, released } = await settleReverted(ledger, relay.ticket, relay.checked.call, relay.gas, relay.simulatedAt, await relay.broadcast());
    expect(attribution).toEqual({ cause: "sold-out", detail: "contract:SoldOut" });
    expect(released).toMatchObject({ banned: ["key"], struck: false });
  });

  it("refuses a 1-second authorization before any gas is spent, and blames nobody for a relay mined after its margin (A-04)", async () => {
    const link = await receiveCard();
    const t = await now();
    const short = await authorizePayment({ outstanding: null, link, signer: payer3, now: t, amount: 1n, ttlSeconds: 1n, client });
    const refused = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(JSON.parse(JSON.stringify(short.request))), client, now: t }).catch((error: unknown) => error);
    expect(isPayLinkError(refused, "E_INVALID_ARGUMENT") ? refused.params["rule"] : refused).toBe("RelayValidityTooShort");

    // Exactly the margin: admitted. The relayer then stalls past validThrough (its own latency), and the token refuses.
    const ledger = new RelayAdmissionLedger();
    const edge = await authorizePayment({ outstanding: null, link, signer: payer3, now: await now(), amount: 1n, ttlSeconds: 121n, client });
    const relay = await admitRelay(ledger, edge.request, "203.0.113.33");
    expect(relay.ticket.validThrough - relay.ticket.admittedAt).toBeLessThanOrEqual(120n);
    await client.request<{ Method: "evm_setNextBlockTimestamp"; Parameters: [number]; ReturnType: null }>({ method: "evm_setNextBlockTimestamp", params: [Number(relay.ticket.validThrough + 1n)] });
    const { attribution, released } = await settleReverted(ledger, relay.ticket, relay.checked.call, relay.gas, relay.simulatedAt, await relay.broadcast());
    expect(attribution).toEqual({ cause: "late-inclusion", detail: "time-bound-passed-before-inclusion" });
    expect(released).toMatchObject({ banned: [], struck: false });
  });
});
