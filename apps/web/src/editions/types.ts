// SPDX-License-Identifier: MIT
/**
 * Editions (ADR 0008): one product, one contract, several builds. Exactly three things vary between editions, and each
 * is an extension point here:
 *
 *   1. the account layer: who signs (`AccountLayer`: Mera passkeys only in the Monad edition; EIP-6963 injected
 *      wallets elsewhere, with EIP-5792 batches for smart-account payers in the Base edition);
 *   2. the default token: which allowlisted token the create terminal preselects on each chain;
 *   3. the payment rail: how a payment reaches the chain (`PaymentRail`: the gasless relayer, the payer's own
 *      submission of the same authorisation, an EIP-5792 batch, or the payer's wallet).
 *
 * Everything else (registry, SDK, design, routes) is shared. An edition is chosen at build time with
 * `VITE_EDITION`, so code for the other editions is tree-shaken away.
 */
import type { ChainDefinition, Edition, Token } from "@paylink/chains";
import type { AccountLayer } from "../accounts/types.ts";
import type { PaymentRail } from "../rails/types.ts";

export type Route = "create" | "pay" | "receipt" | "ledger" | "send" | "till" | "status";

export interface EditionProfile {
  readonly id: Edition;
  /** Path prefix the edition is served under ("/" for `all`, "/monad/", "/base/"). */
  readonly base: string;
  /** Engraved tag next to the wordmark. */
  readonly tag: string;
  /** Extension point 1: account layers offered, in order. */
  readonly accountLayers: readonly AccountLayer[];
  /** Extension point 2: the token preselected on a chain (must be on the chain's allowlist and listed). */
  defaultToken(chain: ChainDefinition): Token | undefined;
  /** Extension point 3: payment rails, best first; the payer view asks each which router paths it can execute. */
  readonly rails: readonly PaymentRail[];
  /** Payee routes shown in the terminal's mode switch, in order. */
  readonly tabs: readonly Route[];
  /** Local-currency estimate shown under dollar amounts (display only, never in a calculation), or `null`. */
  readonly fx: "MGA" | null;
  /** How a tester gets test dollars: the relayer's faucet onboarding, a faucet's own page, or nothing. */
  readonly testFunds: { readonly kind: "relayer" } | { readonly kind: "link"; readonly url: `https://${string}`; readonly name: string } | null;
  /** The EIP-5792 batch path is presented as "Pay with Base" (Base edition). */
  readonly payWithBase: boolean;
}
