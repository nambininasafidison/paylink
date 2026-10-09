// SPDX-License-Identifier: MIT
/**
 * `/ledger/`: the payee's books (ADR 0009). Invoices signed on this device by the connected wallet, each state read from
 * the chain (`statesOf`, chain time), a tally of what they brought in per token, filters, CSV export, and the actions
 * v1 had: copy the link, open it, put it on the till, and cancel it: gaslessly when the relayer serves the chain (the
 * payee signs `Cancel`, the relayer submits `cancelBySig`), else with one `cancel` transaction from the payee and the
 * registry's clamped gas limit (`app/cancel.ts`). Receipts of payments made from this device follow.
 */
import { invoiceKind } from "@paylink/sdk";
import { formatDateTime } from "@paylink/i18n";
import type { PageDefinition } from "../app/boot.ts";
import { cancelInvoice } from "../app/cancel.ts";
import { networkName } from "../app/chains.ts";
import { passkeyLayerOf } from "../app/passkey-layer.ts";
import { booksPanel } from "../books/panel.ts";
import type { Edition } from "@paylink/chains";
import type { App } from "../app/context.ts";
import { intro, notes, routeHref } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { pickWallet } from "../app/wallet-ui.ts";
import { decodeUiError } from "../core/errors.ts";
import { displayAmount, figureWidth, shortHex } from "../core/format.ts";
import { payUrl, receiptUrl, tillUrl } from "../core/links.ts";
import { ledgerCsv } from "../read/csv.ts";
import { matchesFilter, readLedger, rowLamp } from "../read/ledger.ts";
import type { LedgerFilter, LedgerRow, LedgerSnapshot, RowLabel } from "../read/ledger.ts";
import { parseStoredReceipt } from "../store/db.ts";
import { encodeInvoiceFragment } from "@paylink/sdk";
import { lamp, num, setStatus, statusLine, unit } from "../ui/atoms.ts";
import { segmented } from "../ui/controls.ts";
import { h, replace } from "../ui/h.ts";
import { announce, copyText, download } from "../ui/live.ts";
import type { PlainMessageKey } from "@paylink/i18n";

/** The edition this build serves (ADR 0008): a constant, so the other editions' bundles drop the ledger backup. */
declare const __PAYLINK_EDITION__: Edition;

const LABEL_KEY: Readonly<Record<RowLabel, PlainMessageKey>> = {
  open: "ledger.lamp.open",
  paid: "ledger.lamp.paid",
  soldOut: "ledger.lamp.soldOut",
  overdue: "ledger.lamp.overdue",
  expired: "ledger.lamp.expired",
  cancelled: "ledger.lamp.cancelled",
  scheduled: "ledger.lamp.scheduled",
  unconfirmed: "ledger.lamp.unconfirmed",
};

export const ledgerPage: PageDefinition = {
  route: "ledger",
  payer: false,
  title: "ledger.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(intro({ kicker: t("ledger.kicker"), title: [t("ledger.h1")], lede: t("ledger.lede") }));
    ui.aside.append(
      h(
        "aside",
        { class: "about", attrs: { "aria-labelledby": "lights" } },
        h("h2", { class: "eyebrow", attrs: { id: "lights" } }, t("ledger.legend.title")),
        h(
          "dl",
          { class: "legend" },
          h("div", null, h("dt", null, lamp("open", t("ledger.lamp.open"))), h("dd", null, t("ledger.legend.open"))),
          h("div", null, h("dt", null, lamp("paid", t("ledger.lamp.paid"))), h("dd", null, t("ledger.legend.paid"))),
          h("div", null, h("dt", null, lamp("overdue", t("ledger.lamp.overdue"))), h("dd", null, t("ledger.legend.overdue"))),
          h("div", null, h("dt", null, lamp("closed", t("ledger.lamp.closed"))), h("dd", null, t("ledger.legend.closed"))),
        ),
      ),
      notes(t("ledger.notes.title"), [
        [t("ledger.notes.device"), t("ledger.notes.deviceText")],
        [t("ledger.notes.cancel"), t("ledger.notes.cancelText")],
      ]),
    );
    const section = h("section", { class: "view view-ledger", attrs: { "aria-labelledby": "ledger-head" } });
    ui.views.append(section);
    // Re-read the books when the connected address changes, not on every wallet event.
    let shown: string | null | undefined;
    const show = (): void => {
      const address = app.session.account()?.address ?? null;
      if (address !== shown) {
        shown = address;
        void renderLedger(app, ui, section);
      }
    };
    app.session.subscribe(show);
    void app.session.ready.then(show);
    // Monad edition: the PayLink key's second key backs these books up and restores them (ADR 0016). The build
    // constant drops the panel from the other editions' bundles.
    const passkeys = __PAYLINK_EDITION__ === "monad" ? passkeyLayerOf(app) : null;
    if (passkeys !== null) {
      ui.views.append(booksPanel(app, passkeys, { restored: () => { shown = undefined; show(); } }));
    }
  },
};

let filter: LedgerFilter = "all";

async function renderLedger(app: App, ui: PageUi, section: HTMLElement): Promise<void> {
  const { t } = app.i18n;
  const account = app.session.account();
  const head = h("div", { class: "view-head" }, h("h2", { attrs: { id: "ledger-head" } }, t("ledger.head")), h("span", { class: "view-meta" }, account === null ? "" : shortHex(account.address)));
  ui.plate(t("ledger.plate"), account === null ? "off" : "wait");
  if (account === null) {
    replace(
      section,
      head,
      h("div", { class: "empty-state" }, h("p", null, t("ledger.connect")), h("button", { class: "key key-primary", attrs: { type: "button" }, on: { click: () => { void pickWallet(app); } } }, t("app.connect"))),
    );
    return;
  }
  replace(section, head, h("p", { class: "loading", attrs: { role: "status" } }, t("ledger.reading")));
  const snapshot = await readLedger({ store: app.store, registry: app.registry, clientFor: (chain) => app.client(chain), payee: account.address, role: "issued" });
  ui.plate(t("ledger.plate"), snapshot.unreachable.length > 0 ? "wait" : "ok");
  const status = statusLine();
  const list = h("ul", { class: "links" });
  const paint = (): void => {
    const rows = snapshot.rows.filter((row) => matchesFilter(row, filter));
    replace(list, rows.length === 0 ? h("li", { class: "is-message" }, t("ledger.emptyFilter")) : rows.map((row) => ledgerRow(app, row, status, () => { void renderLedger(app, ui, section); })));
  };
  if (snapshot.rows.length === 0) {
    replace(
      section,
      head,
      h("div", { class: "empty-state" }, h("p", null, t("ledger.empty")), h("a", { class: "key key-primary", attrs: { href: routeHref(app, "create") } }, t("ledger.createFirst"))),
      await receiptsBlock(app),
    );
    return;
  }
  const filterSeg = segmented<LedgerFilter>(
    "filter",
    t("ledger.filter"),
    [
      { value: "all", label: t("ledger.filter.all") },
      { value: "open", label: t("ledger.filter.open") },
      { value: "paid", label: t("ledger.filter.paid") },
      { value: "closed", label: t("ledger.filter.closed") },
    ],
    filter,
    (value) => {
      filter = value;
      paint();
    },
  );
  filterSeg.element.classList.add("ledger-filter");
  const exportKey = h(
    "button",
    {
      class: "key key-line",
      attrs: { type: "button" },
      on: {
        click: () => {
          const csv = ledgerCsv(snapshot.rows, (row) => payUrl(app.site, encodeInvoiceFragment(row.link)));
          download(`paylink-ledger-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8", csv);
        },
      },
    },
    t("ledger.export"),
  );
  paint();
  replace(
    section,
    head,
    tally(app, snapshot),
    h("div", { class: "ledger-tools" }, filterSeg.element, exportKey),
    snapshot.unreachable.map((chainId) => h("p", { class: "warn-note" }, t("ledger.unreachable", { network: networkName(app.registry.getOrThrow(chainId)) }))),
    snapshot.skipped > 0 ? h("p", { class: "field-hint" }, app.i18n.plural("ledger.skipped", snapshot.skipped, {})) : null,
    h("div", { class: "ledger-head", attrs: { "aria-hidden": "true" } }, h("span", null, t("ledger.cols.invoice")), h("span", null, t("ledger.cols.amount"))),
    list,
    footing(app, snapshot),
    status,
    app.config.indexer === null ? null : h("p", { class: "field-hint" }, t("ledger.history")),
    await receiptsBlock(app),
  );
}

function tally(app: App, snapshot: LedgerSnapshot): HTMLElement {
  const { t } = app.i18n;
  const lines = snapshot.totals.length === 0 ? [{ text: "0.00", symbol: "" }] : snapshot.totals.map((x) => ({ text: displayAmount(x.total, x.token, app.locale), symbol: `${x.token.symbol} · ${x.chain.label}` }));
  return h(
    "div",
    { class: "tally screen" },
    h("span", { class: "tally-label" }, t("ledger.tally")),
    h("div", { class: "tally-sum" }, lines.map((line) => h("div", { class: "tally-line" }, num(line.text), line.symbol === "" ? null : unit(line.symbol)))),
    h(
      "div",
      { class: "tally-sub" },
      h("span", null, h("b", null, String(snapshot.rows.length)), " ", app.i18n.plural("ledger.invoicesWord", snapshot.rows.length, {})),
      h("span", null, h("b", null, String(snapshot.open)), " ", app.i18n.plural("ledger.openWord", snapshot.open, {})),
    ),
  );
}

function footing(app: App, snapshot: LedgerSnapshot): HTMLElement {
  const { t } = app.i18n;
  return h(
    "div",
    { class: "footing" },
    h("span", { class: "footing-label" }, t("ledger.footing")),
    h(
      "span",
      { class: "footing-sum" },
      snapshot.totals.map((x) => h("span", null, num(displayAmount(x.total, x.token, app.locale)), unit(x.token.symbol))),
    ),
  );
}

function ledgerRow(app: App, row: LedgerRow, status: HTMLElement, reload: () => void): HTMLLIElement {
  const { t } = app.i18n;
  const { link, state, chain } = row;
  const invoice = link.invoice;
  const { lamp: lampKind, label } = rowLamp(row);
  const fragment = encodeInvoiceFragment(link);
  const url = payUrl(app.site, fragment);
  const copy = h("button", { class: "key key-text", attrs: { type: "button" } }, t("share.copy"));
  copy.addEventListener("click", () => {
    void copyText(url, copy, { idle: t("share.copy"), done: t("share.copied"), said: t("share.copiedSaid") });
  });
  const kind = invoiceKind(invoice);
  const title = link.memo ?? (kind === "receive-card" ? t("ticket.card") : invoice.amount === 0n ? t("ledger.row.openAmount") : t("ticket.invoice"));
  const payments = state?.payments ?? 0;
  const meta =
    state === null
      ? t("ledger.row.unconfirmed")
      : payments === 0
        ? row.status === "payable"
          ? t("ledger.row.awaiting")
          : t("ledger.row.noPayments")
        : invoice.maxPayments > 1
          ? t("ledger.row.seats", { paid: payments, max: invoice.maxPayments })
          : app.i18n.plural("ledger.row.payments", payments, {});
  const when =
    invoice.validUntil === 0n
      ? null
      : h("span", { class: "when", attrs: { title: formatDateTime(app.locale, invoice.validUntil) } }, (row.status === "expired" ? t("ledger.row.expired", { date: formatDateTime(app.locale, invoice.validUntil, { dateStyle: "medium" }) }) : t("ledger.row.expires", { date: formatDateTime(app.locale, invoice.validUntil, { dateStyle: "medium" }) })));
  const price = invoice.amount === 0n ? h("span", { class: "price any" }, t("ticket.any")) : [num(displayAmount(invoice.amount, link.token, app.locale), "price"), h("span", { class: "unit-mini" }, link.token.symbol)];
  const credited = state !== null && state.total > 0n ? displayAmount(state.total, link.token, app.locale) : null;
  const cancelKey = row.status === "payable" ? cancelButton(app, row, status, reload) : null;
  return h(
    "li",
    { class: `is-${lampKind === "open" || lampKind === "busy" ? "open" : lampKind === "paid" ? "paid" : "closed"}` },
    h(
      "div",
      { class: "row-main" },
      lamp(lampKind, t(LABEL_KEY[label]), true),
      h("span", { class: "row-band" }, chain.label),
      h("p", { class: "row-memo" }, title),
      h("p", { class: "row-meta" }, meta, when === null ? null : [h("span", { class: "sr-only" }, ", "), when]),
    ),
    h(
      "div",
      { class: "row-amt" },
      price,
      credited === null ? null : h("span", { class: "credit", vars: { "--n": figureWidth(`+${credited}`) } }, h("span", { class: "sr-only" }, t("ledger.row.received", { amount: credited, symbol: link.token.symbol })), h("span", { attrs: { "aria-hidden": "true" } }, `+${credited}`)),
    ),
    h(
      "div",
      { class: "row-foot" },
      h("div", { class: "row-actions" }, cancelKey, copy, h("a", { class: "key key-text", attrs: { href: url } }, t("ledger.row.view")), row.status === "payable" ? h("a", { class: "key key-text", attrs: { href: tillUrl(app.site, fragment) } }, t("ledger.row.till")) : null),
    ),
  );
}

/** Cancel in two presses (the first arms it for five seconds), then gasless `cancelBySig` or the payee's `cancel`. */
function cancelButton(app: App, row: LedgerRow, status: HTMLElement, reload: () => void): HTMLButtonElement {
  const { t } = app.i18n;
  let armed = 0;
  const key = h("button", { class: "key key-text key-danger", attrs: { type: "button" } }, t("ledger.row.cancel"));
  key.addEventListener("click", () => {
    if (armed === 0) {
      key.textContent = t("ledger.row.cancelConfirm");
      armed = window.setTimeout(() => {
        armed = 0;
        key.textContent = t("ledger.row.cancel");
      }, 5000);
      return;
    }
    window.clearTimeout(armed);
    armed = 0;
    key.disabled = true;
    void (async () => {
      try {
        const account = app.session.account();
        if (account === null) {
          return;
        }
        await cancelInvoice(app, row.link, account, (step) => {
          switch (step) {
            case "sign":
              setStatus(status, "", account.kind === "passkey" ? t("ledger.cancel.fingerprint") : t("ledger.cancel.sign"));
              break;
            case "relayed":
              setStatus(status, "", t("ledger.cancel.relayed"));
              break;
            case "confirm":
              setStatus(status, "", t("ledger.cancel.confirm"));
              break;
            case "sent":
              setStatus(status, "", t("ledger.cancel.sent"));
              break;
          }
        });
        setStatus(status, "ok", t("ledger.cancel.done"));
        // The books are re-read from the chain and redrawn: say it through the live region too, since the redraw
        // replaces this status line.
        announce(t("ledger.cancel.done"));
        reload();
      } catch (error) {
        const decoded = decodeUiError(app, error);
        setStatus(status, "err", decoded.message, decoded.code);
        key.disabled = false;
        key.textContent = t("ledger.row.cancel");
      }
    })();
  });
  return key;
}

/** Payments made from this device, newest first, each a link to its verifiable receipt. */
async function receiptsBlock(app: App): Promise<HTMLElement | null> {
  const { t } = app.i18n;
  const receipts = (await app.store.listReceipts()).map(parseStoredReceipt).filter((r) => r !== null && r.role === "paid");
  if (receipts.length === 0) {
    return null;
  }
  receipts.sort((a, b) => (b?.savedAt ?? 0) - (a?.savedAt ?? 0));
  return h(
    "div",
    { class: "receipts-block" },
    h("div", { class: "sub-head" }, h("h3", null, t("ledger.receipts")), h("span", { class: "view-meta" }, String(receipts.length))),
    h(
      "ul",
      { class: "links" },
      receipts.map((r) => {
        if (r === null) {
          return null;
        }
        const chain = app.registry.get(r.chainId);
        const token = chain === undefined ? undefined : app.registry.findToken(r.chainId, r.token);
        const amount = token === undefined ? r.amount : displayAmount(BigInt(r.amount), token, app.locale);
        return h(
          "li",
          { class: "is-paid" },
          h("div", { class: "row-main" }, lamp("paid", t("ledger.lamp.paid"), true), chain === undefined ? null : h("span", { class: "row-band" }, chain.label), h("p", { class: "row-memo" }, t("ledger.receipt.to", { payee: shortHex(r.payee) })), h("p", { class: "row-meta" }, formatDateTime(app.locale, r.blockTime))),
          h("div", { class: "row-amt" }, num(amount, "price"), h("span", { class: "unit-mini" }, token?.symbol ?? "")),
          h("div", { class: "row-foot" }, h("div", { class: "row-actions" }, h("a", { class: "key key-text", attrs: { href: receiptUrl(app.site, r.fragment) } }, t("ledger.receipt.open")))),
        );
      }),
    ),
  );
}
