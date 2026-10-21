// SPDX-License-Identifier: MIT
/**
 * The token's own EIP-712 domain, for EIP-3009 authorizations (invoice spec §8.3): read from the token's
 * ERC-5267 `eip712Domain()` where implemented, otherwise from `name()` and `version()`, and compared with
 * the registry entry. Never assumed for a token whose domain the spec does not state.
 *
 * A token with neither `eip712Domain()` nor `version()` (Paxos `PaxosTokenV2`: PayPal USD hard-codes version "1" in
 * its `DOMAIN_SEPARATOR()`, C on Ethereum Sepolia, docs/research/paypal/sepolia.md) is accepted only with the domain
 * the registry states, and only when that domain hashes to the token's own `DOMAIN_SEPARATOR()` (ADR 0018).
 */
import type { Erc20Token, TokenDomain } from "@paylink/chains";
import { AbiDecodingZeroDataError, decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import { domainSeparator } from "./eip712.ts";
import type { Eip712Domain } from "./eip712.ts";
import { PayLinkError } from "./errors.ts";
import type { CallReader } from "./signature.ts";
import { isRevertError } from "./signature.ts";

const TOKEN_DOMAIN_ABI = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
] as const;

async function callString(client: CallReader, token: Address, functionName: "name" | "version"): Promise<string> {
  const result = await client.call({ to: token, data: encodeFunctionData({ abi: TOKEN_DOMAIN_ABI, functionName }) });
  return decodeFunctionResult({ abi: TOKEN_DOMAIN_ABI, functionName, data: result.data ?? "0x" });
}

/**
 * Calls a view the token may not implement: `undefined` when it reverts or returns nothing (no such function, or a
 * fallback that answers empty), the decoded value otherwise. Transport failures are thrown.
 */
async function optionalView<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (isRevertError(error) || error instanceof AbiDecodingZeroDataError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The domain of a token without `version()`: the registry's stated version, accepted only when
 * `keccak256(EIP712Domain(name(), version, chainId, token))` equals the token's `DOMAIN_SEPARATOR()`.
 */
async function provenDomain(client: CallReader, chainId: number, token: Address, name: string, stated: TokenDomain | null | undefined): Promise<Eip712Domain> {
  const version = stated?.version;
  if (version === undefined) {
    throw new PayLinkError("E_TOKEN_DOMAIN_UNKNOWN", `token ${token} has no version(); the registry must state its EIP-712 domain`, { token });
  }
  const separator = await optionalView(async () => {
    const result = await client.call({ to: token, data: encodeFunctionData({ abi: TOKEN_DOMAIN_ABI, functionName: "DOMAIN_SEPARATOR" }) });
    return decodeFunctionResult({ abi: TOKEN_DOMAIN_ABI, functionName: "DOMAIN_SEPARATOR", data: result.data ?? "0x" });
  });
  const domain: Eip712Domain = { name, version, chainId, verifyingContract: token };
  if (separator?.toLowerCase() !== domainSeparator(domain).toLowerCase()) {
    throw new PayLinkError("E_TOKEN_DOMAIN_UNKNOWN", `token ${token} has no version(), and its DOMAIN_SEPARATOR() does not prove version ${version}`, { token });
  }
  return domain;
}

/**
 * Reads a token's EIP-712 domain from the chain. Only the four-field domain (name, version, chainId,
 * verifyingContract) is supported, because that is what EIP-3009 tokens sign; anything else is refused.
 *
 * `stated` is the registry's domain for the token: used only for a token that implements neither `eip712Domain()` nor
 * `version()`, and then only when it hashes to the token's `DOMAIN_SEPARATOR()` (`E_TOKEN_DOMAIN_UNKNOWN` otherwise).
 */
export async function readTokenDomain(client: CallReader, chainId: number, token: Address, stated?: TokenDomain | null): Promise<Eip712Domain> {
  let returned: Hex | undefined;
  try {
    returned = (await client.call({ to: token, data: encodeFunctionData({ abi: TOKEN_DOMAIN_ABI, functionName: "eip712Domain" }) })).data;
  } catch (error) {
    if (!isRevertError(error)) {
      throw error;
    }
  }
  let reported: readonly [string, string, string, bigint, Address, string, readonly bigint[]] | undefined;
  try {
    // A token without ERC-5267 reverts, or returns nothing through a fallback: both mean "not implemented".
    reported = returned === undefined || returned === "0x" ? undefined : decodeFunctionResult({ abi: TOKEN_DOMAIN_ABI, functionName: "eip712Domain", data: returned });
  } catch {
    reported = undefined;
  }
  if (reported === undefined) {
    // No ERC-5267 (Circle FiatToken v2, for example): name() and version(); no version() either (Paxos PYUSD): the
    // registry's version, proven against DOMAIN_SEPARATOR().
    const [name, version] = await Promise.all([callString(client, token, "name"), optionalView(async () => await callString(client, token, "version"))]);
    return version === undefined ? await provenDomain(client, chainId, token, name, stated) : { name, version, chainId, verifyingContract: token };
  }
  const [fields, name, version, reportedChainId, verifyingContract, , extensions] = reported;
  if (fields !== "0x0f" || extensions.length > 0 || reportedChainId !== BigInt(chainId) || verifyingContract.toLowerCase() !== token.toLowerCase()) {
    throw new PayLinkError("E_TOKEN_DOMAIN_MISMATCH", `token ${token} reports an EIP-712 domain PayLink cannot sign for`, { token });
  }
  return { name, version, chainId, verifyingContract: token };
}

/**
 * The domain to sign EIP-3009 authorizations under. With a client, the on-chain domain is read and must match
 * the registry's (when the registry states one). Without a client, the registry's stated domain is used;
 * a token whose domain the registry does not state needs a client (`E_TOKEN_DOMAIN_UNKNOWN`).
 */
export async function resolveTokenDomain(parameters: {
  readonly chainId: number;
  readonly token: Erc20Token;
  readonly client?: CallReader;
}): Promise<Eip712Domain> {
  const { chainId, token, client } = parameters;
  const expected = token.eip712Domain;
  if (client === undefined) {
    if (expected === null) {
      throw new PayLinkError("E_TOKEN_DOMAIN_UNKNOWN", `the registry does not state the EIP-712 domain of ${token.symbol}; pass a client to read it`, {
        token: token.address,
      });
    }
    return { name: expected.name, version: expected.version, chainId, verifyingContract: token.address };
  }
  const onChain = await readTokenDomain(client, chainId, token.address, expected);
  if (expected !== null && (expected.name !== onChain.name || expected.version !== onChain.version)) {
    throw new PayLinkError("E_TOKEN_DOMAIN_MISMATCH", `${token.symbol} signs as ${onChain.name}/${onChain.version}, the registry says ${expected.name}/${expected.version}`, {
      token: token.address,
    });
  }
  return onChain;
}
