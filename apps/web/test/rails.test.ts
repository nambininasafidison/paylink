// SPDX-License-Identifier: MIT
/**
 * The wallet rail (T0): exact-amount approve only when the allowance is short, every PayLink transaction simulated and
 * sent with the registry's clamped gas limit (Monad charges the limit), a mined revert replayed for its reason, and
 * the Paid event of this payer for this invoice located in the receipt.
 */
import { approveCall, gasLimitFor, payLinkV2Abi } from "@paylink/sdk";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, erc20Abi, RawContractError } from "viem";
import type { Hex, TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import type { AccountProvider, TransactionRequest } from "../src/accounts/types.ts";
import { paidLogIndex, TransactionRevertedError, walletRail } from "../src/rails/wallet.ts";
import type { PaymentContext, PaymentStep } from "../src/rails/types.ts";
import { CHAIN_ID, CONTRACT, fakeChain, issue, localChain, NOW, payer, TOKEN_ADDRESS } from "./helpers.ts";

const SOLD_OUT = encodeErrorResult({ abi: payLinkV2Abi, errorName: "SoldOut", args: [1] });
const TX = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

function paidLog(key: Hex, payee: Hex, from: Hex, amount: bigint, logIndex: number, address: Hex = CONTRACT) {
  return {
    address,
    topics: encodeEventTopics({ abi: payLinkV2Abi, eventName: "Paid", args: { key, payee, payer: from } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "bytes32" }], [TOKEN_ADDRESS, amount, 0, `0x${"00".repeat(32)}`]),
    logIndex,
    blockNumber: 101n,
    blockHash: TX(9),
    transactionHash: TX(1),
    transactionIndex: 0,
    removed: false,
  };
}

function receipt(hash: Hex, status: "success" | "reverted", logs: unknown[] = []): TransactionReceipt {
  return { transactionHash: hash, status, blockNumber: 101n, logs } as unknown as TransactionReceipt;
}

function account(sent: TransactionRequest[], hashes: Hex[]): AccountProvider {
  return {
    connector: { id: "dev.paylink.test", name: "Test", icon: null, layer: "eip6963" },
    kind: "injected",
    address: payer.address,
    chainId: () => Promise.resolve(CHAIN_ID),
    switchChain: () => Promise.resolve(),
    signTypedData: (typed) => payer.signTypedData(typed),
    sendTransaction: (request) => {
      sent.push(request);
      const hash = hashes.shift();
      return hash === undefined ? Promise.reject(new Error("unexpected transaction")) : Promise.resolve(hash);
    },
    onChange: () => () => undefined,
  };
}

async function context(options: { allowance?: bigint; receipts: Map<Hex, TransactionReceipt>; hashes: Hex[]; estimate?: bigint }) {
  const { link } = await issue();
  const fake = fakeChain();
  fake.allowances.set(`${payer.address.toLowerCase()}:${CONTRACT.toLowerCase()}`, options.allowance ?? 0n);
  const sent: TransactionRequest[] = [];
  const steps: PaymentStep["kind"][] = [];
  const client = {
    ...fake.client,
    estimateGas: () => Promise.resolve(options.estimate ?? 120_000n),
    waitForReceipt: (hash: Hex) => {
      const found = options.receipts.get(hash);
      return found === undefined ? Promise.reject(new Error(`no receipt for ${hash}`)) : Promise.resolve(found);
    },
    call: async (p: Parameters<typeof fake.client.call>[0]) => {
      if (p.blockNumber !== undefined) {
        // The replay of a mined revert: SoldOut(1).
        throw new RawContractError({ data: SOLD_OUT });
      }
      return await fake.client.call(p);
    },
  };
  const ctx: PaymentContext = {
    link,
    chain: localChain(),
    account: account(sent, options.hashes),
    client,
    amount: link.invoice.amount,
    payerRef: `0x${"00".repeat(32)}`,
    now: NOW,
    onStep: (step) => steps.push(step.kind),
  };
  return { ctx, sent, steps, link };
}

describe("wallet rail", () => {
  it("pays straight away when the allowance covers the amount, with the clamped gas limit", async () => {
    const receipts = new Map<Hex, TransactionReceipt>();
    const { ctx, sent, steps, link } = await context({ allowance: 25_500_000n, receipts, hashes: [TX(1)] });
    receipts.set(TX(1), receipt(TX(1), "success", [paidLog(`0x${"77".repeat(32)}`, link.invoice.payee, payer.address, 1n, 0), paidLog(link.key, link.invoice.payee, payer.address, link.invoice.amount, 4)]));
    const outcome = await walletRail().execute("approve-pay", ctx);
    expect(outcome.logIndex).toBe(4);
    expect(outcome.txHash).toBe(TX(1));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.gas).toBe(gasLimitFor(localChain(), "pay", 120_000n));
    expect(sent[0]?.to).toBe(CONTRACT);
    expect(decodeFunctionData({ abi: payLinkV2Abi, data: sent[0]?.data ?? "0x" }).functionName).toBe("pay");
    expect(steps).toEqual(["simulate", "confirm", "sent", "mined"]);
  });

  it("approves exactly the amount first when the allowance is short, never more", async () => {
    const receipts = new Map<Hex, TransactionReceipt>();
    const { ctx, sent, steps, link } = await context({ allowance: 1n, receipts, hashes: [TX(2), TX(3)], estimate: 50_001n });
    receipts.set(TX(2), receipt(TX(2), "success"));
    receipts.set(TX(3), receipt(TX(3), "success", [paidLog(link.key, link.invoice.payee, payer.address, link.invoice.amount, 1)]));
    await walletRail().execute("approve-pay", ctx);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.to).toBe(TOKEN_ADDRESS);
    expect(sent[0]?.data).toBe(approveCall(TOKEN_ADDRESS, CONTRACT, link.invoice.amount).data);
    const approve = decodeFunctionData({ abi: erc20Abi, data: sent[0]?.data ?? "0x" });
    expect(approve.args).toEqual([CONTRACT, 25_500_000n]);
    // ceil(50,001 × 1.10) = 55,002: approve is not a PayLink function, so it has a margin but no registry bounds.
    expect(sent[0]?.gas).toBe(55_002n);
    expect(steps).toEqual(["approve", "approve-sent", "simulate", "confirm", "sent", "mined"]);
  });

  it("replays a mined revert to name it", async () => {
    const receipts = new Map<Hex, TransactionReceipt>();
    const { ctx } = await context({ allowance: 25_500_000n, receipts, hashes: [TX(4)] });
    receipts.set(TX(4), receipt(TX(4), "reverted"));
    const error = await walletRail().execute("approve-pay", ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionRevertedError);
    expect((error as TransactionRevertedError).txHash).toBe(TX(4));
    expect((error as TransactionRevertedError).revertData).toBe(SOLD_OUT);
  });

  it("refuses paths it cannot carry out", async () => {
    const { ctx } = await context({ receipts: new Map(), hashes: [] });
    for (const path of ["relayed-authorization", "self-authorization", "batched-approve-pay"] as const) {
      await expect(walletRail().execute(path, ctx)).rejects.toThrow(/does not execute/);
    }
    expect(walletRail().paths).toEqual(["permit", "approve-pay", "native"]);
    expect(await walletRail().ready(localChain())).toBe(true);
  });

  it("finds only this payer's Paid event for this invoice on the canonical contract", async () => {
    const { ctx, link } = await context({ receipts: new Map(), hashes: [] });
    const other = "0x0000000000000000000000000000000000000bad" as const;
    const logs = [paidLog(link.key, link.invoice.payee, other, 1n, 0), paidLog(link.key, link.invoice.payee, payer.address, 1n, 1, other), paidLog(link.key, link.invoice.payee, payer.address, 1n, 2)];
    expect(paidLogIndex(receipt(TX(5), "success", logs), ctx)).toBe(2);
    expect(() => paidLogIndex(receipt(TX(6), "success", logs.slice(0, 2)), ctx)).toThrow(/no Paid event/);
  });
});
