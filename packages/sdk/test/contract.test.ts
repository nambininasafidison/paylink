// SPDX-License-Identifier: MIT
/**
 * Deployment integrity against the real release runtime code (test/fixtures, captured from anvil by
 * scripts/capture-runtime-fixture.sh), state reads, and the calldata of every entry point.
 */
import { readFileSync } from "node:fs";
import { RELEASE } from "@paylink/chains";
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, hexToBytes, keccak256, toFunctionSelector, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  approveCall,
  cancelBySigCall,
  cancelCall,
  erc20ApproveAbi,
  expectedImmutables,
  isPayLinkError,
  maskedRuntimeHash,
  maskRuntimeCode,
  payCall,
  payLinkV2Abi,
  payNativeCall,
  payWithAuthorizationCall,
  payWithPermitCall,
  readImmutables,
  readLinkState,
  readLinkStates,
  STATES_OF_MAX_BATCH,
  verifyDeploymentCode,
  ZERO_HASH,
} from "../src/index.ts";
import type { Authorization, LinkState } from "../src/index.ts";
import { CONTRACT, payer, sampleInvoice, T0, TOKEN } from "./helpers.ts";
import { mockClient } from "./mock-client.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/paylinkv2-runtime-31337.json", import.meta.url), "utf8")) as {
  chainId: number;
  address: Address;
  runtimeCode: Hex;
  eip712DomainReturnData: Hex;
};
const EIP712_DOMAIN = toFunctionSelector("eip712Domain()");

describe("deployment integrity (ARCHITECTURE §6)", () => {
  const live = (code: Hex | undefined, domain: Hex = fixture.eip712DomainReturnData) =>
    mockClient({ code: code === undefined ? {} : { [fixture.address.toLowerCase()]: code }, answers: { [EIP712_DOMAIN]: domain } });

  it("the release's masked runtime hash matches the deployed code", () => {
    expect(maskedRuntimeHash(fixture.runtimeCode, RELEASE.immutableReferences)).toBe(RELEASE.maskedRuntimeHash);
    expect(keccak256(fixture.runtimeCode)).not.toBe(RELEASE.maskedRuntimeHash);
    expect(hexToBytes(maskRuntimeCode(fixture.runtimeCode, RELEASE.immutableReferences)).length).toBe(
      RELEASE.runtimeCodeSize - (hexToBytes(RELEASE.cborMetadata).length),
    );
  });

  it("the seven immutables are the ones recomputed from (chainId, address)", () => {
    expect(readImmutables(fixture.runtimeCode, RELEASE.immutableReferences)).toEqual(expectedImmutables(fixture.chainId, fixture.address));
    expect(expectedImmutables(10143, fixture.address)).not.toEqual(expectedImmutables(fixture.chainId, fixture.address));
  });

  it("accepts the genuine deployment", async () => {
    expect(await verifyDeploymentCode({ client: live(fixture.runtimeCode), chainId: fixture.chainId, address: fixture.address })).toEqual({ genuine: true });
  });

  it("refuses no code, other code, copied code and a wrong domain", async () => {
    const check = (client: ReturnType<typeof live>, chainId = fixture.chainId, address = fixture.address) => verifyDeploymentCode({ client, chainId, address });
    expect(await check(live(undefined))).toEqual({ genuine: false, failure: "no-code" });
    expect(await check(live("0x"))).toEqual({ genuine: false, failure: "no-code" });
    const patched = concat(["0x00", `0x${fixture.runtimeCode.slice(4)}`]);
    expect(await check(live(patched))).toEqual({ genuine: false, failure: "masked-hash" });
    expect(await check(live("0x6080604052"))).toEqual({ genuine: false, failure: "masked-hash" });
    // Genuine code copied to another chain: the cached chain ID and domain separator give it away.
    expect(await check(live(fixture.runtimeCode), 10143)).toEqual({ genuine: false, failure: "immutables" });
    const wrongDomain = encodeAbiParameters(
      [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
      ["0x0f", "PayLink", "1", BigInt(fixture.chainId), fixture.address, ZERO_HASH, []],
    );
    expect(await check(live(fixture.runtimeCode, wrongDomain))).toEqual({ genuine: false, failure: "domain" });
  });

  it("validates its inputs", () => {
    expect(() => maskRuntimeCode("0x00", [{ start: 0, length: 32 }])).toThrow(/outside the code/);
    expect(() => maskRuntimeCode("0x00", [])).toThrow(/too short/);
    expect(() => maskRuntimeCode("0x00ff", [])).toThrow(/CBOR metadata length/);
    expect(maskRuntimeCode("0xaabb0000", [])).toBe("0xaabb");
  });
});

describe("state reads", () => {
  const STATE_OF = toFunctionSelector("stateOf(bytes32)");
  const STATES_OF = toFunctionSelector("statesOf(bytes32[])");
  const state = (i: number): LinkState => ({ payments: i, cancelled: i % 2 === 1, lastPaidAt: BigInt(i) * 10n, total: BigInt(i) * 1000n });

  it("reads one state", async () => {
    const client = mockClient({ answers: { [STATE_OF]: encodeFunctionResult({ abi: payLinkV2Abi, functionName: "stateOf", result: state(3) }) } });
    expect(await readLinkState(client, CONTRACT, ZERO_HASH)).toEqual(state(3));
  });

  it("batches statesOf by 256 keys, in order", async () => {
    const keys = Array.from({ length: 600 }, (_, i): Hex => `0x${i.toString(16).padStart(64, "0")}`);
    const client = mockClient({
      answers: {
        [STATES_OF]: (data) => {
          const { args } = decodeFunctionData({ abi: payLinkV2Abi, data });
          const batch = args[0] as readonly Hex[];
          return encodeFunctionResult({ abi: payLinkV2Abi, functionName: "statesOf", result: batch.map((k) => state(Number(BigInt(k)))) });
        },
      },
    });
    const states = await readLinkStates(client, CONTRACT, keys);
    expect(states).toHaveLength(600);
    expect(states[599]).toEqual(state(599));
    expect(client.calls.map((c) => c.to)).toEqual([CONTRACT, CONTRACT, CONTRACT]);
    expect(STATES_OF_MAX_BATCH).toBe(256);
    expect(await readLinkStates(client, CONTRACT, [])).toEqual([]);
  });

  it("refuses a node that returns the wrong number of states", async () => {
    const client = mockClient({ answers: { [STATES_OF]: encodeFunctionResult({ abi: payLinkV2Abi, functionName: "statesOf", result: [] }) } });
    await expect(readLinkStates(client, CONTRACT, [ZERO_HASH])).rejects.toThrow(/returned 0 states for 1 keys/);
  });
});

describe("call builders", () => {
  const { invoice } = sampleInvoice();
  const sig: Hex = `0x${"aa".repeat(65)}`;
  const authorization: Authorization = {
    payer: payer.address,
    amount: invoice.amount,
    payerRef: ZERO_HASH,
    validAfter: 0n,
    validBefore: T0,
    payerSalt: `0x${"01".repeat(32)}`,
    v: 27,
    r: `0x${"02".repeat(32)}`,
    s: `0x${"03".repeat(32)}`,
  };
  const decode = (data: Hex) => decodeFunctionData({ abi: payLinkV2Abi, data });

  it("encodes each entry point with value only for payNative", () => {
    const relayed = payWithAuthorizationCall(CONTRACT, invoice, sig, authorization);
    expect([relayed.to, relayed.value, relayed.data.slice(0, 10)]).toEqual([CONTRACT, 0n, "0xa4c514ef"]);
    expect(decode(relayed.data).args).toEqual([invoice, sig, authorization]);
    const pay = payCall(CONTRACT, invoice, sig, invoice.amount);
    expect(decode(pay.data)).toMatchObject({ functionName: "pay", args: [invoice, sig, invoice.amount, ZERO_HASH] });
    const permit = { deadline: T0, v: 28, r: authorization.r, s: authorization.s };
    expect(decode(payWithPermitCall(CONTRACT, invoice, sig, 1n, permit, `0x${"09".repeat(32)}`).data).args).toEqual([invoice, sig, 1n, `0x${"09".repeat(32)}`, permit]);
    const native = payNativeCall(CONTRACT, { ...invoice, token: zeroAddress }, sig, 5n);
    expect([native.value, decode(native.data).functionName]).toEqual([5n, "payNative"]);
    expect(decode(cancelCall(CONTRACT, invoice).data)).toMatchObject({ functionName: "cancel", args: [invoice] });
    expect(decode(cancelBySigCall(CONTRACT, { chainId: 1, invoice, deadline: T0, signature: sig }).data)).toMatchObject({ functionName: "cancelBySig", args: [invoice, T0, sig] });
  });

  it("approves exactly the payment amount, never unlimited or zero", () => {
    const approve = approveCall(TOKEN, CONTRACT, 25n);
    expect(approve.to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: erc20ApproveAbi, data: approve.data }).args).toEqual([CONTRACT, 25n]);
    for (const run of [() => approveCall(TOKEN, CONTRACT, 0n), () => payNativeCall(CONTRACT, invoice, sig, 0n)]) {
      try {
        run();
        expect.unreachable();
      } catch (error) {
        expect(isPayLinkError(error, "E_INVALID_ARGUMENT")).toBe(true);
      }
    }
  });
});
