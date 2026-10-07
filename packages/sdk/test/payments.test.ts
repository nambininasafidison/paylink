// SPDX-License-Identifier: MIT
/** PaymentRouter (spec §3.5), gas limits (§3.3.6), the payability predicate (invoice spec §7.2) and amounts. */
import { baseSepolia, arc, mezoTestnet, monadTestnet } from "@paylink/chains";
import type { TokenCapabilities } from "@paylink/chains";
import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  clampGasLimit,
  convertDecimals,
  EMPTY_LINK_STATE,
  formatAmount,
  formatAmountLocale,
  gasBounds,
  gasLimitFor,
  isPayLinkError,
  linkStatus,
  MAX_UINT128,
  parseAmount,
  isDelegatedCode,
  payerAccountKind,
  predictPayment,
  selectPaymentPath,
} from "../src/index.ts";
import type { PaymentAttempt, PayLinkErrorCode } from "../src/index.ts";
import { CONTRACT, payee, payer, sampleInvoice, T0 } from "./helpers.ts";

const code = (run: () => unknown): PayLinkErrorCode | undefined => {
  try {
    run();
  } catch (error) {
    return isPayLinkError(error) ? error.code : undefined;
  }
  return undefined;
};

const caps = (eip3009: boolean, eip2612: boolean, native = false): TokenCapabilities => ({ eip3009, eip2612, native });

describe("selectPaymentPath (spec §3.5 table)", () => {
  it.each<[string, Parameters<typeof selectPaymentPath>[0], ReturnType<typeof selectPaymentPath>]>([
    [
      "3009 token, passkey payer, relayer healthy",
      { capabilities: caps(true, true), account: "passkey", relayerHealthy: true, outstanding: null },
      { available: true, path: "relayed-authorization", fallbacks: ["self-authorization", "permit", "approve-pay"], payerPaysGas: false, resubmit: null },
    ],
    [
      "same, relayer down",
      { capabilities: caps(true, true), account: "eoa", relayerHealthy: false, outstanding: null },
      { available: true, path: "self-authorization", fallbacks: ["permit", "approve-pay"], payerPaysGas: true, resubmit: null },
    ],
    [
      "2612 token (MUSD)",
      { capabilities: caps(false, true), account: "eoa", relayerHealthy: true, outstanding: null },
      { available: true, path: "permit", fallbacks: ["approve-pay"], payerPaysGas: true, resubmit: null },
    ],
    [
      "smart-account payer with EIP-5792",
      { capabilities: caps(true, true), account: "smart-account", supportsBatch: true, relayerHealthy: true, outstanding: null },
      { available: true, path: "batched-approve-pay", fallbacks: ["approve-pay"], payerPaysGas: true, resubmit: null },
    ],
    [
      "smart-account payer without batching",
      { capabilities: caps(true, true), account: "smart-account", relayerHealthy: true, outstanding: null },
      { available: true, path: "approve-pay", fallbacks: [], payerPaysGas: true, resubmit: null },
    ],
    ["anything else", { capabilities: caps(false, false), account: "eoa", relayerHealthy: true, outstanding: null }, { available: true, path: "approve-pay", fallbacks: [], payerPaysGas: true, resubmit: null }],
    ["native coin", { capabilities: caps(false, false, true), account: "eoa", relayerHealthy: true, outstanding: null }, { available: true, path: "native", fallbacks: [], payerPaysGas: true, resubmit: null }],
    [
      "passkey payer without gas, relayer healthy: gasless only",
      { capabilities: caps(true, true), account: "passkey", relayerHealthy: true, payerHasGas: false, outstanding: null },
      { available: true, path: "relayed-authorization", fallbacks: [], payerPaysGas: false, resubmit: null },
    ],
    [
      "passkey payer without gas, relayer down",
      { capabilities: caps(true, false), account: "passkey", relayerHealthy: false, payerHasGas: false, outstanding: null },
      { available: false, reason: "needs-gas", whenRelayerReturns: "relayed-authorization", resubmit: null },
    ],
    [
      "no gas and no 3009",
      { capabilities: caps(false, true), account: "eoa", relayerHealthy: true, payerHasGas: false, outstanding: null },
      { available: false, reason: "needs-gas", whenRelayerReturns: null, resubmit: null },
    ],
  ])("%s", (_name, input, route) => {
    expect(selectPaymentPath(input)).toEqual(route);
  });
});

describe("payerAccountKind (§8.3, audit finding A-03)", () => {
  it("treats any code, including an EIP-7702 designator, as a smart account", () => {
    const delegated = `0xef0100${"ab".repeat(20)}` as const;
    expect(payerAccountKind(undefined)).toBe("eoa");
    expect(payerAccountKind("0x")).toBe("eoa");
    expect(payerAccountKind("0x", { passkey: true })).toBe("passkey");
    expect(payerAccountKind(delegated)).toBe("smart-account");
    expect(payerAccountKind(delegated, { passkey: true })).toBe("smart-account");
    expect(payerAccountKind("0x6080604052")).toBe("smart-account");
    expect([isDelegatedCode(delegated), isDelegatedCode("0xEF0100AB"), isDelegatedCode("0x6080"), isDelegatedCode(undefined)]).toEqual([true, true, false, false]);
    // A delegated EOA is never routed to EIP-3009, relayed or not: the token would ask its delegate.
    const route = selectPaymentPath({ capabilities: caps(true, true), account: payerAccountKind(delegated), supportsBatch: true, relayerHealthy: true, outstanding: null });
    expect(route).toMatchObject({ path: "batched-approve-pay", fallbacks: ["approve-pay"] });
  });
});

describe("gas limits (spec §3.3.6)", () => {
  const bounds = { floor: 100_000n, ceiling: 150_000n };

  it("clamps estimate × 1.10 between floor and ceiling, rounding up", () => {
    expect(clampGasLimit(50_000n, bounds)).toBe(100_000n);
    expect(clampGasLimit(100_001n, bounds)).toBe(110_002n);
    expect(clampGasLimit(140_000n, bounds)).toBe(150_000n);
    expect(clampGasLimit(150_000n, bounds)).toBe(150_000n);
  });

  it("refuses an estimate above the ceiling instead of sending a certain out-of-gas", () => {
    try {
      clampGasLimit(150_001n, bounds);
      expect.unreachable();
    } catch (error) {
      expect(isPayLinkError(error, "E_GAS_ABOVE_CEILING") && error.params).toEqual({ estimate: "150001", ceiling: "150000" });
    }
    expect(code(() => clampGasLimit(0n, bounds))).toBe("E_INVALID_ARGUMENT");
    expect(code(() => clampGasLimit(1n, { floor: 2n, ceiling: 1n }))).toBe("E_INVALID_ARGUMENT");
  });

  it("uses the registry's bounds per chain and function", () => {
    // Monad: its own gas schedule (anvil MonadTen emulation); a first gasless payment needs ~223k gas there.
    expect(gasBounds(monadTestnet, "payWithAuthorization")).toEqual({ floor: 224_000n, ceiling: 336_000n });
    expect(gasLimitFor(monadTestnet, "payWithAuthorization", 223_327n)).toBe(245_660n);
    expect(gasBounds(baseSepolia, "payWithAuthorization")).toEqual({ floor: 143_000n, ceiling: 215_000n });
    expect(gasLimitFor(baseSepolia, "cancel", 40_000n)).toBe(54_000n);
    expect(gasLimitFor(mezoTestnet, "payWithPermit", 130_000n)).toBe(143_000n);
    expect(code(() => gasBounds(arc, "pay"))).toBe("E_INVALID_ARGUMENT");
  });
});

describe("predictPayment (invoice spec §7.2 order)", () => {
  const { invoice } = sampleInvoice();
  const base: PaymentAttempt = {
    invoice,
    verifyingContract: CONTRACT,
    state: EMPTY_LINK_STATE,
    now: T0 + 1n,
    fn: "payWithAuthorization",
    amount: invoice.amount,
    payer: payer.address,
    signatureValid: true,
  };
  const predict = (patch: Partial<PaymentAttempt>): string | null => predictPayment({ ...base, ...patch })?.name ?? null;

  it("predicts success and each error in the contract's order", () => {
    expect(predict({})).toBeNull();
    expect(predict({ invoice: { ...invoice, payee: zeroAddress }, signatureValid: false })).toBe("InvalidInvoice");
    expect(predict({ fn: "payNative", signatureValid: false })).toBe("WrongPaymentPath");
    expect(predict({ invoice: { ...invoice, token: zeroAddress }, fn: "pay" })).toBe("WrongPaymentPath");
    expect(predict({ state: { ...EMPTY_LINK_STATE, cancelled: true }, signatureValid: false })).toBe("Cancelled");
    expect(predict({ signatureValid: false, now: 0n })).toBe("InvalidSignature");
    expect(predict({ now: T0 - 1n })).toBe("NotYetValid");
    expect(predict({ now: invoice.validUntil + 1n })).toBe("Expired");
    expect(predict({ now: invoice.validUntil })).toBeNull();
    expect(predict({ state: { ...EMPTY_LINK_STATE, payments: 1 }, amount: 1n })).toBe("SoldOut");
    expect(predict({ amount: 1n, payer: payee.address })).toBe("WrongAmount");
    expect(predict({ payer: payee.address })).toBe("SelfPayment");
  });

  it("applies the open-amount and unlimited rules, and the native value cap first", () => {
    const open = { ...invoice, amount: 0n, maxPayments: 0, validUntil: 0n };
    expect(predict({ invoice: open, amount: 1n, now: 2n ** 60n, state: { ...EMPTY_LINK_STATE, payments: 99 } })).toBeNull();
    expect(predict({ invoice: open, amount: 0n })).toBe("WrongAmount");
    const native = { ...invoice, token: zeroAddress };
    const capped = predictPayment({ ...base, invoice: { ...native, payee: zeroAddress }, fn: "payNative", amount: MAX_UINT128 + 1n });
    expect([capped?.name, capped?.params]).toEqual(["WrongAmount", { expected: "25000000", sent: MAX_UINT128.toString() }]);
    expect(predict({ invoice: native, fn: "payNative" })).toBeNull();
  });

  it("names the lamp state (paid is presented as already paid)", () => {
    expect(linkStatus(invoice, EMPTY_LINK_STATE, T0)).toBe("payable");
    expect(linkStatus(invoice, { ...EMPTY_LINK_STATE, cancelled: true }, T0)).toBe("cancelled");
    expect(linkStatus(invoice, { ...EMPTY_LINK_STATE, payments: 1 }, T0)).toBe("paid");
    expect(linkStatus({ ...invoice, maxPayments: 2 }, { ...EMPTY_LINK_STATE, payments: 2 }, T0)).toBe("sold-out");
    expect(linkStatus(invoice, EMPTY_LINK_STATE, T0 - 1n)).toBe("not-yet-valid");
    expect(linkStatus(invoice, EMPTY_LINK_STATE, invoice.validUntil + 1n)).toBe("expired");
    expect(linkStatus({ ...invoice, validUntil: 0n, maxPayments: 0 }, { ...EMPTY_LINK_STATE, payments: 5 }, 2n ** 60n)).toBe("payable");
  });
});

describe("amounts", () => {
  it("parses strictly", () => {
    expect(parseAmount("25", 6)).toBe(25_000_000n);
    expect(parseAmount(" 25.5 ", 6)).toBe(25_500_000n);
    expect(parseAmount(".5", 6)).toBe(500_000n);
    expect(parseAmount("5.", 6)).toBe(5_000_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseAmount("25,50", 6, { decimalSeparator: "," })).toBe(25_500_000n);
    expect(parseAmount("7", 0)).toBe(7n);
    for (const bad of ["", ".", "-1", "+1", "1e6", "1 000", "1,000.5", "0x10", "١٢"]) {
      expect(code(() => parseAmount(bad, 6)), bad).toBe("E_AMOUNT_FORMAT");
    }
    expect(code(() => parseAmount("1.5", 6, { decimalSeparator: "," }))).toBe("E_AMOUNT_FORMAT");
    expect(code(() => parseAmount("0.0000001", 6))).toBe("E_AMOUNT_PRECISION");
    expect(code(() => parseAmount("340282366920938463463374607431768.211456", 6))).toBe("E_AMOUNT_RANGE");
    expect(code(() => parseAmount("1", 37))).toBe("E_INVALID_ARGUMENT");
    expect(code(() => parseAmount("1", 1.5))).toBe("E_INVALID_ARGUMENT");
  });

  it("formats exactly with a minimum of fraction digits", () => {
    expect(formatAmount(25_500_000n, 6)).toBe("25.50");
    expect(formatAmount(25_000_000n, 6)).toBe("25.00");
    expect(formatAmount(1n, 6)).toBe("0.000001");
    expect(formatAmount(1n, 18, { minFractionDigits: 0 })).toBe("0.000000000000000001");
    expect(formatAmount(10n ** 18n, 18, { minFractionDigits: 0 })).toBe("1");
    expect(formatAmount(7n, 0)).toBe("7");
    expect(formatAmount(MAX_UINT128, 6)).toBe("340282366920938463463374607431768.211455");
    expect(code(() => formatAmount(-1n, 6))).toBe("E_INVALID_ARGUMENT");
    expect(code(() => formatAmount(1n, 6, { minFractionDigits: -1 }))).toBe("E_INVALID_ARGUMENT");
  });

  it("formats in a locale without rounding", () => {
    expect(formatAmountLocale(1_234_567_500_000n, 6, "en-US")).toBe("1,234,567.50");
    expect(formatAmountLocale(1_234_567_500_000n, 6, "fr-FR").replace(/[\u202F\u00A0]/gu, " ")).toBe("1 234 567,50");
    expect(formatAmountLocale(1n, 18, "en-US")).toBe("0.000000000000000001");
    expect(formatAmountLocale(5n, 0, "en-US", { minFractionDigits: 2 })).toBe("5");
  });

  it("converts between 6 and 18 decimals exactly", () => {
    expect(convertDecimals(1_500_000n, 6, 18)).toBe(1_500_000_000_000_000_000n);
    expect(convertDecimals(1_500_000_000_000_000_000n, 18, 6)).toBe(1_500_000n);
    expect(convertDecimals(5n, 6, 6)).toBe(5n);
    expect(code(() => convertDecimals(1n, 18, 6))).toBe("E_AMOUNT_PRECISION");
    expect(code(() => convertDecimals(-1n, 6, 18))).toBe("E_INVALID_ARGUMENT");
  });
});
