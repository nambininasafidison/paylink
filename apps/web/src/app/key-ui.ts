// SPDX-License-Identifier: MIT
/**
 * The KeyCard (PAYLINK-V2-SPEC §3.6 "KeyCard for passkey onboarding"): how a merchant or a payer gets a PayLink key in
 * the Monad edition, where a passkey is the only account layer. One dark display window says what the key is (the
 * phone's passkey, behind its fingerprint or screen lock, synced by its passkey manager) and what it is not (PayLink
 * never sees it; there is no recovery beyond the passkey itself), then two keys: create one, or use the one this phone
 * already has. The test-network warning (no recovery beyond the passkey) comes before the key that creates one. Signed
 * in, the same card shows the account and offers to forget the key on this device.
 */
import type { AccountProvider } from "../accounts/types.ts";
import type { PasskeyLayer } from "../accounts/passkey.ts";
import { CREATE_ID, SIGN_IN_ID } from "../accounts/passkey.ts";
import { decodeUiError } from "../core/errors.ts";
import { addr, fact, setStatus, statusLine } from "../ui/atoms.ts";
import { openModal } from "../ui/dialog.ts";
import { h, svg } from "../ui/h.ts";
import type { App } from "./context.ts";

/** The fingerprint glyph of the card: drawn arcs, laterite only on the active ring. */
function glyph(): SVGSVGElement {
  const arcs = ["M14 34a12 12 0 0 1 20-16", "M10 28a16 16 0 0 1 28-12", "M18 38a8 8 0 0 1 14-14", "M24 40v-8", "M30 38a8 8 0 0 0 2-6"];
  return svg(
    "svg",
    { class: "keycard-glyph", viewBox: "0 0 48 48", "aria-hidden": "true", focusable: "false" },
    arcs.map((d, i) => svg("path", { d, class: i === 0 ? "ring is-signal" : "ring" })),
  );
}

/**
 * Opens the KeyCard and resolves with the signed-in account, or `null` when the user closes it.
 * `manage`: the signed-in card (account, forget) instead of creating or using a key.
 */
export async function keyCard(app: App, layer: PasskeyLayer, manage = false): Promise<AccountProvider | null> {
  const { t } = app.i18n;
  await app.session.ready;
  const restored = app.session.account();
  if (!manage && restored !== null) {
    // Restored silently while the page loaded (a key this device knows): nothing to ask.
    return restored;
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: AccountProvider | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const status = statusLine();
    const support = layer.support();
    const account = app.session.account();
    const face = h(
      "section",
      { class: "screen keycard-face", attrs: { "aria-labelledby": "keycard-title" } },
      h("div", { class: "screen-top" }, h("span", null, t("key.kicker")), h("span", null, app.edition.tag.toUpperCase())),
      h("div", { class: "keycard-head" }, glyph(), h("h3", { attrs: { id: "keycard-title" } }, account === null ? t("key.title") : account.connector.name)),
      h(
        "dl",
        { class: "readings" },
        fact(t("key.signsWith"), t("key.signsWithValue")),
        fact(t("key.keptBy"), t("key.keptByValue")),
        fact(t("key.fees"), t("key.feesValue")),
        account === null ? null : fact(t("key.account"), addr(account.address)),
      ),
      h("p", { class: "signing-note" }, t("key.note")),
    );
    const body: (HTMLElement | null)[] = [face];
    if (!support.ok) {
      const why = support.reason === "wrong-host" ? t("key.unsupported.host", { host: support.rpId }) : support.reason === "insecure" ? t("key.unsupported.insecure") : t("key.unsupported.browser");
      body.push(h("p", { class: "warn-note is-err", attrs: { role: "alert" } }, h("b", null, t("key.unsupported")), " ", why));
    } else if (manage && account !== null) {
      const forget = h("button", { class: "key key-line key-danger", attrs: { type: "button" } }, t("key.forget"));
      forget.addEventListener("click", () => {
        layer.forget();
        app.session.disconnect();
        modal.close();
      });
      body.push(h("div", { class: "key-row" }, forget), h("p", { class: "field-hint" }, t("key.forgetHint")));
    } else {
      const label = h("input", { attrs: { id: "key-label", maxlength: "64", autocomplete: "nickname", placeholder: t("key.labelPlaceholder"), "aria-describedby": "key-label-hint" } });
      const create = h("button", { class: "key key-primary", attrs: { type: "button", "data-key": "create" } }, t("key.create"));
      const use = h("button", { class: "key key-line", attrs: { type: "button", "data-key": "use" } }, t("key.use"));
      const run = (connectorId: string, button: HTMLButtonElement): void => {
        create.disabled = true;
        use.disabled = true;
        button.setAttribute("aria-busy", "true");
        setStatus(status, "", t(connectorId === CREATE_ID ? "key.status.creating" : "key.status.using"));
        app.session
          .connect(connectorId, connectorId === CREATE_ID ? { label: label.value } : {})
          .then((connected) => {
            finish(connected);
            modal.close();
          })
          .catch((error: unknown) => {
            const decoded = decodeUiError(app, error);
            setStatus(status, "err", decoded.message, decoded.code);
          })
          .finally(() => {
            create.disabled = false;
            use.disabled = false;
            button.removeAttribute("aria-busy");
          });
      };
      create.addEventListener("click", () => {
        run(CREATE_ID, create);
      });
      use.addEventListener("click", () => {
        run(SIGN_IN_ID, use);
      });
      body.push(
        // What cannot be undone comes before the key that does it.
        h("p", { class: "warn-note" }, h("b", null, t("key.testnet")), " ", t("key.testnetText")),
        h("div", { class: "field" }, h("label", { attrs: { for: "key-label" } }, t("key.label"), h("span", { class: "opt" }, t("common.optional"))), label, h("p", { class: "field-hint", attrs: { id: "key-label-hint" } }, t("key.labelHint"))),
        create,
        h("div", { class: "key-row" }, use),
      );
    }
    body.push(status);
    const modal = openModal(manage && account !== null ? t("key.account.title") : t("key.pick.title"), t("common.close"), ...body);
    modal.element.classList.add("modal-key");
    modal.element.addEventListener("close", () => {
      finish(app.session.account());
    });
  });
}
