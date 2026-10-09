// SPDX-License-Identifier: MIT
/**
 * The batch rail: EIP-5792 `wallet_sendCalls([approve, pay])` with `atomicRequired`, for payers whose account is a
 * smart account (PAYLINK-V2-SPEC §2.2 T1 "Pay with Base"; the PaymentRouter's `batched-approve-pay`). The approval is
 * for exactly the amount, and both calls land in one atomic batch, so no allowance is left behind and the payer
 * approves once.
 *
 * Smart accounts are payers only (spec §5 threat 12): an EIP-3009 signature from a smart account is checked through
 * ERC-1271 by the token, and an undeployed one cannot answer at all, so the router never offers them the gasless rail.
 *
 * The wallet reports the batch's transaction hashes; the `Paid` event and its receipt are then read from the registry
 * RPC (never trusted from the wallet) before the payer view says "Approved".
 */
import { approveCall, payCall } from "@paylink/sdk";
import { pollingIntervalFor } from "../core/clients.ts";
import { AppError } from "../core/errors.ts";
import type { PaymentRail } from "./types.ts";
import { paidLogIndex } from "./wallet.ts";

export function batchRail(): PaymentRail {
  return {
    id: "batch",
    paths: ["batched-approve-pay"],
    ready: () => Promise.resolve(true),
    async execute(path, context) {
      const { link, account } = context;
      if (path !== "batched-approve-pay" || account.sendCalls === undefined || link.token.kind !== "erc20") {
        throw new Error(`the batch rail does not execute ${path} for this account`);
      }
      const contract = link.target.deployment.address;
      const calls = [approveCall(link.token.address, contract, context.amount), payCall(contract, link.invoice, link.signature, context.amount, context.payerRef)];
      context.onStep({ kind: "batch" });
      const started = performance.now();
      const result = await account.sendCalls({ chainId: context.chain.chainId, calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value })) });
      if (result.status !== "confirmed") {
        throw new AppError("pay.error.batch", {}, "BatchIncomplete");
      }
      for (const txHash of [...result.txHashes].reverse()) {
        const receipt = await context.client.waitForReceipt(txHash, { pollingMs: pollingIntervalFor(context.chain), timeoutMs: 60_000 });
        if (receipt.status !== "success") {
          continue;
        }
        try {
          const logIndex = paidLogIndex(receipt, context);
          context.onStep({ kind: "mined", txHash });
          return { txHash, receipt, logIndex, elapsedMs: performance.now() - started };
        } catch {
          // Another transaction of the batch (a non-atomic wallet split it): look at the next one.
        }
      }
      throw new AppError("pay.error.batch", {}, "BatchIncomplete");
    },
  };
}
