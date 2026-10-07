// SPDX-License-Identifier: MIT
/** Error decoding to i18n keys (spec §3.6, §3.9, invoice spec §7.6). */
import { toViemChain, monadTestnet } from "@paylink/chains";
import {
  CallExecutionError,
  ChainMismatchError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  HttpRequestError,
  InsufficientFundsError,
  ProviderRpcError,
  RawContractError,
  RpcRequestError,
  TimeoutError,
  UserRejectedRequestError,
  WebSocketRequestError,
} from "viem";
import type { Abi, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { contractError, decodeError, decodeRevertData, ERROR_CODE_I18N_KEYS, PayLinkError, payLinkV2Abi, SDK_I18N_KEYS } from "../src/index.ts";
import { CONTRACT } from "./helpers.ts";

const solidityError = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }] as const satisfies Abi;
const reason = (text: string): Hex => encodeErrorResult({ abi: solidityError, errorName: "Error", args: [text] });
const soldOut = encodeErrorResult({ abi: payLinkV2Abi, errorName: "SoldOut", args: [1] });

describe("decodeRevertData", () => {
  it.each<[string, Hex, string, Record<string, string>]>([
    ["SoldOut(1)", soldOut, "error.contract.soldOut", { maxPayments: "1" }],
    ["WrongAmount", encodeErrorResult({ abi: payLinkV2Abi, errorName: "WrongAmount", args: [25n, 24n] }), "error.contract.wrongAmount", { expected: "25", sent: "24" }],
    ["Expired", encodeErrorResult({ abi: payLinkV2Abi, errorName: "Expired", args: [1791763200n] }), "error.contract.expired", { validUntil: "1791763200" }],
    ["InvalidSignature", encodeErrorResult({ abi: payLinkV2Abi, errorName: "InvalidSignature" }), "error.contract.invalidSignature", {}],
    ["SafeERC20FailedOperation", encodeErrorResult({ abi: payLinkV2Abi, errorName: "SafeERC20FailedOperation", args: [CONTRACT] }), "error.contract.tokenCallFailed", { token: CONTRACT }],
    ["StringTooLong (unreachable)", encodeErrorResult({ abi: payLinkV2Abi, errorName: "StringTooLong", args: ["x"] }), "error.contract.unexpected", { name: "StringTooLong" }],
  ])("%s", (_name, data, key, params) => {
    const decoded = decodeRevertData(data);
    expect([decoded.source, decoded.i18nKey, decoded.params, decoded.selector]).toEqual(["contract", key, params, data.slice(0, 10)]);
  });

  it.each([
    ["FiatTokenV2: invalid signature", "error.token.authorizationInvalid"],
    ["FiatTokenV2: authorization is used or canceled", "error.token.authorizationUsed"],
    ["FiatTokenV2: authorization is expired", "error.token.authorizationExpired"],
    ["FiatTokenV2: authorization is not yet valid", "error.token.authorizationNotYetValid"],
    ["FiatTokenV2: permit is expired", "error.token.permitExpired"],
    ["EIP2612: invalid signature", "error.token.permitInvalid"],
    ["ERC20: transfer amount exceeds balance", "error.token.insufficientBalance"],
    ["ERC20: transfer amount exceeds allowance", "error.token.insufficientAllowance"],
    ["ERC20: insufficient allowance", "error.token.insufficientAllowance"],
    ["Blacklistable: account is blacklisted", "error.token.accountBlocked"],
    ["Pausable: paused", "error.token.paused"],
    ["Something else", "error.token.reverted"],
  ])("maps the token revert string %j", (text, key) => {
    expect(decodeRevertData(reason(text))).toMatchObject({ source: "token", name: "Error", i18nKey: key, params: { reason: text } });
  });

  it("cleans untrusted revert strings (controls, bidi, length)", () => {
    const decoded = decodeRevertData(reason(`‮evil\u0000${"x".repeat(500)}`));
    expect(decoded.params["reason"]).toBe(`evil${"x".repeat(196)}`);
  });

  it("decodes panics, OpenZeppelin ERC-20 v5 errors, empty and unknown data", () => {
    const panic = encodeErrorResult({ abi: [{ type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] }], errorName: "Panic", args: [0x11n] });
    expect(decodeRevertData(panic)).toMatchObject({ source: "panic", i18nKey: "error.contract.panic", params: { code: "17" } });
    const tokenAbi = [
      { type: "error", name: "ERC20InsufficientBalance", inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] },
      { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ name: "spender", type: "address" }, { name: "allowance", type: "uint256" }, { name: "needed", type: "uint256" }] },
      { type: "error", name: "ERC2612ExpiredSignature", inputs: [{ name: "deadline", type: "uint256" }] },
      { type: "error", name: "ERC2612InvalidSigner", inputs: [{ name: "signer", type: "address" }, { name: "owner", type: "address" }] },
    ] as const satisfies Abi;
    expect(decodeRevertData(encodeErrorResult({ abi: tokenAbi, errorName: "ERC20InsufficientBalance", args: [CONTRACT, 1n, 2n] }))).toMatchObject({
      source: "token",
      i18nKey: "error.token.insufficientBalance",
      params: { sender: CONTRACT, balance: "1", needed: "2" },
    });
    expect(decodeRevertData(encodeErrorResult({ abi: tokenAbi, errorName: "ERC20InsufficientAllowance", args: [CONTRACT, 0n, 2n] })).i18nKey).toBe("error.token.insufficientAllowance");
    expect(decodeRevertData(encodeErrorResult({ abi: tokenAbi, errorName: "ERC2612ExpiredSignature", args: [5n] })).i18nKey).toBe("error.token.permitExpired");
    expect(decodeRevertData(encodeErrorResult({ abi: tokenAbi, errorName: "ERC2612InvalidSigner", args: [CONTRACT, CONTRACT] })).i18nKey).toBe("error.token.permitInvalid");
    expect(decodeRevertData("0x")).toMatchObject({ i18nKey: "error.contract.revertedWithoutReason", selector: null });
    expect(decodeRevertData("0x1234")).toMatchObject({ i18nKey: "error.contract.revertedWithoutReason" });
    expect(decodeRevertData("0xdeadbeef00")).toMatchObject({ source: "unknown", i18nKey: "error.unknown", params: { selector: "0xdeadbeef" } });
    expect(decodeRevertData("0x08c379a0ff")).toMatchObject({ source: "unknown", i18nKey: "error.unknown" });
  });
});

describe("decodeError", () => {
  const chain = toViemChain(monadTestnet);

  it("finds revert data through viem's error chains", () => {
    const reverted = new ContractFunctionRevertedError({ abi: payLinkV2Abi, data: soldOut, functionName: "pay" });
    const wrapped = new ContractFunctionExecutionError(reverted, { abi: payLinkV2Abi, functionName: "pay", args: [], contractAddress: CONTRACT });
    expect(decodeError(wrapped)).toMatchObject({ name: "SoldOut", i18nKey: "error.contract.soldOut" });
    const call = new CallExecutionError(new RawContractError({ data: soldOut }), { to: CONTRACT, data: "0x" });
    expect(decodeError(call).name).toBe("SoldOut");
    const rpc = new RpcRequestError({ body: {}, error: { code: 3, message: "execution reverted", data: reason("Pausable: paused") }, url: "https://rpc.example" });
    expect(decodeError(rpc).i18nKey).toBe("error.token.paused");
    const provider = new ProviderRpcError(new Error("execution reverted"), { code: 3, shortMessage: "execution reverted", data: soldOut });
    expect(decodeError(provider).name).toBe("SoldOut");
    expect(decodeError(soldOut).name).toBe("SoldOut");
  });

  it("maps wallet and network failures", () => {
    expect(decodeError(new UserRejectedRequestError(new Error("denied"))).i18nKey).toBe("error.wallet.rejected");
    expect(decodeError({ code: 4001, message: "User rejected the request." }).i18nKey).toBe("error.wallet.rejected");
    expect(decodeError(new ChainMismatchError({ chain, currentChainId: 1 })).i18nKey).toBe("error.wallet.wrongNetwork");
    expect(decodeError(new InsufficientFundsError()).i18nKey).toBe("error.wallet.insufficientFunds");
    expect(decodeError(new TimeoutError({ body: {}, url: "https://rpc.example" })).i18nKey).toBe("error.network.timeout");
    expect(decodeError(new HttpRequestError({ url: "https://rpc.example" })).i18nKey).toBe("error.network.unavailable");
    expect(decodeError(new WebSocketRequestError({ url: "wss://rpc.example" })).i18nKey).toBe("error.network.unavailable");
    expect(decodeError(new RpcRequestError({ body: {}, error: { code: -32005, message: "limit" }, url: "https://rpc.example" })).i18nKey).toBe("error.network.unavailable");
  });

  it("passes SDK errors through and maps anything else to error.unknown", () => {
    expect(decodeError(new PayLinkError("E_CHAIN_UNKNOWN", "x", { chainId: "1" }))).toEqual({
      source: "sdk",
      name: "E_CHAIN_UNKNOWN",
      selector: null,
      i18nKey: "error.link.chainUnknown",
      params: { chainId: "1" },
    });
    for (const value of [new Error("boom"), "not hex", 42, null, undefined, { code: 4002 }, new RawContractError({ data: "0x" })]) {
      expect(decodeError(value).i18nKey).toBe("error.unknown");
    }
  });

  it("builds predicted contract errors with the same keys", () => {
    expect(contractError("SoldOut", { maxPayments: "1" })).toEqual({ source: "contract", name: "SoldOut", selector: null, i18nKey: "error.contract.soldOut", params: { maxPayments: "1" } });
    expect(contractError("Nope").i18nKey).toBe("error.contract.unexpected");
  });
});

describe("i18n key catalogue", () => {
  it("lists every key once and covers every SDK error code", () => {
    expect(new Set(SDK_I18N_KEYS).size).toBe(SDK_I18N_KEYS.length);
    for (const key of Object.values(ERROR_CODE_I18N_KEYS)) {
      expect(SDK_I18N_KEYS).toContain(key);
    }
    for (const key of SDK_I18N_KEYS) {
      expect(key).toMatch(/^error\.[a-z]+(\.[A-Za-z0-9]+)?$/);
    }
  });
});
