// SPDX-License-Identifier: MIT
/**
 * The brand artwork (`brand/`): the master mark is the app's mark (apps/web/public/icons/mark.svg, v1's favicon and
 * `brandMark()`) drawn on a 1024 grid, exactly ×32, plus the LED glow of its laterite dot; every colour of the mark,
 * the social card and the screenshot frame is a v1 token; the SVG is inert (no script, no foreign content, no external
 * reference) so it can be inlined anywhere; the templates load only this package's fonts and the mark.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { customProperties, read, REPO } from "./css.ts";

const mark = read("brand/mark.svg");
const favicon = readFileSync(join(REPO, "apps/web/public/icons/mark.svg"), "utf8");

/** The numeric attributes of the first `<tag …>` whose attributes match `filter`, by name. */
function element(svg: string, tag: string, filter: (attrs: string) => boolean = () => true): Map<string, string> {
  for (const [, attrs = ""] of svg.matchAll(new RegExp(`<${tag}\\b([^>]*)/?>`, "g"))) {
    if (filter(attrs)) {
      return new Map([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name = "", value = ""]) => [name, value]));
    }
  }
  throw new Error(`no <${tag}> matches`);
}

/** The numbers in an attribute, rounded to 1e-6 (so 2.6 × 32 compares equal to 83.2). */
const numbers = (value: string | undefined): number[] => [...(value ?? "").matchAll(/-?\d+(?:\.\d+)?/g)].map(([n]) => Number(n));
const round = (values: number[]): number[] => values.map((v) => Math.round(v * 1e6) / 1e6);
/** v1's light, dark-media and data-theme colours (tokens.css), upper case. */
const tokens = new Set([...read("src/tokens.css").matchAll(/#[0-9A-Fa-f]{6}\b/g)].map(([c]) => c.toUpperCase()));

describe("master mark", () => {
  it("is the app's mark at ×32 on a 1024 grid", () => {
    expect(element(mark, "svg").get("viewBox")).toBe("0 0 1024 1024");
    expect(element(favicon, "svg").get("viewBox")).toBe("0 0 32 32");
    const scaled = (attrs: Map<string, string>, names: readonly string[]): number[] => round(names.flatMap((n) => numbers(attrs.get(n)).map((v) => v * 32)));
    const exact = (attrs: Map<string, string>, names: readonly string[]): number[] => round(names.flatMap((n) => numbers(attrs.get(n))));
    const isTile = (a: string): boolean => !a.includes("bezel");
    expect(exact(element(mark, "rect", isTile), ["width", "height", "rx"])).toEqual(scaled(element(favicon, "rect"), ["width", "height", "rx"]));
    // The arc's rotation and its two flags (indices 4 to 6 of "M x y A rx ry rotation large sweep x y") are not lengths.
    expect(exact(element(mark, "path"), ["d", "stroke-width"])).toEqual(scaled(element(favicon, "path"), ["d", "stroke-width"]).map((v, i) => ([4, 5, 6].includes(i) ? v / 32 : v)));
    const origin = (a: string): boolean => a.includes("stroke=");
    const dot = (a: string): boolean => a.includes('fill="#FF5A1F"');
    for (const pick of [origin, dot]) {
      expect(exact(element(mark, "circle", pick), ["cx", "cy", "r", "stroke-width"])).toEqual(scaled(element(favicon, "circle", pick), ["cx", "cy", "r", "stroke-width"]));
    }
  });

  it("keeps the app's colours: graphite tile, paper arc and ring, laterite dot", () => {
    for (const [selector, tag] of [["tile", "rect"], ["arc", "path"], ["origin", "circle"], ["dot", "circle"]] as const) {
      const ours = element(mark, tag, (a) => a.includes(`class="${selector}"`));
      const app = element(favicon, tag, (a) => (selector === "origin" ? a.includes("stroke=") : selector === "dot" ? a.includes("#FF5A1F") : true));
      for (const attribute of ["fill", "stroke"]) {
        expect(ours.get(attribute)?.toUpperCase(), `${selector} ${attribute}`).toBe(app.get(attribute)?.toUpperCase());
      }
    }
  });

  it("uses v1 token colours only, and the glow is the laterite dot's own colour", () => {
    for (const [colour] of mark.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
      expect(tokens.has(colour.toUpperCase()), colour).toBe(true);
    }
    expect([...mark.matchAll(/stop-color="([^"]+)"/g)].map(([, c]) => c)).toEqual(["#FF5A1F", "#FF5A1F"]);
  });

  it("is inert: no script, foreign content, style attribute, event handler or external reference", () => {
    expect(mark).not.toMatch(/<script|<foreignObject|<image|\sstyle=|\son\w+=|href=|https?:\/\/(?!www\.w3\.org\/2000\/svg")/i);
    expect([...mark.matchAll(/url\(([^)]*)\)/g)].map(([, ref]) => ref)).toEqual(["#paylink-mark-glow"]);
  });
});

describe("social card and screenshot frame", () => {
  for (const file of ["brand/social-card.html", "brand/frame.html"]) {
    const html = read(file);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";

    it(`${file}: every colour is a v1 token (rgba only for laterite glows and black shadows)`, () => {
      for (const [colour] of style.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
        expect(tokens.has(colour.toUpperCase()), colour).toBe(true);
      }
      for (const [rgba] of style.matchAll(/rgba\([^)]*\)/g)) {
        expect(rgba, rgba).toMatch(/^rgba\((?:255, ?90, ?31|0, ?0, ?0|14, ?14, ?13), ?[.\d]+\)$/);
      }
      expect(customProperties(style, /:root\s*\{/).get("--signal")).toBe("#FF5A1F");
    });

    it(`${file}: loads only this package's fonts, the mark and the committed screenshots`, () => {
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"|url\("([^"]+)"\)/g)].map(([, a, b]) => a ?? b ?? "");
      for (const ref of refs) {
        expect(ref, ref).toMatch(/^(?:mark\.svg|\.\.\/fonts\/[\w-]+\.woff2|\.\.\/\.\.\/\.\.\/docs\/submissions\/assets\/screens\/[\w-]+\.png)$/);
      }
      expect(html).not.toMatch(/<script/i);
    });
  }
});
