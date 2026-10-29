// SPDX-License-Identifier: MIT
/**
 * The pay page's rail chooser (docs/paypal/SPEC.md §12.3, §14.2 F2 and F3, §14.3 "Rail chooser"): one link, two rails.
 *
 * - **Pay with PayPal**: the page's primary key whenever it is offered (a payer without a wallet, the judges' path B,
 *   meets it first; the token key then steps back to a secondary "Or pay in USDC from a wallet"). A top-level link to
 *   the twin's payer page (`recipient_view_url`, from the public `GET /v1/rails/:key`). It is offered only when all
 *   of these hold, checked in the browser: the four lamps are green (the chain says the invoice is genuine and
 *   payable); the API says the twin is open; the URL is PayPal's sandbox payer page exactly as pinned in code
 *   (`https://www.sandbox.paypal.com/invoice/p/#<id>`: `https:`, that host, no credentials or port, that path, no query;
 *   `PAYPAL_PAYER_HOSTS` here, `isPayPalPayerPage` of `@paylink/api-contract`, never taken from the API or the link); and
 *   the twin's amount, in USD, equals the signed amount exactly. Otherwise the PayPal key is not shown: the API is
 *   trusted for availability and advice, never for where a payer goes or how much they pay (threats T-56, T-58).
 * - **Pay in USDC or PayPal USD**: the page's own key, on Ethereum Sepolia from the payer's wallet, unchanged.
 *
 * States: both rails · PayPal hidden (no twin, the API unreachable, or a check failed, which says so) · "PayPal says
 * this invoice is paid" (advisory: the token key waits for the payer to say they did not pay there) · a PayPal payment
 * in flight (neither rail) · the token paused or an address frozen by its issuer (fixed text; the token key waits).
 *
 * Loaded by the pay page with a dynamic import, in the PayPal edition only: the pay route's first load (110 kB of gzipped
 * JavaScript) does not carry it. It imports as little of the app as it can (the DOM builder, the API client, exact
 * amounts) and takes the page's formatters as arguments, so the code the pay route shares with it stays in one chunk.
 *
 * Owner: web edition workstream.
 */
import { isPayPalPayerPage, PAYPAL_EDITION_CHAIN_ID, PAYPAL_PAYER_PAGES } from "@paylink/api-contract";
import type { RailsResponse } from "@paylink/api-contract";
import type { DecodedInvoiceLink } from "@paylink/sdk";
import type { Address, Hex } from "viem";
import type { App } from "../../app/context.ts";
import type { ChainClient } from "../../core/clients.ts";
import { h, replace } from "../../ui/h.ts";
import { getRails, paypalApi } from "./api.ts";
import { baseFromDecimal, seconds, usdFromBase } from "./money.ts";

/**
 * The only host a payer is sent to: PayPal's sandbox, whose payer page the owner's capture of 2026-10-29 recorded as
 * `https://www.sandbox.paypal.com/invoice/p/#{id}` (docs/research/paypal/capture-2026-10-29.md). The edition is sandbox
 * only (decision D-HOST): PayPal's live payer page, the same rule on `www.paypal.com`, is never followed from it. A
 * change here is a reviewed commit.
 */
export const PAYPAL_PAYER_HOSTS: readonly string[] = [PAYPAL_PAYER_PAGES.sandbox.host];

/** The payer page's URL when it may be followed (PayPal's sandbox payer page, `isPayPalPayerPage`), else `null`. */
export function payerUrl(value: string | null): URL | null {
  if (value === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return PAYPAL_PAYER_HOSTS.includes(url.hostname) && isPayPalPayerPage(url, "sandbox") ? url : null;
}

/** What the chooser does with the API's answer for this link, before the lamps are read. */
export type RailVerdict =
  | { readonly kind: "offer"; readonly url: string }
  | { readonly kind: "hidden"; readonly reason: "none" | "closed" | "host" | "amount" | "ineligible" }
  | { readonly kind: "paid" }
  | { readonly kind: "pending" };

/** Whether this link could have a twin at all: one payment, a fixed amount in whole cents, USDC or PayPal USD. */
export function twinnable(link: DecodedInvoiceLink): boolean {
  return link.invoice.maxPayments === 1 && link.invoice.amount !== 0n && (link.token.symbol === "USDC" || link.token.symbol === "PYUSD") && usdFromBase(link.invoice.amount, link.token.decimals) !== null;
}

/** The verdict for `rails` on `link`: the host and the exact amount are checked here, whatever the API says. */
export function railVerdict(link: DecodedInvoiceLink, rails: RailsResponse): RailVerdict {
  if (!twinnable(link)) {
    return { kind: "hidden", reason: "ineligible" };
  }
  switch (rails.status) {
    case "none":
      return { kind: "hidden", reason: "none" };
    case "closed":
      return { kind: "hidden", reason: "closed" };
    case "pending":
      return { kind: "pending" };
    case "paid":
      return { kind: "paid" };
    case "open": {
      const url = payerUrl(rails.url);
      if (url === null) {
        return { kind: "hidden", reason: "host" };
      }
      const amount = rails.amount === null ? null : baseFromDecimal(rails.amount, link.token.decimals);
      if (rails.currency !== "USD" || amount !== link.invoice.amount) {
        return { kind: "hidden", reason: "amount" };
      }
      return { kind: "offer", url: url.href };
    }
  }
}

/** The token's issuer controls on Ethereum Sepolia, read live (both answered on chain on 2026-10-22, block 11,966,866). */
const PAUSED: Hex = "0x5c975abb"; // paused()
const FROZEN: Readonly<Record<string, Hex>> = {
  PYUSD: "0xe5839836", // isFrozen(address), Paxos PaxosTokenV2
  USDC: "0xfe575a87", // isBlacklisted(address), Circle FiatToken
};

const word = (address: Address): string => address.slice(2).toLowerCase().padStart(64, "0");

async function flag(client: ChainClient, to: Address, data: Hex): Promise<boolean | null> {
  try {
    const result = await client.call({ to, data });
    if (result.data === undefined || !/^0x[0-9a-f]{64}$/i.test(result.data)) {
      return null;
    }
    return BigInt(result.data) !== 0n;
  } catch {
    return null;
  }
}

/** Whether the issuer has paused the token, or frozen the payee or PayLinkV2 (`null` members: not readable). */
export async function tokenControls(client: ChainClient, link: DecodedInvoiceLink): Promise<{ readonly paused: boolean | null; readonly frozen: boolean | null }> {
  const selector = FROZEN[link.token.symbol];
  const [paused, payee, contract] = await Promise.all([
    flag(client, link.token.address, PAUSED),
    selector === undefined ? Promise.resolve(null) : flag(client, link.token.address, `${selector}${word(link.invoice.payee)}`),
    selector === undefined ? Promise.resolve(null) : flag(client, link.token.address, `${selector}${word(link.target.deployment.address)}`),
  ]);
  return { paused, frozen: payee === true || contract === true ? true : payee === null && contract === null ? null : false };
}

export interface RailChooser {
  readonly element: HTMLElement;
  /** The chain's checks were read: `allowed` is true when every lamp is green and payments are not locked. */
  checked(allowed: boolean): void;
  /** True while the token key must wait: a PayPal payment in flight, the token paused or frozen, or "paid" unconfirmed. */
  holds(): boolean;
  /** True while "Pay with PayPal" is offered (both rails): it is then the page's primary key, the token key secondary. */
  offers(): boolean;
}

/** `text` with the word PayPal set as a wordmark (bold, the edition's ink: no brand colour, ADR 0018's grammar). */
function withWordmark(text: string): (string | HTMLElement)[] {
  const at = text.indexOf("PayPal");
  return at < 0 ? [text] : [text.slice(0, at), h("b", { class: "paypal-word" }, "PayPal"), text.slice(at + "PayPal".length)];
}

/** The pay page's own formatters: the invoice's amount and a time of day, in the payer's language. */
export interface RailFormat {
  amount(value: bigint): string;
  time(unixSeconds: number): string;
}

/** The chooser for `link`. `changed` is called when `holds()` may have changed. */
export function railChooser(app: Pick<App, "i18n" | "config" | "client">, link: DecodedInvoiceLink, format: RailFormat, changed: () => void): RailChooser {
  const { t } = app.i18n;
  const element = h("div", { class: "rails", attrs: { "data-rails": "checking", "aria-live": "polite" } });
  let verdict: RailVerdict | null = null;
  let checkedAt: string | null = null;
  let allowed = false;
  let controls: { paused: boolean | null; frozen: boolean | null } = { paused: null, frozen: null };
  let paidConfirmed = false;

  const paint = (): void => {
    const notes: HTMLElement[] = [];
    if (controls.paused === true) {
      notes.push(h("p", { class: "warn-note is-err", attrs: { "data-hold": "paused" } }, h("b", null, t("paypal.rails.pausedHead", { symbol: link.token.symbol })), " ", t("paypal.rails.paused", { symbol: link.token.symbol })));
    } else if (controls.frozen === true) {
      notes.push(h("p", { class: "warn-note is-err", attrs: { "data-hold": "frozen" } }, h("b", null, t("paypal.rails.frozenHead")), " ", t("paypal.rails.frozen", { symbol: link.token.symbol })));
    }
    const when = seconds(checkedAt);
    const read = when === null ? "" : format.time(when);
    if (verdict?.kind === "pending") {
      element.setAttribute("data-rails", "pending");
      replace(element, h("p", { class: "warn-note", attrs: { "data-hold": "pending" } }, h("b", null, t("paypal.rails.pendingHead")), " ", t("paypal.rails.pending")), notes);
      return;
    }
    if (verdict?.kind === "paid") {
      element.setAttribute("data-rails", "paid");
      const note = h("p", { class: "warn-note", attrs: { "data-hold": paidConfirmed ? null : "paid" } }, h("b", null, t("paypal.rails.paidHead")), " ", t("paypal.rails.paid", { time: read }));
      const confirm = h("input", { attrs: { type: "checkbox", "data-action": "not-paid-on-paypal" } });
      confirm.checked = paidConfirmed;
      confirm.addEventListener("change", () => {
        paidConfirmed = confirm.checked;
        if (paidConfirmed) {
          note.removeAttribute("data-hold");
        } else {
          note.setAttribute("data-hold", "paid");
        }
        changed();
      });
      replace(element, note, h("label", { class: "check" }, confirm, h("span", null, t("paypal.rails.paidConfirm"))), notes);
      return;
    }
    if (verdict?.kind === "offer" && allowed) {
      element.setAttribute("data-rails", "both");
      const amount = `${format.amount(link.invoice.amount)} USD`;
      replace(
        element,
        h("p", { class: "rails-head" }, t("paypal.rails.head")),
        h(
          "div",
          { class: "rail-row", attrs: { "data-rail": "PAYPAL" } },
          h("a", { class: "key key-primary key-paypal", attrs: { href: verdict.url, rel: "noopener noreferrer", "data-action": "pay-paypal" } }, h("span", null, withWordmark(t("paypal.rails.payPaypal"))), h("span", { class: "rail-tag" }, "PAYPAL")),
          h("p", { class: "route-note" }, t("paypal.rails.paypalNote", { amount, time: read })),
        ),
        h("p", { class: "rails-or", attrs: { "data-rail": link.token.symbol } }, t("paypal.rails.or", { symbol: link.token.symbol })),
        notes,
      );
      return;
    }
    element.setAttribute("data-rails", verdict === null ? "checking" : verdict.kind === "offer" ? "waiting" : `hidden-${verdict.reason}`);
    const withheld = verdict?.kind === "hidden" && (verdict.reason === "host" || verdict.reason === "amount") ? verdict.reason : null;
    replace(element, withheld === null ? null : h("p", { class: "warn-note is-err", attrs: { "data-withheld": withheld } }, h("b", null, t("paypal.rails.withheldHead")), " ", t("paypal.rails.withheld")), notes);
  };

  // The API named by /config.json for Ethereum Sepolia (as `apiUrl` reads it, without importing the config module).
  const endpoint = app.config.api ?? null;
  const api = endpoint?.chains.includes(PAYPAL_EDITION_CHAIN_ID) === true ? paypalApi(endpoint.url) : null;
  const client = app.client(link.target.chain);
  void tokenControls(client, link).then((read) => {
    controls = read;
    paint();
    changed();
  });
  if (api === null || !twinnable(link)) {
    verdict = { kind: "hidden", reason: api === null ? "none" : "ineligible" };
    paint();
  } else {
    void getRails(api, link.key)
      .then((rails) => {
        verdict = railVerdict(link, rails);
        checkedAt = rails.checkedAt;
      })
      .catch(() => {
        // No answer: the PayPal key is simply not offered; the token rail works without the API.
        verdict = { kind: "hidden", reason: "none" };
      })
      .finally(() => {
        paint();
        changed();
      });
  }
  paint();

  return {
    element,
    checked(value) {
      allowed = value;
      paint();
    },
    holds() {
      return controls.paused === true || controls.frozen === true || verdict?.kind === "pending" || (verdict?.kind === "paid" && !paidConfirmed);
    },
    offers() {
      return verdict?.kind === "offer" && allowed;
    },
  };
}
