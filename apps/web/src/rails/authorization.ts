// SPDX-License-Identifier: MIT
/**
 * The authorisation rails: the payer signs one EIP-3009 `ReceiveWithAuthorization` bound to the invoice (ADR 0003:
 * the token nonce is recomputed on-chain from key, payer, amount, reference and salt, so whoever submits it cannot
 * redirect it), and `payWithAuthorization` settles it.
 *
 * - `relayed-authorization`: the relayer submits it (apps/relayer); the payer holds no gas coin (spec §2.1, §2.2).
 * - `self-authorization`: the payer submits the very same authorisation with their own gas ("pay with your own gas").
 *
 * Retry safety (invoice spec §8.6) is enforced here, not left to the page:
 * 1. Before anything is signed, the device's stored authorisation for (chain, invoice, payer) is parsed against the
 *    registry and assessed on chain (`assessOutstanding`). Live: it is resubmitted, never re-signed. Consumed: the
 *    payment already went through. Cancelled or expired: a new one may be signed.
 * 2. A new authorisation is persisted (`recordOutstandingAuthorization`) before it is sent to anyone.
 * 3. Settlement is followed on the chain, not on the relayer's word: the relayer may replace its transaction (same
 *    nonce, higher fees), so the rail watches both the hash it was given and the token's `authorizationState`, and
 *    finds the `Paid(key, payee, payer)` log either way. The record is deleted only once that receipt is found.
 */
import type { Erc20Token } from "@paylink/chains";
import {
  assessOutstanding,
  authorizePayment,
  decodePaidLog,
  gasLimitFor,
  outstandingAuthorizationId,
  PAID_TOPIC,
  parseOutstandingAuthorization,
  readAuthorizationState,
  recordOutstandingAuthorization,
  resubmissionCall,
} from "@paylink/sdk";
import type { AuthorizationAssessment, CheckedOutstandingAuthorization } from "@paylink/sdk";
import { pad } from "viem";
import type { Hex, TransactionReceipt } from "viem";
import { pollingIntervalFor } from "../core/clients.ts";
import { AppError } from "../core/errors.ts";
import { RelayerProblem } from "../core/relayer.ts";
import type { PaymentContext, PaymentOutcome, PaymentRail, RailEnv } from "./types.ts";
import { paidLogIndex } from "./wallet.ts";

/** How long the payer view follows a relayed payment before it says "still pending" (the authorisation is kept). */
export const SETTLEMENT_TIMEOUT_MS = 120_000;
/** Blocks searched back for the `Paid` log once the token reports the authorisation used (Monad caps ranges at 100). */
const LOG_LOOKBACK = 90n;

/** A relayer refusal the payer can act on: `fallback` says whether paying with their own gas is the way out. */
export class RelayFallbackError extends Error {
  readonly problem: RelayerProblem;

  constructor(problem: RelayerProblem) {
    super(problem.message, { cause: problem });
    this.name = "RelayFallbackError";
    this.problem = problem;
  }
}

/** The stored authorisation for this payment and its state on chain, or `null` when the device holds none (or junk). */
export async function assessStored(
  context: Pick<PaymentContext, "authorizations" | "registry" | "client" | "now" | "link" | "chain"> & { readonly payer: `0x${string}` },
): Promise<{ readonly id: string; readonly checked: CheckedOutstandingAuthorization; readonly assessment: AuthorizationAssessment } | { readonly id: string; readonly checked: null; readonly assessment: null }> {
  const id = outstandingAuthorizationId({ chainId: context.chain.chainId, key: context.link.key, payer: context.payer });
  const stored = await context.authorizations.get(id);
  if (stored === undefined) {
    return { id, checked: null, assessment: null };
  }
  let checked: CheckedOutstandingAuthorization;
  try {
    checked = parseOutstandingAuthorization(stored, context.registry);
  } catch {
    // Tampered or from an older registry: it cannot be resubmitted safely, and it cannot redirect anything either.
    await context.authorizations.delete(id);
    return { id, checked: null, assessment: null };
  }
  if (checked.request.authorization.payer.toLowerCase() !== context.payer.toLowerCase() || checked.outstanding.key.toLowerCase() !== context.link.key.toLowerCase()) {
    await context.authorizations.delete(id);
    return { id, checked: null, assessment: null };
  }
  const assessment = await assessOutstanding({ client: context.client, checked, now: context.now });
  return { id, checked, assessment };
}

/** The authorisation to send: the stored one while it is live, else a new signature, persisted before it leaves. */
async function prepare(context: PaymentContext): Promise<{ readonly id: string; readonly checked: CheckedOutstandingAuthorization; readonly signedAt: number }> {
  const token = context.link.token;
  if (token.kind !== "erc20" || !token.capabilities.eip3009) {
    throw new AppError("pay.route.none", {});
  }
  const stored = await assessStored({ ...context, payer: context.account.address });
  if (stored.assessment?.state === "consumed") {
    throw new AppError("pay.error.consumed", {});
  }
  if (stored.checked !== null && stored.assessment.state === "live") {
    const storedAmount = stored.checked.request.authorization.amount;
    if (storedAmount !== context.amount) {
      throw new AppError("pay.error.outstanding", { seconds: Number(stored.assessment.validBefore - context.now) });
    }
    context.onStep({ kind: "resubmit" });
    return { id: stored.id, checked: stored.checked, signedAt: performance.now() };
  }
  context.onStep({ kind: "sign-authorization" });
  const payment = await authorizePayment({
    link: context.link,
    signer: context.account,
    now: context.now,
    outstanding: stored.assessment,
    amount: context.amount,
    payerRef: context.payerRef,
    client: context.client,
  });
  const signedAt = performance.now();
  const record = recordOutstandingAuthorization(context.link, payment);
  await context.authorizations.put(stored.id, record);
  return { id: stored.id, checked: parseOutstandingAuthorization(record, context.registry), signedAt };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The `Paid(key, payee, payer)` log of this payer for this invoice in recent blocks, with its receipt. */
async function findPaid(context: PaymentContext, fromBlock: bigint | null): Promise<TransactionReceipt | null> {
  const head = await context.client.getBlockNumber();
  const floor = head > LOG_LOOKBACK ? head - LOG_LOOKBACK : 0n;
  const start = fromBlock === null || fromBlock < floor ? floor : fromBlock;
  const payerTopic = pad(context.account.address.toLowerCase() as Hex, { size: 32 });
  const logs = await context.client.getLogs({ address: context.link.target.deployment.address, fromBlock: start, toBlock: head, topics: [PAID_TOPIC, context.link.key, null, payerTopic] });
  for (const log of [...logs].reverse()) {
    const event = log.transactionHash === null ? null : decodePaidLog({ address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex === null ? null : Number(log.logIndex) });
    if (event !== null && event.amount === context.amount && log.transactionHash !== null) {
      return await context.client.getTransactionReceipt({ hash: log.transactionHash });
    }
  }
  return null;
}

/**
 * Follows a submitted authorisation to its `Paid` receipt: the hash the relayer (or the wallet) gave first, then, once
 * the token reports the nonce used, the log itself (a replacement transaction has another hash).
 */
export async function waitForSettlement(context: PaymentContext, checked: CheckedOutstandingAuthorization, firstHash: Hex | null, timeoutMs = SETTLEMENT_TIMEOUT_MS): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  let hint = firstHash;
  const pause = pollingIntervalFor(context.chain);
  const startBlock = await context.client.getBlockNumber().catch(() => null);
  for (let round = 0; ; round += 1) {
    if (hint !== null) {
      try {
        const receipt = await context.client.getTransactionReceipt({ hash: hint });
        if (receipt.status === "success") {
          return receipt;
        }
        hint = null; // reverted: the authorisation may still land in another transaction, or be dead
      } catch {
        // Not mined yet (or replaced, or the RPC hiccuped): keep polling until the deadline.
      }
    }
    if (hint === null || round % 3 === 2) {
      const used = await readAuthorizationState({ client: context.client, token: (checked.token satisfies Erc20Token).address, payer: checked.request.authorization.payer, nonce: checked.outstanding.nonce }).catch(() => false);
      if (used) {
        const receipt = await findPaid(context, startBlock === null ? null : startBlock - 2n).catch(() => null);
        if (receipt !== null) {
          return receipt;
        }
      } else if (hint === null) {
        const head = await context.client.getBlock({ blockTag: "latest" }).catch(() => null);
        if (head !== null && head.timestamp >= checked.request.authorization.validBefore) {
          // Never used, and no block can include it any more: the payment did not happen (a new one may be signed).
          throw new AppError("pay.error.notSettled", {});
        }
      }
    }
    if (Date.now() > deadline) {
      throw new AppError("pay.error.pending", {});
    }
    await sleep(pause);
  }
}

function outcome(context: PaymentContext, receipt: TransactionReceipt, signedAt: number): PaymentOutcome {
  return { txHash: receipt.transactionHash, receipt, logIndex: paidLogIndex(receipt, context), elapsedMs: performance.now() - signedAt };
}

/** `relayed-authorization`: the relayer submits; the payer needs one signature and no gas. */
export function relayedAuthorizationRail(): PaymentRail {
  return {
    id: "relayer",
    paths: ["relayed-authorization"],
    async ready(chain, env: RailEnv) {
      const availability = await env.relayer.availability(chain.chainId);
      return availability.kind === "up" && availability.health.operations.pay;
    },
    async execute(path, context) {
      if (path !== "relayed-authorization") {
        throw new Error(`the relayer rail does not execute ${path}`);
      }
      const { id, checked, signedAt } = await prepare(context);
      let hint: Hex | null;
      try {
        const accepted = await context.relayer.pay(checked.outstanding.request);
        hint = accepted.txHash;
        context.onStep({ kind: "relayed", txHash: accepted.txHash });
      } catch (error) {
        if (error instanceof RelayerProblem && error.code === "already-settled") {
          // The authorisation was used: find the payment it made.
          hint = null;
        } else if (error instanceof RelayerProblem) {
          context.relayer.invalidate();
          throw new RelayFallbackError(error);
        } else {
          throw error;
        }
      }
      const receipt = await waitForSettlement(context, checked, hint);
      context.onStep({ kind: "mined", txHash: receipt.transactionHash });
      const result = outcome(context, receipt, signedAt);
      await context.authorizations.delete(id);
      return result;
    },
  };
}

/** `self-authorization`: the payer submits the same authorisation with their own gas. */
export function selfAuthorizationRail(): PaymentRail {
  return {
    id: "self-authorization",
    paths: ["self-authorization"],
    ready: () => Promise.resolve(true),
    async execute(path, context) {
      if (path !== "self-authorization") {
        throw new Error(`the self-authorization rail does not execute ${path}`);
      }
      const { id, checked, signedAt } = await prepare(context);
      const call = resubmissionCall(checked);
      context.onStep({ kind: "simulate" });
      const estimate = await context.client.estimateGas({ from: context.account.address, to: call.to, data: call.data, value: call.value });
      const gas = gasLimitFor(context.chain, "payWithAuthorization", estimate);
      context.onStep({ kind: "confirm" });
      const txHash = await context.account.sendTransaction({ chainId: context.chain.chainId, to: call.to, data: call.data, value: 0n, gas });
      context.onStep({ kind: "sent", txHash });
      const receipt = await waitForSettlement(context, checked, txHash);
      context.onStep({ kind: "mined", txHash: receipt.transactionHash });
      const result = outcome(context, receipt, signedAt);
      await context.authorizations.delete(id);
      return result;
    },
  };
}
