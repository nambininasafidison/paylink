// SPDX-License-Identifier: MIT
/**
 * The ledger's rail column (docs/paypal/SPEC.md §14.2 F7): on each invoice that has a PayPal twin, the engraved rails
 * it can be paid on (`PAYPAL` and its token), the one that paid it marked, and the twin's PayPal number; the CSV gains
 * `rail` and `paypal_invoice`.
 *
 * The chain decides the token rail (the ledger's own state); PayPal's side is what the API last read with PayPal's GET,
 * cached on this device (`twins.ts`) and read again here when a desk session is already open (no signature is asked
 * for on the ledger). A twin this device never saw shows its rails without a number.
 *
 * Owner: web edition workstream.
 */
import type { App } from "../../app/context.ts";
import type { LedgerRow } from "../../read/ledger.ts";
import { h, replace } from "../../ui/h.ts";
import { getTwin } from "./api.ts";
import { apiFor } from "./context.ts";
import { twinnable } from "./rails.ts";
import { storedSession } from "./session.ts";
import { cachedTwin, rememberTwin } from "./twins.ts";
import type { CachedTwin } from "./twins.ts";

/** Twins read again per ledger view, at most (the API's per-request work stays small). */
const REFRESH_LIMIT = 20;

/** The rail that paid the row: PayPal (its GET), the token (the chain), or none yet. */
export function paidRail(row: Pick<LedgerRow, "status" | "link">, twin: Pick<CachedTwin, "statusClass"> | null): string | null {
  if (twin !== null && (twin.statusClass === "paid" || twin.statusClass === "paid-outside")) {
    return "PAYPAL";
  }
  return row.status === "paid" || row.status === "sold-out" ? row.link.token.symbol : null;
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

/** Reads the twins of the shown rows again when a desk session is open, and repaints their cells. */
export function refreshRails(app: App, rows: readonly LedgerRow[], root: ParentNode): void {
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
      })
      .catch(() => undefined);
  }
}
