// SPDX-License-Identifier: MIT
/**
 * The Mezo edition's chain client: Mezo testnet's RPC answers `null` to a lookup by hash for a mined transaction about
 * one time in two (`rpcLimits.inconsistentTxIndex`, docs/research/mezo.md §2, ADR 0017), so on such a chain a receipt
 * lookup is asked again on the registry's schedule (`txLookupRetryMs`: eight lookups over about 11 s) before it says
 * "not found". `verifyReceipt` then answers "not-found" only after every lookup; `waitForReceipt` polls on its own.
 *
 * boot.ts wraps every client with it behind the build-time edition constant, so no other edition carries it.
 */
import type { ChainDefinition } from "@paylink/chains";
import { txLookupRetryMs } from "@paylink/chains";
import { withReceiptRetries } from "@paylink/sdk";
import type { ChainClient } from "../../core/clients.ts";

const patient = new WeakMap<ChainClient, ChainClient>();

/** `client` for `chain`, asking again for receipts the chain's RPC answers `null` for; `client` itself elsewhere. */
export function mezoClient(chain: ChainDefinition, client: ChainClient): ChainClient {
  if (chain.rpcLimits.inconsistentTxIndex !== true) {
    return client;
  }
  let wrapped = patient.get(client);
  if (wrapped === undefined) {
    wrapped = withReceiptRetries(client, txLookupRetryMs(chain));
    patient.set(client, wrapped);
  }
  return wrapped;
}
