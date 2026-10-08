// SPDX-License-Identifier: MIT
/**
 * The edition this build serves (`VITE_EDITION`, ADR 0008), injected as the `__PAYLINK_EDITION__` constant so the
 * minifier drops the other editions' branches. Implementations are chosen here and nowhere else:
 *
 * | Edition | Account layer                      | Rails, best first                                              |
 * |---------|------------------------------------|----------------------------------------------------------------|
 * | monad   | Mera passkeys only (spec §2.1 T1)   | relayed authorisation, own-gas authorisation, wallet           |
 * | base    | EIP-6963 wallets (EIP-5792 batches) | relayed authorisation (EOAs), EIP-5792 batch, own-gas, wallet  |
 * | all     | EIP-6963 wallets                    | relayed authorisation, own-gas authorisation, wallet           |
 *
 * The PaymentRouter (`selectPaymentPath`) decides the path from the token, the payer's account and the relayer's
 * health; a rail only executes what it is handed.
 */
import type { ChainDefinition, Edition, Token } from "@paylink/chains";
import { eip6963Layer } from "../accounts/eip6963.ts";
import { passkeyLayer } from "../accounts/passkey.ts";
import { relayedAuthorizationRail, selfAuthorizationRail } from "../rails/authorization.ts";
import { batchRail } from "../rails/batch.ts";
import { walletRail } from "../rails/wallet.ts";
import type { EditionProfile } from "./types.ts";

declare const __PAYLINK_EDITION__: Edition;
/** The production relying party ID (FACTS 2026-10-07), or `null` in local and end-to-end builds (the page's host). */
declare const __PAYLINK_RP_ID__: string | null;

/** Monad testnet: the Monad edition's chain, and the account's chain before a page picks one. */
const MONAD_TESTNET = 10143;

/** The registry's default token for the chain, else its first listed one. Hidden tokens are never preselected. */
export function registryDefaultToken(chain: ChainDefinition): Token | undefined {
  return chain.tokens.find((t) => t.listing === "default") ?? chain.tokens.find((t) => t.listing === "listed");
}

export function editionBase(edition: Edition): string {
  return edition === "all" ? "/" : `/${edition}/`;
}

const common = { defaultToken: registryDefaultToken, payWithBase: false } as const;

/** Monad Metropolis (spec §2.1): Mera passkeys only, gasless AUSD through the relayer, onboarding, MGA estimates. */
export function monadProfile(rpId: string | null): EditionProfile {
  return {
    ...common,
    id: "monad",
    base: editionBase("monad"),
    tag: "Monad",
    tabs: ["create", "ledger", "send", "till"],
    accountLayers: [passkeyLayer({ rpId, defaultChainId: MONAD_TESTNET })],
    rails: [relayedAuthorizationRail(), selfAuthorizationRail(), walletRail()],
    fx: "MGA",
    testFunds: { kind: "relayer" },
  };
}

/** Colosseum, Base track (spec §2.2): injected wallets, gasless USDC for EOAs, Pay with Base for smart accounts. */
export function baseProfile(): EditionProfile {
  return {
    ...common,
    id: "base",
    base: editionBase("base"),
    tag: "Base",
    tabs: ["create", "ledger", "send", "till"],
    accountLayers: [eip6963Layer()],
    rails: [relayedAuthorizationRail(), batchRail(), selfAuthorizationRail(), walletRail()],
    fx: null,
    testFunds: { kind: "link", url: "https://faucet.circle.com", name: "Circle Faucet" },
    payWithBase: true,
  };
}

/** Mezo (later, spec §9): injected wallets and the wallet rail (MUSD is EIP-2612 only). */
export function mezoProfile(): EditionProfile {
  return { ...common, id: "mezo", base: editionBase("mezo"), tag: "Mezo", tabs: ["create", "ledger", "till"], accountLayers: [eip6963Layer()], rails: [walletRail()], fx: null, testFunds: null };
}

/** Every chain at the root: injected wallets, gasless where the relayer serves the chain. */
export function allProfile(): EditionProfile {
  return {
    ...common,
    id: "all",
    base: editionBase("all"),
    tag: "v2",
    tabs: ["create", "ledger", "send", "till"],
    accountLayers: [eip6963Layer()],
    // Gasless where the relayer serves the chain. Once a payer has signed an authorisation, invoice spec §8.6 allows
    // only that authorisation until it is used, cancelled or expired, so the own-gas rail must be here too: without
    // it a relayer failure after the signature would leave the payer nothing to pay with (spec §3.5, §3.7). Otherwise
    // the payer's wallet, exactly as at T0 (permit, approve-pay).
    rails: [relayedAuthorizationRail(), selfAuthorizationRail(), walletRail()],
    fx: "MGA",
    testFunds: null,
  };
}

let current: EditionProfile | undefined;

/** The profile of this build (created once; its account layer starts listening only when asked). */
export function edition(): EditionProfile {
  // Compared with the build constant directly, so the minifier folds the conditions and drops the other editions'
  // factories (and with them the Mera passkey layer outside the Monad edition, the batch rail outside Base).
  current ??=
    __PAYLINK_EDITION__ === "monad"
      ? monadProfile(__PAYLINK_RP_ID__)
      : __PAYLINK_EDITION__ === "base"
        ? baseProfile()
        : __PAYLINK_EDITION__ === "mezo"
          ? mezoProfile()
          : allProfile();
  return current;
}
