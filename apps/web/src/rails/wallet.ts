// SPDX-License-Identifier: MIT
/**
 * The wallet rail: the payer sends the settlement transaction from their own wallet (tier T0, PAYLINK-V2-SPEC §2.1 and
 * §2.2: `pay` / `payWithPermit` with an injected wallet).
 *
 * - `permit`: one EIP-2612 signature for exactly the amount, PayLinkV2 as spender, then one `payWithPermit` transaction.
 * - `approve-pay`: an exact-amount `approve` (skipped when the allowance already covers it), then `pay`. Never an
 *   unlimited allowance (invoice spec §13.2).
 * - `native`: `payNative` with the amount as value.
 *
 * Every PayLink transaction is simulated by `eth_estimateGas` first and sent with an explicit gas limit,
 * `clamp(estimate × 1.10, floor, ceiling)` from the registry (spec §3.3.6; Monad charges the limit). A transaction that
 * reverts anyway is replayed at its block to recover the revert reason.
 */
import type { Erc20Token, PayLinkFunction } from "@paylink/chains";
import { approveCall, decodePaidLog, gasLimitFor, payCall, payNativeCall, preparePermitPayment, replayRevertData } from "@paylink/sdk";
import type { CallRequest } from "@paylink/sdk";
import type { Address, Hex, TransactionReceipt } from "viem";
import { pollingIntervalFor } from "../core/clients.ts";
import type { ChainClient } from "../core/clients.ts";
import type { PaymentContext, PaymentOutcome, PaymentRail } from "./types.ts";

/** Permit validity: long enough to read the wallet prompt, short enough to stay a one-payment permit. */
export const PERMIT_TTL_SECONDS = 20n * 60n;
/** Margin on approve's own estimate (approve is not a PayLink function, so it has no registry bounds). */
const APPROVE_MARGIN = { numerator: 110n, denominator: 100n } as const;

/** A settlement transaction that was mined but reverted; `revertData` is what the replay at its block returned. */
export class TransactionRevertedError extends Error {
  readonly txHash: Hex;
  readonly revertData: Hex | null;

  constructor(txHash: Hex, revertData: Hex | null) {
    super(`transaction ${txHash} reverted`);
    this.name = "TransactionRevertedError";
    this.txHash = txHash;
    this.revertData = revertData;
  }
}

async function waitFor(context: PaymentContext, txHash: Hex, call: CallRequest, gas: bigint): Promise<TransactionReceipt> {
  const receipt = await context.client.waitForReceipt(txHash, { pollingMs: pollingIntervalFor(context.chain) });
  if (receipt.status !== "success") {
    const revertData = await replayRevertData({ client: context.client, from: context.account.address, call, gas, blockNumber: receipt.blockNumber }).catch(() => null);
    throw new TransactionRevertedError(txHash, revertData);
  }
  return receipt;
}

async function estimate(client: ChainClient, from: `0x${string}`, call: CallRequest): Promise<bigint> {
  return await client.estimateGas({ from, to: call.to, data: call.data, value: call.value });
}

/** The block-level index of the `Paid` event this payer's transaction emitted for this invoice. */
export function paidLogIndex(receipt: Pick<TransactionReceipt, "logs">, context: Pick<PaymentContext, "link"> & { readonly account: { readonly address: Address } }): number {
  const contract = context.link.target.deployment.address.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract) {
      continue;
    }
    const event = decodePaidLog(log);
    if (event !== null && event.key === context.link.key.toLowerCase() && event.payer.toLowerCase() === context.account.address.toLowerCase()) {
      return event.logIndex ?? log.logIndex;
    }
  }
  throw new Error("the transaction emitted no Paid event for this invoice");
}

async function settle(context: PaymentContext, fn: PayLinkFunction, call: CallRequest): Promise<PaymentOutcome> {
  context.onStep({ kind: "simulate" });
  const gas = gasLimitFor(context.chain, fn, await estimate(context.client, context.account.address, call));
  context.onStep({ kind: "confirm" });
  const txHash = await context.account.sendTransaction({ chainId: context.chain.chainId, to: call.to, data: call.data, value: call.value, gas });
  const started = performance.now();
  context.onStep({ kind: "sent", txHash });
  const receipt = await waitFor(context, txHash, call, gas);
  const elapsedMs = performance.now() - started;
  context.onStep({ kind: "mined", txHash });
  return { txHash, receipt, logIndex: paidLogIndex(receipt, context), elapsedMs };
}

async function ensureAllowance(context: PaymentContext, token: Erc20Token): Promise<void> {
  const spender = context.link.target.deployment.address;
  const allowance = await context.client.erc20(token.address, "allowance", [context.account.address, spender]);
  if (allowance >= context.amount) {
    return;
  }
  context.onStep({ kind: "approve" });
  const call = approveCall(token.address, spender, context.amount);
  const estimated = await estimate(context.client, context.account.address, call);
  const gas = (estimated * APPROVE_MARGIN.numerator + APPROVE_MARGIN.denominator - 1n) / APPROVE_MARGIN.denominator;
  const txHash = await context.account.sendTransaction({ chainId: context.chain.chainId, to: call.to, data: call.data, value: 0n, gas });
  context.onStep({ kind: "approve-sent", txHash });
  await waitFor(context, txHash, call, gas);
}

export function walletRail(): PaymentRail {
  return {
    id: "wallet",
    paths: ["permit", "approve-pay", "native"],
    ready: () => Promise.resolve(true),
    async execute(path, context) {
      const { link } = context;
      const contract = link.target.deployment.address;
      switch (path) {
        case "permit": {
          context.onStep({ kind: "sign-permit" });
          const prepared = await preparePermitPayment({
            link,
            signer: context.account,
            client: context.client,
            deadline: context.now + PERMIT_TTL_SECONDS,
            amount: context.amount,
            payerRef: context.payerRef,
          });
          return await settle(context, "payWithPermit", prepared.call);
        }
        case "approve-pay": {
          if (link.token.kind !== "erc20") {
            throw new Error("approve-pay needs an ERC-20 token");
          }
          await ensureAllowance(context, link.token);
          return await settle(context, "pay", payCall(contract, link.invoice, link.signature, context.amount, context.payerRef));
        }
        case "native":
          return await settle(context, "payNative", payNativeCall(contract, link.invoice, link.signature, context.amount, context.payerRef));
        case "relayed-authorization":
        case "self-authorization":
        case "batched-approve-pay":
          throw new Error(`the wallet rail does not execute ${path}`);
      }
    },
  };
}
