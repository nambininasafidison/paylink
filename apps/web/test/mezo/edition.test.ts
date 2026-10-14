// SPDX-License-Identifier: MIT
/**
 * The Mezo edition as its build sees it (`__PAYLINK_EDITION__` = "mezo", vitest project `mezo`): its registry, its
 * profile, the payment routes MUSD allows (docs/research/mezo.md §11), its words, and the BTC fee arithmetic.
 */
import { registry as shipped } from "@paylink/chains";
import type { Erc20Token } from "@paylink/chains";
import { EN, LOCALES, loadEditionMessages, loadMessages, placeholders } from "@paylink/i18n";
import type { DecodedInvoiceLink } from "@paylink/sdk";
import { selectPaymentPath } from "@paylink/sdk";
import { describe, expect, it } from "vitest";
import { appRegistry } from "../../src/core/registry.ts";
import { edition, mezoProfile } from "../../src/editions/index.ts";
import { loadMezoCopy, MEZO_COPY, mezoTranslator, withMezoCopy } from "../../src/editions/mezo/copy.ts";
import { MEZO_LINKS } from "../../src/editions/mezo/links.ts";
import { feeUpperBound, satsText, settlementGas } from "../../src/editions/mezo/ui.ts";

const MEZO = 31611;
const MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";

const musd = (): Erc20Token => {
  const token = appRegistry("mezo").getOrThrow(MEZO).tokens.find((t) => t.symbol === "MUSD");
  if (token?.kind !== "erc20") {
    throw new Error("no MUSD in the Mezo registry");
  }
  return token;
};

describe("the Mezo edition's registry", () => {
  it("is Mezo testnet alone, taken from the shipped registry even while it keeps the chain disabled for the others", () => {
    const registry = appRegistry("mezo");
    expect(registry.chains.map((c) => c.chainId)).toEqual([MEZO]);
    const chain = registry.getOrThrow(MEZO);
    const original = shipped.getOrThrow(MEZO);
    // The registry's facts, unchanged, except that only the default dollar is offered when creating a link.
    expect({ ...chain, tokens: [] }).toEqual({ ...original, tokens: [] });
    expect(chain.tokens.map((t) => [t.address, t.symbol, t.decimals, t.capabilities])).toEqual(original.tokens.map((t) => [t.address, t.symbol, t.decimals, t.capabilities]));
    expect(chain.tokens.filter((t) => t.listing !== "hidden").map((t) => t.symbol)).toEqual(["MUSD"]);
    // Still on the allowlist: a link in native BTC decodes and verifies here.
    const native = original.tokens.find((t) => t.kind === "native");
    expect(registry.findToken(MEZO, "0x0000000000000000000000000000000000000000")?.symbol).toBe(native?.symbol);
    expect(chain.nativeCurrency.symbol).toBe("BTC");
    expect(chain.rpc.map((r) => r.url)).toEqual(["https://rpc.test.mezo.org"]);
    // The other editions still never see it.
    expect(appRegistry("all").get(MEZO)).toBeUndefined();
    expect(appRegistry("base").get(MEZO)).toBeUndefined();
  });

  it("names MUSD as the default dollar, EIP-2612 only, and reads the deployment from the registry alone", () => {
    const token = musd();
    expect([token.address, token.decimals, token.listing, token.capabilities]).toEqual([MUSD, 18, "default", { eip3009: false, eip2612: true, native: false }]);
    expect(edition().defaultToken(appRegistry("mezo").getOrThrow(MEZO))?.symbol).toBe("MUSD");
    // No address from anywhere else: a deployment exists only once protocol/deployments/31611.json is recorded.
    expect(appRegistry("mezo").v2Target(MEZO)?.deployment).toEqual(shipped.getOrThrow(MEZO).deployment ?? undefined);
  });
});

describe("the Mezo profile", () => {
  it("is this build's edition: injected wallets, the wallet and batch rails, no relayed rail, MGA estimates, borrowed test MUSD", () => {
    const profile = edition();
    expect(profile).toBe(edition());
    expect(profile.id).toBe("mezo");
    expect(profile.base).toBe("/mezo/");
    expect(profile.tag).toBe("Mezo");
    expect(profile.accountLayers.map((l) => [l.id, l.kind])).toEqual([["eip6963", "injected"]]);
    expect(profile.rails.map((r) => r.id)).toEqual(["batch", "wallet"]);
    const paths = profile.rails.flatMap((r) => r.paths);
    expect(paths).not.toContain("relayed-authorization");
    expect(paths).not.toContain("self-authorization");
    expect(paths).toEqual(expect.arrayContaining(["permit", "approve-pay", "batched-approve-pay"]));
    expect(profile.tabs).toEqual(["create", "ledger", "send", "till"]);
    expect(profile.fx).toBe("MGA");
    expect(profile.testFunds).toEqual({ kind: "borrow" });
    expect(profile.payWithBase).toBe(false);
    expect(mezoProfile().id).toBe("mezo");
  });

  it("routes MUSD as the facts allow: permit, then approve and pay; a smart account approves (in one batch when it can)", () => {
    const capabilities = musd().capabilities;
    const eoa = selectPaymentPath({ capabilities, account: "eoa", relayerHealthy: true, outstanding: null });
    expect(eoa).toMatchObject({ available: true, path: "permit", fallbacks: ["approve-pay"], payerPaysGas: true });
    const smart = selectPaymentPath({ capabilities, account: "smart-account", relayerHealthy: true, outstanding: null });
    expect(smart).toMatchObject({ available: true, path: "approve-pay" });
    const batch = selectPaymentPath({ capabilities, account: "smart-account", supportsBatch: true, relayerHealthy: true, outstanding: null });
    expect(batch).toMatchObject({ available: true, path: "batched-approve-pay", fallbacks: ["approve-pay"] });
    // No BTC, no payment: every MUSD path is paid by the payer's own gas.
    expect(selectPaymentPath({ capabilities, account: "eoa", relayerHealthy: true, payerHasGas: false, outstanding: null })).toMatchObject({ available: false, reason: "needs-gas" });
  });
});

describe("the Mezo words", () => {
  it("rewords existing core sentences with the same placeholders, in every language", async () => {
    for (const locale of LOCALES) {
      const core = locale === "en" ? EN : await loadMessages(locale);
      const own = await loadEditionMessages("mezo", locale);
      for (const [key, mezo] of Object.entries(MEZO_COPY)) {
        const original = (core as Readonly<Record<string, string>>)[key];
        const reworded = own[mezo];
        expect(original, `${locale} ${key}`).toBeDefined();
        expect(reworded, `${locale} ${mezo}`).toBeDefined();
        expect(placeholders(reworded ?? "").sort(), `${locale} ${key}`).toEqual(placeholders(original ?? "").sort());
      }
    }
  });

  it("says MUSD and BTC where the core catalogue says dollars and a fee service", async () => {
    const t = mezoTranslator("en", EN, await loadMezoCopy("en")).t;
    expect(t("create.h1b")).toBe("Get paid in MUSD");
    expect(t("create.kicker")).toBe("Bitcoin-backed dollar invoices");
    expect(t("pay.assure")).toContain("in BTC");
    expect(t("pay.route.needsGas")).toContain("No BTC for the network fee");
    expect(t("pay.retryRelayer")).not.toContain("fee service");
    expect(t("mezo.notes.title")).toBe("MUSD and BTC on Mezo");
    // Untouched keys stay the core's.
    expect(t("create.step1.title")).toBe(EN["create.step1.title"]);
    const fr = mezoTranslator("fr", await loadMessages("fr"), await loadMezoCopy("fr")).t;
    expect(fr("create.h1b")).toBe("Soyez payé en MUSD");
    // A key a translation lacks falls back to the Mezo English, never to the bare key.
    expect(withMezoCopy(EN, {})["create.h1b"]).toBe(EN["create.h1b"]);
  });

  it("links only to Mezo's own pages for test BTC and test MUSD", () => {
    expect(Object.values(MEZO_LINKS).every((url) => /^https:\/\/([a-z.]+\.)?mezo\.org\/?|^https:\/\/discord\.com\/invite\/mezo$/.test(url))).toBe(true);
    expect(MEZO_LINKS.faucet).toBe("https://faucet.test.mezo.org");
    expect(MEZO_LINKS.borrow).toBe("https://testnet.mezo.org/feature/borrow");
  });
});

describe("the BTC fee", () => {
  it("writes base units as satoshis, two significant digits, rounded half up, in the language's decimals", () => {
    // 136,000 gas × 276 wei = 3.7536e-11 BTC = 0.0037536 sat.
    expect(satsText(136_000n * 276n, 18, "en")).toBe("0.0038");
    expect(satsText(136_000n * 276n, 18, "fr")).toBe("0,0038");
    expect(satsText(136_000n * 276n, 18, "mg")).toBe("0,0038");
    expect(satsText(0n, 18, "en")).toBe("0");
    expect(satsText(10n ** 10n, 18, "en")).toBe("1");
    expect(satsText(123_456n * 10n ** 10n, 18, "en")).toBe("120000");
    expect(satsText(15n * 10n ** 9n, 18, "en")).toBe("1.5");
  });

  it("bounds a payment's fee by PayLink's gas limits at the current max fee, the approve's own estimate included", async () => {
    const chain = appRegistry("mezo").getOrThrow(MEZO);
    const permitGas = settlementGas(chain, "permit");
    const payGas = settlementGas(chain, "approve-pay");
    expect(permitGas).not.toBeNull();
    expect(settlementGas(chain, "relayed-authorization")).toBeNull();
    const asked: unknown[] = [];
    const client = {
      estimateFees: () => Promise.resolve({ maxFeePerGas: 276n, maxPriorityFeePerGas: 16n }),
      estimateGas: (parameters: unknown) => {
        asked.push(parameters);
        return Promise.resolve(46_394n);
      },
    };
    const link = { token: musd(), target: { chain, deployment: { address: "0x448eCce9711860502806A3d5B021a4f9Ba715082" } } } as unknown as DecodedInvoiceLink;
    const payer = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
    expect(await feeUpperBound(client, chain, "permit", link, payer, 12_500_000_000_000_000_000n)).toBe((permitGas ?? 0n) * 276n);
    expect(asked).toHaveLength(0);
    expect(await feeUpperBound(client, chain, "approve-pay", link, payer, 12_500_000_000_000_000_000n)).toBe(((payGas ?? 0n) + (46_394n * 110n + 99n) / 100n) * 276n);
    expect(asked).toEqual([expect.objectContaining({ from: payer, to: MUSD, value: 0n })]);
    // An open amount not typed yet still prices the approve (one base unit, the same storage write).
    await feeUpperBound(client, chain, "batched-approve-pay", link, payer, 0n);
    expect(asked).toHaveLength(2);
    expect(await feeUpperBound(client, chain, "native", link, payer, 1n)).toBeNull();
  });
});
