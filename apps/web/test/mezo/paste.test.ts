// SPDX-License-Identifier: MIT
/**
 * "Paste the client's message" on the Mezo create terminal (editions/mezo/paste.ts): due dates in English, French and
 * Malagasy, the amount in MUSD or dollars (never converted from another currency), the shortest validity that covers
 * the due date, and the form filled in the language's number format.
 */
import { EN } from "@paylink/i18n";
import { describe, expect, it } from "vitest";
import type { App } from "../../src/app/context.ts";
import { loadMezoCopy, mezoTranslator } from "../../src/editions/mezo/copy.ts";
import { dueDateOf, pasteHelper, readMessage, validityFor } from "../../src/editions/mezo/paste.ts";
import type { ValidityChoice } from "../../src/editions/mezo/paste.ts";

describe("paste the client's message (paste.ts)", () => {
  const now = new Date(Date.UTC(2026, 10, 9, 10, 0));
  const day = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();

  it("reads due dates in English, French and Malagasy", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["due 2026-11-20", "2026-11-20"],
      ["avant le 20/11", "2026-11-20"],
      ["by 3/1/2027", "2027-01-03"],
      ["payable le 15 décembre", "2026-12-15"],
      ["by November 12th", "2026-11-12"],
      ["alohan'ny 20 Novambra", "2026-11-20"],
      ["on 1 March", "2027-03-01"],
      ["within 2 weeks", "2026-11-23"],
      ["dans 3 jours", "2026-11-12"],
      ["afaka 7 andro", "2026-11-16"],
      ["in a month", "2026-12-09"],
      ["demain", "2026-11-10"],
      ["next week please", "2026-11-16"],
    ];
    for (const [text, iso] of cases) {
      expect(dueDateOf(text, now)?.getTime(), text).toBe(day(iso));
    }
    expect(dueDateOf("12.50 MUSD for 3 days of work", now)).toBeNull();
  });

  it("fills a MUSD or dollar amount and the shortest validity that covers the due date; never converts another currency", () => {
    expect(readMessage("Hi! Could you invoice $250 for the logo, due 2026-11-15?", now)).toMatchObject({ amount: { value: "250", unit: "USD" }, due: { days: 6 }, validity: "7d" });
    expect(readMessage("Montant : 1 250,50 MUSD, à régler demain", now)).toMatchObject({ amount: { value: "1250.5" }, validity: "1d" });
    expect(readMessage("300 € before 2026-11-30", now)).toMatchObject({ amount: null, unsupported: "300 €", validity: "30d" });
    expect(readMessage("0.002 BTC, due 2027-03-01", now)).toMatchObject({ amount: null, unsupported: "0.002 BTC", validity: null });
    expect(readMessage("150 000 Ar", now).unsupported).toBe("150 000 Ar");
    expect([validityFor(-1), validityFor(0), validityFor(1), validityFor(7), validityFor(30), validityFor(31)]).toEqual([null, "1d", "1d", "7d", "30d", null]);
  });

  it("fills the form it is given, in the language's number format, and says what it did not fill", async () => {
    const app = { i18n: mezoTranslator("fr", EN, await loadMezoCopy("en")), locale: "fr" } as unknown as App;
    const filled: { amount?: string; validity?: ValidityChoice } = {};
    const helper = pasteHelper(app, { setAmount: (amount) => (filled.amount = amount), setValidity: (validity) => (filled.validity = validity) });
    const area = helper.querySelector("textarea");
    if (area === null) {
      throw new Error("no text area");
    }
    area.value = `Invoice me 1,250.50 MUSD, due ${new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)}`;
    helper.querySelector("button")?.click();
    expect(filled).toEqual({ amount: "1250,5", validity: "7d" });
    expect(helper.querySelectorAll(".paste-out li")).toHaveLength(2);
    area.value = "0.01 BTC";
    helper.querySelector("button")?.click();
    expect(helper.querySelector(".paste-out")?.textContent).toContain("0.01 BTC");
    expect(filled.amount).toBe("1250,5");
  });
});
