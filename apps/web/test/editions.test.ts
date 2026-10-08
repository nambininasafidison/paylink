// SPDX-License-Identifier: MIT
/**
 * Editions (ADR 0008): the registry each edition trusts, the three extension points (account layer, default token,
 * payment rail), `?chain=` limited to the edition's chains, and preferences that survive refused storage.
 */
import { registry as shipped } from "@paylink/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bandOptions, initialChain, plateText } from "../src/app/chains.ts";
import type { App } from "../src/app/context.ts";
import { appRegistry, editionChains } from "../src/core/registry.ts";
import { applyTheme, prefs } from "../src/core/prefs.ts";
import { edition, editionBase, registryDefaultToken } from "../src/editions/index.ts";
import { createTranslator, EN } from "@paylink/i18n";
import { SCRIPT_URL } from "./helpers.ts";

describe("edition registries", () => {
  it("scopes each edition to its own chains", () => {
    expect(appRegistry("all").chains.map((c) => c.chainId)).toEqual([10143, 84532, 421614]);
    expect(appRegistry("monad").chains.map((c) => c.chainId)).toEqual([10143]);
    expect(appRegistry("base").chains.map((c) => c.chainId)).toEqual([84532, 421614]);
  });

  it("keeps the shipped addresses: no e2e override in unit and production builds", () => {
    for (const chain of appRegistry("all").chains) {
      const original = shipped.getOrThrow(chain.chainId);
      expect(chain.tokens).toEqual(original.tokens);
      expect(chain.rpc).toEqual(original.rpc);
      expect(chain.name).not.toContain("e2e");
    }
  });

  it("reports which chains have a canonical deployment", () => {
    const registry = appRegistry("all");
    expect(editionChains(registry).map((c) => [c.chain.chainId, c.deployed])).toEqual(registry.chains.map((c) => [c.chainId, registry.v2Target(c.chainId) !== undefined]));
  });
});

describe("edition profile", () => {
  it("serves this build's edition with its extension points", () => {
    const profile = edition();
    expect(profile.id).toBe("all");
    expect(profile.base).toBe("/");
    expect(profile.accountLayers.map((l) => l.id)).toEqual(["eip6963"]);
    expect(profile.rails.map((r) => r.id)).toEqual(["wallet"]);
    expect(profile.tabs).toEqual(["create", "ledger", "send", "till"]);
    expect(edition()).toBe(profile);
  });

  it("serves each edition under its own path", () => {
    expect(editionBase("all")).toBe("/");
    expect(editionBase("monad")).toBe("/monad/");
    expect(editionBase("base")).toBe("/base/");
  });

  it("preselects the registry's default token, never a hidden one", () => {
    const monad = shipped.getOrThrow(10143);
    expect(registryDefaultToken(monad)?.symbol).toBe("AUSD");
    const onlyHidden = { ...monad, tokens: monad.tokens.map((t) => ({ ...t, listing: "hidden" as const })) };
    expect(registryDefaultToken(onlyHidden)).toBeUndefined();
    const listed = { ...monad, tokens: monad.tokens.map((t) => ({ ...t, listing: t.symbol === "USDC" ? ("listed" as const) : ("hidden" as const) })) };
    expect(registryDefaultToken(listed)?.symbol).toBe("USDC");
  });
});

describe("?chain=", () => {
  const app = (): App => ({ registry: appRegistry("base"), i18n: createTranslator("en", EN, { fallback: EN }) }) as unknown as App;

  it("selects among the edition's chains by band label, registry key or chain ID", () => {
    expect(initialChain(app(), "?chain=arb")?.chainId).toBe(421614);
    expect(initialChain(app(), "?chain=ARB")?.chainId).toBe(421614);
    expect(initialChain(app(), "?chain=84532")?.chainId).toBe(84532);
  });

  it("ignores chains outside the edition", () => {
    const fallback = initialChain(app(), "")?.chainId;
    expect(initialChain(app(), "?chain=monad")?.chainId).toBe(fallback);
    expect(initialChain(app(), "?chain=10143")?.chainId).toBe(fallback);
    expect(initialChain(app(), "?chain=%3Cscript%3E")?.chainId).toBe(fallback);
  });

  it("labels bands with the network and whether PayLink is deployed there", () => {
    const options = bandOptions(app());
    expect(options.map((o) => o.label)).toEqual(["BASE", "ARB"]);
    for (const option of options) {
      const deployed = appRegistry("base").v2Target(option.id) !== undefined;
      expect(option.sub).toBe(deployed ? `Testnet · ${String(option.id)}` : "Not deployed");
    }
    expect(plateText(shipped.getOrThrow(84532))).toBe("Base Sepolia · 84532");
  });
});

describe("preferences", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("stores only valid values and falls back to defaults", () => {
    expect(prefs.theme.get()).toBe("auto");
    prefs.theme.set("dark");
    expect(prefs.theme.get()).toBe("dark");
    prefs.theme.set("auto");
    expect(localStorage.getItem("paylink.theme")).toBeNull();
    localStorage.setItem("paylink.locale", "xx");
    expect(prefs.locale.get()).toBeNull();
    localStorage.setItem("paylink.wallet", SCRIPT_URL);
    expect(prefs.wallet.get()).toBeNull();
    prefs.chime.set(false);
    expect(prefs.chime.get()).toBe(false);
  });

  it("keeps working when storage is refused", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(prefs.theme.get()).toBe("auto");
    expect(() => {
      prefs.theme.set("dark");
    }).not.toThrow();
  });

  it("applies the theme as v1 does, through data-theme", () => {
    const root = document.createElement("html");
    applyTheme("dark", root);
    expect(root.getAttribute("data-theme")).toBe("dark");
    applyTheme("auto", root);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});
