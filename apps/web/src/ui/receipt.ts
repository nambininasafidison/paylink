// SPDX-License-Identifier: MIT
/**
 * The receipt slip (v1 `.receipt` + `.perf`): it prints out of the terminal's printer slot, on paper in both themes,
 * with a zig-zag tear edge. It states what the chain proves (amount, payee, payer, time, transaction) and the three
 * checks behind "Approved"; an invalid receipt says so in red instead.
 */
import { lamp, num, unit } from "./atoms.ts";
import type { LampKind } from "./atoms.ts";
import { h } from "./h.ts";
import type { Child } from "./h.ts";

export interface SlipContent {
  readonly top: string;
  readonly verdict: string;
  readonly valid: boolean;
  readonly amount: string;
  readonly symbol: string;
  readonly rows: readonly (readonly [string, Child])[];
  readonly checks: readonly (readonly [LampKind, string])[];
  readonly foot: string;
  readonly label: string;
}

export function receiptSlip(content: SlipContent): HTMLElement {
  return h(
    "div",
    { class: "receipt-wrap" },
    h(
      "div",
      { class: "receipt", attrs: { role: "group", "aria-label": content.label } },
      h("div", { class: "receipt-top" }, h("span", null, content.top), h("b", { class: content.valid ? null : "is-err" }, content.verdict)),
      h("div", { class: "receipt-amt" }, num(content.amount), unit(content.symbol)),
      h("dl", null, content.rows.map(([term, value]) => h("div", null, h("dt", null, term), h("dd", null, value)))),
      content.checks.length === 0 ? null : h("div", { class: "checks-mini" }, content.checks.map(([kind, text]) => lamp(kind, text))),
      h("p", { class: "receipt-foot" }, content.foot),
    ),
  );
}
