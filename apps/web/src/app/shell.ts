// SPDX-License-Identifier: MIT
/**
 * The page frame, in v1's grammar: the top bar (brand, edition tag, language and theme dials, the connect key that
 * becomes an account readout with a green LED), the lead column that speaks to whoever is at the terminal, the
 * terminal itself (plate, banners, mode switch) and the footer.
 */
import { LOCALE_INFO, LOCALES } from "@paylink/i18n";
import type { PlainMessageKey } from "@paylink/i18n";
import { shortHex } from "../core/format.ts";
import { applyTheme, prefs } from "../core/prefs.ts";
import type { Theme } from "../core/prefs.ts";
import type { Route } from "../editions/types.ts";
import { brandMark, ext } from "../ui/atoms.ts";
import { h, replace, svg } from "../ui/h.ts";
import type { Child } from "../ui/h.ts";
import { rich } from "../ui/rich.ts";
import type { App } from "./context.ts";
import { connectLabel, pickWallet } from "./wallet-ui.ts";

export type LedState = "ok" | "wait" | "err" | "off";

export interface PageUi {
  /** The lead column's speaking part (kicker, title, lede, specs). */
  readonly intro: HTMLElement;
  /** Notes that travel down beside the terminal on desktop. */
  readonly aside: HTMLElement;
  /** The terminal (`main`), focus target of the skip link. */
  readonly terminal: HTMLElement;
  /** Where the page puts its views, under the plate, banners and mode switch. */
  readonly views: HTMLElement;
  plate(text: string, led?: LedState): void;
  /** Adds a banner under the plate; returns it so the page can remove it. */
  banner(kind: "warn" | "err" | "info", ...children: Child[]): HTMLElement;
  /** What the payer's lead says (v1 voices): `null` is the default voice. */
  voice(state: string | null): void;
}

const ROUTE_PATH: Readonly<Record<Route, string>> = { create: "", pay: "pay/", receipt: "r/", ledger: "ledger/", send: "send/", till: "till/", status: "status/" };
const TAB_LABEL: Readonly<Record<Route, PlainMessageKey>> = {
  create: "app.nav.create",
  pay: "app.nav.create",
  receipt: "app.nav.create",
  ledger: "app.nav.ledger",
  send: "app.nav.send",
  till: "app.nav.till",
  status: "app.nav.status",
};

export function routeHref(app: App, route: Route): string {
  return `${app.site.base}${ROUTE_PATH[route]}`;
}

const THEMES: readonly Theme[] = ["auto", "light", "dark"];

function themeIcon(theme: Theme): SVGSVGElement {
  const common = { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" };
  if (theme === "light") {
    return svg("svg", common, svg("circle", { cx: "8", cy: "8", r: "3.2", fill: "none", stroke: "currentColor", "stroke-width": "1.5" }), svg("path", { d: "M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3", stroke: "currentColor", "stroke-width": "1.4" }));
  }
  if (theme === "dark") {
    return svg("svg", common, svg("path", { d: "M12.5 10.2A5.5 5.5 0 0 1 5.8 3.5a5.5 5.5 0 1 0 6.7 6.7Z", fill: "none", stroke: "currentColor", "stroke-width": "1.5" }));
  }
  return svg("svg", common, svg("circle", { cx: "8", cy: "8", r: "5.5", fill: "none", stroke: "currentColor", "stroke-width": "1.5" }), svg("path", { d: "M8 2.5v11A5.5 5.5 0 0 0 8 2.5Z", fill: "currentColor" }));
}

function languageDial(app: App): HTMLElement {
  const { t } = app.i18n;
  return h(
    "div",
    { class: "dial", attrs: { role: "group", "aria-label": t("app.lang.label") } },
    LOCALES.map((locale) =>
      h(
        "button",
        {
          attrs: { type: "button", "aria-pressed": locale === app.locale ? "true" : "false", lang: LOCALE_INFO[locale].tag, title: LOCALE_INFO[locale].nativeName, "aria-label": LOCALE_INFO[locale].nativeName },
          on: {
            click: () => {
              if (locale !== app.locale) {
                prefs.locale.set(locale);
                location.reload();
              }
            },
          },
        },
        LOCALE_INFO[locale].short,
      ),
    ),
  );
}

function themeDial(app: App): HTMLElement {
  const { t } = app.i18n;
  const labels: Readonly<Record<Theme, string>> = { auto: t("app.theme.auto"), light: t("app.theme.light"), dark: t("app.theme.dark") };
  const buttons = THEMES.map((theme) =>
    h(
      "button",
      {
        attrs: { type: "button", "aria-pressed": prefs.theme.get() === theme ? "true" : "false", "aria-label": labels[theme], title: labels[theme] },
        on: {
          click: () => {
            prefs.theme.set(theme);
            applyTheme(theme);
            for (const [i, b] of buttons.entries()) {
              b.setAttribute("aria-pressed", THEMES[i] === theme ? "true" : "false");
            }
          },
        },
      },
      themeIcon(theme),
    ),
  );
  return h("div", { class: "dial", attrs: { role: "group", "aria-label": t("app.theme.label") } }, buttons);
}

function connectKey(app: App): HTMLButtonElement {
  const { t } = app.i18n;
  const key = h("button", { class: "key key-line connect", attrs: { type: "button" } });
  const render = (): void => {
    const account = app.session.account();
    key.classList.toggle("is-on", account !== null);
    if (account === null) {
      key.textContent = connectLabel(app);
      key.removeAttribute("title");
      key.removeAttribute("aria-label");
    } else {
      key.textContent = shortHex(account.address);
      key.setAttribute("title", account.address);
      key.setAttribute("aria-label", account.kind === "passkey" ? t("app.accountKey", { address: account.address }) : t("app.account", { address: account.address }));
    }
  };
  key.addEventListener("click", () => {
    if (app.session.account() === null) {
      void pickWallet(app);
    } else {
      void pickWallet(app, true);
    }
  });
  app.session.subscribe(render);
  render();
  return key;
}

function header(app: App): HTMLElement {
  const { t } = app.i18n;
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "bar" },
      h("a", { class: "brand", attrs: { href: routeHref(app, "create"), "aria-label": t("app.home") } }, brandMark(), h("span", { class: "word" }, "PayLink"), h("span", { class: "edition-tag" }, app.edition.tag)),
      h("div", { class: "top-dials" }, languageDial(app), themeDial(app)),
      connectKey(app),
    ),
  );
}

function footer(app: App): HTMLElement {
  const { t } = app.i18n;
  const networks = app.registry.chains.map((c) => c.label).join(" · ");
  return h(
    "footer",
    { class: "foot" },
    h(
      "div",
      { class: "bar" },
      h("div", { class: "foot-item" }, h("span", { class: "foot-label" }, t("app.foot.networks")), h("span", { class: "coords" }, networks)),
      h("div", { class: "foot-item" }, h("span", { class: "foot-label" }, t("app.foot.madeIn")), t("app.foot.place"), " ", h("span", { class: "coords" }, "18°55′S 47°31′E")),
      h(
        "div",
        { class: "foot-item" },
        h("span", { class: "foot-label" }, t("app.foot.system")),
        h(
          "span",
          { class: "foot-links" },
          h("a", { attrs: { href: routeHref(app, "status") } }, t("app.foot.status")),
          h("a", { attrs: { href: "/deploy/" } }, t("app.foot.deploy")),
          h("a", { attrs: { href: "/arc/" } }, t("app.foot.arc")),
          ext("https://github.com/nambininasafidison/paylink", t("app.foot.source")),
        ),
      ),
    ),
  );
}

function tabs(app: App, current: Route): HTMLElement | null {
  const { t } = app.i18n;
  if (!app.edition.tabs.includes(current)) {
    return null;
  }
  return h(
    "nav",
    { class: "tabs", attrs: { "aria-label": t("app.nav.label") }, vars: { "--tabs": String(app.edition.tabs.length) } },
    app.edition.tabs.map((route) =>
      h("a", { attrs: { href: routeHref(app, route), "aria-current": route === current ? "page" : null } }, h("span", { class: "tab-label" }, t(TAB_LABEL[route]))),
    ),
  );
}

/** Renders the frame and returns the slots the page fills. */
export function renderShell(app: App, route: Route, payer: boolean): PageUi {
  const { t } = app.i18n;
  const introSlot = h("div", { class: "intro" });
  const aside = h("div", { class: "lead-aside" });
  const plateText = h("span", { attrs: { id: "plate" } });
  const plate = h("div", { class: "plate" }, h("span", null, h("i", { class: "led", attrs: { "aria-hidden": "true" } }), plateText), h("span", { class: "model" }, t("app.plate.model")));
  const banners = h("div", { class: "banners" });
  const views = h("div", { class: "views" });
  const terminal = h("main", { class: "device", attrs: { id: "terminal", tabindex: "-1", "aria-labelledby": "plate" } }, plate, banners, tabs(app, route), views);
  document.body.classList.add(`page-${route}`);
  if (payer) {
    document.body.classList.add("page-payer");
  }
  replace(
    document.body,
    h("a", { class: "skip", attrs: { href: "#terminal" } }, t("app.skip")),
    header(app),
    h("div", { class: "frame" }, h("div", { class: "lead" }, introSlot, aside), terminal),
    footer(app),
  );
  const ui: PageUi = {
    intro: introSlot,
    aside,
    terminal,
    views,
    plate(text, led = "ok") {
      plateText.textContent = text;
      plate.setAttribute("data-led", led);
    },
    banner(kind, ...children) {
      const element = h("div", { class: ["banner", kind === "err" ? "is-err" : kind === "info" ? "is-info" : null], attrs: { role: kind === "err" ? "alert" : "status" } }, h("div", null, ...children));
      banners.append(element);
      return element;
    },
    voice(state) {
      if (state === null) {
        delete document.documentElement.dataset["state"];
      } else {
        document.documentElement.dataset["state"] = state;
      }
    },
  };
  globalBanners(app, ui);
  return ui;
}

function globalBanners(app: App, ui: PageUi): void {
  const { t } = app.i18n;
  const banner = app.config.banner;
  if (banner !== null) {
    const text = banner.text[app.locale] ?? banner.text.en;
    ui.banner(banner.level === "critical" ? "err" : banner.level === "warning" ? "warn" : "info", h("p", null, text));
  }
  if (!app.store.persistent) {
    ui.banner("warn", h("p", null, t("app.banner.storage")));
  }
  if (app.framed) {
    ui.banner("err", h("p", null, t("app.banner.framed")));
  }
}

/** The lead's intro block: kicker, a two-line title ending in the laterite stop, the lede with its one emphasis, specs. */
export function intro(parts: { readonly kicker: string; readonly title: readonly [string, string?]; readonly lede: string; readonly specs?: readonly (readonly [string, Child])[]; readonly voice?: string }): HTMLElement {
  const [first, second] = parts.title;
  return h(
    "div",
    { class: "voice", attrs: parts.voice === undefined ? {} : { "data-voice": parts.voice } },
    h("p", { class: "kicker" }, parts.kicker),
    h("h1", null, first, second === undefined ? null : [h("br"), second], h("span", { class: "stop", attrs: { "aria-hidden": "true" } }, ".")),
    h("p", { class: "lede" }, rich(parts.lede)),
    parts.specs === undefined ? null : h("dl", { class: "specs" }, parts.specs.map(([term, value]) => h("div", null, h("dt", null, term), h("dd", null, value)))),
  );
}

/** A numbered "how it works" list for the lead aside. */
export function steps(title: string, items: readonly (readonly [string, string])[]): HTMLElement {
  const id = `steps-${title.length.toString(36)}-${String(items.length)}`;
  return h(
    "aside",
    { class: "about", attrs: { "aria-labelledby": id } },
    h("h2", { class: "eyebrow", attrs: { id } }, title),
    h("ol", { class: "steps" }, items.map(([name, text], i) => h("li", null, h("span", { class: "step-n" }, String(i + 1).padStart(2, "0")), h("b", null, name), h("p", null, text)))),
  );
}

/** A "good to know" note list for the lead aside. */
export function notes(title: string, items: readonly (readonly [string, string])[]): HTMLElement {
  const id = `notes-${title.length.toString(36)}-${String(items.length)}`;
  return h(
    "aside",
    { class: "about notes", attrs: { "aria-labelledby": id } },
    h("h2", { class: "eyebrow", attrs: { id } }, title),
    h("ul", { class: "note-list" }, items.map(([bold, text]) => h("li", null, h("b", null, bold), " ", text))),
  );
}
