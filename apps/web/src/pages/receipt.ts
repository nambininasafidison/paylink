// SPDX-License-Identifier: MIT
/**
 * `/r/#2.<chainId>.<txHash>.<logIndex>[.<inv>.<sig>[.<memo>]]`: a receipt anyone can verify (invoice spec §12).
 *
 * Every opening re-reads the transaction receipt from the registry's RPCs: it must have succeeded, the log at that
 * index must be a well-formed `Paid` event of the canonical deployment, in an allowlisted token, and, when the link
 * carries the invoice, its key, payee, token and amount must match. The slip states what that proves, never a bare
 * "valid"; "could not check" is never shown as either valid or invalid. Prints on an 80 mm roll or on A6.
 */
import { decodeReceiptFragment, fragmentOf, sanitizeMemoForDisplay, verifyReceipt } from "@paylink/sdk";
import type { DecodedReceiptLink, ReceiptProof } from "@paylink/sdk";
import { formatDateTime } from "@paylink/i18n";
import type { PageDefinition } from "../app/boot.ts";
import { networkName, plateText } from "../app/chains.ts";
import type { App } from "../app/context.ts";
import { intro, notes } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { decodeUiError } from "../core/errors.ts";
import { displayAmount, shortHex } from "../core/format.ts";
import { receiptUrl } from "../core/links.ts";
import { receiptId } from "../store/db.ts";
import { addr, ext, fact, hexGroups, setStatus, statusLine } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { copyText, printElement } from "../ui/live.ts";
import { receiptSlip } from "../ui/receipt.ts";

export const receiptPage: PageDefinition = {
  route: "receipt",
  payer: true,
  title: "receipt.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(
      intro({ kicker: t("receipt.voice.kicker"), title: [t("receipt.voice.h1a"), t("receipt.voice.h1b")], lede: t("receipt.voice.lede") }),
      intro({ voice: "unverified", kicker: t("receipt.voice.invalid.kicker"), title: [t("receipt.voice.invalid.h1a"), t("receipt.voice.invalid.h1b")], lede: t("receipt.voice.invalid.lede") }),
      intro({ voice: "offline", kicker: t("receipt.voice.offline.kicker"), title: [t("receipt.voice.offline.h1a"), t("receipt.voice.offline.h1b")], lede: t("receipt.voice.offline.lede") }),
    );
    ui.aside.append(
      notes(t("receipt.notes.title"), [
        [t("receipt.notes.proves"), t("receipt.notes.provesText")],
        [t("receipt.notes.identity"), t("receipt.notes.identityText")],
      ]),
    );
    const view = h("section", { class: "view view-receipt", attrs: { "aria-labelledby": "receipt-head" } });
    ui.views.append(view);
    const show = (): void => {
      void renderReceipt(app, ui, view);
    };
    window.addEventListener("hashchange", show);
    show();
  },
};

async function renderReceipt(app: App, ui: PageUi, view: HTMLElement): Promise<void> {
  const { t } = app.i18n;
  ui.voice(null);
  const head = h("div", { class: "view-head" }, h("h2", { attrs: { id: "receipt-head" } }, t("receipt.head")));
  const status = statusLine();
  const fragment = fragmentOf(location.href);
  if (fragment === "") {
    ui.plate(t("receipt.plate.empty"), "off");
    replace(view, head, h("p", { class: "state-note" }, t("receipt.empty")));
    return;
  }
  let decoded: DecodedReceiptLink;
  try {
    decoded = decodeReceiptFragment(fragment, app.registry);
  } catch (error) {
    ui.voice("unverified");
    ui.plate(t("pay.plate.invalid"), "err");
    const problem = decodeUiError(app, error);
    setStatus(status, "err", problem.message, problem.code);
    replace(view, head, status);
    return;
  }
  const chain = decoded.target.chain;
  ui.plate(plateText(chain), "wait");
  setStatus(status, "", t("receipt.checking", { network: networkName(chain) }));
  replace(view, head, status);
  const client = app.client(chain);
  let verification: Awaited<ReturnType<typeof verifyReceipt>>;
  try {
    verification = await verifyReceipt({ registry: app.registry, client, reference: decoded, ...(decoded.invoice === null ? {} : { paid: decoded.invoice }) });
  } catch {
    ui.voice("offline");
    setStatus(status, "warn", t("receipt.unreachable", { network: networkName(chain) }));
    view.append(h("div", { class: "key-row" }, h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { void renderReceipt(app, ui, view); } } }, t("common.retry"))));
    return;
  }
  if (!verification.valid) {
    ui.voice("unverified");
    ui.plate(plateText(chain), "err");
    const message = app.i18n.lookup(verification.i18nKey, verification.params) ?? t("error.unknown");
    setStatus(status, "err", message, t("common.errorCode", { code: verification.failure }));
    return;
  }
  ui.plate(plateText(chain), "ok");
  setStatus(status, "ok", verification.proof.finality === "finalized" ? t("receipt.status.final") : t("receipt.status.confirmed"));
  const account = app.session.account();
  if (account !== null && account.address.toLowerCase() === verification.proof.payee.toLowerCase()) {
    await app.store.putReceipt({
      id: receiptId(decoded.chainId, decoded.txHash, decoded.logIndex),
      chainId: decoded.chainId,
      txHash: decoded.txHash,
      logIndex: decoded.logIndex,
      role: "received",
      invoiceKey: verification.proof.key,
      payee: verification.proof.payee,
      payer: verification.proof.payer,
      token: verification.proof.token,
      amount: verification.proof.amount.toString(),
      blockTime: Number(verification.proof.timestamp),
      fragment,
      savedAt: Date.now(),
    });
  }
  view.append(...proofView(app, decoded, verification.proof, fragment));
}

function proofView(app: App, decoded: DecodedReceiptLink, proof: ReceiptProof, fragment: string): HTMLElement[] {
  const { t } = app.i18n;
  const chain = decoded.target.chain;
  const token = proof.tokenInfo;
  const explorer = chain.explorers[0];
  const memo = proof.memo === null ? null : sanitizeMemoForDisplay(proof.memo);
  const slip = receiptSlip({
    top: t("receipt.top"),
    verdict: t("receipt.approved"),
    valid: true,
    amount: displayAmount(proof.amount, token, app.locale),
    symbol: token.symbol,
    rows: [
      ...(memo === null ? [] : [[t("receipt.for"), memo] as const]),
      [t("receipt.to"), shortHex(proof.payee)],
      [t("receipt.from"), shortHex(proof.payer)],
      [t("receipt.time"), formatDateTime(app.locale, proof.timestamp)],
      [t("receipt.network"), `${chain.label} · ${String(chain.chainId)}`],
      [t("receipt.tx"), explorer === undefined ? shortHex(proof.txHash) : ext(`${explorer.url}/tx/${proof.txHash}`, shortHex(proof.txHash))],
    ],
    checks: [
      ["ok", t("receipt.check.paid")],
      ["ok", t("receipt.check.contract")],
      [proof.invoice === null ? "off" : "ok", proof.invoice === null ? t("receipt.check.noInvoice") : t("receipt.check.invoice")],
      [proof.finality === "finalized" ? "ok" : "wait", proof.finality === "finalized" ? t("receipt.finalized") : t("receipt.confirmed")],
    ],
    foot: t("receipt.foot", { network: networkName(chain) }),
    label: t("receipt.label"),
  });
  const url = receiptUrl(app.site, fragment);
  const copy = h("button", { class: "key key-line", attrs: { type: "button" } }, t("receipt.copy"));
  copy.addEventListener("click", () => {
    void copyText(url, copy, { idle: t("receipt.copy"), done: t("share.copied"), said: t("receipt.copiedSaid") });
  });
  return [
    slip,
    h(
      "div",
      { class: "share-keys" },
      h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { printElement(slip, "80mm"); } } }, t("receipt.print80")),
      h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { printElement(slip, "a6"); } } }, t("receipt.printA6")),
      copy,
      explorer === undefined ? null : h("a", { class: "key key-line ext", attrs: { href: `${explorer.url}/tx/${proof.txHash}`, target: "_blank", rel: "noopener noreferrer" } }, t("receipt.explorer")),
    ),
    h(
      "details",
      { class: "details" },
      h("summary", null, t("details.title")),
      h(
        "dl",
        null,
        fact(t("receipt.to"), addr(proof.payee)),
        fact(t("receipt.from"), addr(proof.payer)),
        fact(t("details.chain"), `${networkName(chain)} · ${chain.caip2}`),
        fact(t("details.contract"), proof.contract),
        fact(t("details.token"), `${token.symbol} · ${token.address}`),
        fact(t("details.key"), hexGroups(proof.key)),
        fact(t("details.tx"), hexGroups(proof.txHash)),
        fact(t("details.block"), proof.blockNumber.toString()),
        fact(t("details.logIndex"), String(proof.logIndex)),
        fact(t("details.payerRef"), hexGroups(proof.payerRef)),
      ),
    ),
  ];
}
