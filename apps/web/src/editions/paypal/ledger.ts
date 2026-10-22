// SPDX-License-Identifier: MIT
/**
 * The ledger's rail column (docs/paypal/SPEC.md §14.2 F7): on each invoice that has a PayPal twin, the engraved rails
 * it can be paid on (`PAYPAL` and its token), the one that paid it marked, and the twin's PayPal number; the CSV gains
 * `rail` and `paypal_invoice`. An invoice PayPal says is paid (S2) while the chain does not reads as paid on its row
 * ("Paid on PayPal · PL-…", the filters agree), and its amount adds up apart, as received on PayPal: the core totals
 * are the chain's and say so (`ledger.tally`, `ledger.footing` in PAYPAL_COPY).
 *
 * The chain decides the token rail (the ledger's own state); PayPal's side is what the API last read with PayPal's GET,
 * cached on this device (`twins.ts`) and read again here when a desk session is already open (no signature is asked
 * for on the ledger). A twin this device never saw shows its rails without a number.
 *
 * Owner: web edition workstream.
 */
import type { App } from "../../app/context.ts";
import type { LedgerRow } from "../../read/ledger.ts";
import type { LedgerFilter } from "../../read/ledger.ts";
import { displayAmount } from "../../core/format.ts";
import { lamp, num, unit } from "../../ui/atoms.ts";
import { h, replace } from "../../ui/h.ts";
import { getTwin } from "./api.ts";
import { apiFor } from "./context.ts";
import { twinnable } from "./rails.ts";
import { storedSession } from "./session.ts";
import { cachedTwin, rememberTwin } from "./twins.ts";
import type { CachedTwin } from "./twins.ts";

/** Twins read again per ledger view, at most (the API's per-request work stays small). */
const REFRESH_LIMIT = 20;

const chainPaid = (row: Pick<LedgerRow, "status">): boolean => row.status === "paid" || row.status === "sold-out";

/**
 * What PayPal's last read says of a row the chain does not show paid: `paid` (a payment on PayPal, S2), `marked` (the
 * merchant marked it paid on PayPal), or null. A chain payment wins: PayPal then shows PayLink's own record of it.
 */
export function paypalPaid(row: Pick<LedgerRow, "status">, twin: Pick<CachedTwin, "statusClass"> | null): "paid" | "marked" | null {
  if (twin === null || chainPaid(row)) {
    return null;
  }
  return twin.statusClass === "paid" ? "paid" : twin.statusClass === "paid-outside" ? "marked" : null;
}

/** The rail that paid the row: the token (the chain), PayPal (its GET), or none yet. */
export function paidRail(row: Pick<LedgerRow, "status" | "link">, twin: Pick<CachedTwin, "statusClass"> | null): string | null {
  if (chainPaid(row)) {
    return row.link.token.symbol;
  }
  return paypalPaid(row, twin) === null ? null : "PAYPAL";
}

/** The ledger's filter in this edition: a row paid on PayPal is paid (and closed), never open. */
export function matchesPaypalFilter(row: LedgerRow, filter: LedgerFilter, core: (row: LedgerRow, filter: LedgerFilter) => boolean): boolean {
  if (paypalPaid(row, cachedTwin(row.link.key)) !== "paid") {
    return core(row, filter);
  }
  return filter !== "open";
}

/** The two CSV columns the edition adds, for one row. */
export function railColumns(row: Pick<LedgerRow, "status" | "link">): readonly [string, string] {
  const twin = cachedTwin(row.link.key);
  return [paidRail(row, twin) ?? "", twin?.number ?? ""];
}

export const RAIL_CSV_COLUMNS = ["rail", "paypal_invoice"] as const;

function paint(cell: HTMLElement, row: LedgerRow, twin: CachedTwin | null, t: App["i18n"]["t"]): void {
  const paid = paidRail(row, twin);
  const rails = twinnable(row.link) || twin !== null ? ["PAYPAL", row.link.token.symbol] : [row.link.token.symbol];
  cell.setAttribute("data-paid", paid ?? "");
  replace(
    cell,
    rails.map((rail) => h("span", { class: ["rail-tag", rail === paid ? "is-on" : null], attrs: { title: rail === paid ? t("paypal.ledger.paidOn", { rail }) : null } }, rail)),
    twin === null ? null : h("span", { class: "twin-no", attrs: { title: t("paypal.ledger.twin") } }, twin.number),
  );
  // Paid on PayPal while the chain is still open: the row's chip and line say so (never "Awaiting payment").
  const onPaypal = paypalPaid(row, twin);
  const item = cell.closest("li");
  if (onPaypal === null || twin === null || item === null) {
    return;
  }
  item.classList.remove("is-open", "is-closed");
  item.classList.add("is-paid");
  item.setAttribute("data-paypal", onPaypal);
  item.querySelector(".row-main > .pill")?.replaceWith(lamp("paid", onPaypal === "paid" ? t("paypal.ledger.paidPaypal") : t("paypal.ledger.markedPaypal"), true));
  const meta = item.querySelector(".row-meta");
  if (meta !== null) {
    meta.textContent = onPaypal === "paid" ? t("paypal.ledger.paidMeta", { number: twin.number }) : t("paypal.ledger.markedMeta", { number: twin.number });
  }
}

/** Where the ledger's totals are drawn: the tally window and the footing, both the chain's. */
export interface LedgerTotals {
  readonly tally: HTMLElement;
  readonly footing: HTMLElement;
}

/** Adds "received on PayPal" beside the chain's totals: the signed amounts of the invoices PayPal says are paid. */
export function paintPaypalTotals(app: App, rows: readonly LedgerRow[], totals: LedgerTotals): void {
  const paid = rows.filter((row) => paypalPaid(row, cachedTwin(row.link.key)) === "paid");
  const total = paid.reduce((sum, row) => sum + row.link.invoice.amount, 0n);
  const label = `USD · ${app.i18n.t("paypal.ledger.receivedPaypal")}`;
  totals.tally.querySelector("[data-paypal-total]")?.remove();
  totals.footing.querySelector("[data-paypal-total]")?.remove();
  const first = paid[0];
  if (first === undefined) {
    return;
  }
  const text = displayAmount(total, first.link.token, app.locale);
  totals.tally.querySelector(".tally-sum")?.append(h("div", { class: "tally-line", attrs: { "data-paypal-total": "" } }, num(text), unit(label)));
  totals.footing.querySelector(".footing-sum")?.append(h("span", { attrs: { "data-paypal-total": "" } }, num(text), unit(label)));
}

/** Fills the rail cells (`[data-rail-cell]`, left empty by the ledger) of the shown rows from this device's cache. */
export function paintRails(app: App, rows: readonly LedgerRow[], root: ParentNode): void {
  for (const row of rows) {
    const cell = root.querySelector<HTMLElement>(`[data-rail-cell="${row.link.key}"]`);
    if (cell !== null) {
      paint(cell, row, cachedTwin(row.link.key), app.i18n.t);
    }
  }
}

/** Reads the twins of the shown rows again when a desk session is open, and repaints their cells (and `changed()`). */
export function refreshRails(app: App, rows: readonly LedgerRow[], root: ParentNode, changed: () => void = () => undefined): void {
  const api = apiFor(app);
  const account = app.session.account();
  const token = account === null ? null : storedSession(account.address);
  if (api === null || token === null) {
    return;
  }
  for (const row of rows.filter((r) => twinnable(r.link)).slice(0, REFRESH_LIMIT)) {
    void getTwin(api, token, row.link.key)
      .then((twin) => {
        rememberTwin(twin);
        const cell = root.querySelector<HTMLElement>(`[data-rail-cell="${row.link.key}"]`);
        if (cell !== null) {
          paint(cell, row, cachedTwin(row.link.key), app.i18n.t);
        }
        changed();
      })
      .catch(() => undefined);
  }
}
