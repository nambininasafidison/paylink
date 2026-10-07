// SPDX-License-Identifier: MIT
/**
 * Gas limits (PAYLINK-V2-SPEC §3.3.6): `gasLimit = clamp(eth_estimateGas × 1.10, floor, ceiling)` with the
 * per-function, per-chain bounds of `@paylink/chains`. Monad charges the gas **limit** (C), so limits are
 * explicit and tight, never a wallet default.
 *
 * One deliberate refinement of the clamp: an estimate **above** the ceiling is refused
 * (`E_GAS_ABOVE_CEILING`) instead of clamped, because sending with a limit below the estimate would only
 * buy a certain out-of-gas failure, paid in full on Monad. It signals a hostile ERC-1271 payee (threat 13)
 * or a ceiling that needs re-measuring on that chain.
 */
import type { ChainDefinition, GasBounds, PayLinkFunction } from "@paylink/chains";
import { assertArgument, PayLinkError } from "./errors.ts";

/** The 10 % estimate margin, as a fraction. */
export const GAS_ESTIMATE_MARGIN = { numerator: 110n, denominator: 100n } as const;

/** `clamp(ceil(estimate × 1.10), floor, ceiling)`; throws `E_GAS_ABOVE_CEILING` if the estimate exceeds the ceiling. */
export function clampGasLimit(estimate: bigint, bounds: GasBounds): bigint {
  assertArgument(estimate > 0n, "the gas estimate must be positive");
  assertArgument(bounds.floor > 0n && bounds.floor <= bounds.ceiling, "gas bounds must satisfy 0 < floor <= ceiling");
  if (estimate > bounds.ceiling) {
    throw new PayLinkError("E_GAS_ABOVE_CEILING", `estimate ${estimate} is above the ceiling ${bounds.ceiling}`, {
      estimate: estimate.toString(),
      ceiling: bounds.ceiling.toString(),
    });
  }
  const margin = (estimate * GAS_ESTIMATE_MARGIN.numerator + GAS_ESTIMATE_MARGIN.denominator - 1n) / GAS_ESTIMATE_MARGIN.denominator;
  return margin < bounds.floor ? bounds.floor : margin > bounds.ceiling ? bounds.ceiling : margin;
}

/** The registry's gas bounds for a function on a v2 chain. */
export function gasBounds(chain: ChainDefinition, fn: PayLinkFunction): GasBounds {
  if (chain.gas === null) {
    throw new PayLinkError("E_INVALID_ARGUMENT", `chain ${chain.chainId} has no PayLink v2 gas table`);
  }
  return chain.gas.limits[fn];
}

/** The gas limit to send for `fn` on `chain`, from an `eth_estimateGas` result. */
export function gasLimitFor(chain: ChainDefinition, fn: PayLinkFunction, estimate: bigint): bigint {
  return clampGasLimit(estimate, gasBounds(chain, fn));
}
