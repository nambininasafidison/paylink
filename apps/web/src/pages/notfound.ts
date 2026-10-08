// SPDX-License-Identifier: MIT
/** `404.html`: served by Cloudflare Pages for any unknown path (it walks up to the nearest 404.html). */
import type { PageDefinition } from "../app/boot.ts";
import { intro, routeHref } from "../app/shell.ts";
import { h } from "../ui/h.ts";

export const notFoundPage: PageDefinition = {
  route: "status",
  payer: true,
  title: "notFound.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(intro({ kicker: t("notFound.kicker"), title: [t("notFound.h1a"), t("notFound.h1b")], lede: t("notFound.lede") }));
    ui.plate(t("notFound.plate"), "off");
    ui.views.append(
      h(
        "section",
        { class: "view" },
        h("div", { class: "view-head" }, h("h2", null, t("notFound.head"))),
        h("p", { class: "state-note" }, t("notFound.text")),
        h("div", { class: "key-row" }, h("a", { class: "key key-primary", attrs: { href: routeHref(app, "create") } }, t("notFound.home"))),
      ),
    );
  },
};
