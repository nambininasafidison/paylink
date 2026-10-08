// SPDX-License-Identifier: MIT
/**
 * Page start-up, shared by every route: theme and language first (so nothing renders twice), then configuration, the
 * device store, the edition's registry and account layers, the frame, and the page itself. A page that throws leaves
 * an error banner in the terminal rather than a blank screen.
 */
import { createTranslator, EN, LOCALE_INFO, loadMessages, negotiateLocale } from "@paylink/i18n";
import type { PlainMessageKey } from "@paylink/i18n";
import { chainClient } from "../core/clients.ts";
import { loadConfig } from "../core/config.ts";
import { loadFx } from "../core/fx.ts";
import { relayerClient } from "../core/relayer.ts";
import { decodeUiError } from "../core/errors.ts";
import { applyTheme, prefs } from "../core/prefs.ts";
import { appRegistry } from "../core/registry.ts";
import { edition } from "../editions/index.ts";
import type { Route } from "../editions/types.ts";
import { registerServiceWorker } from "../pwa/register.ts";
import { openDeviceStore } from "../store/db.ts";
import { h } from "../ui/h.ts";
import type { App } from "./context.ts";
import { createSession } from "./session.ts";
import { renderShell } from "./shell.ts";
import type { PageUi } from "./shell.ts";

export interface PageDefinition {
  readonly route: Route;
  /** Payer-facing (pay, receipt): no mode switch, and the lead gives way to the bill on phones. */
  readonly payer: boolean;
  readonly title: PlainMessageKey;
  render(app: App, ui: PageUi): Promise<void> | void;
}

export async function boot(page: PageDefinition): Promise<void> {
  applyTheme(prefs.theme.get());
  const locale = prefs.locale.get() ?? negotiateLocale(navigator.languages);
  const profile = edition();
  const [messages, configLoad, store, fx] = await Promise.all([loadMessages(locale), loadConfig("/"), openDeviceStore(), profile.fx === null ? Promise.resolve(null) : loadFx()]);
  const i18n = createTranslator(locale, messages, { fallback: EN });
  document.documentElement.lang = LOCALE_INFO[locale].tag;
  document.title = `${i18n.t(page.title)} · PayLink`;
  const registry = appRegistry(profile.id);
  const client = (chain: Parameters<App["client"]>[0]): ReturnType<App["client"]> => chainClient(chain, configLoad.config);
  for (const layer of profile.accountLayers) {
    layer.bind?.({ registry, client });
  }
  const session = createSession(profile.accountLayers);
  const app: App = {
    edition: profile,
    registry,
    config: configLoad.config,
    configProblem: configLoad.ok ? null : configLoad.problem,
    i18n,
    locale,
    store,
    session,
    site: { origin: location.origin, base: profile.base },
    framed: window.top !== window.self,
    client,
    relayer: relayerClient(configLoad.config),
    fx,
  };
  const ui = renderShell(app, page.route, page.payer);
  try {
    await page.render(app, ui);
  } catch (error) {
    const decoded = decodeUiError(app, error);
    ui.banner("err", h("p", null, decoded.message), h("p", { class: "status-code" }, decoded.code));
  }
  registerServiceWorker(app);
}
