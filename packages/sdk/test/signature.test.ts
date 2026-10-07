// SPDX-License-Identifier: MIT
/** Payee-signature verification with the contract's dispatch (invoice spec §6, OpenZeppelin SignatureChecker). */
import { concat, ExecutionRevertedError, HttpRequestError, keccak256, numberToHex, RawContractError, sliceHex, stringToHex, toFunctionSelector } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ERC1271_MAGIC_VALUE, isRevertError, normalizeEcdsaV, parseEcdsaSignature, recoverEcdsaSigner, SECP256K1_HALF_ORDER, verifySignature } from "../src/index.ts";
import { payee, payer } from "./helpers.ts";
import { mockClient } from "./mock-client.ts";

const digest = keccak256(stringToHex("PayLink test digest"));
const IS_VALID = toFunctionSelector("isValidSignature(bytes32,bytes)");
const MAGIC = concat([ERC1271_MAGIC_VALUE, `0x${"00".repeat(28)}`]);
const wallet = "0x8464135c8F25Da09e49BC8782676a84730C318bC";
const signature = await payee.sign({ hash: digest });

/** The same signature with `s` replaced by n − s and `v` flipped: the malleable twin. */
function highS(sig: Hex): Hex {
  const s = BigInt(sliceHex(sig, 32, 64));
  const v = Number.parseInt(sig.slice(130), 16);
  const n = SECP256K1_HALF_ORDER * 2n + 1n;
  return concat([sliceHex(sig, 0, 32), numberToHex(n - s, { size: 32 }), numberToHex(v === 27 ? 28 : 27, { size: 1 })]);
}

describe("ECDSA as OpenZeppelin accepts it", () => {
  it("parses r, s, v of a 65-byte low-s signature", () => {
    const parsed = parseEcdsaSignature(signature);
    expect(parsed.ok && [parsed.r, parsed.s, parsed.v]).toEqual([sliceHex(signature, 0, 32), sliceHex(signature, 32, 64), Number.parseInt(signature.slice(130), 16)]);
  });

  it.each<[string, Hex, "malformed" | "high-s"]>([
    ["64-byte compact (EIP-2098)", sliceHex(signature, 0, 64), "malformed"],
    ["66 bytes", concat([signature, "0x00"]), "malformed"],
    ["v = 0", concat([sliceHex(signature, 0, 64), "0x00"]), "malformed"],
    ["v = 29", concat([sliceHex(signature, 0, 64), "0x1d"]), "malformed"],
    ["uppercase hex", signature.toUpperCase().replace("0X", "0x") as Hex, "malformed"],
    ["high s", highS(signature), "high-s"],
  ])("refuses %s", async (_name, sig, failure) => {
    expect(parseEcdsaSignature(sig)).toEqual({ ok: false, failure });
    expect(await recoverEcdsaSigner(digest, sig)).toEqual({ failure });
  });

  it("refuses an r that is not on the curve", async () => {
    const offCurve = concat([`0x${"00".repeat(32)}`, sliceHex(signature, 32, 65)]);
    expect(await recoverEcdsaSigner(digest, offCurve)).toEqual({ failure: "malformed" });
  });

  it("normalises v from {0, 1} to {27, 28} and leaves other signatures alone", () => {
    const parsed = parseEcdsaSignature(signature);
    if (!parsed.ok) {
      throw new Error("valid");
    }
    const raw = concat([parsed.r, parsed.s, numberToHex(parsed.v - 27, { size: 1 })]);
    expect(raw.slice(130)).toMatch(/^0[01]$/);
    expect(normalizeEcdsaV(raw)).toBe(signature);
    expect(normalizeEcdsaV(signature.toUpperCase().replace("0X", "0x") as Hex)).toBe(signature);
    expect(normalizeEcdsaV("0xABCD")).toBe("0xabcd");
  });
});

describe("verifySignature: the contract's dispatch", () => {
  it("offline: ECDSA only, and says the code was not checked", async () => {
    expect(await verifySignature({ signer: payee.address, digest, signature })).toEqual({
      valid: true,
      method: "ecdsa",
      codeChecked: false,
      delegated: false,
      failure: null,
    });
    expect(await verifySignature({ signer: payer.address, digest, signature })).toMatchObject({ valid: false, failure: "wrong-signer" });
    expect(await verifySignature({ signer: payee.address, digest, signature: highS(signature) })).toMatchObject({ valid: false, failure: "high-s" });
  });

  it("EOA (no code): ECDSA, code checked", async () => {
    const client = mockClient({});
    expect(await verifySignature({ signer: payee.address, digest, signature, client })).toMatchObject({ valid: true, method: "ecdsa", codeChecked: true });
    const empty = mockClient({ code: { [payee.address.toLowerCase()]: "0x" } });
    expect((await verifySignature({ signer: payee.address, digest, signature, client: empty })).method).toBe("ecdsa");
  });

  it("contract (code): ERC-1271 only, even for a valid ECDSA signature of the owner", async () => {
    const accepts = mockClient({ code: { [wallet.toLowerCase()]: "0x6080" }, answers: { [IS_VALID]: MAGIC } });
    expect(await verifySignature({ signer: wallet, digest, signature: "0x01", client: accepts })).toMatchObject({
      valid: true,
      method: "erc1271",
      delegated: false,
    });
    expect(accepts.calls[0]?.to).toBe(wallet);
    const rejects = mockClient({ code: { [wallet.toLowerCase()]: "0x6080" }, answers: { [IS_VALID]: `0x${"00".repeat(32)}` } });
    expect(await verifySignature({ signer: wallet, digest, signature, client: rejects })).toMatchObject({ valid: false, failure: "erc1271-rejected" });
    const short = mockClient({ code: { [wallet.toLowerCase()]: "0x6080" }, answers: { [IS_VALID]: ERC1271_MAGIC_VALUE } });
    expect((await verifySignature({ signer: wallet, digest, signature, client: short })).failure).toBe("erc1271-rejected");
    const empty = mockClient({ code: { [wallet.toLowerCase()]: "0x6080" } });
    expect((await verifySignature({ signer: wallet, digest, signature, client: empty })).failure).toBe("erc1271-rejected");
  });

  it("ERC-1271 reverts are an invalid signature; transport failures are thrown", async () => {
    for (const error of [new RawContractError({ data: "0x" }), new ExecutionRevertedError()]) {
      const reverts = mockClient({ code: { [wallet.toLowerCase()]: "0x6080" }, answers: { [IS_VALID]: error } });
      expect(await verifySignature({ signer: wallet, digest, signature, client: reverts })).toMatchObject({ valid: false, failure: "erc1271-reverted" });
    }
    const down = mockClient({ code: { [wallet.toLowerCase()]: "0x6080" }, answers: { [IS_VALID]: new HttpRequestError({ url: "https://rpc.example" }) } });
    await expect(verifySignature({ signer: wallet, digest, signature, client: down })).rejects.toBeInstanceOf(HttpRequestError);
    expect(isRevertError(new Error("plain"))).toBe(false);
  });

  it("EIP-7702 delegated EOA: verified through the delegate's ERC-1271 and flagged", async () => {
    const delegated = mockClient({ code: { [payee.address.toLowerCase()]: `0xef0100${"ab".repeat(20)}` }, answers: { [IS_VALID]: `0x${"00".repeat(32)}` } });
    expect(await verifySignature({ signer: payee.address, digest, signature, client: delegated })).toEqual({
      valid: false,
      method: "erc1271",
      codeChecked: true,
      delegated: true,
      failure: "erc1271-rejected",
    });
  });
});
