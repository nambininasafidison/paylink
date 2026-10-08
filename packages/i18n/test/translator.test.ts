// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { createTranslator, EN, interpolate, loadMessages, MISSING, placeholders } from "../src/index.ts";
import type { Messages } from "../src/index.ts";

describe("interpolate", () => {
  it("fills named placeholders and reports missing ones", () => {
    const onMissing = vi.fn();
    expect(interpolate("Pay {amount} {symbol}", { amount: "25.50", symbol: "USDC" })).toBe("Pay 25.50 USDC");
    expect(interpolate("Pay {amount} {symbol}", { amount: 1n }, onMissing)).toBe(`Pay 1 ${MISSING}`);
    expect(onMissing).toHaveBeenCalledWith("symbol");
    expect(placeholders("{a} and {b} and {a}")).toEqual(["a", "b"]);
  });

  it("never interprets values as markup or placeholders", () => {
    expect(interpolate("Note: {memo}", { memo: "<b>{symbol}</b>" })).toBe("Note: <b>{symbol}</b>");
  });

  it("ignores inherited properties", () => {
    expect(interpolate("{toString}", {})).toBe(MISSING);
  });
});

describe("translator", () => {
  it("translates with typed parameters and falls back to English", async () => {
    const fr = createTranslator("fr", await loadMessages("fr"), { fallback: EN });
    expect(fr.t("pay.payKey", { amount: "25,50", symbol: "AUSD" })).toBe("Payer 25,50 AUSD");
    const partial = { "app.connect": "Connecter" } as unknown as Messages;
    const withFallback = createTranslator("fr", partial, { fallback: EN });
    expect(withFallback.t("common.close")).toBe("Close");
    const without = createTranslator("fr", partial);
    expect(without.t("common.close")).toBe("common.close");
  });

  it("selects plural forms with Intl.PluralRules", async () => {
    const en = createTranslator("en", EN);
    expect(en.plural("ledger.row.payments", 1, {})).toBe("1 payment");
    expect(en.plural("ledger.row.payments", 2, {})).toBe("2 payments");
    expect(en.plural("ledger.row.payments", 1200, {})).toBe("1,200 payments");
    const fr = createTranslator("fr", await loadMessages("fr"));
    // French: 0 and 1 are singular.
    expect(fr.plural("ledger.row.payments", 0, {})).toBe("0 paiement");
    expect(fr.plural("ledger.row.payments", 2, {})).toBe("2 paiements");
    const mg = createTranslator("mg", await loadMessages("mg"));
    expect(mg.plural("ledger.row.payments", 3, {})).toBe("Fandoavana 3");
  });

  it("looks up computed keys and returns null for unknown ones", () => {
    const en = createTranslator("en", EN);
    expect(en.lookup("error.contract.soldOut", { maxPayments: "3" })).toBe("This link has taken all its 3 payments.");
    expect(en.lookup("no.such.key")).toBeNull();
  });

  it("reports untranslated keys and missing parameters", () => {
    const onMissing = vi.fn();
    const en = createTranslator("en", EN, { onMissing });
    en.lookup("pay.payKey", { amount: "1" });
    expect(onMissing).toHaveBeenCalledWith("pay.payKey", "symbol");
  });

  it("loads every catalogue", async () => {
    for (const locale of ["en", "fr", "mg"] as const) {
      expect(Object.keys(await loadMessages(locale))).toHaveLength(Object.keys(EN).length);
    }
  });
});
