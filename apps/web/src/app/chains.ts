// SPDX-License-Identifier: MIT
/** Chain choice shared by the payee pages: `?chain=` (edition chains only), the band selector's options, names. */
import type { ChainDefinition } from "@paylink/chains";
import type { BandOption } from "../ui/controls.ts";
import type { App } from "./context.ts";

/** A chain's band label and its engraved second line ("Testnet · 10143", or "Not deployed yet"). */
export function bandOptions(app: App): BandOption[] {
  const { t } = app.i18n;
  return app.registry.chains.map((chain) => {
    const deployed = app.registry.v2Target(chain.chainId) !== undefined;
    return {
      id: chain.chainId,
      label: chain.label,
      sub: deployed ? t(chain.testnet ? "chain.testnet" : "chain.mainnet", { chainId: chain.chainId }) : t("chain.notDeployedShort"),
      disabled: false,
    };
  });
}

/**
 * The chain named by `?chain=` (its band label such as `monad`, `base`, `arb`, its registry key or its ID), but only
 * among the edition's own chains (spec §3.6); otherwise the first chain with a deployment, otherwise the first chain.
 */
export function initialChain(app: App, search: string = location.search): ChainDefinition | undefined {
  const wanted = new URLSearchParams(search).get("chain")?.trim().toLowerCase() ?? "";
  const chains = app.registry.chains;
  const named = wanted === "" ? undefined : chains.find((c) => c.label.toLowerCase() === wanted || c.key === wanted || String(c.chainId) === wanted);
  return named ?? chains.find((c) => app.registry.v2Target(c.chainId) !== undefined) ?? chains[0];
}

/** "Monad testnet": the registry's name, which is a proper noun and not translated. */
export function networkName(chain: ChainDefinition): string {
  return chain.name;
}

/** The terminal's plate: "Monad testnet · 10143". */
export function plateText(chain: ChainDefinition): string {
  return `${chain.name} · ${String(chain.chainId)}`;
}
