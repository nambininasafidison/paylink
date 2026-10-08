// SPDX-License-Identifier: MIT
/**
 * PAYLINK-V2-SPEC §3.6 "Design continuity": packages/design copies the v1 web/paylink.css tokens verbatim. The block
 * between the BEGIN and END markers must be byte-identical to lines 12-81 of the frozen v1 stylesheet, and the v2
 * additions may not redefine any v1 token.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { customProperties, read, REPO, stripComments } from "./css.ts";

const v1 = readFileSync(join(REPO, "web/paylink.css"), "utf8");
const tokens = read("src/tokens.css");

function v1Block(): string {
  return v1.split("\n").slice(11, 81).join("\n");
}

function copiedBlock(): string {
  const begin = tokens.indexOf("/* BEGIN v1 tokens (web/paylink.css) */\n");
  const end = tokens.indexOf("/* END v1 tokens */");
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return tokens.slice(begin + "/* BEGIN v1 tokens (web/paylink.css) */\n".length, end).replace(/\n$/, "");
}

describe("tokens.css", () => {
  it("copies the v1 token block byte for byte", () => {
    expect(v1Block().startsWith("/* ---------- Tokens: light = paper + graphite ---------- */")).toBe(true);
    expect(v1Block().endsWith("}")).toBe(true);
    expect(copiedBlock()).toBe(v1Block());
  });

  it("keeps the v1 light, dark-media and data-theme token sets identical", () => {
    const light = customProperties(v1, /:root\s*\{/);
    const copiedLight = customProperties(copiedBlock(), /:root\s*\{/);
    expect(copiedLight).toEqual(light);
    const dark = customProperties(v1, /:root:not\(\[data-theme="light"\]\)\s*\{/);
    const forced = customProperties(v1, /:root\[data-theme="dark"\]\s*\{/);
    // v1's two dark blocks must agree with each other, and the copy carries both.
    expect(forced).toEqual(dark);
    expect(customProperties(copiedBlock(), /:root\[data-theme="dark"\]\s*\{/)).toEqual(dark);
    expect(light.get("--signal")).toBe("#FF5A1F");
    expect(light.get("--led-ok")).toBe("#22C866");
    expect(light.get("--led-wait")).toBe("#FFB000");
    expect(light.get("--led-err")).toBe("#FF3B2E");
  });

  it("adds v2 tokens without redefining a v1 token", () => {
    const additions = tokens.slice(tokens.indexOf("/* END v1 tokens */"));
    const v1Names = new Set(customProperties(v1, /:root\s*\{/).keys());
    const added = [...stripComments(additions).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) {
      expect(v1Names.has(name ?? ""), `${String(name)} is a v1 token`).toBe(false);
    }
  });

  it("puts every token in the tokens layer", () => {
    const text = stripComments(tokens).trim();
    expect(text.startsWith("@layer tokens {")).toBe(true);
    expect(text.endsWith("}")).toBe(true);
  });
});
