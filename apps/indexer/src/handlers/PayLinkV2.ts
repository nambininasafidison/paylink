// SPDX-License-Identifier: MIT
/**
 * PayLinkV2 event handlers (Envio HyperIndex 3, auto-loaded from src/handlers). Each one loads the entities its log
 * touches, hands them to the pure functions of `../ledger.ts`, and writes back the result. Only the canonical
 * deployments of config.yaml are indexed; nothing here calls out to the network. Block timestamp and transaction hash
 * come from config.yaml `field_selection` (one selection for the handlers and for the test indexer's simulated logs).
 */
import { indexer } from "envio";
import { applyCancelled, applyPaid, cancelledIds, paidIds } from "../ledger.ts";
import type { CancelledLog, PaidLog } from "../ledger.ts";

indexer.onEvent({ contract: "PayLinkV2", event: "Paid" }, async ({ event, context }) => {
  const log: PaidLog = {
    chainId: event.chainId,
    key: event.params.key,
    payee: event.params.payee,
    payer: event.params.payer,
    token: event.params.token,
    amount: event.params.amount,
    index: event.params.index,
    payerRef: event.params.payerRef,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
  };
  const id = paidIds(log);
  const [existing, invoice, payee, payeeToken, payerPayee, dailyVolume, dailyActivity] = await Promise.all([
    context.Payment.get(id.payment),
    context.Invoice.get(id.invoice),
    context.Payee.get(id.payee),
    context.PayeeToken.get(id.payeeToken),
    context.PayerPayee.get(id.payerPayee),
    context.DailyVolume.get(id.dailyVolume),
    context.DailyActivity.get(id.dailyActivity),
  ]);
  if (existing !== undefined) {
    return; // already applied (see ledger.ts): never count a payment twice
  }
  const next = applyPaid({ invoice, payee, payeeToken, payerPayee, dailyVolume, dailyActivity }, log);
  context.Payment.set(next.payment);
  context.Invoice.set(next.invoice);
  context.Payee.set(next.payee);
  context.PayeeToken.set(next.payeeToken);
  context.PayerPayee.set(next.payerPayee);
  context.DailyVolume.set(next.dailyVolume);
  context.DailyActivity.set(next.dailyActivity);
});

indexer.onEvent({ contract: "PayLinkV2", event: "InvoiceCancelled" }, async ({ event, context }) => {
  const log: CancelledLog = {
    chainId: event.chainId,
    key: event.params.key,
    payee: event.params.payee,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
  };
  const id = cancelledIds(log);
  const [invoice, payee, dailyActivity] = await Promise.all([context.Invoice.get(id.invoice), context.Payee.get(id.payee), context.DailyActivity.get(id.dailyActivity)]);
  const next = applyCancelled({ invoice, payee, dailyActivity }, log);
  if (next === null) {
    return;
  }
  context.Invoice.set(next.invoice);
  context.Payee.set(next.payee);
  context.DailyActivity.set(next.dailyActivity);
});
