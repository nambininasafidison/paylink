// SPDX-License-Identifier: MIT
/**
 * The payer's view of the PayPal fake (`recipient_view_url`): one plain page per invoice with its number, amount and
 * status, and one button that pays the amount due as a sandbox buyer would on PayPal's page. No style sheet, no
 * third-party asset; every value is escaped. It exists for the e2e suite and the judges' offline path; PayPal's real
 * page is PayPal's (docs/paypal/SPEC.md F2).
 *
 * The fake's payer links follow PayPal's own rule, `<origin>/invoice/p/#<id>` (`payPalPayerPageUrl` of
 * `@paylink/api-contract`, the sandbox's as the owner's capture of 2026-10-29 recorded it): the invoice is in the
 * fragment, which a browser never sends. So `/invoice/p/` answers a page whose one inline script, allowed by its hash and
 * nothing else, reads the fragment and opens the invoice's own page, `/invoice/p/<id>`, which has no script.
 *
 * Owner: PayPal spine workstream.
 */

/** What the page shows. */
export interface PayerView {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly currency: string;
  readonly total: string;
  readonly due: string;
  readonly payable: boolean;
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** HTML-escapes text for an element or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (ch) => ESCAPES[ch] ?? ch);
}

/** The page for `view`, or the "no such invoice" page; `payAction` is the form's target. */
export function payerPage(view: PayerView | null, payAction: string): string {
  const body =
    view === null
      ? "<h1>Invoice not found</h1><p>This PayPal fake has no such invoice.</p>"
      : [
          `<h1>Invoice ${escapeHtml(view.number)}</h1>`,
          `<p>Amount: <strong data-amount>${escapeHtml(view.total)} ${escapeHtml(view.currency)}</strong></p>`,
          `<p>Due: <span data-due>${escapeHtml(view.due)} ${escapeHtml(view.currency)}</span></p>`,
          `<p>Status: <span data-status>${escapeHtml(view.status)}</span></p>`,
          view.payable
            ? `<form method="post" action="${escapeHtml(payAction)}"><button type="submit">Pay ${escapeHtml(view.due)} ${escapeHtml(view.currency)} as the sandbox buyer</button></form>`
            : "<p>Nothing to pay.</p>",
        ].join("\n");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>PayPal fake: invoice</title>",
    "</head>",
    "<body>",
    "<p><em>PayPal fake (PayLink tests and offline demo). Not PayPal, no money.</em></p>",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * The one script of `/invoice/p/`: the invoice id in the fragment opens `/invoice/p/<id>` (relative to `/invoice/p/`,
 * so a mount path is kept); anything else says so.
 */
export const PAYER_REDIRECT_SCRIPT =
  'var id = location.hash.slice(1); if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) { location.replace(encodeURIComponent(id)); } else { document.body.textContent = "Invoice not found: no invoice id after # in this PayPal fake link."; }';

/** `script-src` of that page: the SHA-256 of `PAYER_REDIRECT_SCRIPT` (test/paypal/fake.test.ts recomputes it). */
export const PAYER_REDIRECT_SCRIPT_HASH = "sha256-MijRx4n5dxI9sAihNwccN4zo0U9nrL7nKqQIrRbKxZY=";

/** The page of `/invoice/p/`: PayPal's payer link without the invoice in the path (module comment). */
export function payerRedirectPage(): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>PayPal fake: invoice</title>",
    "</head>",
    "<body>",
    "<p><em>PayPal fake (PayLink tests and offline demo). Not PayPal, no money.</em></p>",
    `<script>${PAYER_REDIRECT_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
