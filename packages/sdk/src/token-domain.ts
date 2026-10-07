// SPDX-License-Identifier: MIT
/**
 * The token's own EIP-712 domain, for EIP-3009 authorizations (invoice spec §8.3): read from the token's
 * ERC-5267 `eip712Domain()` where implemented, otherwise from `name()` and `version()`, and compared with
 * the registry entry. Never assumed for a token whose domain the spec does not state.
 */
import type { Erc20Token } from "@paylink/chains";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
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
] as const;

async function callString(client: CallReader, token: Address, functionName: "name" | "version"): Promise<string> {
  const result = await client.call({ to: token, data: encodeFunctionData({ abi: TOKEN_DOMAIN_ABI, functionName }) });
  return decodeFunctionResult({ abi: TOKEN_DOMAIN_ABI, functionName, data: result.data ?? "0x" });
}

/**
 * Reads a token's EIP-712 domain from the chain. Only the four-field domain (name, version, chainId,
 * verifyingContract) is supported, because that is what EIP-3009 tokens sign; anything else is refused.
 */
export async function readTokenDomain(client: CallReader, chainId: number, token: Address): Promise<Eip712Domain> {
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
    // No ERC-5267 (Circle FiatToken v2, for example): name() and version().
    const [name, version] = await Promise.all([callString(client, token, "name"), callString(client, token, "version")]);
    return { name, version, chainId, verifyingContract: token };
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
  const onChain = await readTokenDomain(client, chainId, token.address);
  if (expected !== null && (expected.name !== onChain.name || expected.version !== onChain.version)) {
    throw new PayLinkError("E_TOKEN_DOMAIN_MISMATCH", `${token.symbol} signs as ${onChain.name}/${onChain.version}, the registry says ${expected.name}/${expected.version}`, {
      token: token.address,
    });
  }
  return onChain;
}
