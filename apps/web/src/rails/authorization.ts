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
 *    finds the payment either way. The record is deleted only once that receipt is found.
 * 4. A stored authorisation the token reports used is a payment that went through (a relay the payer gave up on landed
 *    late, or another device sent it): its receipt is found, never a red error. The token emits EIP-3009
 *    `AuthorizationUsed(payer, nonce)` in the very transaction that settled it, and the nonce is bound to this invoice,
 *    payer, amount and salt (ADR 0003), so the search is exact: that event, inside the only blocks that could include
 *    the authorisation (stamped from its signature to its `validBefore`), in requests the chain's RPC accepts
 *    (`locateAuthorizedPayment`). AUSD on Monad testnet carries the event's topic in its code (checked from the sandbox
 *    on 2026-10-08), as FiatToken USDC does.
 */
import type { ChainDefinition, Erc20Token } from "@paylink/chains";
import {
  assessOutstanding,
  AUTHORIZATION_USED_EVENT,
  authorizePayment,
  DEFAULT_AUTHORIZATION_TTL_SECONDS,
  gasLimitFor,
  outstandingAuthorizationId,
  parseOutstandingAuthorization,
  readAuthorizationState,
  recordOutstandingAuthorization,
  resubmissionCall,
} from "@paylink/sdk";
import type { AuthorizationAssessment, CheckedOutstandingAuthorization } from "@paylink/sdk";
import { encodeEventTopics, pad } from "viem";
import type { Address, Hex, TransactionReceipt } from "viem";
import type { ChainClient } from "../core/clients.ts";
import { pollingIntervalFor } from "../core/clients.ts";
import { AppError } from "../core/errors.ts";
import { RelayerProblem } from "../core/relayer.ts";
import type { PaymentContext, PaymentOutcome, PaymentRail, RailEnv } from "./types.ts";
import { paidLogIndex } from "./wallet.ts";

/** How long the payer view follows a relayed payment before it says "still pending" (the authorisation is kept). */
export const SETTLEMENT_TIMEOUT_MS = 120_000;
/** `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`, EIP-3009. */
const AUTHORIZATION_USED_TOPIC = encodeEventTopics({ abi: [AUTHORIZATION_USED_EVENT], eventName: "AuthorizationUsed" })[0];

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

type Prepared =
  /** Send this authorisation (the stored one, or one just signed and stored). */
  | { readonly kind: "send"; readonly id: string; readonly checked: CheckedOutstandingAuthorization; readonly signedAt: number }
  /** The stored one was already used: this is the payment it made. */
  | { readonly kind: "settled"; readonly id: string; readonly receipt: TransactionReceipt };

/**
 * The authorisation to send: the stored one while it is live, else a new signature, persisted before it leaves. A
 * stored one the token reports used is the payment already made: its receipt, never a second signature.
 */
async function prepare(context: PaymentContext): Promise<Prepared> {
  const token = context.link.token;
  if (token.kind !== "erc20" || !token.capabilities.eip3009) {
    throw new AppError("pay.route.none", {}, "NoPaymentRoute");
  }
  const stored = await assessStored({ ...context, payer: context.account.address });
  if (stored.checked !== null && stored.assessment.state === "consumed") {
    const receipt = await locateAuthorizedPayment(context.client, context.chain, context.link, stored.checked);
    if (receipt === null) {
      throw new AppError("pay.error.consumed", {}, "AuthorizationUsed");
    }
    return { kind: "settled", id: stored.id, receipt };
  }
  if (stored.checked !== null && stored.assessment.state === "live") {
    const storedAmount = stored.checked.request.authorization.amount;
    if (storedAmount !== context.amount) {
      throw new AppError("pay.error.outstanding", { seconds: Number(stored.assessment.validBefore - context.now) }, "AuthorizationLive");
    }
    context.onStep({ kind: "resubmit" });
    return { kind: "send", id: stored.id, checked: stored.checked, signedAt: performance.now() };
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
  return { kind: "send", id: stored.id, checked: parseOutstandingAuthorization(record, context.registry), signedAt };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The transaction that used this authorisation, with the invoice's `Paid` log in it, or `null` when no block that
 * could include it has the token's `AuthorizationUsed(payer, nonce)` (yet). Only blocks stamped from the signature
 * (`validBefore` less the window this app signs for, or `validAfter` when later) up to `validBefore` can include it.
 * `after` narrows the search to blocks after a number already searched.
 */
export async function locateAuthorizedPayment(
  client: Pick<ChainClient, "getBlock" | "getBlockNumber" | "getLogs" | "getTransactionReceipt">,
  chain: Pick<ChainDefinition, "rpcLimits">,
  link: PaymentContext["link"],
  checked: CheckedOutstandingAuthorization,
  after: bigint | null = null,
): Promise<TransactionReceipt | null> {
  // Searching history is the rare path (a late relay): its module loads on first use, off the pay route's first load.
  const { findInWindow } = await import("../read/history.ts");
  const authorization = checked.request.authorization;
  const payer = authorization.payer;
  const signedFrom = authorization.validBefore - DEFAULT_AUTHORIZATION_TTL_SECONDS;
  const opens = authorization.validAfter > signedFrom ? authorization.validAfter : signedFrom;
  const filter = { address: checked.token.address, topics: [AUTHORIZATION_USED_TOPIC, pad(payer.toLowerCase() as Hex, { size: 32 }), checked.outstanding.nonce] };
  return await findInWindow(client, chain, filter, { opens, closes: authorization.validBefore, after }, async (log) => {
    if (log.transactionHash === null) {
      return null;
    }
    const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
    if (receipt.status !== "success") {
      return null;
    }
    try {
      paidLogIndex(receipt, { link, account: { address: payer } });
      return receipt;
    } catch {
      // Not a PayLink settlement of this invoice (the token alone cannot use a nonce bound to it): keep looking.
      return null;
    }
  });
}

/** A stored authorisation the token reports used, and the payment it made (invoice spec §8.6 "consumed"). */
export type ConsumedPayment =
  /** No stored authorisation for this payer and invoice, or one that is not used. */
  | { readonly state: "none" }
  /** Used: the payment it made, found on the chain. The stored record is deleted. */
  | { readonly state: "found"; readonly outcome: PaymentOutcome }
  /** Used, but no block of its window shows the payment yet (an RPC behind the head): the record is kept. */
  | { readonly state: "missing" };

/**
 * When the device holds an authorisation of `payer` for this invoice and the token reports it used, finds the payment
 * it made (a late relay, or a resubmission from elsewhere). Nothing is signed or sent.
 */
export async function recoverConsumedPayment(
  context: Pick<PaymentContext, "authorizations" | "registry" | "client" | "now" | "link" | "chain"> & { readonly payer: Address },
): Promise<ConsumedPayment> {
  const stored = await assessStored(context);
  if (stored.checked === null || stored.assessment.state !== "consumed") {
    return { state: "none" };
  }
  const receipt = await locateAuthorizedPayment(context.client, context.chain, context.link, stored.checked);
  if (receipt === null) {
    return { state: "missing" };
  }
  const logIndex = paidLogIndex(receipt, { link: context.link, account: { address: context.payer } });
  await context.authorizations.delete(stored.id);
  return { state: "found", outcome: { txHash: receipt.transactionHash, receipt, logIndex, elapsedMs: null } };
}

/**
 * Follows a submitted authorisation to its `Paid` receipt: the hash the relayer (or the wallet) gave first, then, once
 * the token reports the nonce used, the log itself (a replacement transaction has another hash).
 */
export async function waitForSettlement(context: PaymentContext, checked: CheckedOutstandingAuthorization, firstHash: Hex | null, timeoutMs = SETTLEMENT_TIMEOUT_MS): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  let hint = firstHash;
  const pause = pollingIntervalFor(context.chain);
  /** The last block already searched for the payment: the whole window once, then only newer blocks. */
  let searched: bigint | null = null;
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
        // Used, possibly long before this page asked (the relayer answers "already settled" for a relay it sent
        // earlier): the whole window the first time, then only blocks newer than those searched (an RPC behind).
        const head = await context.client.getBlockNumber().catch(() => null);
        let receipt: TransactionReceipt | null = null;
        let complete = false;
        try {
          receipt = await locateAuthorizedPayment(context.client, context.chain, context.link, checked, searched === null ? null : searched - 2n);
          complete = true;
        } catch {
          // An RPC hiccup: the same blocks are searched again next time.
        }
        if (receipt !== null) {
          return receipt;
        }
        if (complete && head !== null) {
          searched = head;
        }
      } else if (hint === null) {
        const head = await context.client.getBlock({ blockTag: "latest" }).catch(() => null);
        if (head !== null && head.timestamp >= checked.request.authorization.validBefore) {
          // Never used, and no block can include it any more: the payment did not happen (a new one may be signed).
          throw new AppError("pay.error.notSettled", {}, "AuthorizationLapsed");
        }
      }
    }
    if (Date.now() > deadline) {
      throw new AppError("pay.error.pending", {}, "SettlementPending");
    }
    await sleep(pause);
  }
}

function outcome(context: PaymentContext, receipt: TransactionReceipt, signedAt: number): PaymentOutcome {
  return { txHash: receipt.transactionHash, receipt, logIndex: paidLogIndex(receipt, context), elapsedMs: performance.now() - signedAt };
}

/** The payment a stored authorisation already made: its receipt is the outcome, and the record is done with. */
async function settledEarlier(context: PaymentContext, prepared: Extract<Prepared, { kind: "settled" }>): Promise<PaymentOutcome> {
  context.onStep({ kind: "mined", txHash: prepared.receipt.transactionHash });
  const result = { txHash: prepared.receipt.transactionHash, receipt: prepared.receipt, logIndex: paidLogIndex(prepared.receipt, context), elapsedMs: null };
  await context.authorizations.delete(prepared.id);
  return result;
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
      const prepared = await prepare(context);
      if (prepared.kind === "settled") {
        return await settledEarlier(context, prepared);
      }
      const { id, checked, signedAt } = prepared;
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
      const prepared = await prepare(context);
      if (prepared.kind === "settled") {
        return await settledEarlier(context, prepared);
      }
      const { id, checked, signedAt } = prepared;
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
