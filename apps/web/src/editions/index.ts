// SPDX-License-Identifier: MIT
/**
 * The edition this build serves (`VITE_EDITION`, ADR 0008), injected as the `__PAYLINK_EDITION__` constant so the
 * minifier drops the other editions' branches. T0: every edition uses injected wallets and the wallet rail; T1 swaps in
 * Mera passkeys (Monad), Base Account for payers (Base) and the relayer rail, here and nowhere else.
 */
import type { ChainDefinition, Edition, Token } from "@paylink/chains";
import { eip6963Layer } from "../accounts/eip6963.ts";
import { walletRail } from "../rails/wallet.ts";
import type { EditionProfile } from "./types.ts";

declare const __PAYLINK_EDITION__: Edition;

/** The registry's default token for the chain, else its first listed one. Hidden tokens are never preselected. */
export function registryDefaultToken(chain: ChainDefinition): Token | undefined {
  return chain.tokens.find((t) => t.listing === "default") ?? chain.tokens.find((t) => t.listing === "listed");
}

export function editionBase(edition: Edition): string {
  return edition === "all" ? "/" : `/${edition}/`;
}

function profile(edition: Edition): EditionProfile {
  const common = { accountLayers: [eip6963Layer()], rails: [walletRail()], defaultToken: registryDefaultToken } as const;
  switch (edition) {
    case "monad":
      return { ...common, id: "monad", base: editionBase("monad"), tag: "Monad", tabs: ["create", "ledger", "send", "till"] };
    case "base":
      return { ...common, id: "base", base: editionBase("base"), tag: "Base", tabs: ["create", "ledger", "till"] };
    case "mezo":
      return { ...common, id: "mezo", base: editionBase("mezo"), tag: "Mezo", tabs: ["create", "ledger", "till"] };
    case "all":
      return { ...common, id: "all", base: editionBase("all"), tag: "v2", tabs: ["create", "ledger", "send", "till"] };
  }
}

let current: EditionProfile | undefined;

/** The profile of this build (created once; its account layer starts listening only when asked). */
export function edition(): EditionProfile {
  current ??= profile(__PAYLINK_EDITION__);
  return current;
}
