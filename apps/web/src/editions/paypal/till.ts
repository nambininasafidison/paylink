// SPDX-License-Identifier: MIT
/**
 * The till's PayPal source (docs/paypal/SPEC.md §14.2 F4, §3.1 U3, §3.2 "PayPal payment"): while an armed till runs in
 * the PayPal edition, it also reads the invoice's PayPal twin through the API (`GET /v1/twin/:key`, every 3 seconds,
 * §7.5; the API answers from its cache and asks PayPal at most once per twin every 10 seconds).
 *
 * The till lights for PayPal only when all of these hold, checked here whatever the API says: PayPal's status, as PayPal's
 * own GET returned it, is `PAID`; the reconciler puts the twin in S2 (paid on PayPal, at least one transaction that is
 * not PayLink's own record of a chain payment) or S4 (paid on both rails: still a PayPal payment); the twin is the armed
 * invoice's (same key); and its amount in USD (the only currency a twin has) is the signed amount exactly. `MARKED_AS_PAID`, a payment in flight, a
 * partial payment or an echo of a chain payment never light it: the chain lights those itself, from its own receipt.
 *
 * Reading the twin needs the payee's desk session. The till never asks for a signature on its own: with no session on
 * this device, it shows a key that opens one (one wallet signature, no transaction, no fee), and watches the chain
 * meanwhile. No model text reaches the till: a twin carries none, and every word here is fixed (AI-4).
 *
 * Owner: web edition workstream.
 */
import type { TwinView } from "@paylink/api-contract";
import type { DecodedInvoiceLink } from "@paylink/sdk";
import type { App } from "../../app/context.ts";
import { pickWallet } from "../../app/wallet-ui.ts";
import { h, replace } from "../../ui/h.ts";
import { ApiError, getTwin } from "./api.ts";
import { apiFor } from "./context.ts";
import { baseFromDecimal } from "./money.ts";
import { forgetSession, openSession, storedSession } from "./session.ts";
import { rememberTwin } from "./twins.ts";

/** How often a running till reads the twin (docs/paypal/SPEC.md §7.5: "every 3 s while an invoice is armed"). */
export const TWIN_POLL_MS = 3000;

/** Whether `twin` is a verified PayPal payment of `link`, exactly (the till's only PayPal rule). */
export function paidOnPaypal(link: Pick<DecodedInvoiceLink, "key" | "invoice" | "token">, twin: TwinView): boolean {
  return (
    twin.status === "PAID" &&
    (twin.situation === "S2" || twin.situation === "S4") &&
    twin.key.toLowerCase() === link.key.toLowerCase() &&
    link.invoice.amount !== 0n &&
    baseFromDecimal(twin.amount, link.token.decimals) === link.invoice.amount
  );
}

/** What the till's PayPal line says. */
export type PaypalTillState = "off" | "no-session" | "watching" | "no-twin" | "unreachable" | "paid";

export interface PaypalTill {
  /** The PayPal line under the till's display (fixed words only). */
  readonly element: HTMLElement;
  /** The till started: read the twin now and every 3 seconds. */
  start(): void;
  /** The till stopped (or lit): no more reads. */
  stop(): void;
}

/**
 * The PayPal side of an armed till. `onPaid` is called once, with the twin as the API read it, when `paidOnPaypal`
 * holds; the till then lights with the source "via PAYPAL" and the time PayPal was read.
 */
export function paypalTill(app: App, link: DecodedInvoiceLink, onPaid: (twin: TwinView) => void): PaypalTill {
  const { t } = app.i18n;
  const element = h("div", { class: "till-paypal", attrs: { "data-paypal": "off" } });
  const api = apiFor(app);
  let running = false;
  let timer = 0;
  let lit = false;

  const say = (state: PaypalTillState, ...children: (HTMLElement | string)[]): void => {
    element.setAttribute("data-paypal", state);
    replace(element, ...children);
  };

  const payeeAccount = (): ReturnType<App["session"]["account"]> => {
    const account = app.session.account();
    return account !== null && account.address.toLowerCase() === link.invoice.payee.toLowerCase() ? account : null;
  };

  const askForSession = (): void => {
    const key = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "watch-paypal" } }, t("paypal.till.watch"));
    key.addEventListener("click", () => {
      key.disabled = true;
      key.setAttribute("aria-busy", "true");
      void (async () => {
        try {
          await app.session.ready;
          const account = payeeAccount() ?? (await pickWallet(app));
          if (api === null || account?.address.toLowerCase() !== link.invoice.payee.toLowerCase()) {
            say("no-session", h("p", { class: "field-hint" }, t("paypal.till.payeeOnly")), key);
            return;
          }
          await openSession(app, api, account);
          if (running) {
            poll();
          } else {
            say("watching", h("p", { class: "field-hint" }, t("paypal.till.ready")));
          }
        } catch {
          say("no-session", h("p", { class: "field-hint" }, t("paypal.till.notWatched")), key);
        } finally {
          key.disabled = false;
          key.removeAttribute("aria-busy");
        }
      })();
    });
    say("no-session", h("p", { class: "field-hint" }, t("paypal.till.notWatched")), key);
  };

  const token = (): string | null => {
    const account = payeeAccount();
    return account === null ? null : storedSession(account.address);
  };

  const schedule = (): void => {
    window.clearTimeout(timer);
    if (running && !lit) {
      timer = window.setTimeout(poll, TWIN_POLL_MS);
    }
  };

  function poll(): void {
    if (!running || lit || api === null) {
      return;
    }
    const session = token();
    if (session === null) {
      askForSession();
      return;
    }
    getTwin(api, session, link.key)
      .then((twin) => {
        rememberTwin(twin);
        if (!running || lit) {
          return;
        }
        if (paidOnPaypal(link, twin)) {
          lit = true;
          say("paid", h("p", { class: "field-hint" }, t("paypal.till.verified")));
          onPaid(twin);
          return;
        }
        say("watching", h("p", { class: "field-hint" }, t("paypal.till.watching")));
        schedule();
      })
      .catch((error: unknown) => {
        if (!running || lit) {
          return;
        }
        if (error instanceof ApiError && error.code === "unauthorized") {
          forgetSession();
          askForSession();
          return;
        }
        if (error instanceof ApiError && error.code === "not-found") {
          // No twin for this invoice: nothing to watch on PayPal; the chain is watched as always.
          say("no-twin", h("p", { class: "field-hint" }, t("paypal.till.noTwin")));
          return;
        }
        say("unreachable", h("p", { class: "field-hint" }, t("paypal.till.unreachable")));
        schedule();
      });
  }

  if (api === null) {
    say("off", h("p", { class: "field-hint" }, t("paypal.till.noApi")));
  } else if (token() === null) {
    askForSession();
  } else {
    say("watching", h("p", { class: "field-hint" }, t("paypal.till.ready")));
  }

  return {
    element,
    start() {
      running = true;
      lit = false;
      if (api !== null) {
        poll();
      }
    },
    stop() {
      running = false;
      window.clearTimeout(timer);
    },
  };
}
