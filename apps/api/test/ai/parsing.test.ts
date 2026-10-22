// SPDX-License-Identifier: MIT
/**
 * Code's half of A1 (invariant AI-5): personal data out of the prompt, amounts parsed by code from the text the model
 * copied, and due dates resolved by code from the phrase it copied. Today is Wednesday 2026-10-21 in Antananarivo.
 */
import { describe, expect, it } from "vitest";
import { decideAmount, readDigits, scanMoney } from "../../src/ai/amounts.ts";
import { antananarivoToday, decideDueDate, resolveDuePhrase } from "../../src/ai/dates.ts";
import { restore, tokenise, withoutPlaceholders } from "../../src/ai/pii.ts";
import { T0 } from "../helpers.ts";

const TODAY = "2026-10-21";

describe("tokenise", () => {
  it("replaces emails, phones and 0x addresses, the same value with the same placeholder", () => {
    const t = tokenise("Mail sarah@example.com or SARAH@example.com, call +261 34 12 345 67 or 034 12 345 67, (415) 555-0132, pay 0x70997970C51812dc3A010C7d01b50e0d17dc79C8.");
    expect(t.text).toBe("Mail [EMAIL_1] or [EMAIL_1], call [PHONE_1] or [PHONE_2], [PHONE_3], pay [ADDRESS_1].");
    expect(restore(t, "[EMAIL_1]", "EMAIL")).toBe("sarah@example.com");
    expect(restore(t, "[EMAIL_1]", "PHONE")).toBeNull();
    expect(restore(t, "[EMAIL_9]", "EMAIL")).toBeNull();
    expect(t.counts).toEqual({ EMAIL: 1, PHONE: 3, ADDRESS: 1, HEX: 0 });
  });

  it("leaves amounts alone, even long ariary amounts", () => {
    for (const text of ["$1,250,000.00", "1 500 000 Ar", "150 000 Ar", "120,50 €", "$120"]) {
      expect(tokenise(text).text).toBe(text);
    }
  });

  it("neutralises placeholders already in the input (no smuggled token is mapped back)", () => {
    const t = tokenise("my email is [EMAIL_1] and real@example.org");
    expect(t.text).toBe("my email is (placeholder) and [EMAIL_1]");
    expect(restore(t, "[EMAIL_1]", "EMAIL")).toBe("real@example.org");
    expect(withoutPlaceholders("Logo for [EMAIL_1] and [PHONE_2]")).toBe("Logo for and");
  });
});

describe("amounts", () => {
  it("reads separators the way people write money", () => {
    expect(readDigits("1,200.50", "USD")).toEqual({ decimal: "1200.50", ambiguous: false });
    expect(readDigits("1.200,50", "EUR")).toEqual({ decimal: "1200.50", ambiguous: false });
    expect(readDigits("120,50", null)).toEqual({ decimal: "120.50", ambiguous: false });
    expect(readDigits("1 200", null)).toEqual({ decimal: "1200", ambiguous: false });
    expect(readDigits("1,200", "USD")).toEqual({ decimal: "1200", ambiguous: false });
    expect(readDigits("1.200", "USD")).toEqual({ decimal: "1200", ambiguous: true });
    expect(readDigits("1,000,000", "USD")).toEqual({ decimal: "1000000", ambiguous: false });
  });

  it("finds the currency written next to each number", () => {
    const marks = scanMoney("Logo $120, hosting 30 USD, 50 euros, 150 000 Ar, C$40, £10, US$ 99, 2026-11-06").map((m) => [m.digits, m.currency]);
    expect(marks).toEqual([
      ["120", "USD"],
      ["30", "USD"],
      ["50", "EUR"],
      ["150 000", "MGA"],
      ["40", "OTHER"],
      ["10", "GBP"],
      ["99", "USD"],
      ["2026", null],
      ["11", null],
      ["06", null],
    ]);
  });

  it("decides the amount (src/ai/amounts.ts table)", () => {
    const d = (text: string, copy: string | null) => {
      const r = decideAmount(text, copy);
      return [r.amountBase?.toString() ?? null, r.currency, [...r.clarifications], r.basis];
    };
    expect(d("Send me the invoice, $120, I'll pay by Friday.", "$120")).toEqual(["120000000", "USD", [], "matched"]);
    expect(d("Facture : 120,50 $ merci", "120,50 $")).toEqual(["120500000", "USD", [], "matched"]);
    expect(d("Logo $120 + hosting $30", "$120")).toEqual(["120000000", "USD", ["several_amounts"], "matched"]);
    expect(d("Logo 120 euros", "120 euros")).toEqual([null, null, ["currency_not_usd"], "not-usd"]);
    expect(d("Logo 150 000 Ar", "150 000 Ar")).toEqual([null, null, ["currency_not_usd"], "not-usd"]);
    expect(d("Logo for 120", "120")).toEqual(["120000000", null, ["amount_ambiguous"], "no-currency"]);
    expect(d("Logo $120", "$1200")).toEqual([null, null, ["amount_ambiguous"], "not-in-text"]);
    expect(d("Logo $120", "0.01")).toEqual([null, null, ["amount_ambiguous"], "not-in-text"]);
    expect(d("Logo, about $1.2k", "$1.2k")).toEqual([null, null, ["amount_ambiguous"], "ambiguous"]);
    expect(d("Logo $120.505", "$120.505")).toEqual([null, null, ["amount_ambiguous"], "ambiguous"]);
    expect(d("Logo $0", "$0")).toEqual([null, null, ["amount_ambiguous"], "ambiguous"]);
    expect(d("Logo, let's talk price", null)).toEqual([null, null, ["amount_missing"], "no-amount"]);
    expect(d("Logo, $120 or $150", null)).toEqual([null, null, ["amount_ambiguous"], "no-amount"]);
    // A copy of a bare number that also appears with a dollar sign elsewhere: the dollar mention wins.
    expect(d("120 pages for $120", "120")).toEqual(["120000000", "USD", [], "matched"]);
  });
});

describe("due dates", () => {
  const r = (phrase: string, language: "en" | "fr" | "mg" = "en") => {
    const out = resolveDuePhrase(phrase, TODAY, language);
    return out.kind === "date" ? out.date : out.kind;
  };

  it("Antananarivo's today is UTC+3", () => {
    expect(antananarivoToday(T0)).toBe("2026-10-21");
    expect(antananarivoToday(Date.UTC(2026, 9, 21, 21, 30))).toBe("2026-10-22");
  });

  it("resolves the phrases of EN, FR and MG messages", () => {
    expect(r("by Friday")).toBe("2026-10-23");
    expect(r("vendredi", "fr")).toBe("2026-10-23");
    expect(r("zoma", "mg")).toBe("2026-10-23");
    expect(r("next Friday")).toBe("ambiguous");
    expect(r("vendredi prochain", "fr")).toBe("2026-10-23");
    expect(r("on Wednesday")).toBe("ambiguous");
    expect(r("tomorrow")).toBe("2026-10-22");
    expect(r("demain", "fr")).toBe("2026-10-22");
    expect(r("rahampitso", "mg")).toBe("2026-10-22");
    expect(r("après-demain", "fr")).toBe("2026-10-23");
    expect(r("today")).toBe("2026-10-21");
    expect(r("in 2 weeks")).toBe("2026-11-04");
    expect(r("within two weeks")).toBe("2026-11-04");
    expect(r("dans deux semaines", "fr")).toBe("2026-11-04");
    expect(r("afaka roa herinandro", "mg")).toBe("2026-11-04");
    expect(r("dans 10 jours", "fr")).toBe("2026-10-31");
    expect(r("in 1 month")).toBe("2026-11-21");
    expect(r("net 30")).toBe("2026-11-20");
    expect(r("on receipt")).toBe("2026-10-21");
    expect(r("end of the month")).toBe("2026-10-31");
    expect(r("fin du mois", "fr")).toBe("2026-10-31");
    expect(r("faran'ny volana", "mg")).toBe("2026-10-31");
    expect(r("fin novembre", "fr")).toBe("2026-11-30");
    expect(r("Nov 6")).toBe("2026-11-06");
    expect(r("November 6th, 2026")).toBe("2026-11-06");
    expect(r("le 6 novembre", "fr")).toBe("2026-11-06");
    expect(r("6 novambra", "mg")).toBe("2026-11-06");
    expect(r("6 Jan")).toBe("2027-01-06");
    expect(r("2026-11-06")).toBe("2026-11-06");
    expect(r("06/11/2026", "fr")).toBe("2026-11-06");
    expect(r("06/11/2026", "en")).toBe("ambiguous");
    expect(r("11/26", "en")).toBe("2026-11-26");
    expect(r("avant le 30", "fr")).toBe("2026-10-30");
    expect(r("by the 15th")).toBe("2026-11-15");
    expect(r("next week")).toBe("ambiguous");
    expect(r("soon")).toBe("unknown");
    expect(r("31/02/2027", "fr")).toBe("unknown");
  });

  it("decides the due date: the phrase must be in the message, the date ahead and within a year", () => {
    const d = (text: string, phrase: string | null, iso: string | null = null) => {
      const out = decideDueDate(text, phrase, iso, TODAY, "en");
      return [out.dueDate, [...out.clarifications], out.basis];
    };
    expect(d("I'll pay by Friday", "by Friday")).toEqual(["2026-10-23", [], "resolved"]);
    expect(d("I'll pay by Friday", "by Monday")).toEqual([null, ["due_date_unclear"], "not-in-text"]);
    expect(d("I'll pay soon", "soon")).toEqual([null, ["due_date_unclear"], "unresolved"]);
    expect(d("No date here", null, "2026-12-01")).toEqual([null, ["due_date_unclear"], "no-phrase"]);
    expect(d("No date here", null)).toEqual([null, [], "none"]);
    expect(d("paid on 2026-10-01", "2026-10-01")).toEqual([null, ["due_date_past"], "past"]);
    expect(d("due 2028-01-01", "2028-01-01")).toEqual([null, ["due_date_too_far"], "too-far"]);
    expect(decideDueDate("pay by Friday", "by Friday", "2026-10-30", TODAY, "en").disagreed).toBe(true);
  });
});
