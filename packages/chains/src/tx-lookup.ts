// SPDX-License-Identifier: MIT
/**
 * Lookups by hash on a chain whose public RPC answers `null` for mined transactions (`rpcLimits.inconsistentTxIndex`,
 * Mezo testnet: docs/research/mezo.md §2, ADR 0017).
 */
import type { ChainDefinition } from "./types.ts";

/**
 * Pauses, in milliseconds, before each extra attempt of a lookup by hash that came back `null`: eight attempts over
 * about 11 s. Measured on Mezo testnet, about one answer in two is a wrongful `null`, so all eight are `null` about once
 * in 250 checks of a mined transaction; a caller that holds proof the transaction is mined then says "could not
 * check", never "absent".
 */
export const TX_LOOKUP_RETRY_MS: readonly number[] = Object.freeze([250, 500, 1000, 1500, 2000, 2500, 3000]);

/** The pauses before each extra lookup of a transaction by hash on `chain`: none where a `null` is final. */
export function txLookupRetryMs(chain: Pick<ChainDefinition, "rpcLimits"> | undefined): readonly number[] {
  return chain?.rpcLimits.inconsistentTxIndex === true ? TX_LOOKUP_RETRY_MS : [];
}
