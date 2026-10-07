// SPDX-License-Identifier: MIT
/**
 * Maps anything a payment can fail with to an i18n key with named parameters (spec §3.6 "custom errors are
 * mapped to i18n keys", §3.9): PayLinkV2 custom errors (invoice spec §7.6), the OpenZeppelin errors that can
 * surface through it, token-side reverts bubbled up unchanged, panics, wallet rejections, transport failures
 * and the SDK's own errors. The raw error name stays available as a support code ("Error code SoldOut").
 *
 * Revert data and revert strings come from untrusted contracts: parameters are plain strings to be
 * rendered as text, never as markup.
 */
import {
  BaseError,
  ChainMismatchError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  HttpRequestError,
  InsufficientFundsError,
  isHex,
  ProviderRpcError,
  RawContractError,
  RpcRequestError,
  TimeoutError,
  UserRejectedRequestError,
  WebSocketRequestError,
} from "viem";
import type { Abi, Hex } from "viem";
import { isPayLinkError } from "./errors.ts";
import { payLinkV2Abi } from "./generated/paylink-v2-abi.ts";
import type { SdkI18nKey } from "./i18n-keys.ts";

/** Where an error came from. */
export type ErrorSource = "contract" | "token" | "panic" | "wallet" | "network" | "sdk" | "unknown";

export interface DecodedError {
  readonly source: ErrorSource;
  /** Error name, also the support code shown under the sentence ("SoldOut", "Error", "E_CHAIN_UNKNOWN"). */
  readonly name: string;
  /** 4-byte selector of the revert data, when there was revert data. */
  readonly selector: Hex | null;
  readonly i18nKey: SdkI18nKey;
  /** Named placeholders for the translated sentence. Untrusted when they come from revert data. */
  readonly params: Readonly<Record<string, string>>;
}

/** PayLinkV2 errors and their keys; parameter names are the error's argument names (§7.6). */
const CONTRACT_KEYS: Readonly<Record<string, SdkI18nKey>> = {
  InvalidInvoice: "error.contract.invalidInvoice",
  InvalidSignature: "error.contract.invalidSignature",
  SignatureExpired: "error.contract.signatureExpired",
  NotPayee: "error.contract.notPayee",
  Cancelled: "error.contract.cancelled",
  NotYetValid: "error.contract.notYetValid",
  Expired: "error.contract.expired",
  SoldOut: "error.contract.soldOut",
  WrongAmount: "error.contract.wrongAmount",
  WrongPaymentPath: "error.contract.wrongPaymentPath",
  SelfPayment: "error.contract.selfPayment",
  ReceivedMismatch: "error.contract.receivedMismatch",
  PayeeShortPaid: "error.contract.payeeShortPaid",
  BatchTooLarge: "error.contract.batchTooLarge",
  // OpenZeppelin 5.3.0 errors reachable through PayLinkV2.
  ReentrancyGuardReentrantCall: "error.contract.reentrancy",
  SafeERC20FailedOperation: "error.contract.tokenCallFailed",
  InsufficientBalance: "error.contract.insufficientNativeBalance",
  FailedCall: "error.contract.payeeRejectedNative",
  // Inherited from EIP712; unreachable after construction.
  InvalidShortString: "error.contract.unexpected",
  StringTooLong: "error.contract.unexpected",
};

/** OpenZeppelin ERC-20 v5 errors that tokens such as AUSD or MUSD may bubble up. */
const TOKEN_ABI = [
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  { type: "error", name: "ERC2612ExpiredSignature", inputs: [{ name: "deadline", type: "uint256" }] },
  {
    type: "error",
    name: "ERC2612InvalidSigner",
    inputs: [
      { name: "signer", type: "address" },
      { name: "owner", type: "address" },
    ],
  },
] as const satisfies Abi;

const TOKEN_ERROR_KEYS: Readonly<Record<string, SdkI18nKey>> = {
  ERC20InsufficientBalance: "error.token.insufficientBalance",
  ERC20InsufficientAllowance: "error.token.insufficientAllowance",
  ERC2612ExpiredSignature: "error.token.permitExpired",
  ERC2612InvalidSigner: "error.token.permitInvalid",
};

/** Revert strings of Circle FiatToken v2.x and classic OpenZeppelin ERC-20s, matched exactly. */
const TOKEN_REASON_KEYS: Readonly<Record<string, SdkI18nKey>> = {
  "FiatTokenV2: invalid signature": "error.token.authorizationInvalid",
  "FiatTokenV2: authorization is used or canceled": "error.token.authorizationUsed",
  "FiatTokenV2: authorization is expired": "error.token.authorizationExpired",
  "FiatTokenV2: authorization is not yet valid": "error.token.authorizationNotYetValid",
  "FiatTokenV2: permit is expired": "error.token.permitExpired",
  "EIP2612: invalid signature": "error.token.permitInvalid",
  "ERC20: transfer amount exceeds balance": "error.token.insufficientBalance",
  "ERC20: transfer amount exceeds allowance": "error.token.insufficientAllowance",
  "ERC20: insufficient allowance": "error.token.insufficientAllowance",
  "Blacklistable: account is blacklisted": "error.token.accountBlocked",
  "Pausable: paused": "error.token.paused",
};

const ERROR_STRING_SELECTOR = "0x08c379a0";
const PANIC_SELECTOR = "0x4e487b71";
const MAX_REASON_LENGTH = 200;

const stringify = (value: unknown): string => (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean" ? String(value) : typeof value === "string" ? value : JSON.stringify(value));

function namedParams(abi: Abi, errorName: string, args: readonly unknown[] | undefined): Record<string, string> {
  const item = abi.find((entry) => entry.type === "error" && entry.name === errorName);
  const params: Record<string, string> = {};
  if (item?.type === "error") {
    item.inputs.forEach((input, i) => {
      params[input.name ?? `arg${i}`] = stringify(args?.[i]);
    });
  }
  return params;
}

function tryDecode(abi: Abi, data: Hex): { errorName: string; args: readonly unknown[] | undefined } | null {
  try {
    const decoded = decodeErrorResult({ abi, data });
    return { errorName: decoded.errorName, args: decoded.args };
  } catch {
    return null;
  }
}

/** Untrusted revert text, cut to a sane length with control and bidi characters removed. */
function cleanReason(reason: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return reason.replace(/[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩‎‏؜]/gu, "").slice(0, MAX_REASON_LENGTH);
}

/**
 * A PayLinkV2 error by name, as the decoder would report it, for errors predicted off-chain
 * (`predictPayment`). `params` uses the error's argument names.
 */
export function contractError(name: string, params: Readonly<Record<string, string>> = {}): DecodedError {
  return { source: "contract", name, selector: null, i18nKey: CONTRACT_KEYS[name] ?? "error.contract.unexpected", params };
}

/** Decodes raw revert data (`0x` + selector + arguments) from PayLinkV2 or a token it called. */
export function decodeRevertData(data: Hex): DecodedError {
  if (data === "0x" || data.length < 10) {
    return { source: "contract", name: "Reverted", selector: null, i18nKey: "error.contract.revertedWithoutReason", params: {} };
  }
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  if (selector === ERROR_STRING_SELECTOR || selector === PANIC_SELECTOR) {
    const builtin = tryDecode([], data);
    if (builtin !== null && builtin.errorName === "Error") {
      const reason = cleanReason(stringify(builtin.args?.[0]));
      return { source: "token", name: "Error", selector, i18nKey: TOKEN_REASON_KEYS[reason] ?? "error.token.reverted", params: { reason } };
    }
    if (builtin !== null) {
      return { source: "panic", name: "Panic", selector, i18nKey: "error.contract.panic", params: { code: stringify(builtin.args?.[0]) } };
    }
  }
  const own = tryDecode(payLinkV2Abi, data);
  if (own !== null) {
    const i18nKey = CONTRACT_KEYS[own.errorName] ?? "error.contract.unexpected";
    const params = i18nKey === "error.contract.unexpected" ? { name: own.errorName } : namedParams(payLinkV2Abi, own.errorName, own.args);
    return { source: "contract", name: own.errorName, selector, i18nKey, params };
  }
  const token = tryDecode(TOKEN_ABI, data);
  if (token !== null) {
    const key = TOKEN_ERROR_KEYS[token.errorName] ?? "error.token.reverted";
    return { source: "token", name: token.errorName, selector, i18nKey: key, params: namedParams(TOKEN_ABI, token.errorName, token.args) };
  }
  return { source: "unknown", name: "Unknown", selector, i18nKey: "error.unknown", params: { selector } };
}

/**
 * Finds revert data in a viem error chain: `ContractFunctionRevertedError.raw`, `RawContractError.data`, or
 * the `data` of a JSON-RPC error (`execution reverted`, code 3). Other errors' `data` is not revert data, and
 * anything that is not a viem error has none.
 */
export function revertDataOf(error: unknown): Hex | null {
  if (!(error instanceof BaseError)) {
    return null;
  }
  let found: Hex | null = null;
  error.walk((e) => {
    const value =
      e instanceof ContractFunctionRevertedError
        ? e.raw
        : e instanceof RawContractError || e instanceof RpcRequestError || e instanceof ProviderRpcError
          ? (e.data as unknown)
          : undefined;
    if (found === null && typeof value === "string" && isHex(value) && value.length >= 10) {
      found = value;
    }
    return false;
  });
  return found;
}

function isUserRejection(error: unknown): boolean {
  if (error instanceof BaseError) {
    return error.walk((e) => e instanceof UserRejectedRequestError) !== null;
  }
  // A bare EIP-1193 provider error: { code: 4001 }.
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 4001;
}

/**
 * Decodes any error thrown while signing, simulating or sending a PayLink transaction, or by the SDK. Raw
 * revert data (`0x…`) is accepted too. Never throws.
 */
export function decodeError(error: unknown): DecodedError {
  if (typeof error === "string" && isHex(error)) {
    return decodeRevertData(error);
  }
  if (isPayLinkError(error)) {
    return { source: "sdk", name: error.code, selector: null, i18nKey: error.i18nKey, params: error.params };
  }
  if (isUserRejection(error)) {
    return { source: "wallet", name: "UserRejectedRequestError", selector: null, i18nKey: "error.wallet.rejected", params: {} };
  }
  if (error instanceof BaseError) {
    const data = revertDataOf(error);
    if (data !== null) {
      return decodeRevertData(data);
    }
    if (error.walk((e) => e instanceof ChainMismatchError) !== null) {
      return { source: "wallet", name: "ChainMismatchError", selector: null, i18nKey: "error.wallet.wrongNetwork", params: {} };
    }
    if (error.walk((e) => e instanceof InsufficientFundsError) !== null) {
      return { source: "wallet", name: "InsufficientFundsError", selector: null, i18nKey: "error.wallet.insufficientFunds", params: {} };
    }
    if (error.walk((e) => e instanceof TimeoutError) !== null) {
      return { source: "network", name: "TimeoutError", selector: null, i18nKey: "error.network.timeout", params: {} };
    }
    if (error.walk((e) => e instanceof HttpRequestError || e instanceof WebSocketRequestError || e instanceof RpcRequestError) !== null) {
      return { source: "network", name: "RequestError", selector: null, i18nKey: "error.network.unavailable", params: {} };
    }
  }
  return { source: "unknown", name: "Unknown", selector: null, i18nKey: "error.unknown", params: {} };
}
