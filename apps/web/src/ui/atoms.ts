// SPDX-License-Identifier: MIT
/**
 * Small pieces of the Precision Terminal, built with `h()`: instrument numerals, units, lamps, grouped addresses and
 * hashes, the status line with its engraved error code, external links.
 */
import type { Address, Hex } from "viem";
import { addressGroups, figureWidth, spokenAddress } from "../core/format.ts";
import { h, replace, svg } from "./h.ts";
import type { Child } from "./h.ts";

/** Instrument numerals, sized by their length (`--n`, v1). */
export function num(text: string, extra?: string): HTMLSpanElement {
  return h("span", { class: ["num", extra], vars: { "--n": figureWidth(text) } }, text);
}

export function unit(text: string): HTMLSpanElement {
  return h("span", { class: "unit" }, text);
}

export type LampKind = "open" | "paid" | "closed" | "ok" | "off" | "wait" | "err" | "busy" | "fee" | "overdue";

export function lamp(kind: LampKind, text: string, pill = false): HTMLSpanElement {
  return h("span", { class: [pill ? "pill" : "lamp", kind] }, text);
}

/**
 * An address in two rows of five groups, first and last groups bold (v1 `.addr`). The visual groups are hidden from
 * assistive technology, which reads one sentence instead: the groups separated by pauses (spec §3.10). `title` keeps
 * the full address for hover and long-press.
 */
export function addr(address: Address, label?: string): HTMLElement {
  const groups = addressGroups(address);
  const spoken = label === undefined ? spokenAddress(address) : `${label}: ${spokenAddress(address)}`;
  return h(
    "code",
    { class: "addr", attrs: { title: address } },
    groups.map((g, i) => h("span", { class: i === 0 || i === groups.length - 1 ? "end" : null, attrs: { "aria-hidden": "true" } }, g)),
    h("span", { class: "sr-only" }, spoken),
  );
}

/** A 32-byte hash or key in groups of four, wrapping between groups only. */
export function hexGroups(value: Hex): HTMLElement {
  const body = value.slice(2).match(/.{1,4}/g) ?? [];
  return h(
    "code",
    { class: "hex", attrs: { title: value } },
    h("span", { class: "hex-0x" }, "0x"),
    body.map((g, i) => h("span", { class: i === body.length - 1 ? "end" : null }, g)),
  );
}

/** An external link: new tab, no referrer, the drawn arrow. */
export function ext(href: string, label: Child): HTMLAnchorElement {
  return h("a", { class: "ext", attrs: { href, target: "_blank", rel: "noopener noreferrer" } }, label);
}

export type StatusKind = "" | "ok" | "err" | "warn";

/**
 * Sets a status line: one LED and a mono message, with the support code engraved under it ("Error code SoldOut").
 * `role="status"` with `aria-live="polite"` is set by `statusLine()`; errors also move into an alert.
 */
export function setStatus(element: HTMLElement, kind: StatusKind, message: string, code?: string): void {
  element.className = ["status", kind].filter((c) => c !== "").join(" ");
  replace(element, message, code === undefined ? null : h("span", { class: "code" }, code));
  element.setAttribute("role", kind === "err" ? "alert" : "status");
}

export function statusLine(): HTMLElement {
  return h("div", { class: "status", attrs: { role: "status", "aria-live": "polite" } });
}

/** The brand mark: tile, arc, origin and the laterite dot (v1). */
export function brandMark(): SVGSVGElement {
  return svg(
    "svg",
    { class: "mark", viewBox: "0 0 32 32", "aria-hidden": "true", focusable: "false" },
    svg("rect", { class: "tile", width: "32", height: "32", rx: "8" }),
    svg("path", { class: "arc", d: "M9 23A14 14 0 0 1 23 9", fill: "none", "stroke-width": "2.6" }),
    svg("circle", { class: "origin", cx: "9", cy: "23", r: "2.6", "stroke-width": "2" }),
    svg("circle", { class: "dot", cx: "23", cy: "9", r: "3.8" }),
  );
}

/** A labelled fact row for `<dl class="facts">` and friends. */
export function fact(term: Child, ...value: Child[]): HTMLDivElement {
  return h("div", null, h("dt", null, term), h("dd", null, ...value));
}
