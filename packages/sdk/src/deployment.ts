// SPDX-License-Identifier: MIT
/**
 * "Genuine PayLink contract" (invoice spec §4.2, ARCHITECTURE §6): the four deployment checks that
 * `protocol/script/utils/PayLinkRelease.sol` applies, reproduced for clients (`/status/`, the verification
 * strip):
 *
 * 1. the init code hash is the release's (recorded at deploy time; see `@paylink/chains` `RELEASE`);
 * 2. the runtime code, with every immutable range zeroed and the CBOR metadata stripped, has the release's
 *    masked runtime hash;
 * 3. the seven OpenZeppelin `EIP712` immutables equal the values recomputed from `(chainId, address)`, so
 *    genuine code copied to another address or chain is rejected;
 * 4. ERC-5267 `eip712Domain()` returns `fields = 0x0f`, `PayLink`, `2`, this chain, this address, no salt
 *    and no extensions.
 *
 * Checks 2 to 4 need only the live chain and run here.
 */
import { RELEASE } from "@paylink/chains";
import { bytesToHex, decodeFunctionResult, encodeFunctionData, hexToBytes, keccak256, numberToHex, pad, stringToBytes, stringToHex } from "viem";
import type { Address, Hex } from "viem";
import { payLinkV2Abi } from "./abi.ts";
import { DOMAIN_NAME, DOMAIN_VERSION, ZERO_HASH } from "./constants.ts";
import { domainSeparator, payLinkDomain } from "./eip712.ts";
import { assertArgument } from "./errors.ts";
import type { CallReader, CodeReader } from "./signature.ts";

/** A byte range of an immutable in the runtime code. */
export interface ImmutableReference {
  readonly start: number;
  readonly length: number;
}

/** What the integrity check compares the live code with. Defaults to the release artifact. */
export interface ReleaseIdentity {
  readonly maskedRuntimeHash: Hex;
  readonly immutableReferences: readonly ImmutableReference[];
}

const DEFAULT_RELEASE: ReleaseIdentity = RELEASE;

/**
 * Runtime code with every immutable range set to zero and the trailing CBOR metadata removed (its length is
 * the big-endian uint16 in the last two bytes, which are removed too). Throws on code too short for that.
 */
export function maskRuntimeCode(code: Hex, references: readonly ImmutableReference[]): Hex {
  const bytes = hexToBytes(code);
  for (const ref of references) {
    assertArgument(ref.start >= 0 && ref.length > 0 && ref.start + ref.length <= bytes.length, "an immutable range lies outside the code");
    bytes.fill(0, ref.start, ref.start + ref.length);
  }
  assertArgument(bytes.length >= 2, "the code is too short to carry CBOR metadata");
  const cborLength = ((bytes[bytes.length - 2] ?? 0) << 8) | (bytes[bytes.length - 1] ?? 0);
  assertArgument(cborLength + 2 <= bytes.length, "the CBOR metadata length exceeds the code");
  return bytesToHex(bytes.subarray(0, bytes.length - cborLength - 2));
}

/** keccak256 of the masked runtime code (check 2). */
export function maskedRuntimeHash(code: Hex, references: readonly ImmutableReference[]): Hex {
  return keccak256(maskRuntimeCode(code, references));
}

/** OpenZeppelin `ShortString`: the string's bytes left-aligned, its length in the last byte. */
function shortString(value: string): Hex {
  const bytes = stringToBytes(value);
  const word = new Uint8Array(32);
  word.set(bytes, 0);
  word[31] = bytes.length;
  return bytesToHex(word);
}

/**
 * The seven `EIP712` immutables of a PayLinkV2 at `address` on `chainId`, sorted: the cached domain
 * separator, chain ID and address, the hashed name and version, and the name and version ShortStrings.
 */
export function expectedImmutables(chainId: number, address: Address): Hex[] {
  return [
    domainSeparator(payLinkDomain({ chainId, verifyingContract: address })),
    numberToHex(chainId, { size: 32 }),
    pad(address.toLowerCase() as Hex, { size: 32 }),
    keccak256(stringToHex(DOMAIN_NAME)),
    keccak256(stringToHex(DOMAIN_VERSION)),
    shortString(DOMAIN_NAME),
    shortString(DOMAIN_VERSION),
  ].sort();
}

/** The 32-byte words at the immutable ranges of `code`, sorted. */
export function readImmutables(code: Hex, references: readonly ImmutableReference[]): Hex[] {
  const bytes = hexToBytes(code);
  return references.map((ref) => bytesToHex(bytes.subarray(ref.start, ref.start + ref.length))).sort();
}

export type DeploymentFailure = "no-code" | "masked-hash" | "immutables" | "domain";

export type DeploymentCheck = { readonly genuine: true } | { readonly genuine: false; readonly failure: DeploymentFailure };

/**
 * Runs checks 2 to 4 against the live chain. Transport failures are thrown, so "could not check" never
 * reads as "genuine".
 */
export async function verifyDeploymentCode(parameters: {
  readonly client: CodeReader & CallReader;
  readonly chainId: number;
  readonly address: Address;
  readonly release?: ReleaseIdentity;
}): Promise<DeploymentCheck> {
  const { client, chainId, address } = parameters;
  const release = parameters.release ?? DEFAULT_RELEASE;
  const code = await client.getCode({ address });
  if (code === undefined || code === "0x") {
    return { genuine: false, failure: "no-code" };
  }
  let masked: Hex;
  try {
    masked = maskedRuntimeHash(code, release.immutableReferences);
  } catch {
    return { genuine: false, failure: "masked-hash" };
  }
  if (masked !== release.maskedRuntimeHash) {
    return { genuine: false, failure: "masked-hash" };
  }
  const actual = readImmutables(code, release.immutableReferences);
  const expected = expectedImmutables(chainId, address);
  if (actual.length !== expected.length || actual.some((word, i) => word !== expected[i])) {
    return { genuine: false, failure: "immutables" };
  }
  const result = await client.call({ to: address, data: encodeFunctionData({ abi: payLinkV2Abi, functionName: "eip712Domain" }) });
  const [fields, name, version, domainChainId, verifyingContract, salt, extensions] = decodeFunctionResult({
    abi: payLinkV2Abi,
    functionName: "eip712Domain",
    data: result.data ?? "0x",
  });
  const domainOk =
    fields === "0x0f" &&
    name === DOMAIN_NAME &&
    version === DOMAIN_VERSION &&
    domainChainId === BigInt(chainId) &&
    verifyingContract.toLowerCase() === address.toLowerCase() &&
    salt === ZERO_HASH &&
    extensions.length === 0;
  return domainOk ? { genuine: true } : { genuine: false, failure: "domain" };
}
