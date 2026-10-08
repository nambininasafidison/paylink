// SPDX-License-Identifier: MIT
/**
 * CSS architecture (PAYLINK-V2-SPEC §3.6): `@layer reset, tokens, base, components, utilities`, every rule inside one
 * of those layers, laterite as the only signal colour (no new colour literals beyond v1's palette), and the
 * accessibility switches v1 had (reduced motion, forced colours).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { read, REPO, stripComments } from "./css.ts";

const LAYERS = ["reset", "tokens", "base", "components", "utilities"];
const LAYERED = ["reset.css", "tokens.css", "base.css", "components.css", "print.css", "utilities.css"];

/** Top-level statements of a stylesheet (brace-balanced), comments removed. */
function topLevel(css: string): string[] {
  const text = stripComments(css);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        out.push(text.slice(start, i + 1).trim());
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  return out.filter((s) => s !== "");
}

describe("cascade layers", () => {
  it("declares the layer order once, before importing every part", () => {
    const statements = topLevel(read("src/index.css"));
    expect(statements[0]).toBe(`@layer ${LAYERS.join(", ")};`);
    expect(statements.slice(1)).toEqual(["fonts.css", ...LAYERED].map((f) => `@import "./${f}";`));
  });

  for (const file of LAYERED) {
    it(`${file} puts every rule in a declared layer`, () => {
      for (const statement of topLevel(read(`src/${file}`))) {
        const layer = /^@layer ([a-z]+) \{/.exec(statement)?.[1];
        expect(layer !== undefined && LAYERS.includes(layer), statement.slice(0, 80)).toBe(true);
      }
    });
  }

  it("fonts.css holds only @font-face rules", () => {
    for (const statement of topLevel(read("src/fonts.css"))) {
      expect(statement.startsWith("@font-face {")).toBe(true);
    }
  });
});

describe("palette", () => {
  const v1Colours = new Set([...readFileSync(join(REPO, "web/paylink.css"), "utf8").matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map((m) => m[0].toUpperCase()));
  const tokenColours = new Set([...read("src/tokens.css").matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0].toUpperCase()));
  /** Literals that are not colours of the interface: QR black on white, and the CSS keyword-like data-URI fills. */
  const allowed = new Set(["#FFF", "#000", "#0000", "#000000", "#FFFFFF"]);

  it("uses no colour literal outside v1's palette and the tokens (laterite is the only signal colour)", () => {
    for (const file of ["components.css", "base.css", "print.css", "utilities.css"]) {
      const css = stripComments(read(`src/${file}`)).replace(/url\("data:[^"]*"\)/g, "");
      for (const [literal] of css.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
        const colour = literal.toUpperCase();
        expect(v1Colours.has(colour) || tokenColours.has(colour) || allowed.has(colour), `${file}: ${literal}`).toBe(true);
      }
    }
  });

  it("keeps v1's reduced-motion and forced-colours switches", () => {
    const css = read("src/components.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (forced-colors: active)");
  });
});
