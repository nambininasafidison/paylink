// SPDX-License-Identifier: MIT
/**
 * POST /v1/paypal/webhook (docs/paypal/SPEC.md §7.5, ADR 0018): a PayPal delivery is a hint that an invoice changed,
 * never a fact. In order:
 *
 * 1. The raw body (at most 64 KiB, read once) and the five transmission headers; missing or malformed → 400
 *    `webhook-rejected` (rule `E_WEBHOOK_MALFORMED`), nothing called, nothing changed.
 * 2. P10 with the body spliced in raw, against `PAYPAL_WEBHOOK_ID` (the fake's subscription in `fake` mode). Anything but
 *    `SUCCESS` → 400 `webhook-rejected` (rule `E_WEBHOOK_SIGNATURE`) and a `webhook.rejected` log line; no id configured
 *    → 503 (rule `E_WEBHOOK_NOT_CONFIGURED`); PayPal not answering → 503: in both cases PayPal delivers again later.
 * 3. Idempotency: the event id is recorded in the Global store (7 days); a repeat answers 200 `duplicate` and does
 *    nothing more. When the store cannot be read the delivery is processed anyway: everything after this step is
 *    idempotent (a read and a deterministic reconciliation).
 * 4. Events that are not `INVOICING.INVOICE.*`, or that name no invoice, answer 200 `ignored`: PayPal stops retrying.
 * 5. P5: the invoice as PayPal holds it. Only an invoice whose `detail.reference` is a PayLink key and whose private memo
 *    names a payee on this API's chain is a twin (src/paypal/invoice.ts); any other answers 200 `ignored`.
 * 6. The twin is handed to the sink: the reconciler's `reconcileTwinEvent` (src/reconciler/engine.ts), which reconciles
 *    it at once with P5's answer and the chain, or plans it for the cron when another reconciliation holds the twin.
 *    Truth comes from P5 and the chain there, never from the body. P5 failing after a verified delivery answers 200
 *    `deferred`: the event id is already recorded, and the cron's own schedule reads the twin again.
 *
 * Answers to PayPal carry no detail beyond the outcome. Logs carry the event type, the outcome and PayPal's ids, never
 * the body or the headers.
 *
 * Routes: paypal.webhook. Owner: PayPal spine workstream.
 */
import { INVOICE_KEY_PATTERN } from "@paylink/api-contract";
import type { Address, InvoiceKey } from "@paylink/api-contract";
import { readText } from "../core/http.ts";
import { errorFields } from "../core/log.ts";
import { ProblemError } from "../core/problem.ts";
import type { ApiServices } from "../core/services.ts";
import { isPayPalError } from "../paypal/client.ts";
import { webhookIdFor } from "../paypal/factory.ts";
import { parseTwinMemo } from "../paypal/invoice.ts";
import type { Invoice } from "../paypal/types.ts";
import { eventFacts, INVOICE_EVENT_PREFIX, parseEventBody, readTransmission, verifyDelivery, WEBHOOK_ID_PATTERN } from "../paypal/webhook.ts";
import { reconcileTwinEvent } from "../reconciler/engine.ts";
import type { RouteHandlers } from "./types.ts";
import { BODY_LIMITS, DEFAULT_BODY_LIMIT } from "./types.ts";

/** A verified invoicing event whose invoice, read by P5, is a PayLink twin. */
export interface VerifiedTwinEvent {
  readonly eventId: string | null;
  readonly eventType: string;
  /** P5's answer: the only PayPal truth (§7.5). */
  readonly invoice: Invoice;
  readonly key: InvoiceKey;
  readonly payee: Address;
  readonly chainId: number;
}

/** What happens to a verified twin event: reconciled now, or planned for the cron. */
export type TwinEventSink = (services: ApiServices, event: VerifiedTwinEvent, now: number) => Promise<"reconciled" | "scheduled">;

/** A sink that only plans the twin's reconciliation for now (the cron reads due checks every minute, §7.5). */
export const scheduleTwinCheck: TwinEventSink = async (services, event, now) => {
  await services.stores.global().scheduleCheck({ payee: event.payee, key: event.key, dueAt: now });
  return "scheduled";
};

/** The answer's body: the outcome only. */
export type WebhookOutcome = "processed" | "duplicate" | "ignored" | "deferred";

export function createWebhookHandlers(sink: TwinEventSink = reconcileTwinEvent): RouteHandlers {
  return {
    "paypal.webhook": async ({ c, services, now }) => {
      const { logger } = services.runtime;
      const raw = await readText(c, BODY_LIMITS["paypal.webhook"] ?? DEFAULT_BODY_LIMIT);
      const transmission = readTransmission((name) => c.req.header(name));
      const event = parseEventBody(raw);
      if (!transmission.ok || event === null) {
        logger.log("warn", "webhook.rejected", { reason: transmission.ok ? "body" : `header:${transmission.header}` });
        throw new ProblemError("webhook-rejected", "the delivery is not a PayPal webhook", { rule: "E_WEBHOOK_MALFORMED" });
      }

      const webhookId = webhookIdFor(services);
      if (webhookId === null || !WEBHOOK_ID_PATTERN.test(webhookId)) {
        logger.log("error", "webhook.not-configured", {});
        throw new ProblemError("paypal-unavailable", "the webhook subscription is not configured", { rule: "E_WEBHOOK_NOT_CONFIGURED", retryAfter: 300 });
      }
      let verified: boolean;
      try {
        verified = (await verifyDelivery(services.paypal, webhookId, transmission.transmission, raw)).verified;
      } catch (error) {
        logger.log("warn", "webhook.unverifiable", errorFields(error));
        throw new ProblemError("paypal-unavailable", "PayPal did not confirm the delivery; deliver again later", { rule: "E_WEBHOOK_UNVERIFIABLE", retryAfter: 60 });
      }
      if (!verified) {
        logger.log("warn", "webhook.rejected", { reason: "signature", transmissionId: transmission.transmission.transmission_id });
        throw new ProblemError("webhook-rejected", "PayPal did not verify the delivery", { rule: "E_WEBHOOK_SIGNATURE" });
      }
      await note(services, "webhook-verified", now);

      const facts = eventFacts(event);
      const answer = (outcome: WebhookOutcome, extra: Readonly<Record<string, string>> = {}): Response => {
        logger.log("info", "webhook.received", { eventType: facts.eventType, outcome, ...(facts.id === null ? {} : { eventId: facts.id }), ...extra });
        return c.json({ received: true, outcome }, 200);
      };

      if (facts.id !== null) {
        try {
          if ((await services.stores.global().markWebhookEvent(facts.id, now)) === "seen") {
            return answer("duplicate");
          }
        } catch (error) {
          logger.log("warn", "webhook.dedup-unavailable", errorFields(error));
        }
      }
      if (facts.invoiceId === null) {
        return answer("ignored", { reason: facts.eventType.startsWith(INVOICE_EVENT_PREFIX) ? "no-invoice-id" : "event-type" });
      }

      let invoice: Invoice;
      try {
        invoice = await services.paypal.getInvoice(facts.invoiceId);
      } catch (error) {
        logger.log("warn", "webhook.read-failed", errorFields(error));
        if (isPayPalError(error) && error.status === 404) {
          return answer("ignored", { reason: "unknown-invoice" });
        }
        return answer("deferred", { reason: "paypal-get" });
      }
      await note(services, "paypal-get", now);

      const key = invoice.detail.reference ?? "";
      const owner = parseTwinMemo(invoice.detail.memo);
      if (!INVOICE_KEY_PATTERN.test(key) || owner?.chainId !== services.runtime.config.chainId) {
        return answer("ignored", { reason: "not-a-twin" });
      }
      try {
        await sink(services, { eventId: facts.id, eventType: facts.eventType, invoice, key: key as InvoiceKey, payee: owner.payee, chainId: owner.chainId }, now);
      } catch (error) {
        logger.log("warn", "webhook.sink-failed", errorFields(error));
        return answer("deferred", { reason: "sink" });
      }
      return answer("processed", { invoiceId: facts.invoiceId });
    },
  };
}

/** Records a health fact; the health row is advisory, so a store failure never fails the delivery. */
async function note(services: ApiServices, fact: "webhook-verified" | "paypal-get", at: number): Promise<void> {
  try {
    await services.stores.global().noteHealth(fact, at);
  } catch {
    // The Status page shows the row as unknown; nothing else depends on it.
  }
}

export const webhookHandlers: RouteHandlers = createWebhookHandlers();
