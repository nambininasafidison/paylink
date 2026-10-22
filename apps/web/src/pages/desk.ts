// SPDX-License-Identifier: MIT
/**
 * `/paypal/desk/`: the PayPal edition's collections desk (docs/paypal/SPEC.md §10, §14.2 F5 and F6, ADR 0018).
 *
 * The payee connects the wallet they sign invoices with and opens a session (one signature: no transaction, no fee,
 * 12 hours). The desk then lists, from `GET /v1/desk`: red alerts first (paid twice, hands off), the proposals inside
 * the reconciler's fence, each an exact-values grid approved with a tap, and the automatic records of chain payments on
 * their PayPal twins with Undo for 24 hours. **Check my invoices** has the API read every open twin again
 * (`POST /v1/desk/sweep`) and lets the assistant propose, inside the same fence. **Was I really paid?** checks a pasted
 * message against PayPal and the chain only.
 *
 * Nothing here signs a payment or moves money: approving a proposal sends its hash and approval token, and the
 * executor reads PayPal and the chain again before it acts. The only signature a card can ask for is the payee's own
 * cancel of the token rail.
 *
 * Only the PayPal build has this page (vite.config.ts builds `desk/` for that edition alone).
 *
 * Owner: web edition workstream.
 */
import { DRAFT_MAX_TEXT } from "@paylink/api-contract";
import type { DeskResponse, DeskSweepResponse, HealthResponse } from "@paylink/api-contract";
import { formatDateTime } from "@paylink/i18n";
import type { AccountProvider } from "../accounts/types.ts";
import type { PageDefinition } from "../app/boot.ts";
import type { App } from "../app/context.ts";
import { intro, notes } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { pickWallet } from "../app/wallet-ui.ts";
import { shortHex } from "../core/format.ts";
import { getDesk, getHealth, postApprove, postCheck, postReject, postSweep, postUndo } from "../editions/paypal/api.ts";
import type { PaypalApi } from "../editions/paypal/api.ts";
import { apiFor, apiUrl, failureText, seconds } from "../editions/paypal/context.ts";
import { alertCard, proposalCard, recordCard, verdictReadout } from "../editions/paypal/desk.ts";
import type { DeskActions } from "../editions/paypal/desk.ts";
import { forgetSession, openSession, storedSession, withSession } from "../editions/paypal/session.ts";
import { lamp, setStatus, statusLine } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { announce } from "../ui/live.ts";

export { apiUrl };

/** The API row of the desk's foot: answering with its version, not configured, or unreachable. */
async function apiHealth(app: App, item: HTMLLIElement, detail: HTMLElement): Promise<HealthResponse | null> {
  const { t } = app.i18n;
  const set = (state: "ok" | "wait" | "err" | "", text: string): void => {
    item.setAttribute("data-lamp", state);
    detail.textContent = text;
  };
  const api = apiFor(app);
  if (api === null) {
    set("", t("paypal.desk.apiNone"));
    return null;
  }
  try {
    const health = await getHealth(api);
    set(health.status === "ok" ? "ok" : "wait", `${t("paypal.desk.apiOk")} · ${health.version}`);
    return health;
  } catch {
    set("err", t("paypal.desk.apiDown"));
    return null;
  }
}

export const deskPage: PageDefinition = {
  route: "desk",
  payer: false,
  title: "paypal.desk.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(intro({ kicker: t("paypal.desk.kicker"), title: [t("paypal.desk.h1a"), t("paypal.desk.h1b")], lede: t("paypal.desk.lede") }));
    ui.aside.append(
      notes(t("paypal.notes.title"), [
        [t("paypal.notes.sandboxHead"), t("paypal.notes.sandbox")],
        [t("paypal.notes.fenceHead"), t("paypal.notes.fence")],
        [t("paypal.notes.truthHead"), t("paypal.notes.truth")],
      ]),
    );
    ui.plate(t("paypal.desk.plate"), "wait");
    const section = h("section", { class: "view view-desk", attrs: { "aria-labelledby": "desk-head" } });
    const detail = h("span", { class: "vstrip-detail" });
    const apiRow = h("li", { attrs: { "data-lamp": "busy" } }, h("span", { class: "vstrip-name" }, t("paypal.desk.api")), detail);
    const foot = h("ul", { class: "vstrip desk-foot" }, apiRow);
    ui.views.append(section);
    void apiHealth(app, apiRow, detail);
    let shown: string | null | undefined;
    const show = (): void => {
      const address = app.session.account()?.address ?? null;
      if (address !== shown) {
        shown = address;
        renderDesk(app, ui, section, foot);
      }
    };
    app.session.subscribe(show);
    void app.session.ready.then(show);
    show();
  },
};

function head(app: App, account: AccountProvider | null): HTMLElement {
  const { t } = app.i18n;
  return h("div", { class: "view-head" }, h("h2", { attrs: { id: "desk-head" } }, t("paypal.desk.head")), h("span", { class: "view-meta" }, account === null ? "" : shortHex(account.address)));
}

function renderDesk(app: App, ui: PageUi, section: HTMLElement, foot: HTMLElement): void {
  const { t } = app.i18n;
  const api = apiFor(app);
  const account = app.session.account();
  section.setAttribute("data-desk", "");
  if (api === null) {
    ui.plate(t("paypal.desk.plate"), "off");
    section.setAttribute("data-desk", "no-api");
    replace(section, head(app, account), h("div", { class: "empty-state" }, h("p", null, t("paypal.desk.noApi"))), foot);
    return;
  }
  if (account === null) {
    ui.plate(t("paypal.desk.plate"), "off");
    section.setAttribute("data-desk", "no-wallet");
    replace(
      section,
      head(app, null),
      h("div", { class: "empty-state" }, h("p", null, t("paypal.desk.connect")), h("button", { class: "key key-primary", attrs: { type: "button", "data-action": "connect" }, on: { click: () => { void pickWallet(app); } } }, t("app.connect"))),
      foot,
    );
    return;
  }
  if (storedSession(account.address) === null) {
    ui.plate(t("paypal.desk.plate"), "wait");
    section.setAttribute("data-desk", "no-session");
    const status = statusLine();
    const open = h("button", { class: "key key-primary", attrs: { type: "button", "data-action": "open-session" } }, t("paypal.session.open"));
    open.addEventListener("click", () => {
      open.disabled = true;
      open.setAttribute("aria-busy", "true");
      setStatus(status, "", t("paypal.session.signing"));
      openSession(app, api, account)
        .then(() => {
          renderDesk(app, ui, section, foot);
        })
        .catch((error: unknown) => {
          open.disabled = false;
          open.removeAttribute("aria-busy");
          const failure = failureText(app, error);
          setStatus(status, "err", failure.message, failure.code);
        });
    });
    replace(section, head(app, account), h("div", { class: "empty-state" }, h("p", null, t("paypal.session.why")), open, status), foot);
    return;
  }
  void loadDesk(app, ui, section, foot, api, account);
}

async function loadDesk(app: App, ui: PageUi, section: HTMLElement, foot: HTMLElement, api: PaypalApi, account: AccountProvider, sweep = false): Promise<void> {
  const { t } = app.i18n;
  section.setAttribute("data-desk", "loading");
  replace(section, head(app, account), h("p", { class: "loading", attrs: { role: "status" } }, sweep ? t("paypal.desk.sweeping") : t("paypal.desk.reading")), foot);
  const session = async <T>(work: (token: string) => Promise<T>): Promise<T> => await withSession(app, api, account, work);
  let desk: DeskResponse | DeskSweepResponse;
  try {
    desk = await session(async (token) => (sweep ? await postSweep(api, token) : await getDesk(api, token)));
  } catch (error) {
    ui.plate(t("paypal.desk.plate"), "err");
    section.setAttribute("data-desk", "error");
    const status = statusLine();
    const failure = failureText(app, error);
    setStatus(status, "err", failure.message, failure.code);
    const retry = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "retry" }, on: { click: () => { void loadDesk(app, ui, section, foot, api, account); } } }, t("paypal.desk.retry"));
    const signOut = h("button", { class: "key key-text", attrs: { type: "button" }, on: { click: () => { forgetSession(); renderDesk(app, ui, section, foot); } } }, t("paypal.session.forget"));
    replace(section, head(app, account), status, h("div", { class: "key-row" }, retry, signOut), foot);
    return;
  }
  const reload = (): void => {
    void loadDesk(app, ui, section, foot, api, account);
  };
  const actions: DeskActions = {
    approve: async (p) => await session(async (token) => await postApprove(api, token, p.id, { hash: p.hash, token: p.token })),
    reject: async (p) => {
      await session(async (token) => await postReject(api, token, p.id));
    },
    undo: async (r) => {
      await session(async (token) => await postUndo(api, token, r.id));
    },
    reload,
  };
  const open = desk.proposals.filter((p) => p.state === "open").length;
  ui.plate(t("paypal.desk.plate"), desk.alerts.length > 0 ? "err" : open > 0 ? "wait" : "ok");
  section.setAttribute("data-desk", "ready");
  const checked = seconds(desk.checkedAt);
  const sweepKey = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "sweep" } }, t("paypal.desk.sweep"));
  sweepKey.addEventListener("click", () => {
    void loadDesk(app, ui, section, foot, api, account, true);
  });
  const assistantLamp = desk.assistant.available
    ? lamp("ok", t("paypal.assistant.on"), true)
    : lamp(desk.assistant.reason === "resting" ? "wait" : "off", desk.assistant.reason === "resting" ? t("paypal.assistant.resting") : desk.assistant.reason === "error" ? t("paypal.assistant.error") : t("paypal.assistant.off"), true);
  const sweepInfo = (desk as Partial<DeskSweepResponse>).sweep ?? null;
  const swept = sweepInfo === null ? null : app.i18n.plural("paypal.desk.swept", sweepInfo.checked, { remaining: sweepInfo.remaining });
  const meta = [checked === null ? t("paypal.desk.neverChecked") : t("paypal.desk.checked", { time: formatDateTime(app.locale, checked) }), swept].filter((x) => x !== null).join(" · ");
  const proposals = desk.proposals;
  const list = <T,>(items: readonly T[], card: (item: T) => HTMLLIElement): HTMLElement => h("ul", { class: "desk-cards" }, items.map(card));
  replace(
    section,
    head(app, account),
    h("div", { class: "desk-tools" }, sweepKey, h("span", { class: "view-meta", attrs: { "data-meta": "" } }, meta), assistantLamp),
    desk.assistant.available ? null : h("p", { class: "field-hint" }, desk.assistant.reason === "resting" ? t("paypal.assistant.restingNote") : t("paypal.assistant.offNote")),
    desk.alerts.length === 0
      ? null
      : [h("div", { class: "sub-head" }, h("h3", null, t("paypal.desk.alerts")), h("span", { class: "view-meta" }, String(desk.alerts.length))), list(desk.alerts, (a) => alertCard(app, a))],
    h("div", { class: "sub-head" }, h("h3", null, t("paypal.desk.proposals")), h("span", { class: "view-meta" }, String(open))),
    proposals.length === 0 ? h("p", { class: "desk-empty" }, t("paypal.desk.noProposals")) : list(proposals, (p) => proposalCard(app, p, actions)),
    desk.autoRecords.length === 0
      ? null
      : [h("div", { class: "sub-head" }, h("h3", null, t("paypal.desk.records")), h("span", { class: "view-meta" }, String(desk.autoRecords.length))), list(desk.autoRecords, (r) => recordCard(app, r, actions))],
    checkBlock(app, api, account),
    foot,
  );
  if (sweep) {
    announce(meta);
  }
}

/** "Was I really paid?": the pasted message is data; the verdict comes from PayPal's GET and the chain only. */
function checkBlock(app: App, api: PaypalApi, account: AccountProvider): HTMLElement {
  const { t } = app.i18n;
  const input = h("textarea", { attrs: { id: "check-text", rows: "4", maxlength: String(DRAFT_MAX_TEXT), spellcheck: "false", placeholder: t("paypal.check.placeholder"), "aria-describedby": "check-hint" } });
  const key = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "check" } }, t("paypal.check.key"));
  const status = statusLine();
  const out = h("div", { class: "check-out" });
  key.addEventListener("click", () => {
    const text = input.value.trim();
    if (text === "") {
      setStatus(status, "err", t("paypal.check.empty"));
      input.focus();
      return;
    }
    key.disabled = true;
    key.setAttribute("aria-busy", "true");
    setStatus(status, "", t("paypal.check.checking"));
    replace(out);
    withSession(app, api, account, async (token) => await postCheck(api, token, { text }))
      .then((answer) => {
        setStatus(status, "", "");
        replace(out, verdictReadout(app, answer));
      })
      .catch((error: unknown) => {
        const failure = failureText(app, error);
        // No answer is never a verdict: "can't check now", with the reason under it.
        setStatus(status, "warn", t("paypal.check.cannot"), failure.code);
      })
      .finally(() => {
        key.disabled = false;
        key.removeAttribute("aria-busy");
      });
  });
  return h(
    "section",
    { class: "check-form", attrs: { "aria-labelledby": "check-head" } },
    h("div", { class: "sub-head" }, h("h3", { attrs: { id: "check-head" } }, t("paypal.check.head")), h("span", { class: "view-meta", attrs: { lang: "mg" } }, "Tonga ve?")),
    h("p", { class: "field-hint", attrs: { id: "check-hint" } }, t("paypal.check.hint")),
    h("div", { class: "field" }, h("label", { attrs: { for: "check-text" } }, t("paypal.check.label")), input),
    h("div", { class: "key-row" }, key),
    status,
    out,
  );
}
