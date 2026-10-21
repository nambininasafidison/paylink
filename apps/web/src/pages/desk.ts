// SPDX-License-Identifier: MIT
/**
 * `/paypal/desk/`: the PayPal edition's collections desk (docs/paypal/SPEC.md §14, ADR 0018). Foundation scaffold: the
 * page says what is coming and whether the edition's API answers (`GET /v1/health` of `@paylink/api-contract`, at the
 * `api` endpoint of `/config.json` when it serves Ethereum Sepolia). Proposals, auto-records, alerts and the "Check my
 * invoices" key arrive with the web edition workstream; nothing here signs, approves or calls a session route.
 *
 * Only the PayPal build has this page (vite.config.ts builds `desk/` for that edition alone).
 *
 * Owner: web edition workstream.
 */
import { PAYPAL_EDITION_CHAIN_ID } from "@paylink/api-contract";
import type { HealthResponse } from "@paylink/api-contract";
import type { PageDefinition } from "../app/boot.ts";
import type { App } from "../app/context.ts";
import { intro, notes } from "../app/shell.ts";
import { endpointFor } from "../core/config.ts";
import { lamp } from "../ui/atoms.ts";
import { h } from "../ui/h.ts";

const HEALTH_TIMEOUT_MS = 8_000;

/** The API's base URL when `/config.json` names one that serves this edition's chain, else `null`. */
export function apiUrl(app: Pick<App, "config">): string | null {
  return endpointFor(app.config.api ?? null, PAYPAL_EDITION_CHAIN_ID);
}

/** The API row: answering with its version, not configured, or unreachable. */
async function apiHealth(app: App, item: HTMLLIElement, detail: HTMLElement): Promise<void> {
  const { t } = app.i18n;
  const set = (state: "ok" | "wait" | "err" | "", text: string): void => {
    item.setAttribute("data-lamp", state);
    detail.textContent = text;
  };
  const url = apiUrl(app);
  if (url === null) {
    set("", t("paypal.desk.apiNone"));
    return;
  }
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/v1/health`, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = (await response.json().catch(() => null)) as Partial<HealthResponse> | null;
    if (!response.ok || body?.service !== "paylink-api") {
      set("err", t("paypal.desk.apiDown"));
      return;
    }
    const version = typeof body.version === "string" ? body.version.slice(0, 32) : "";
    set(body.status === "ok" ? "ok" : "wait", `${t("paypal.desk.apiOk")} · ${version}`);
  } catch {
    set("err", t("paypal.desk.apiDown"));
  }
}

export const deskPage: PageDefinition = {
  route: "desk",
  payer: false,
  title: "paypal.desk.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(intro({ kicker: t("paypal.desk.kicker"), title: [t("paypal.desk.h1a"), t("paypal.desk.h1b")], lede: t("paypal.desk.lede") }));
    ui.aside.append(notes(t("paypal.notes.title"), [[t("paypal.notes.sandboxHead"), t("paypal.notes.sandbox")]]));
    ui.plate(t("paypal.desk.plate"), "off");
    const detail = h("span", { class: "vstrip-detail" });
    const api = h("li", { attrs: { "data-lamp": "busy" } }, h("span", { class: "vstrip-name" }, t("paypal.desk.api")), detail);
    ui.views.append(
      h(
        "section",
        { class: "view view-desk", attrs: { "aria-labelledby": "desk-head", "data-coming": "" } },
        h("div", { class: "view-head" }, h("h2", { attrs: { id: "desk-head" } }, t("paypal.desk.head")), lamp("wait", t("paypal.desk.coming"), true)),
        h(
          "ul",
          { class: "note-list" },
          [t("paypal.desk.twin"), t("paypal.desk.check"), t("paypal.desk.approve")].map((text) => h("li", null, text)),
        ),
        h("ul", { class: "vstrip" }, api),
      ),
    );
    void apiHealth(app, api, detail);
  },
};
