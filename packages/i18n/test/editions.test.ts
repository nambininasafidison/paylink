// SPDX-License-Identifier: MIT
/**
 * Edition catalogues (ADR 0008): each loads as its own chunk in each language, with exactly the English keys, and only
 * through `loadEditionMessages` (the core catalogue and the feature catalogues never carry them).
 */
import { describe, expect, it } from "vitest";
import { EN, LOCALES, loadEditionMessages, loadMessages } from "../src/index.ts";

describe("edition catalogues", () => {
  it("loads the Mezo catalogue in every language, with the English keys", async () => {
    const en = await loadEditionMessages("mezo", "en");
    expect(en["mezo.create.h1b"]).toBe("Get paid in MUSD");
    for (const locale of LOCALES) {
      const own = await loadEditionMessages("mezo", locale);
      expect(Object.keys(own).sort(), locale).toEqual(Object.keys(en).sort());
    }
  });

  it("keeps the Mezo keys out of the catalogue every page carries", async () => {
    for (const locale of LOCALES) {
      const core = locale === "en" ? EN : await loadMessages(locale);
      expect(Object.keys(core).filter((key) => key.startsWith("mezo.")), locale).toEqual([]);
    }
  });
});
