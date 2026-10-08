// SPDX-License-Identifier: MIT
/**
 * The signing display (PAYLINK-V2-SPEC §3.6 "SigningDisplay"): a dark display window that states exactly what the
 * next signature approves, before the prompt. A passkey shows no wallet popup, so for a PayLink key this window is the
 * only place the payer or the seller reads what their fingerprint signs: amount, recipient grouped by four with any
 * saved name, network, validity. It is a labelled region whose readings are a description list, so a screen reader
 * reads the same facts in the same order.
 */
import { fact } from "./atoms.ts";
import { h } from "./h.ts";
import type { Child } from "./h.ts";

export interface SigningContent {
  /** Engraved line, left ("Your key will sign"). */
  readonly kicker: string;
  /** Engraved line, right (the chain's band label). */
  readonly band: string;
  readonly title: string;
  /** The amount reading first (big), then the facts. */
  readonly amount: { readonly label: string; readonly value: string; readonly unit: string | null } | null;
  readonly rows: readonly (readonly [string, Child])[];
  readonly note: string;
}

let sequence = 0;

export function signingDisplay(content: SigningContent): HTMLElement {
  sequence += 1;
  const titleId = `signing-${String(sequence)}`;
  return h(
    "section",
    { class: "screen signing", attrs: { "aria-labelledby": titleId } },
    h("div", { class: "screen-top" }, h("span", null, content.kicker), h("span", null, content.band)),
    h("h3", { attrs: { id: titleId } }, content.title),
    h(
      "dl",
      { class: "readings" },
      content.amount === null
        ? null
        : h("div", { class: "is-amount" }, h("dt", null, content.amount.label), h("dd", null, content.amount.value, content.amount.unit === null ? null : h("span", { class: "unit" }, content.amount.unit))),
      content.rows.map(([term, value]) => fact(term, value)),
    ),
    h("p", { class: "signing-note" }, content.note),
  );
}
