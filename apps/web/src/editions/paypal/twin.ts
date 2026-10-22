// SPDX-License-Identifier: MIT
/**
 * The twin panel (docs/paypal/SPEC.md §7, §14.2 F1, §14.3 "Twin panel"), under an invoice the payee just signed: one
 * key makes its PayPal twin (`POST /v1/twin` with the signed link exactly as shared), and the panel shows what PayPal
 * itself answered when the API read the twin back (`GET` P5): its number, its status and when it was read.
 *
 * States: ready (optional client name, email and due date) · creating · created and read back (`SHARED` or `SENT`) ·
 * PayPal unavailable ("the invoice is still valid; the PayPal option appears when PayPal answers", and Retry) · hands
 * off (situation S0: PayPal's copy does not match) · not eligible (open amount, several payments, a fraction of a cent,
 * another token or chain) · API not configured. The panel never changes the signed invoice: the link works whatever
 * PayPal does.
 *
 * Making a twin needs a session with the API: the first time, the wallet signs one (no transaction, no fee).
 *
 * Owner: web edition workstream.
 */
import { PAYPAL_EDITION_CHAIN_ID } from "@paylink/api-contract";
import type { TwinCreateRequest, TwinView } from "@paylink/api-contract";
import { formatDateTime } from "@paylink/i18n";
import type { PlainMessageKey } from "@paylink/i18n";
import type { IssuedInvoice } from "@paylink/sdk";
import type { App } from "../../app/context.ts";
import { pickWallet } from "../../app/wallet-ui.ts";
import { displayAmount } from "../../core/format.ts";
import { fact, lamp, setStatus, statusLine } from "../../ui/atoms.ts";
import type { LampKind } from "../../ui/atoms.ts";
import { h, replace } from "../../ui/h.ts";
import { ApiError, postTwin } from "./api.ts";
import { apiFor, baseFromDecimal, failureText, seconds, usdFromBase } from "./context.ts";
import { withSession } from "./session.ts";
import { rememberTwin } from "./twins.ts";

/** Why an invoice cannot have a twin (the API refuses the same, docs/paypal/SPEC.md §7.2). */
export type TwinIneligible = "chain" | "open" | "several" | "cents" | "token";

export function twinEligibility(issued: Pick<IssuedInvoice, "signed" | "token">): TwinIneligible | null {
  const { invoice, chainId } = issued.signed;
  if (chainId !== PAYPAL_EDITION_CHAIN_ID) {
    return "chain";
  }
  if (invoice.amount === 0n) {
    return "open";
  }
  if (invoice.maxPayments !== 1) {
    return "several";
  }
  if (issued.token.symbol !== "USDC" && issued.token.symbol !== "PYUSD") {
    return "token";
  }
  return usdFromBase(invoice.amount, issued.token.decimals) === null ? "cents" : null;
}

const INELIGIBLE_TEXT: Readonly<Record<TwinIneligible, PlainMessageKey>> = {
  chain: "paypal.twin.ineligible.chain",
  open: "paypal.twin.ineligible.open",
  several: "paypal.twin.ineligible.several",
  cents: "paypal.twin.ineligible.cents",
  token: "paypal.twin.ineligible.token",
};

/** The lamp of a PayPal status class on the twin readout. */
function statusLamp(statusClass: string): LampKind {
  switch (statusClass) {
    case "open":
      return "open";
    case "paid":
    case "paid-outside":
      return "paid";
    case "in-flight":
    case "open-not-sent":
    case "not-sent":
      return "wait";
    case "cancelled":
    case "refunded":
      return "closed";
    default:
      return "err";
  }
}

/** What the payee typed for the twin, or a draft's values to start from. */
export interface TwinHints {
  readonly clientName: string | null;
  readonly clientEmail: string | null;
  readonly dueDate: string | null;
}

/** The readout of a twin as PayPal answered it: number, status, amount, last read. */
export function twinReadout(app: App, twin: TwinView): HTMLElement {
  const { t } = app.i18n;
  const checked = seconds(twin.checkedAt);
  const amount = baseFromDecimal(twin.amount, 6);
  return h(
    "section",
    { class: "screen twin-readout", attrs: { "aria-labelledby": "twin-number", "data-status": twin.status } },
    h("div", { class: "screen-top" }, h("span", null, t("paypal.twin.readoutKicker")), h("span", { class: "rail-tag" }, "PAYPAL")),
    h("p", { class: "twin-number", attrs: { id: "twin-number" } }, twin.number),
    h(
      "dl",
      { class: "readings" },
      fact(t("paypal.twin.status"), lamp(statusLamp(twin.statusClass), twin.status, true)),
      fact(t("paypal.twin.amount"), amount === null ? twin.amount : `${displayAmount(amount, { decimals: 6 }, app.locale)} ${twin.currency}`),
      fact(t("paypal.twin.checked"), checked === null ? "—" : formatDateTime(app.locale, checked, { dateStyle: "medium", timeStyle: "medium" })),
    ),
  );
}

/** The twin panel for `issued`, shared at `url`. `hints` prefill the client fields (from an AI draft, if any). */
export function twinPanel(app: App, issued: IssuedInvoice, url: string, hints: TwinHints | null): HTMLElement {
  const { t } = app.i18n;
  const section = h("section", { class: "twin", attrs: { "aria-labelledby": "twin-head", "data-state": "ready" } });
  const head = h("div", { class: "sub-head" }, h("h3", { attrs: { id: "twin-head" } }, t("paypal.twin.head")), h("span", { class: "rail-tags" }, h("span", { class: "rail-tag" }, "PAYPAL"), h("span", { class: "rail-tag" }, issued.token.symbol)));
  const state = (value: string): void => {
    section.setAttribute("data-state", value);
  };
  const ineligible = twinEligibility(issued);
  if (ineligible !== null) {
    state("ineligible");
    replace(section, head, h("p", { class: "field-hint" }, t(INELIGIBLE_TEXT[ineligible])));
    return section;
  }
  const api = apiFor(app);
  if (api === null) {
    state("no-api");
    replace(section, head, h("p", { class: "field-hint" }, t("paypal.twin.noApi")));
    return section;
  }
  const amountUsd = usdFromBase(issued.signed.invoice.amount, issued.token.decimals) ?? "";
  const nameInput = h("input", { attrs: { id: "twin-name", autocomplete: "off", maxlength: "140", value: hints?.clientName ?? "" } });
  const emailInput = h("input", { attrs: { id: "twin-email", type: "email", autocomplete: "off", maxlength: "254", value: hints?.clientEmail ?? "", "aria-describedby": "twin-email-hint" } });
  const dueInput = h("input", { attrs: { id: "twin-due", type: "date", value: hints?.dueDate ?? "" } });
  const fields = h(
    "div",
    { class: "twin-fields" },
    h("div", { class: "field" }, h("label", { attrs: { for: "twin-name" } }, t("paypal.twin.name"), h("span", { class: "opt" }, t("common.optional"))), nameInput),
    h("div", { class: "field" }, h("label", { attrs: { for: "twin-due" } }, t("paypal.twin.due"), h("span", { class: "opt" }, t("common.optional"))), dueInput),
    h(
      "div",
      { class: "field" },
      h("label", { attrs: { for: "twin-email" } }, t("paypal.twin.email"), h("span", { class: "opt" }, t("common.optional"))),
      emailInput,
      h("p", { class: "field-hint", attrs: { id: "twin-email-hint" } }, t("paypal.twin.emailHint")),
    ),
  );
  const key = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "make-twin" } }, t("paypal.twin.make", { amount: amountUsd }));
  const status = statusLine();
  const out = h("div", { class: "twin-out" });

  const request = (): TwinCreateRequest => {
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const due = dueInput.value.trim();
    return {
      link: url,
      ...(name === "" && email === "" ? {} : { recipient: { ...(name === "" ? {} : { givenName: name }), ...(email === "" ? {} : { email }) } }),
      ...(due === "" ? {} : { dueDate: due }),
    };
  };

  const make = async (): Promise<void> => {
    if (!emailInput.checkValidity()) {
      setStatus(status, "err", t("paypal.twin.emailInvalid"));
      emailInput.focus();
      return;
    }
    await app.session.ready;
    const account = app.session.account() ?? (await pickWallet(app));
    if (account === null) {
      setStatus(status, "", t("paypal.session.needWallet"));
      return;
    }
    key.disabled = true;
    key.setAttribute("aria-busy", "true");
    state("creating");
    setStatus(status, "", t("paypal.twin.creating"));
    replace(out);
    try {
      const { twin } = await withSession(app, api, account, async (token) => {
        setStatus(status, "", t("paypal.twin.creating"));
        return await postTwin(api, token, request());
      }, () => {
        setStatus(status, "", t("paypal.session.signing"));
      });
      rememberTwin(twin);
      if (twin.situation === "S0") {
        state("hands-off");
        setStatus(status, "err", t("paypal.twin.handsOff"));
        replace(out, twinReadout(app, twin));
        return;
      }
      state("created");
      fields.hidden = true;
      key.hidden = true;
      setStatus(status, "ok", t("paypal.twin.created", { number: twin.number }));
      replace(out, twinReadout(app, twin), h("p", { class: "field-hint" }, t("paypal.twin.createdNote")));
    } catch (error) {
      if (error instanceof ApiError && (error.code === "paypal-unavailable" || error.code === "network" || error.code === "timeout" || error.code === "rate-limited")) {
        state("paypal-unavailable");
        setStatus(status, "warn", t("paypal.twin.unavailable"), failureText(app, error).code);
        key.textContent = t("paypal.twin.retry");
      } else {
        state("error");
        const failure = failureText(app, error);
        setStatus(status, "err", failure.message, failure.code);
      }
    } finally {
      key.disabled = false;
      key.removeAttribute("aria-busy");
    }
  };
  key.addEventListener("click", () => {
    void make();
  });
  replace(section, head, h("p", { class: "field-hint" }, t("paypal.twin.lede")), fields, key, status, out);
  return section;
}
