// SPDX-License-Identifier: MIT
/** Shared fixtures for the SDK tests. Keys are anvil's public test keys; addresses are local fixtures only. */
import { createRegistry, defineLocalChain, nativeToken } from "@paylink/chains";
import type { Deployment, Erc20Token, Registry, Token } from "@paylink/chains";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildInvoice, encodeInvoiceFragment, signInvoice } from "../src/index.ts";
import type { Invoice, SignedInvoice } from "../src/index.ts";

// anvil default accounts 0, 1 and 2 (mnemonic "test test test test test test test test test test test junk").
export const DEPLOYER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const PAYEE_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const PAYER_KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const payee = privateKeyToAccount(PAYEE_KEY);
export const payer = privateKeyToAccount(PAYER_KEY);

export const CONTRACT: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const TOKEN: Address = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
export const PERMIT_TOKEN: Address = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
export const DENIED: Address = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
export const CHAIN_ID = 31337;
export const T0 = 1_791_158_400n;

export const token3009: Erc20Token = {
  kind: "erc20",
  symbol: "USDC",
  name: "Mock 3009",
  address: TOKEN,
  decimals: 6,
  capabilities: { eip3009: true, eip2612: true, native: false },
  eip712Domain: { name: "USDC", version: "2" },
  listing: "default",
  confidence: "C",
  pendingVerification: [],
};

export const tokenPermit: Erc20Token = {
  kind: "erc20",
  symbol: "MUSD",
  name: "Mock permit",
  address: PERMIT_TOKEN,
  decimals: 18,
  capabilities: { eip3009: false, eip2612: true, native: false },
  eip712Domain: null,
  listing: "listed",
  confidence: "C",
  pendingVerification: [],
};

export const native: Token = nativeToken({ symbol: "ETH", name: "Ether", decimals: 18, listing: "listed", confidence: "C" });

export function deploymentAt(address: Address = CONTRACT, status: Deployment["status"] = "active"): Deployment {
  return {
    address,
    status,
    release: "2.0.0",
    method: "CREATE",
    deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    txHash: `0x${"11".repeat(32)}`,
    blockNumber: 1n,
    initCodeHash: `0x${"22".repeat(32)}`,
    maskedRuntimeHash: `0x${"33".repeat(32)}`,
    runtimeCodeHash: `0x${"44".repeat(32)}`,
  };
}

/** A local registry with the three test tokens, a denied address and an active deployment. */
export function testRegistry(options: { status?: Deployment["status"]; chainId?: number; deployment?: Deployment | null } = {}): Registry {
  const chain = defineLocalChain({
    chainId: options.chainId ?? CHAIN_ID,
    rpcUrl: "http://127.0.0.1:8545",
    tokens: [token3009, tokenPermit, native],
    deployment: options.deployment === undefined ? deploymentAt(CONTRACT, options.status ?? "active") : options.deployment,
  });
  return createRegistry([{ ...chain, deniedTokens: [{ address: DENIED, reason: "test impostor", confidence: "C" }] }]);
}

export const registry = testRegistry();

/** A deterministic one-off invoice for 25.00 of the 3009 token, with a memo. */
export function sampleInvoice(overrides: Partial<Invoice> = {}, memo: string | null = "Logo design, invoice #12"): { invoice: Invoice; memo: string | null } {
  const built = buildInvoice({
    payee: payee.address,
    token: TOKEN,
    amount: 25_000_000n,
    validAfter: T0,
    expiry: { kind: "at", validUntil: T0 + 604_800n },
    maxPayments: 1,
    salt: `0x${"5a".repeat(32)}`,
    memo,
  });
  return { invoice: { ...built.invoice, ...overrides }, memo: built.memo };
}

export async function signedSample(overrides: Partial<Invoice> = {}, memo: string | null = "Logo design, invoice #12"): Promise<SignedInvoice & { fragment: string }> {
  const { invoice, memo: m } = sampleInvoice(overrides, memo);
  const { signature } = await signInvoice({ signer: payee, deployment: { chainId: CHAIN_ID, verifyingContract: CONTRACT }, invoice });
  const signed = { chainId: CHAIN_ID, invoice, signature, memo: m };
  return { ...signed, fragment: encodeInvoiceFragment(signed) };
}
