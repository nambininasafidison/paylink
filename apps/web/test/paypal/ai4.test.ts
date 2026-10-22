// SPDX-License-Identifier: MIT
/**
 * AI-4 (docs/paypal/SPEC.md §9.3): no model text on the signing display, the lamps, the till verdict, the receipt or
 * the "Was I really paid?" verdict. Model text reaches the page in exactly two places, the draft card and a proposal's
 * message, and both render it in a box marked `data-ai`; this test holds the source to that:
 *
 * - only `editions/paypal/assistant.ts` and `editions/paypal/desk.ts` write a `data-ai` attribute, and in `desk.ts`
 *   only the assistant's note does, never the exact-values grid or the verdict;
 * - the money screens' modules import nothing from the edition's AI-facing modules or its API client;
 * - the pay page's rail chooser writes only fixed words and code-computed values (no API text, no `data-ai`).
 *
 * And the edition's stylesheet keeps the design system's palette: tokens only, no colour literal.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../../src");
const read = (path: string): string => readFileSync(join(SRC, path), "utf8");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** The body of a top-level `export function name(…) { … }` in `source` (to the next top-level declaration). */
function body(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = source.slice(start + 1).search(/\n(?:export )?(?:async )?(?:function|const|interface|type) /);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

const MONEY_SCREENS = ["ui/signing.ts", "pages/till.ts", "pages/receipt.ts", "app/proof-slip.ts", "read/checks.ts", "ui/ticket.ts"];

describe("AI-4: model text stays out of the money screens", () => {
  it("is written into a data-ai box by two modules only", () => {
    const writers = files(SRC)
      .filter((f) => f.endsWith(".ts") && readFileSync(f, "utf8").includes('"data-ai"'))
      .map((f) => relative(SRC, f))
      .sort();
    expect(writers).toEqual(["editions/paypal/assistant.ts", "editions/paypal/desk.ts"]);
  });

  it("marks the draft card and the assistant's note, and neither the exact-values grid nor any verdict", () => {
    const assistant = read("editions/paypal/assistant.ts");
    expect(body(assistant, "draftCard")).toContain('"data-ai": "draft"');
    const desk = read("editions/paypal/desk.ts");
    expect(body(desk, "assistantNote")).toContain('"data-ai": "message"');
    for (const name of ["exactGrid", "verdictReadout", "alertCard", "recordCard"]) {
      expect(body(desk, name), name).not.toContain("data-ai");
      // A proposal's `message` is the only model text the API carries; failures' own `.message` is fixed i18n text.
      expect(body(desk, name), name).not.toMatch(/\b(proposal|answer|record|alert|value)\.message\b|message\.text/);
    }
    // The grid renders `exact` values (computed by code) and fixed labels; the message is rendered by assistantNote only.
    expect(body(desk, "proposalCard")).toContain("assistantNote(app, proposal.message)");
    expect(body(desk, "exactGrid")).not.toContain(".text");
  });

  it("keeps the money screens' modules free of the AI-facing modules and the API client", () => {
    for (const path of MONEY_SCREENS) {
      const source = read(path);
      expect(source, path).not.toMatch(/editions\/paypal\/(assistant|desk|api|session|context)\.ts/);
      expect(source, path).not.toContain("data-ai");
    }
  });

  it("lets the rail chooser show only fixed words and values computed by code", () => {
    const rails = read("editions/paypal/rails.ts");
    expect(rails).not.toContain("data-ai");
    expect(rails).not.toMatch(/editions\/paypal\/(assistant|desk)\.ts|from "\.\/(assistant|desk)\.ts"/);
    // The URL is followed only as an href it validated; no answer of the API is ever shown as text.
    expect(rails).not.toMatch(/rails\.(url|status|amount)\s*[,)]\s*$/m);
  });
});

describe("the edition's stylesheet", () => {
  it("uses the design system's tokens and no colour literal", () => {
    const css = read("editions/paypal/paypal.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|color-mix)\(/i);
    const tokens = readFileSync(join(SRC, "../../../packages/design/src/tokens.css"), "utf8");
    for (const [, name] of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
      expect(tokens, name).toContain(`${name ?? ""}:`);
    }
    expect(css.trim().startsWith("@layer components {")).toBe(true);
  });

  it("is loaded by the edition's own boot branch and imported by no shared module", () => {
    const importers = files(SRC)
      .filter((f) => /\.(ts|css)$/.test(f) && /paypal\.css["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(importers).toEqual(["editions/paypal/style.ts"]);
    expect(read("app/boot.ts")).toMatch(/__PAYLINK_EDITION__ === "paypal" \? import\("\.\.\/editions\/paypal\/style\.ts"\)/);
  });
});
