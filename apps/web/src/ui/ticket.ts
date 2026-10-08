// SPDX-License-Identifier: MIT
/**
 * The receive card (v1 `.ticket` + `.lamba`): printed on paper in both themes, so a photo or a screenshot of it
 * explains itself. It shows what the payer will check: the amount, the memo, the payee's address grouped by four, the
 * network and the expiry, and the QR code of the payment link with the link printed under it: in full on paper (the
 * typed fallback when a QR code cannot be scanned), as a deliberate short form with a visible ellipsis on screen, where
 * the share field above holds the whole link to copy.
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

const printable = (url: string): string => url.replace(/^https?:\/\//, "");

/** `host/pay/#2.10143.AAAA…kEqJH`: the start (host, path, version, chain) and the last 8 characters, never a silent cut. */
export function shortLink(url: string): string {
  const text = printable(url);
  const hash = text.indexOf("#");
  const head = hash === -1 ? text.slice(0, 32) : text.slice(0, Math.min(text.length, hash + 1 + text.slice(hash + 1).split(".").slice(0, 2).join(".").length + 5));
  const tail = text.slice(-8);
  return head.length + tail.length + 1 >= text.length ? text : `${head}…${tail}`;
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
      h(
        "div",
        { class: "scan-cap" },
        h("b", null, content.scan),
        h("span", null, content.scanSub),
        h("code", { class: "printed-url" }, h("span", { class: "printed-url-short" }, shortLink(content.url)), h("span", { class: "printed-url-full" }, printable(content.url))),
      ),
    ),
  );
}
