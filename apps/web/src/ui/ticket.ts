// SPDX-License-Identifier: MIT
/**
 * The receive card (v1 `.ticket` + `.lamba`): printed on paper in both themes, so a photo or a screenshot of it
 * explains itself. It shows what the payer will check: the amount, the memo, the payee's address grouped by four, the
 * network and the expiry, and the QR code of the payment link with the link printed under it.
 */
import type { Address } from "viem";
import { addr, num, unit } from "./atoms.ts";
import { h } from "./h.ts";
import { qrSvg } from "./qr.ts";

export interface TicketContent {
  readonly kind: string;
  /** Formatted amount, or `null` for an open amount. */
  readonly amount: string | null;
  readonly symbol: string;
  readonly anyAmount: string;
  readonly memo: string | null;
  readonly payee: Address;
  readonly payeeLabel: string;
  /** Engraved terms line: network, expiry, seats. */
  readonly terms: readonly string[];
  readonly url: string;
  readonly scan: string;
  readonly scanSub: string;
  readonly qrLabel: string;
  readonly cardLabel: string;
}

export function ticket(content: TicketContent): HTMLElement {
  return h(
    "div",
    { class: "ticket", attrs: { role: "group", "aria-label": content.cardLabel } },
    h("div", { class: "lamba", attrs: { "aria-hidden": "true" } }),
    h("div", { class: "ticket-top" }, h("span", { class: "ticket-brand" }, "PayLink"), h("span", null, content.kind)),
    h("div", { class: "ticket-amt" }, content.amount === null ? num(content.anyAmount, "any") : [num(content.amount), unit(content.symbol)]),
    content.memo === null ? null : h("p", { class: "ticket-memo" }, content.memo),
    h("div", { class: "ticket-payee" }, addr(content.payee, content.payeeLabel)),
    h("p", { class: "ticket-terms" }, content.terms.map((term) => h("span", null, term))),
    h("div", { class: "perf", attrs: { "aria-hidden": "true" } }),
    h(
      "div",
      { class: "ticket-scan" },
      h("div", { class: "qr-frame" }, qrSvg(content.url, content.qrLabel)),
      h("div", { class: "scan-cap" }, h("b", null, content.scan), h("span", null, content.scanSub), h("code", { class: "printed-url" }, content.url.replace(/^https?:\/\//, ""))),
    ),
  );
}
