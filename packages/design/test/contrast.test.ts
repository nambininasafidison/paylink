// SPDX-License-Identifier: MIT
/**
 * WCAG 2.2 AA contrast of the documented token pairs (PAYLINK-V2-SPEC §3.10 "Contrast taken from the documented
 * tokens"): text pairs at least 4.5:1, non-text UI (field edges, LEDs on their windows) at least 3:1, in both themes.
 */
import { describe, expect, it } from "vitest";
import { customProperties, read } from "./css.ts";

const tokens = read("src/tokens.css");
const v2 = tokens.slice(tokens.indexOf("/* END v1 tokens */"));
const light = new Map([...customProperties(tokens, /:root\s*\{/), ...customProperties(v2, /:root\s*\{/)]);
const dark = new Map([
  ...light,
  ...customProperties(tokens, /:root\[data-theme="dark"\]\s*\{/),
  ...customProperties(v2, /:root\[data-theme="dark"\]\s*\{/),
]);

function luminance(hex: string): number {
  const digits = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const value = (theme: Map<string, string>, name: string): string => {
  const v = theme.get(name);
  if (v === undefined || !/^#[0-9A-Fa-f]{6}$/.test(v)) {
    throw new Error(`${name} is not a 6-digit hex colour: ${String(v)}`);
  }
  return v;
};

/** [foreground, background, minimum]. */
const TEXT: [string, string][] = [
  ["--ink", "--bg"], ["--ink", "--panel"], ["--ink-2", "--panel"], ["--muted", "--panel"], ["--muted", "--well"], ["--muted", "--bg"],
  ["--signal-ink", "--panel"], ["--signal-ink", "--bg"], ["--ok", "--panel"], ["--err", "--panel"], ["--warn", "--panel"], ["--warn", "--well"],
  ["--screen-ink", "--screen"], ["--screen-dim", "--screen"], ["--lcd-ok", "--screen"], ["--screen-warn", "--screen"], ["--screen-err", "--screen"],
  ["--on-signal", "--signal"], ["--slip-ink", "--slip"], ["--slip-muted", "--slip"],
];
// Field edges (--rule-2) are measured against the surface the field sits on, the panel, where v1 documents 3.3:1
// (WCAG 1.4.11: the boundary against its adjacent colour); against the well inside the field they reach 2.99:1.
const NON_TEXT: [string, string][] = [
  ["--rule-2", "--panel"], ["--focus", "--panel"], ["--focus", "--bg"], ["--signal", "--screen"],
  ["--led-ok", "--screen"], ["--led-wait", "--screen"], ["--led-err", "--screen"],
];

describe("documented contrast", () => {
  for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
    it(`text pairs reach 4.5:1 in ${name}`, () => {
      for (const [fg, bg] of TEXT) {
        const ratio = contrast(value(theme, fg), value(theme, bg));
        expect(ratio, `${fg} on ${bg}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`UI component pairs reach 3:1 in ${name}`, () => {
      for (const [fg, bg] of NON_TEXT) {
        const ratio = contrast(value(theme, fg), value(theme, bg));
        expect(ratio, `${fg} on ${bg}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("matches the ratios v1 documents next to its tokens", () => {
    expect(contrast(value(light, "--muted"), value(light, "--panel"))).toBeCloseTo(5.9, 0);
    expect(contrast(value(light, "--screen-dim"), value(light, "--screen"))).toBeCloseTo(6.1, 0);
    expect(contrast(value(light, "--on-signal"), value(light, "--signal"))).toBeCloseTo(6.3, 0);
    expect(contrast(value(light, "--signal-ink"), value(light, "--panel"))).toBeCloseTo(6, 0);
  });
});
