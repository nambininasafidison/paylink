// SPDX-License-Identifier: MIT
/**
 * The payer's view of the PayPal fake (`recipient_view_url`): one plain page per invoice with its number, amount and
 * status, and one button that pays the amount due as a sandbox buyer would on PayPal's page. No script, no style sheet,
 * no third-party asset; every value is escaped. It exists for the e2e suite and the judges' offline path; PayPal's real
 * page is PayPal's (docs/paypal/SPEC.md F2).
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
