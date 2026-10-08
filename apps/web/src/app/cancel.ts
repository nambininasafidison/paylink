// SPDX-License-Identifier: MIT
/**
 * Cancelling an invoice (PAYLINK-V2-SPEC §2.1 T1 "Gasless cancel"): the payee signs the EIP-712
 * `Cancel(key, deadline)` (one fingerprint with a PayLink key, one signature in a wallet) and the relayer submits
 * `cancelBySig`, so a merchant who holds no gas coin can still close a link. Without a relayer for the chain (or when
 * it refuses), a payee who holds gas sends `cancel` themselves, with the registry's clamped gas limit.
 *
 * Either way the result is read from the chain (`stateOf(key).cancelled`), never taken from the relayer's answer.
 */
import { cancelCall, DEFAULT_CANCEL_TTL_SECONDS, gasLimitFor, readLinkState, signCancel, toCancelAuthorizationJson } from "@paylink/sdk";
import type { DecodedInvoiceLink } from "@paylink/sdk";
import type { AccountProvider } from "../accounts/types.ts";
import { chainTime, pollingIntervalFor } from "../core/clients.ts";
import type { ChainClient } from "../core/clients.ts";
import { AppError } from "../core/errors.ts";
import { RelayerProblem } from "../core/relayer.ts";
import type { App } from "./context.ts";

export type CancelStep = "sign" | "relayed" | "confirm" | "sent";

/** Waits until the chain reports the invoice cancelled. */
async function untilCancelled(client: ChainClient, link: DecodedInvoiceLink, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readLinkState(client, link.target.deployment.address, link.key).catch(() => null);
    if (state?.cancelled === true) {
      return;
    }
    if (Date.now() > deadline) {
      throw new AppError("ledger.cancel.pending", {});
    }
    await new Promise((resolve) => setTimeout(resolve, pollingIntervalFor(link.target.chain)));
  }
}

/** The payee's own `cancel` transaction (needs gas). */
async function cancelWithGas(app: App, link: DecodedInvoiceLink, account: AccountProvider, onStep: (step: CancelStep) => void): Promise<"transaction"> {
  const chain = link.target.chain;
  const client = app.client(chain);
  if ((await client.getBalance(account.address)) === 0n) {
    throw new AppError("ledger.cancel.noGas", { coin: chain.nativeCurrency.symbol });
  }
  await account.switchChain(chain);
  const call = cancelCall(link.target.deployment.address, link.invoice);
  const estimate = await client.estimateGas({ from: account.address, to: call.to, data: call.data, value: 0n });
  onStep("confirm");
  const txHash = await account.sendTransaction({ chainId: chain.chainId, to: call.to, data: call.data, value: 0n, gas: gasLimitFor(chain, "cancel", estimate) });
  onStep("sent");
  const receipt = await client.waitForReceipt(txHash);
  if (receipt.status !== "success") {
    throw new AppError("ledger.cancel.failed", {});
  }
  return "transaction";
}

/** Cancels `link` for its payee: gaslessly through the relayer when it serves the chain, else with gas. */
export async function cancelInvoice(app: App, link: DecodedInvoiceLink, account: AccountProvider, onStep: (step: CancelStep) => void): Promise<"relayed" | "transaction"> {
  const chain = link.target.chain;
  const client = app.client(chain);
  const availability = await app.relayer.availability(chain.chainId);
  if (availability.kind !== "up" || !availability.health.operations.cancel) {
    return await cancelWithGas(app, link, account, onStep);
  }
  const now = await chainTime(client);
  onStep("sign");
  const cancel = await signCancel({
    signer: account,
    deployment: { chainId: chain.chainId, verifyingContract: link.target.deployment.address },
    invoice: link.invoice,
    deadline: now + DEFAULT_CANCEL_TTL_SECONDS,
    client,
  });
  try {
    await app.relayer.cancel(toCancelAuthorizationJson(cancel));
  } catch (error) {
    if (error instanceof RelayerProblem && error.code === "already-cancelled") {
      return "relayed";
    }
    if (error instanceof RelayerProblem && error.fallback === "self-submit" && (await client.getBalance(account.address).catch(() => 0n)) > 0n) {
      return await cancelWithGas(app, link, account, onStep);
    }
    throw error instanceof RelayerProblem ? new AppError("ledger.cancel.relayer", { code: error.code }) : error;
  }
  onStep("relayed");
  await untilCancelled(client, link);
  return "relayed";
}
