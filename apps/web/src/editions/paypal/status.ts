// SPDX-License-Identifier: MIT
/**
 * The Status page's PayPal rows (docs/paypal/SPEC.md §14.2 F8): the edition's API, PayPal's sandbox, PayPal's webhook,
 * the assistant (with today's neurons left, or resting) and the API's store, each read from the public `GET /v1/health` (no
 * secret, no token, no body) and worded from its fixed codes. A code this page does not know reads by its state alone. The API not answering lights
 * every row amber "unknown", never green.
 *
 * Owner: web edition workstream.
 */
import type { HealthRow, HealthResponse } from "@paylink/api-contract";
import { formatCount, formatDateTime, formatSeconds } from "@paylink/i18n";
import type { App } from "../../app/context.ts";
import { h } from "../../ui/h.ts";
import { getHealth } from "./api.ts";
import { apiFor, seconds } from "./context.ts";

type Light = "ok" | "wait" | "err" | "busy" | "";

function row(name: string): { readonly element: HTMLLIElement; set(state: Light, detail: string): void } {
  const detail = h("span", { class: "vstrip-detail" });
  const element = h("li", { attrs: { "data-lamp": "busy" } }, h("span", { class: "vstrip-name" }, name), detail);
  return {
    element,
    set(state, text) {
      element.setAttribute("data-lamp", state);
      detail.textContent = text;
    },
  };
}

const lampOf = (state: HealthRow["state"]): Light => (state === "ok" ? "ok" : state === "down" ? "err" : state === "not-configured" ? "" : "wait");

/** A count of neurons in the page's locale, or a dash when the API did not say. */
const neurons = (app: Pick<App, "locale">, value: number | undefined): string => (value === undefined ? "—" : formatCount(app.locale, value));

/** The words of one health row: its fixed code, with the time or the number it carries. */
export function healthText(app: Pick<App, "i18n" | "locale">, item: HealthRow): string {
  const { t } = app.i18n;
  const when = seconds(item.checkedAt);
  const at = when === null ? "" : formatDateTime(app.locale, when);
  switch (item.code) {
    case "credentials-missing":
    case "webhook-id-missing":
      return t("paypal.status.notConfigured");
    case "fake":
      return t("paypal.status.fake");
    case "not-read-yet":
      return t("paypal.status.notReadYet");
    case "last-get":
      return t("paypal.status.lastGet", { time: at });
    case "none-verified-yet":
      return t("paypal.status.noWebhookYet");
    case "last-verified":
      return t("paypal.status.lastWebhook", { age: formatSeconds(app.locale, item.values?.["ageSeconds"] ?? 0), time: at });
    case "disabled":
      return t("paypal.status.assistantOff");
    case "deployed":
      return t("paypal.status.deployed");
    case "not-deployed":
      return t("paypal.status.notDeployed");
    case "readable":
      return at === "" ? t("paypal.status.storeOk") : t("paypal.status.storeCron", { time: at });
    case "unreadable":
      return t("paypal.status.storeDown");
    case "resting":
      return t("paypal.status.resting", { budget: neurons(app, item.values?.["dailyNeuronBudget"]) });
    default:
      if (item.code.startsWith("model:")) {
        const model = item.code.slice("model:".length);
        const budget = neurons(app, item.values?.["dailyNeuronBudget"]);
        const left = item.values?.["neuronsLeft"];
        return left === undefined ? t("paypal.status.model", { model, budget }) : t("paypal.status.modelLeft", { model, budget, left: neurons(app, left) });
      }
      return t(`paypal.status.state.${item.state === "not-configured" ? "notConfigured" : item.state}` as "paypal.status.state.ok");
  }
}

/** The API's row and its dependency rows, filled once `GET /v1/health` answers. */
export function paypalStatusRows(app: App): HTMLLIElement[] {
  const { t } = app.i18n;
  const api = row(t("paypal.status.api"));
  const rows = {
    paypal: row(t("paypal.status.paypal")),
    webhook: row(t("paypal.status.webhook")),
    assistant: row(t("paypal.status.assistant")),
    store: row(t("paypal.status.store")),
  } as const;
  const client = apiFor(app);
  if (client === null) {
    api.set("", t("paypal.desk.apiNone"));
    for (const r of Object.values(rows)) {
      r.set("", t("paypal.status.state.notConfigured"));
    }
  } else {
    void getHealth(client)
      .then((health: HealthResponse) => {
        api.set(health.status === "ok" ? "ok" : health.status === "down" ? "err" : "wait", t("paypal.status.apiOk", { version: health.version, contract: health.contract }));
        for (const [id, r] of Object.entries(rows)) {
          const item = health.rows.find((x) => x.id === id);
          if (item === undefined) {
            r.set("wait", t("paypal.status.state.unknown"));
          } else {
            r.set(lampOf(item.state), healthText(app, item));
          }
        }
      })
      .catch(() => {
        api.set("err", t("paypal.desk.apiDown"));
        for (const r of Object.values(rows)) {
          r.set("wait", t("paypal.status.state.unknown"));
        }
      });
  }
  return [api.element, rows.paypal.element, rows.webhook.element, rows.assistant.element, rows.store.element];
}
