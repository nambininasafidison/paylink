// SPDX-License-Identifier: MIT
/**
 * `/send/`: the address book and saved receive cards (Agora "send AUSD across borders", spec §2.1). A contact is a
 * label on an address, plus the card link to pay them with. A card is decoded and checked against the registry before
 * it is saved; the label it gets here is what the payer view shows as "Saved as: …" (identity comes from the user, not
 * from the signature, spec §3.6). "Create my receive card" opens the terminal preset for an open-amount, unlimited link.
 */
import { decodeInvoiceFragment, fragmentOf } from "@paylink/sdk";
import type { PageDefinition } from "../app/boot.ts";
import type { App } from "../app/context.ts";
import { intro, notes, routeHref } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { AppError, decodeUiError } from "../core/errors.ts";
import { payUrl } from "../core/links.ts";
import { parseStoredContact } from "../store/db.ts";
import type { ContactRecord } from "../store/db.ts";
import { addr, setStatus, statusLine } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { announce } from "../ui/live.ts";

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
                  contact.card === null ? null : h("a", { class: "key key-text", attrs: { href: payUrl(app.site, contact.card) } }, t("send.pay")),
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
    h("p", { class: "state-note" }, t("send.mineText")),
    h("div", { class: "key-row" }, h("a", { class: "key key-line", attrs: { href: `${routeHref(app, "create")}?preset=card` } }, t("send.mineKey"))),
  );
}
