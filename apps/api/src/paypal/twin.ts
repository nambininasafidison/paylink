// SPDX-License-Identifier: MIT
/**
 * One PayPal twin per PayLink key, whatever happens (docs/paypal/SPEC.md §3.2 "Twin": a retried `POST /v1/twin` for the
 * same K yields one PayPal invoice). No Invoicing operation documents an idempotency header (§7.1 P2), so the twin is
 * found before it is made, and every write whose outcome is unknown is settled by reading:
 *
 * 1. P2: search by `reference`, keeping only invoices whose `detail.reference` is exactly K (PayPal's matching is
 *    partial: a part of a reference finds the invoice, C, the owner's capture of 2026-10-29). Several matches (left by an
 *    earlier failure) → the oldest is the twin.
 * 2. None: P3 with the §7.2 body. A P3 that failed ambiguously (no answer, 5xx) or was refused as a conflict is followed
 *    by P2 again: the invoice it may have made is found, never made twice.
 * 3. A `DRAFT` twin: P4 as a share link. 202 means scheduled (`E_PAYPAL_SCHEDULED`, situation S0). A P4 that failed
 *    ambiguously or was refused is settled by P5: an invoice no longer in `DRAFT` was sent.
 * 4. P5: the twin as PayPal holds it, the answer the caller registers.
 *
 * Each write carries a deterministic `PayPal-Request-Id` (src/paypal/idempotency.ts) as a second line of defence.
 *
 * Owner: PayPal spine workstream.
 */
import type { InvoiceKey } from "@paylink/api-contract";
import type { PayPalClient } from "./client.ts";
import { isPayPalError } from "./client.ts";
import { requestIdFor } from "./idempotency.ts";
import { SHARE_LINK } from "./invoice.ts";
import type { CreateInvoiceRequest, Invoice } from "./types.ts";

/** What `ensureTwin` did. */
export interface EnsuredTwin {
  /** P5's answer after the last write. */
  readonly invoice: Invoice;
  /** `found`: P2 found it (a retry, or a rebuild); `created`: this call made it. */
  readonly origin: "found" | "created";
  /** The answer of this call's P4, or `null` when the twin was already sent. */
  readonly send: 200 | 202 | "settled-by-read" | null;
  /** Other invoices with the same reference (left by an earlier failure); the reconciler alerts on them. */
  readonly duplicates: readonly string[];
}

/** Invoices whose reference is exactly `key`, oldest first. */
export async function findTwins(paypal: PayPalClient, key: InvoiceKey): Promise<readonly Invoice[]> {
  const page = await paypal.searchInvoices({ reference: key }, { page: 1, page_size: 20 });
  return (page.items ?? [])
    .filter((invoice) => invoice.detail.reference === key && typeof invoice.id === "string")
    .sort((a, b) => (a.detail.metadata?.create_time ?? "").localeCompare(b.detail.metadata?.create_time ?? ""));
}

/** P2, then P3 and P4 only if needed, then P5 (the module comment's four steps). */
export async function ensureTwin(paypal: PayPalClient, key: InvoiceKey, body: CreateInvoiceRequest): Promise<EnsuredTwin> {
  if (body.detail.reference !== key) {
    throw new RangeError("the create body's reference must be the key");
  }
  let found = await findTwins(paypal, key);
  let origin: EnsuredTwin["origin"] = "found";
  if (found.length === 0) {
    try {
      found = [await paypal.createInvoice(body, { requestId: requestIdFor("create", key) })];
      origin = "created";
    } catch (error) {
      if (!isPayPalError(error) || !(error.ambiguous || error.status === 409 || error.status === 422)) {
        throw error;
      }
      // The write may have happened (or a concurrent call made the twin): only a read can tell.
      found = await findTwins(paypal, key);
      if (found.length === 0) {
        throw error;
      }
    }
  }
  const [twin, ...others] = found;
  const id = twin?.id;
  if (id === undefined) {
    throw new RangeError("PayPal returned an invoice without an id");
  }
  let send: EnsuredTwin["send"] = null;
  if ((twin?.status ?? "DRAFT") === "DRAFT") {
    try {
      send = (await paypal.sendInvoice(id, SHARE_LINK, { requestId: requestIdFor("send", key) })).status;
    } catch (error) {
      if (!isPayPalError(error) || !(error.ambiguous || error.status === 409 || error.status === 422)) {
        throw error;
      }
      const read = await paypal.getInvoice(id);
      if ((read.status ?? "DRAFT") === "DRAFT") {
        throw error;
      }
      send = "settled-by-read";
    }
  }
  return { invoice: await paypal.getInvoice(id), origin, send, duplicates: others.map((i) => i.id ?? "").filter((i) => i !== "") };
}
