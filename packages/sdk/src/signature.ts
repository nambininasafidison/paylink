// SPDX-License-Identifier: MIT
/**
 * Payee-signature verification with **the same dispatch as the contract** (invoice spec §6, OpenZeppelin
 * 5.3.0 `SignatureChecker.isValidSignatureNow`): ECDSA when the signer has no code, ERC-1271 when it has
 * code (including EIP-7702 delegated EOAs). A payer client that verified differently could light "Signature
 * valid" for an invoice the contract rejects (§6.4).
 */
import { BaseError, encodeFunctionData, ExecutionRevertedError, RawContractError, recoverAddress, size, sliceHex } from "viem";
import type { Address, Hex } from "viem";
import { isLowerHex } from "./bytes.ts";
import { ECDSA_SIGNATURE_LENGTH, EIP7702_DELEGATION_PREFIX, ERC1271_MAGIC_VALUE, SECP256K1_HALF_ORDER } from "./constants.ts";

/** Reads code. viem's `PublicClient` satisfies it. */
export interface CodeReader {
  getCode(parameters: { address: Address }): Promise<Hex | undefined>;
}

/** Performs `eth_call`. viem's `PublicClient` satisfies it. */
export interface CallReader {
  call(parameters: { to: Address; data: Hex }): Promise<{ data?: Hex | undefined }>;
}

/** What signature verification needs from a chain. viem's `PublicClient` satisfies it. */
export type SignatureClient = CodeReader & CallReader;

/** Why a signature does not verify. */
export type SignatureFailure =
  | "malformed" // not 65 bytes, or v not in {27, 28}, or not a curve point (ECDSA)
  | "high-s" // s above n/2 (ECDSA malleability, §14.2)
  | "wrong-signer" // a valid ECDSA signature by another address
  | "erc1271-rejected" // isValidSignature returned anything but the magic value
  | "erc1271-reverted"; // isValidSignature reverted

export interface SignatureVerification {
  readonly valid: boolean;
  /** Which rule applied. */
  readonly method: "ecdsa" | "erc1271";
  /** False when no client was given: ECDSA was assumed without reading the signer's code (offline check). */
  readonly codeChecked: boolean;
  /** The signer is an EIP-7702 delegated EOA (code `0xef0100 ‖ delegate`): issuers should warn (§6.4). */
  readonly delegated: boolean;
  readonly failure: SignatureFailure | null;
}

/** `r`, `s` and `v` of a 65-byte signature, or the reason it is not acceptable to OpenZeppelin ECDSA. */
export function parseEcdsaSignature(
  signature: Hex,
): { readonly ok: true; readonly r: Hex; readonly s: Hex; readonly v: 27 | 28 } | { readonly ok: false; readonly failure: "malformed" | "high-s" } {
  if (!isLowerHex(signature) || size(signature) !== ECDSA_SIGNATURE_LENGTH) {
    return { ok: false, failure: "malformed" };
  }
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) {
    return { ok: false, failure: "malformed" };
  }
  const s = sliceHex(signature, 32, 64);
  if (BigInt(s) > SECP256K1_HALF_ORDER) {
    return { ok: false, failure: "high-s" };
  }
  return { ok: true, r: sliceHex(signature, 0, 32), s, v };
}

/**
 * ECDSA as OpenZeppelin `ECDSA.tryRecover(hash, signature)` accepts it: exactly 65 bytes, `v` in {27, 28},
 * low `s`, no compact (EIP-2098) form. Returns the signer, or the failure.
 */
export async function recoverEcdsaSigner(digest: Hex, signature: Hex): Promise<{ readonly signer: Address } | { readonly failure: "malformed" | "high-s" }> {
  const parsed = parseEcdsaSignature(signature);
  if (!parsed.ok) {
    return { failure: parsed.failure };
  }
  try {
    return { signer: await recoverAddress({ hash: digest, signature }) };
  } catch {
    return { failure: "malformed" };
  }
}

const IS_VALID_SIGNATURE_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

/** The 32-byte word OpenZeppelin compares the ERC-1271 return data with. */
const MAGIC_WORD = `${ERC1271_MAGIC_VALUE}${"0".repeat(56)}`;

/** True when the error is a revert of the called contract, as opposed to a transport failure. */
export function isRevertError(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof RawContractError || e instanceof ExecutionRevertedError) !== null;
}

/**
 * Verifies `signature` by `signer` over `digest` (an invoice key or a cancel digest). With a client, it reads
 * the signer's code and applies the contract's dispatch. Without one, it can only check ECDSA, and says so
 * (`codeChecked: false`): payer clients must pass a client (§13.2). Transport failures are thrown, never
 * reported as an invalid signature.
 */
export async function verifySignature(parameters: {
  readonly signer: Address;
  readonly digest: Hex;
  readonly signature: Hex;
  readonly client?: SignatureClient;
}): Promise<SignatureVerification> {
  const { signer, client } = parameters;
  const code = client === undefined ? undefined : await client.getCode({ address: signer });
  return await verifySignatureWithCode({ ...parameters, code });
}

/**
 * `verifySignature` with the signer's code already read (`eth_getCode`; `undefined` or `0x` for none), so a caller
 * that also needs the code reads it once. Without a client only ECDSA can be checked (`codeChecked: false`).
 */
export async function verifySignatureWithCode(parameters: {
  readonly signer: Address;
  readonly digest: Hex;
  readonly signature: Hex;
  readonly client?: SignatureClient;
  readonly code: Hex | undefined;
}): Promise<SignatureVerification> {
  const { signer, digest, signature, client, code } = parameters;
  const hasCode = code !== undefined && code !== "0x";
  const delegated = hasCode && code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX);
  const codeChecked = client !== undefined;
  if (!hasCode || client === undefined) {
    const recovered = await recoverEcdsaSigner(digest, signature);
    if ("failure" in recovered) {
      return { valid: false, method: "ecdsa", codeChecked, delegated: false, failure: recovered.failure };
    }
    const valid = recovered.signer.toLowerCase() === signer.toLowerCase();
    return { valid, method: "ecdsa", codeChecked, delegated: false, failure: valid ? null : "wrong-signer" };
  }
  const data = encodeFunctionData({ abi: IS_VALID_SIGNATURE_ABI, functionName: "isValidSignature", args: [digest, signature] });
  try {
    const result = await client.call({ to: signer, data });
    const word = (result.data ?? "0x").toLowerCase();
    const valid = word.length >= 66 && word.slice(0, 66) === MAGIC_WORD;
    return { valid, method: "erc1271", codeChecked, delegated, failure: valid ? null : "erc1271-rejected" };
  } catch (error) {
    if (isRevertError(error)) {
      return { valid: false, method: "erc1271", codeChecked, delegated, failure: "erc1271-reverted" };
    }
    throw error;
  }
}

/**
 * Normalises an ECDSA signature from a signer that returns `v` in {0, 1} to {27, 28}, as issuers must
 * (§6.2). Any other signature (ERC-1271 bytes) is returned unchanged.
 */
export function normalizeEcdsaV(signature: Hex): Hex {
  const lower = signature.toLowerCase() as Hex;
  if (size(lower) !== ECDSA_SIGNATURE_LENGTH) {
    return lower;
  }
  const v = Number.parseInt(lower.slice(130, 132), 16);
  return v === 0 || v === 1 ? `0x${lower.slice(2, 130)}${(v + 27).toString(16)}` : lower;
}
