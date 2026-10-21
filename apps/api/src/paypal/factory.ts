// SPDX-License-Identifier: MIT
/**
 * Builds the PayPal client for a runtime: the HTTP client against `runtime.config.paypal.baseUrl` (token cached in the
 * Global store) in `sandbox` mode, the PayPal fake in `fake` mode.
 *
 * Owner: PayPal spine workstream. Scaffold: every operation answers 501 `not-implemented`.
 */
import { pendingMethod } from "../core/not-implemented.ts";
import type { FactoryDeps } from "../core/runtime.ts";
import type { PayPalClient } from "./client.ts";

export function createPayPalClient(deps: FactoryDeps): PayPalClient {
  const pending = pendingMethod(`the PayPal client (${deps.runtime.config.paypal.mode})`);
  return {
    token: pending,
    searchInvoices: pending,
    createInvoice: pending,
    sendInvoice: pending,
    getInvoice: pending,
    recordPayment: pending,
    deletePayment: pending,
    cancelInvoice: pending,
    remindInvoice: pending,
    verifyWebhookSignature: pending,
    createWebhook: pending,
  };
}
