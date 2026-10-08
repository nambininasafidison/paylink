// SPDX-License-Identifier: MIT
/**
 * Choosing a wallet: the EIP-6963 wallets this browser announced, each with its own name and icon (never a brand colour
 * of ours). One wallet connects straight away; none explains what to do on a phone and on a computer. When connected,
 * the same panel shows the account and lets the user switch wallet or disconnect.
 */
import type { AccountProvider, Connector } from "../accounts/types.ts";
import { decodeUiError } from "../core/errors.ts";
import { addr, setStatus, statusLine } from "../ui/atoms.ts";
import { openModal } from "../ui/dialog.ts";
import { h, replace } from "../ui/h.ts";
import type { App } from "./context.ts";
import { passkeyLayerOf } from "./passkey-layer.ts";

function walletKey(connector: Connector, onPick: () => void): HTMLButtonElement {
  const glyph = connector.icon === null
    ? h("span", { class: "wallet-glyph", attrs: { "aria-hidden": "true" } }, connector.name.slice(0, 2).toUpperCase())
    : h("img", { attrs: { src: connector.icon, alt: "", width: "28", height: "28" } });
  return h(
    "button",
    { class: "key wallet-key", attrs: { type: "button", "data-wallet": connector.id }, on: { click: onPick } },
    glyph,
    h("span", { class: "wallet-label" }, h("span", { class: "wallet-name" }, connector.name), h("span", { class: "wallet-rdns" }, connector.id)),
  );
}

/** "Connect wallet", or "Use my PayLink key" in an edition whose only account layer is a passkey. */
export function connectLabel(app: App): string {
  return passkeyLayerOf(app) === null ? app.i18n.t("app.connect") : app.i18n.t("app.connectKey");
}

/**
 * Opens the wallet picker and resolves with the connected account, or `null` when the user closes it.
 * `manage`: the account panel (switch or disconnect) instead of connecting right away.
 */
export async function pickWallet(app: App, manage = false): Promise<AccountProvider | null> {
  const passkeys = passkeyLayerOf(app);
  if (passkeys !== null) {
    // The Monad edition: a PayLink key (passkey) is the only account layer. The KeyCard loads with it.
    const { keyCard } = await import("./key-ui.ts");
    return await keyCard(app, passkeys, manage);
  }
  await app.session.ready;
  const connectors = app.session.connectors();
  if (!manage && connectors.length === 1 && connectors[0] !== undefined) {
    try {
      return await app.session.connect(connectors[0].id);
    } catch (error) {
      // Rejected or failed: fall through to the panel, which shows the reason.
      return await panel(app, connectors, decodeUiError(app, error));
    }
  }
  return await panel(app, connectors, null, manage);
}

async function panel(app: App, connectors: readonly Connector[], problem: { message: string; code: string } | null, manage = false): Promise<AccountProvider | null> {
  const { t } = app.i18n;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: AccountProvider | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const status = statusLine();
    if (problem !== null) {
      setStatus(status, "err", problem.message, problem.code);
    }
    const list = h("div", { class: "wallets" });
    const account = app.session.account();
    const modal = openModal(
      manage && account !== null ? t("wallet.account.title") : t("wallet.pick.title"),
      t("common.close"),
      manage && account !== null
        ? h(
            "div",
            { class: "account-panel" },
            h("p", { class: "label" }, account.connector.name),
            addr(account.address),
            h("div", { class: "key-row" }, h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { app.session.disconnect(); modal.close(); } } }, t("wallet.disconnect"))),
            h("p", { class: "field-hint" }, t("wallet.disconnectHint")),
          )
        : null,
      h("p", { class: "field-hint" }, t("wallet.pick.lede")),
      list,
      status,
    );
    modal.element.addEventListener("close", () => {
      finish(app.session.account());
    });
    if (connectors.length === 0) {
      replace(list, h("p", { class: "wallets-empty" }, t("wallet.pick.none")));
      return;
    }
    replace(
      list,
      connectors.map((connector) =>
        walletKey(connector, () => {
          setStatus(status, "", t("wallet.connecting", { wallet: connector.name }));
          app.session
            .connect(connector.id)
            .then((connected) => {
              finish(connected);
              modal.close();
            })
            .catch((error: unknown) => {
              const decoded = decodeUiError(app, error);
              setStatus(status, "err", decoded.message, decoded.code);
            });
        }),
      ),
    );
  });
}
