// SPDX-License-Identifier: MIT
/**
 * The ledger's "Payments received" block (ADR 0009, spec §3.8): what the connected payee received on the edition's
 * chains, from the history service (apps/indexer, Envio) when `/config.json` names one, else from the latest blocks of
 * the chains' own RPCs, else "history unavailable". Every row opens a receipt that the receipt page verifies on RPC;
 * nothing here changes an invoice's state on the tape above, which comes from `statesOf` only.
 *
 * Also the payee's record ("N payments received since <date> · M payers") and, from the device's own invoices, the
 * typical time to get paid (read/settle.ts). The words are the `history` feature catalogue, loaded with the block, so
 * the catalogue every page carries (the pay route's first load included) does not grow with them.
 */
import { encodeReceiptFragment } from "@paylink/sdk";
import { featureTranslator, formatDateTime } from "@paylink/i18n";
import type { Translator } from "@paylink/i18n";
import type { Address } from "viem";
import { networkName } from "../app/chains.ts";
import type { App } from "../app/context.ts";
import { durationText } from "../core/duration.ts";
import { displayAmount, shortHex } from "../core/format.ts";
import { receiptUrl } from "../core/links.ts";
import { activitySource, readPayeeActivity, trustFigures } from "../read/activity.ts";
import type { ActivityPayment, PayeeActivity } from "../read/activity.ts";
import type { IndexerClient } from "../read/indexer.ts";
import type { LedgerRow, LedgerSnapshot } from "../read/ledger.ts";
import { paidLogReader } from "../read/paid-reader.ts";
import { firstPaidKey, medianSettleTime } from "../read/settle.ts";
import { lamp, num } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";

/**
 * The block, drawn at once with a "reading" line and filled when the history arrives (the tape above never waits for
 * it). `snapshot` is the ledger's chain-confirmed view of this device's invoices, or `null` when there are none.
 */
export function activityBlock(app: App, payee: Address, snapshot: LedgerSnapshot | null): HTMLElement {
  const heading = h("h3");
  const body = h("div", { class: "activity-body" });
  // Hidden until its words are loaded: never an empty heading.
  const block = h("div", { class: "receipts-block activity", attrs: { hidden: true } }, h("div", { class: "sub-head" }, heading), body);
  const source = activitySource(app, paidLogReader);
  const reading = readPayeeActivity(source, payee);
  void (async () => {
    let tr: Translator;
    try {
      tr = await featureTranslator(app.locale, "history");
    } catch {
      // The words could not be loaded (offline before the chunk was cached): the history is optional, the tape is not.
      block.remove();
      return;
    }
    heading.textContent = tr.t("history.head");
    replace(body, h("p", { class: "loading", attrs: { role: "status" } }, tr.t("history.reading")));
    block.hidden = false;
    try {
      const activity = await reading;
      const settle = await settleLine(tr, source.indexer, activity, snapshot);
      replace(body, ...activityView(app, tr, activity, snapshot), settle);
    } catch {
      // readPayeeActivity never throws; anything else (a row that cannot be drawn) must not leave "Reading…" forever.
      replace(body, h("p", { class: "warn-note" }, tr.t("history.unavailable")));
    }
  })();
  return block;
}

/** The record line, the source note and the list of payments. */
function activityView(app: App, tr: Translator, activity: PayeeActivity, snapshot: LedgerSnapshot | null): (HTMLElement | null)[] {
  const { t } = tr;
  if (activity.source === "none") {
    return [h("p", { class: "warn-note" }, t("history.unavailable"))];
  }
  const record =
    activity.source === "indexer"
      ? indexedRecord(app, tr, activity)
      : activity.payments.length === 0
        ? t("history.noneRecent", { duration: durationText(tr, maxWindow(activity.windows)) })
        : tr.plural("history.recent", activity.payments.length, { duration: durationText(tr, maxWindow(activity.windows)) });
  const note = activity.source === "indexer" ? t("history.sourceIndexer") : t("history.sourceChain");
  return [
    h("p", { class: "activity-record" }, record),
    activity.source === "indexer" ? volumes(app, tr, activity) : null,
    h("p", { class: "field-hint" }, note),
    activity.payments.length === 0 ? null : h("ul", { class: "links" }, activity.payments.map((p) => paymentRow(app, tr, p, snapshot))),
  ];
}

function maxWindow(windows: readonly { readonly seconds: bigint }[]): bigint {
  return windows.reduce((max, w) => (w.seconds > max ? w.seconds : max), 0n);
}

function indexedRecord(app: App, tr: Translator, activity: Extract<PayeeActivity, { source: "indexer" }>): string {
  const figures = trustFigures(activity.summaries);
  if (figures.payments === 0 || figures.since === null) {
    return tr.t("history.none");
  }
  return [
    tr.plural("history.since", figures.payments, { date: formatDateTime(app.locale, figures.since, { dateStyle: "medium" }) }),
    tr.plural("history.payers", figures.payers, {}),
  ].join(" · ");
}

/** Volume per listed token and chain, from the history service. Tokens outside the registry are not totalled. */
function volumes(app: App, tr: Translator, activity: Extract<PayeeActivity, { source: "indexer" }>): HTMLElement | null {
  const lines = activity.summaries.flatMap((summary) => {
    const chain = app.registry.get(summary.chainId);
    return summary.tokens.flatMap((v) => {
      const token = app.registry.findToken(summary.chainId, v.token);
      return chain === undefined || token === undefined ? [] : [h("span", null, num(displayAmount(v.volume, token, app.locale)), " ", h("span", { class: "unit-mini" }, `${token.symbol} · ${chain.label}`))];
    });
  });
  return lines.length === 0 ? null : h("p", { class: "activity-volumes" }, h("span", { class: "sr-only" }, `${tr.t("history.volumes")}: `), lines);
}

/** One payment: the device's memo when this device issued the link, the payer, the time and a receipt to verify. */
function paymentRow(app: App, tr: Translator, payment: ActivityPayment, snapshot: LedgerSnapshot | null): HTMLLIElement {
  const { t } = tr;
  const chain = app.registry.get(payment.chainId);
  const token = app.registry.findToken(payment.chainId, payment.token);
  const own: LedgerRow | undefined = snapshot?.rows.find((row) => row.link.chainId === payment.chainId && row.link.key.toLowerCase() === payment.key);
  const title = own?.link.memo ?? t("history.link", { key: shortHex(payment.key, 6, 4), number: payment.index + 1 });
  const amount = token === undefined ? payment.amount.toString() : displayAmount(payment.amount, token, app.locale);
  const fragment = encodeReceiptFragment({ chainId: payment.chainId, txHash: payment.txHash, logIndex: payment.logIndex }, own?.link);
  const when = payment.timestamp === null ? t("history.block", { block: payment.blockNumber.toString() }) : formatDateTime(app.locale, payment.timestamp);
  return h(
    "li",
    { class: "is-paid" },
    h(
      "div",
      { class: "row-main" },
      lamp("paid", t("ledger.lamp.paid"), true),
      chain === undefined ? null : h("span", { class: "row-band" }, chain.label),
      h("p", { class: "row-memo" }, title),
      h("p", { class: "row-meta" }, t("history.from", { payer: shortHex(payment.payer) }), h("span", { class: "sr-only" }, ", "), " · ", when),
    ),
    h("div", { class: "row-amt" }, num(amount, "price"), h("span", { class: "unit-mini" }, token?.symbol ?? t("history.units"))),
    h(
      "div",
      { class: "row-foot" },
      h("div", { class: "row-actions" }, h("a", { class: "key key-text", attrs: { href: receiptUrl(app.site, fragment), "aria-label": t("history.verifyOn", { network: chain === undefined ? String(payment.chainId) : networkName(chain) }) } }, t("history.verify"))),
    ),
  );
}

/**
 * "Typical time to get paid", over the invoices this device issued and the chain shows paid. Multi-payment links get
 * their first payment time from the history service when it has them; one-off invoices need only the chain.
 */
async function settleLine(tr: Translator, indexer: IndexerClient | null, activity: PayeeActivity, snapshot: LedgerSnapshot | null): Promise<HTMLElement | null> {
  if (snapshot === null) {
    return null;
  }
  const firstPaid = new Map<string, bigint>();
  if (indexer !== null && activity.source === "indexer") {
    const byChain = new Map<number, LedgerRow[]>();
    for (const row of snapshot.rows) {
      if (row.state !== null && row.state.payments > 0 && row.link.invoice.maxPayments !== 1) {
        byChain.set(row.link.chainId, [...(byChain.get(row.link.chainId) ?? []), row]);
      }
    }
    await Promise.all(
      [...byChain].map(async ([chainId, rows]) => {
        try {
          for (const first of await indexer.firstPayments(chainId, rows.map((r) => r.link.key))) {
            if (first.firstPaidAt !== null) {
              firstPaid.set(firstPaidKey(chainId, first.key), first.firstPaidAt);
            }
          }
        } catch {
          // Without the history service, multi-payment links are left out of the median (read/settle.ts).
        }
      }),
    );
  }
  const settle = medianSettleTime(snapshot.rows, firstPaid);
  return settle === null ? null : h("p", { class: "activity-settle" }, tr.plural("history.settle", settle.count, { duration: durationText(tr, settle.median) }));
}
