// SPDX-License-Identifier: MIT
/** Amounts are exact (bigint in, text out); addresses are grouped by four; typed amounts accept both separators. */
import { isPayLinkError } from "@paylink/sdk";
import { describe, expect, it } from "vitest";
import { addressGroups, displayAmount, figureWidth, parseTypedAmount, plainAmount, shortHex, spokenAddress } from "../src/core/format.ts";
import { csvField, isoTime } from "../src/read/csv.ts";
import { payUrl, receiptUrl, routePath, tillUrl, whatsappUrl } from "../src/core/links.ts";

const six = { decimals: 6 };
const eighteen = { decimals: 18 };

describe("amounts", () => {
  it("displays every significant digit, at least two decimals, in the reader's locale", () => {
    expect(displayAmount(25_500_000n, six, "en")).toBe("25.50");
    expect(displayAmount(1_234_567_891n, six, "en")).toBe("1,234.567891");
    expect(displayAmount(25_500_000n, six, "fr")).toBe("25,50");
    expect(displayAmount(1_200_000_000n, six, "fr").replace(/\s/g, " ")).toBe("1 200,00");
    expect(displayAmount(1n, eighteen, "en")).toBe("0.000000000000000001");
  });

  it("writes plain amounts for CSV and wallets: dot, no grouping, no padding", () => {
    expect(plainAmount(25_500_000n, six)).toBe("25.5");
    expect(plainAmount(1_200_000_000n, six)).toBe("1200");
  });

  it("parses what people type: either separator, spaces ignored", () => {
    expect(parseTypedAmount("25.50", six)).toBe(25_500_000n);
    expect(parseTypedAmount("25,5", six)).toBe(25_500_000n);
    expect(parseTypedAmount(" 1 200,00 ", six)).toBe(1_200_000_000n);
    expect(parseTypedAmount("1 200.5", six)).toBe(1_200_500_000n);
  });

  it("refuses more decimals than the token has instead of rounding, and anything that is not a plain number", () => {
    expect(() => parseTypedAmount("0.0000001", six)).toThrow();
    try {
      parseTypedAmount("0.0000001", six);
    } catch (error) {
      expect(isPayLinkError(error, "E_AMOUNT_PRECISION")).toBe(true);
    }
    for (const bad of ["1e6", "-5", "1.2.3", "1,2,3", "abc", "0x10", "1,000.50"]) {
      expect(() => parseTypedAmount(bad, six), bad).toThrow();
    }
  });
});

describe("addresses and hashes", () => {
  const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

  it("groups an address by four after 0x and the first four", () => {
    expect(addressGroups(address)).toEqual(["0x7099", "7970", "C518", "12dc", "3A01", "0C7d", "01b5", "0e0d", "17dc", "79C8"]);
    expect(spokenAddress(address)).toBe("0x7099, 7970, C518, 12dc, 3A01, 0C7d, 01b5, 0e0d, 17dc, 79C8");
  });

  it("shortens hashes in the middle", () => {
    expect(shortHex(address)).toBe("0x7099…79C8");
    expect(shortHex("0x1234")).toBe("0x1234");
    expect(shortHex(address, 8, 6)).toBe("0x709979…dc79C8");
  });

  it("sizes instrument numerals by their length, never below four", () => {
    expect(figureWidth("5")).toBe("4");
    expect(figureWidth("1,234.50")).toBe("8");
  });
});

describe("links", () => {
  const site = { origin: "https://paylink-mg.pages.dev", base: "/monad/" };

  it("puts the invoice in the fragment of the edition's routes", () => {
    expect(payUrl(site, "2.10143.abc.def")).toBe("https://paylink-mg.pages.dev/monad/pay/#2.10143.abc.def");
    expect(receiptUrl(site, "2.10143.0xab.3")).toBe("https://paylink-mg.pages.dev/monad/r/#2.10143.0xab.3");
    expect(tillUrl({ ...site, base: "/" }, "2.1.x.y")).toBe("https://paylink-mg.pages.dev/till/#2.1.x.y");
    expect(routePath("/base/", "ledger/")).toBe("/base/ledger/");
  });

  it("encodes the whole WhatsApp message, link included", () => {
    const url = whatsappUrl("Invoice: 25.50 AUSD & more https://paylink-mg.pages.dev/pay/#2.1.a.b");
    expect(url.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(url.slice("https://wa.me/?text=".length))).toBe("Invoice: 25.50 AUSD & more https://paylink-mg.pages.dev/pay/#2.1.a.b");
    expect(url).not.toContain("#");
    expect(url).not.toContain(" ");
  });
});

describe("CSV fields", () => {
  it("quotes per RFC 4180", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
  });

  it("neutralises spreadsheet formulas (OWASP CSV injection)", () => {
    expect(csvField("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-1")).toBe("'-1");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("\tx")).toBe("'\tx");
  });

  it("writes ISO 8601 UTC times, empty for no bound", () => {
    expect(isoTime(0n)).toBe("");
    expect(isoTime(1_791_417_600n)).toBe("2026-10-08T00:00:00Z");
  });
});
