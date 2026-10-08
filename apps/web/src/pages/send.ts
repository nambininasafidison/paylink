// SPDX-License-Identifier: MIT
/**
 * `/send/`: receive cards and the address book (Agora "send AUSD across borders", spec §2.1 T1 "Receive card and
 * Send").
 *
 * - **Your receive card**: the account's open-amount, unlimited invoice (signed on this device, still open on the
 *   chain), shown as the printable card with its QR code, the link, WhatsApp, the share sheet, print and "watch on the
 *   till". Without one, "Create my receive card" opens the terminal preset for it (one signature, no gas).
 * - **Contacts**: a label on an address plus their receive card. "Send" opens the card's pay view, where the payer types
 *   an amount and pays (gaslessly where the relayer serves the chain). A card is decoded and checked against the
 *   registry before it is saved; the label is what the payer view shows as "Saved as: …" (identity comes from the
 *   user, not from the signature, spec §3.6).
 */
import { decodeInvoiceFragment, encodeInvoiceFragment, fragmentOf, readLinkStates } from "@paylink/sdk";
import type { PageDefinition } from "../app/boot.ts";
import type { App } from "../app/context.ts";
import { intro, notes, routeHref } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { pickWallet } from "../app/wallet-ui.ts";
import { AppError, decodeUiError } from "../core/errors.ts";
import { payUrl, tillUrl, whatsappUrl } from "../core/links.ts";
import { parseStoredContact, parseStoredInvoice } from "../store/db.ts";
import type { ContactRecord } from "../store/db.ts";
import { addr, setStatus, statusLine } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { announce, copyText, printElement } from "../ui/live.ts";
import { ticket } from "../ui/ticket.ts";

const MAX_LABEL = 64;

export const sendPage: PageDefinition = {
  route: "send",
  payer: false,
  title: "send.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(intro({ kicker: t("send.kicker"), title: [t("send.h1a"), t("send.h1b")], lede: t("send.lede") }));
    ui.aside.append(
      notes(t("send.notes.title"), [
        [t("send.notes.card"), t("send.notes.cardText")],
        [t("send.notes.labels"), t("send.notes.labelsText")],
      ]),
    );
    ui.plate(t("send.plate"), "ok");
    const section = h("section", { class: "view view-send", attrs: { "aria-labelledby": "send-head" } });
    ui.views.append(section);
    void renderSend(app, ui, section);
  },
};

async function renderSend(app: App, ui: PageUi, section: HTMLElement): Promise<void> {
  const { t } = app.i18n;
  const contacts = (await app.store.listContacts()).map(parseStoredContact).filter((c): c is ContactRecord => c !== null);
  contacts.sort((a, b) => a.label.localeCompare(b.label, app.i18n.tag));
  const status = statusLine();
  const name = h("input", { attrs: { id: "contact-name", maxlength: String(MAX_LABEL), autocomplete: "off", placeholder: t("send.namePlaceholder") } });
  const card = h("input", { attrs: { id: "contact-card", autocomplete: "off", spellcheck: "false", placeholder: t("send.cardPlaceholder"), "aria-describedby": "card-hint" } });
  const save = h("button", { class: "key key-primary", attrs: { type: "button" } }, t("send.save"));
  save.addEventListener("click", () => {
    void (async () => {
      try {
        const label = name.value.trim();
        if (label === "" || label.length > MAX_LABEL) {
          name.focus();
          throw new AppError("send.error.name", { max: MAX_LABEL });
        }
        const raw = card.value.trim();
        const fragment = raw.includes("#") ? fragmentOf(raw) : raw;
        let payee;
        try {
          payee = decodeInvoiceFragment(fragment, app.registry).invoice.payee;
        } catch (error) {
          card.focus();
          setStatus(status, "err", t("send.error.card"), decodeUiError(app, error).code);
          return;
        }
        await app.store.putContact({ address: payee, label, card: fragment, updatedAt: Date.now() });
        announce(t("send.saved", { name: label }));
        await renderSend(app, ui, section);
      } catch (error) {
        const decoded = decodeUiError(app, error);
        setStatus(status, "err", decoded.message, decoded.code);
      }
    })();
  });
  replace(
    section,
    h("div", { class: "view-head" }, h("h2", { attrs: { id: "send-head" } }, t("send.head")), h("span", { class: "view-meta" }, String(contacts.length))),
    contacts.length === 0
      ? h("p", { class: "state-note" }, t("send.empty"))
      : h(
          "ul",
          { class: "links" },
          contacts.map((contact) =>
            h(
              "li",
              { class: "is-open" },
              h("div", { class: "row-main" }, h("p", { class: "row-memo" }, contact.label), addr(contact.address, contact.label)),
              h("div", { class: "row-amt" }),
              h(
                "div",
                { class: "row-foot" },
                h(
                  "div",
                  { class: "row-actions" },
                  h(
                    "button",
                    {
                      class: "key key-text key-danger",
                      attrs: { type: "button" },
                      on: {
                        click: () => {
                          void app.store.deleteContact(contact.address).then(async () => {
                            announce(t("send.removed", { name: contact.label }));
                            await renderSend(app, ui, section);
                          });
                        },
                      },
                    },
                    t("send.remove"),
                  ),
                  contact.card === null ? null : h("a", { class: "key key-text", attrs: { href: payUrl(app.site, contact.card), "aria-label": t("send.payTo", { name: contact.label }) } }, t("send.pay")),
                ),
              ),
            ),
          ),
        ),
    h("div", { class: "sub-head" }, h("h3", null, t("send.add"))),
    h("div", { class: "field" }, h("label", { attrs: { for: "contact-name" } }, t("send.name")), name),
    h("div", { class: "field" }, h("label", { attrs: { for: "contact-card" } }, t("send.card")), card, h("p", { class: "field-hint", attrs: { id: "card-hint" } }, t("send.cardHint"))),
    save,
    status,
    h("div", { class: "sub-head" }, h("h3", null, t("send.mine"))),
    await myCard(app, () => {
      void renderSend(app, ui, section);
    }),
  );
}

/**
 * The connected account's receive card: the newest open-amount, unlimited invoice it signed on this device that the
 * chain still reports open. The card prints in both themes; its QR code and printed link are the payment link.
 */
async function myCard(app: App, rerender: () => void): Promise<HTMLElement> {
  const { t } = app.i18n;
  await app.session.ready;
  const account = app.session.account();
  const create = h("a", { class: "key key-line", attrs: { href: `${routeHref(app, "create")}?preset=card` } }, t("send.mineKey"));
  if (account === null) {
    const connect = h("button", { class: "key key-line", attrs: { type: "button" } }, t("send.mineConnect"));
    connect.addEventListener("click", () => {
      void pickWallet(app).then((account) => {
        if (account !== null) {
          rerender();
        }
      });
    });
    return h("div", null, h("p", { class: "state-note" }, t("send.mineText")), h("div", { class: "key-row" }, connect, create));
  }
  const cards = (await app.store.listInvoices())
    .map((value) => parseStoredInvoice(value, app.registry))
    .filter((x) => x !== null && x.record.role === "issued" && x.link.invoice.amount === 0n && x.link.invoice.maxPayments === 0 && x.link.invoice.payee.toLowerCase() === account.address.toLowerCase())
    .reverse();
  let card = null as (typeof cards)[number];
  for (const candidate of cards) {
    if (candidate === null) {
      continue;
    }
    try {
      const [state] = await readLinkStates(app.client(candidate.link.target.chain), candidate.link.target.deployment.address, [candidate.link.key]);
      const expired = candidate.link.invoice.validUntil !== 0n && BigInt(Math.floor(Date.now() / 1000)) >= candidate.link.invoice.validUntil;
      if (state?.cancelled !== true && !expired) {
        card = candidate;
        break;
      }
    } catch {
      // Offline: show the newest card; the pay view checks it on the chain before anyone pays.
      card = candidate;
      break;
    }
  }
  if (card === null) {
    return h("div", null, h("p", { class: "state-note" }, t("send.mineText")), h("div", { class: "key-row" }, create));
  }
  const { link } = card;
  const fragment = encodeInvoiceFragment({ chainId: link.chainId, invoice: link.invoice, signature: link.signature, memo: link.memo });
  const url = payUrl(app.site, fragment);
  const element = ticket({
    kind: t("ticket.card"),
    amount: null,
    symbol: link.token.symbol,
    anyAmount: t("ticket.any"),
    memo: link.memo,
    payee: link.invoice.payee,
    payeeLabel: t("ticket.payee"),
    terms: [`${link.target.chain.label} · ${String(link.chainId)}`, t("ticket.noExpiry")],
    url,
    scan: t("ticket.scan"),
    scanSub: t("ticket.scanSub", { symbol: link.token.symbol }),
    qrLabel: t("ticket.qr"),
    cardLabel: t("ticket.labelOpen"),
  });
  const copy = h("button", { class: "key key-line", attrs: { type: "button" } }, t("share.copy"));
  copy.addEventListener("click", () => {
    void copyText(url, copy, { idle: t("share.copy"), done: t("share.copied"), said: t("share.copiedSaid") });
  });
  const message = link.memo === null ? t("share.messageOpen", { url }) : t("share.messageOpenMemo", { memo: link.memo, url });
  return h(
    "div",
    { class: "issued my-card" },
    element,
    h(
      "div",
      { class: "share-keys" },
      copy,
      h("a", { class: "key key-line ext", attrs: { href: whatsappUrl(message), target: "_blank", rel: "noopener noreferrer" } }, t("share.whatsapp")),
      h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { printElement(element, "a6"); } } }, t("share.print")),
      h("a", { class: "key key-line", attrs: { href: tillUrl(app.site, fragment) } }, t("send.mineTill")),
    ),
    h("p", { class: "field-hint" }, t("send.mineHint")),
  );
}
