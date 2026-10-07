// SPDX-License-Identifier: MIT
/** Receipt verification (invoice spec §12) against forged and borrowed receipts (threat T-43) and the till rule (§13.4, T-44). */
import { concat, encodeAbiParameters, HttpRequestError, pad, TransactionReceiptNotFoundError, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { createReceiptVerifier, decodePaidLog, invoiceKey, isPaymentForArmedInvoice, PAID_TOPIC, verifyReceipt } from "../src/index.ts";
import type { LogLike, ReceiptClient, ReceiptLike, ReceiptVerification } from "../src/index.ts";
import { CHAIN_ID, CONTRACT, payee, payer, registry, signedSample, TOKEN } from "./helpers.ts";

const signed = await signedSample();
const key = invoiceKey({ chainId: CHAIN_ID, verifyingContract: CONTRACT }, signed.invoice);
const txHash: Hex = `0x${"ab".repeat(32)}`;

function paidLog(overrides: Partial<{ address: Address; key: Hex; payee: Address; payer: Address; token: Address; amount: bigint; index: number; logIndex: number; topics: Hex[]; data: Hex }> = {}): LogLike {
  const data =
    overrides.data ??
    encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "bytes32" }], [
      overrides.token ?? TOKEN,
      overrides.amount ?? 25_000_000n,
      overrides.index ?? 0,
      `0x${"00".repeat(31)}01`,
    ]);
  return {
    address: overrides.address ?? CONTRACT,
    topics: overrides.topics ?? [PAID_TOPIC, overrides.key ?? key, pad(overrides.payee ?? payee.address), pad(overrides.payer ?? payer.address)],
    data,
    logIndex: overrides.logIndex ?? 4,
  };
}

function client(receipt: ReceiptLike | Error, finalized: bigint | null | Error = 200n): ReceiptClient {
  return {
    getTransactionReceipt: () => (receipt instanceof Error ? Promise.reject(receipt) : Promise.resolve(receipt)),
    getBlock: (parameters) => {
      if ("blockTag" in parameters) {
        return finalized instanceof Error ? Promise.reject(finalized) : Promise.resolve({ number: finalized, timestamp: 0n });
      }
      return Promise.resolve({ number: parameters.blockNumber, timestamp: 1_791_158_500n });
    },
  };
}

const receiptWith = (...logs: LogLike[]): ReceiptLike => ({ status: "success", blockNumber: 150n, logs: [paidLog({ logIndex: 0, address: TOKEN }), ...logs] });
const verify = (receipt: ReceiptLike | Error, options: { finalized?: bigint | null | Error; withInvoice?: boolean; logIndex?: number; chainId?: number } = {}): Promise<ReceiptVerification> =>
  verifyReceipt({
    registry,
    client: client(receipt, options.finalized === undefined ? 200n : options.finalized),
    reference: { chainId: options.chainId ?? CHAIN_ID, txHash, logIndex: options.logIndex ?? 4 },
    ...(options.withInvoice === true ? { paid: signed } : {}),
  });

describe("verifyReceipt", () => {
  it("proves the payee, payer, token, amount, key and finality of a genuine payment", async () => {
    const result = await verify(receiptWith(paidLog()), { withInvoice: true });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.proof).toMatchObject({
        chainId: CHAIN_ID,
        txHash,
        logIndex: 4,
        contract: CONTRACT,
        key,
        payee: payee.address,
        payer: payer.address,
        token: TOKEN,
        amount: 25_000_000n,
        index: 0,
        payerRef: `0x${"00".repeat(31)}01`,
        blockNumber: 150n,
        timestamp: 1_791_158_500n,
        finality: "finalized",
        memo: signed.memo,
      });
      expect(result.proof.tokenInfo.symbol).toBe("USDC");
      expect(result.proof.invoice).toEqual(signed.invoice);
    }
  });

  it("reports confirmed (not finalized) above the finalized block or without the tag", async () => {
    for (const finalized of [100n, null, new Error("unsupported block tag")]) {
      const result = await verify(receiptWith(paidLog()), { finalized });
      expect(result.valid && result.proof.finality).toBe("confirmed");
    }
  });

  it.each<[string, () => Promise<ReceiptVerification>, string, Record<string, string>?]>([
    ["an unknown chain", () => verify(receiptWith(paidLog()), { chainId: 10143 }), "chain-unknown", { chainId: "10143" }],
    ["a missing receipt", () => verify(new TransactionReceiptNotFoundError({ hash: txHash })), "not-found"],
    ["a reverted transaction", () => verify({ ...receiptWith(paidLog()), status: "reverted" }), "transaction-reverted"],
    ["a missing log index", () => verify(receiptWith(paidLog()), { logIndex: 9 }), "log-not-found"],
    ["a look-alike contract", () => verify(receiptWith(paidLog({ address: "0x8464135c8F25Da09e49BC8782676a84730C318bC" }))), "wrong-contract"],
    ["another event", () => verify(receiptWith(paidLog({ topics: [`0x${"11".repeat(32)}`, key, pad(payee.address), pad(payer.address)] }))), "not-paid-event"],
    ["three topics", () => verify(receiptWith(paidLog({ topics: [PAID_TOPIC, key, pad(payee.address)] }))), "malformed-log"],
    ["a dirty address topic", () => verify(receiptWith(paidLog({ topics: [PAID_TOPIC, key, `0x01${pad(payee.address).slice(4)}`, pad(payer.address)] }))), "malformed-log"],
    ["129 bytes of data", () => verify(receiptWith(paidLog({ data: concat([paidLog().data, "0x00"]) }))), "malformed-log"],
    ["a dirty token word", () => verify(receiptWith(paidLog({ data: `0x01${paidLog().data.slice(4)}` }))), "malformed-log"],
    ["a dirty amount word", () => verify(receiptWith(paidLog({ data: `0x${paidLog().data.slice(2, 66)}01${paidLog().data.slice(68)}` }))), "malformed-log"],
    ["a dirty index word", () => verify(receiptWith(paidLog({ data: `0x${paidLog().data.slice(2, 130)}01${paidLog().data.slice(132)}` }))), "malformed-log"],
    ["a token off the allowlist (O-3)", () => verify(receiptWith(paidLog({ token: "0x8464135c8F25Da09e49BC8782676a84730C318bC" }))), "token-not-allowlisted"],
    ["another invoice", () => verify(receiptWith(paidLog({ key: `0x${"22".repeat(32)}` })), { withInvoice: true }), "invoice-mismatch", { field: "key" }],
  ])("refuses %s", async (_name, run, failure, params) => {
    const result = await run();
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.failure).toBe(failure);
      expect(result.i18nKey).toMatch(/^error\.receipt\./);
      if (params !== undefined) {
        expect(result.params).toEqual(params);
      }
    }
  });

  it("throws transport failures instead of calling the receipt invalid", async () => {
    await expect(verify(new HttpRequestError({ url: "https://rpc.example" }))).rejects.toBeInstanceOf(HttpRequestError);
  });

  it("checks every field of a supplied invoice against the event", async () => {
    const mismatch = async (paid: typeof signed, log = paidLog()): Promise<string | undefined> => {
      const result = await verifyReceipt({ registry, client: client(receiptWith(log)), reference: { chainId: CHAIN_ID, txHash, logIndex: 4 }, paid });
      return result.valid ? undefined : result.params["field"];
    };
    expect(await mismatch({ ...signed, chainId: 1 })).toBe("chain");
    const otherPayee = { ...signed.invoice, payee: payer.address };
    expect(await mismatch({ ...signed, invoice: otherPayee }, paidLog({ key: invoiceKey({ chainId: CHAIN_ID, verifyingContract: CONTRACT }, otherPayee) }))).toBe("payee");
    const native = { ...signed.invoice, token: zeroAddress };
    expect(await mismatch({ ...signed, invoice: native }, paidLog({ key: invoiceKey({ chainId: CHAIN_ID, verifyingContract: CONTRACT }, native) }))).toBe("token");
    expect(await mismatch(signed, paidLog({ amount: 1n }))).toBe("amount");
    expect(await mismatch({ ...signed, memo: "tampered" })).toBe("memo");
    const open = { ...signed.invoice, amount: 0n };
    expect(await mismatch({ ...signed, invoice: open }, paidLog({ amount: 1n, key: invoiceKey({ chainId: CHAIN_ID, verifyingContract: CONTRACT }, open) }))).toBeUndefined();
    expect(await mismatch({ ...signed, memo: null })).toBeUndefined();
  });
});

describe("decodePaidLog", () => {
  it("decodes a strict Paid log and refuses a bad key topic", () => {
    expect(decodePaidLog(paidLog())).toMatchObject({ key, amount: 25_000_000n, index: 0, logIndex: 4 });
    expect(decodePaidLog(paidLog({ topics: [PAID_TOPIC, "0x12", pad(payee.address), pad(payer.address)] }))).toBeNull();
    expect(decodePaidLog({ ...paidLog(), topics: [] })).toBeNull();
  });
});

describe("createReceiptVerifier and the till rule", () => {
  it("verifies through a client per chain", async () => {
    const asked: number[] = [];
    const verifier = createReceiptVerifier({
      registry,
      clientFor: (chainId) => {
        asked.push(chainId);
        return client(receiptWith(paidLog()));
      },
    });
    expect((await verifier.verify({ chainId: CHAIN_ID, txHash, logIndex: 4 })).valid).toBe(true);
    expect((await verifier.verify({ chainId: CHAIN_ID, txHash, logIndex: 4 }, signed)).valid).toBe(true);
    expect(asked).toEqual([CHAIN_ID, CHAIN_ID]);
  });

  it("lights only for the armed key and, for fixed invoices, the exact amount (T-44)", async () => {
    const result = await verify(receiptWith(paidLog()));
    if (!result.valid) {
      throw new Error("valid receipt expected");
    }
    expect(isPaymentForArmedInvoice(result.proof, { key, invoice: signed.invoice })).toBe(true);
    expect(isPaymentForArmedInvoice(result.proof, { key: `0x${"33".repeat(32)}`, invoice: signed.invoice })).toBe(false);
    expect(isPaymentForArmedInvoice({ ...result.proof, amount: 1n }, { key, invoice: signed.invoice })).toBe(false);
    expect(isPaymentForArmedInvoice({ ...result.proof, amount: 1n }, { key, invoice: { ...signed.invoice, amount: 0n } })).toBe(true);
  });
});
