// SPDX-License-Identifier: MIT
/**
 * The PayPal fake (docs/paypal/SPEC.md §15.2 L3): Invoicing v2 and Webhooks with PayPal's paths, statuses and error
 * bodies, a status machine (src/paypal/fake/model.ts), OAuth tokens, signed webhook deliveries and the postback check
 * that verifies them. PayLink's HTTP client (src/paypal/http.ts) talks to it exactly as to the sandbox, either in
 * process (`fake.fetch`, the transport of the client in `fake` mode) or over HTTP when the fake is served on its own
 * (`fake.app`, or mounted under a path of another server).
 *
 * What the fake decides where PayPal's files are silent is `FakeBehaviour` (model.ts): each choice is the expected one
 * or the pessimistic one, every one is switchable, and each stays UNVERIFIED until the owner's capture run
 * (apps/api/scripts/capture/) records what the sandbox does.
 *
 * For tests: faults (`inject`: an error status, a dropped connection before or after PayPal processed the request), the
 * log of every request (`requests`), the payer paying (`pay`), forced statuses, and webhook delivery on demand (`flush`).
 *
 * Owner: PayPal spine workstream.
 */
import type { Hono } from "hono";
import type { PayPalOperationId } from "../client.ts";
import { PAYPAL_OPERATIONS } from "../client.ts";
import type { FakeHost } from "./app.ts";
import { certUrl, createFakeApp, PAYPAL_ERRORS, renderInvoice } from "./app.ts";
import { FakeIds } from "./ids.ts";
import type { FakeBehaviour, FakeDelivery, FakeInvoice } from "./model.ts";
import { centsOf, DEFAULT_BEHAVIOUR, FAKE_WEBHOOK_ID, FakeState } from "./model.ts";
import { AUTH_ALGO, sign, signatureInput } from "./signing.ts";

export { DEFAULT_BEHAVIOUR, FAKE_WEBHOOK_ID } from "./model.ts";
export type { FakeBehaviour, FakeDelivery } from "./model.ts";

/** The fake's default credentials: not secrets, they only open the fake. */
export const FAKE_CREDENTIALS = { clientId: "FAKE-CLIENT-ID-PAYLINK-TWIN", clientSecret: "FAKE-CLIENT-SECRET-PAYLINK-TWIN" } as const;

/** The base the in-process client calls (`.invalid`: never resolvable, RFC 2606). */
export const FAKE_BASE_URL = "http://paypal.fake.invalid";

export interface PayPalFakeOptions {
  readonly clock?: () => number;
  /** Seed of the ids (same seed, same ids). */
  readonly seed?: number;
  readonly behaviour?: Partial<FakeBehaviour>;
  /** Where the PayPal client sends requests; the fake routes by path whatever the origin. */
  readonly baseUrl?: string;
  /** A path prefix removed before routing, when the fake is mounted under another server (`/__paypal-fake`). */
  readonly mountPath?: string;
  /** Sends one webhook delivery (default: `fetch`). */
  readonly deliver?: (url: string, init: RequestInit) => Promise<Response>;
  /** Deliver queued webhooks right after each change instead of on `flush` (the offline demo). */
  readonly autoDeliver?: boolean;
  readonly credentials?: { readonly clientId: string; readonly clientSecret: string };
}

/** A failure the fake answers instead of processing a request (or after processing it, for `noAnswer: "after"`). */
export interface FakeFault {
  readonly op: PayPalOperationId;
  /** Answer this HTTP status with PayPal's error body, without processing the request. */
  readonly status?: number;
  /** Drop the connection: `before` PayPal processed the request, or `after` (the write happened, the answer was lost). */
  readonly noAnswer?: "before" | "after";
  /** `Retry-After`, in seconds, on an error status. */
  readonly retryAfterSeconds?: number;
  /** How many matching requests fail (default 1). */
  readonly times?: number;
}

/** One request the fake received. */
export interface RecordedRequest {
  readonly op: PayPalOperationId | null;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly requestId: string | null;
  readonly prefer: string | null;
  readonly authorization: "basic" | "bearer" | "none";
  readonly body: string | null;
  /** HTTP status answered, or 0 for a dropped connection. */
  status: number;
  /** The answer's body (JSON text), for contract tests. */
  response: string | null;
}

export interface PayPalFake {
  readonly baseUrl: string;
  readonly credentials: { readonly clientId: string; readonly clientSecret: string };
  /** The subscription every fake starts with; the API's webhook route verifies against it in `fake` mode. */
  readonly webhookId: string;
  /** In-process transport with `fetch`'s signature. */
  readonly fetch: typeof fetch;
  /** The fake as a Hono app (to serve it over HTTP). */
  readonly app: Hono;
  readonly state: FakeState;
  readonly requests: readonly RecordedRequest[];
  /** The fake's public base (payer pages, links) and where its first subscription delivers webhooks. */
  connect(options: { readonly publicUrl?: string; readonly webhookUrl?: string | null }): void;
  /** The payer pays on PayPal's page: the whole amount due, or `amount` (`"60.00"`). Returns the payment id. */
  pay(invoiceId: string, amount?: string): string;
  /** A held payment (`PAYMENT_PENDING`) clears. */
  clearPending(invoiceId: string): void;
  /** Sets any status, as PayPal or the merchant's dashboard could (refunds, auto-cancel). Not a PayPal operation. */
  forceStatus(invoiceId: string, status: string): void;
  inject(fault: FakeFault): void;
  /** Delivers every queued webhook now; returns the deliveries' states. */
  flush(): Promise<readonly FakeDelivery[]>;
  /** Waits until scheduled automatic deliveries are done. */
  settled(): Promise<void>;
  /** Every token issued so far stops working (as if expired). */
  revokeTokens(): void;
  /** The invoice as PayPal's JSON (`GET` without a token), or null. */
  invoice(invoiceId: string): Readonly<Record<string, unknown>> | null;
  /** A request handler for a server that mounts the fake under `mountPath`. */
  handle(request: Request): Promise<Response>;
}

const EVENT_SUMMARIES: Readonly<Record<string, string>> = {
  "INVOICING.INVOICE.PAID": "An invoice was paid",
  "INVOICING.INVOICE.CANCELLED": "An invoice was cancelled",
  "INVOICING.INVOICE.UPDATED": "An invoice was updated",
  "INVOICING.INVOICE.SENT": "An invoice was sent",
  "INVOICING.INVOICE.SCHEDULED": "An invoice was scheduled",
};

/** The operation a request is, from its method and path (the templates of `PAYPAL_OPERATIONS`). */
export function operationOf(method: string, path: string): PayPalOperationId | null {
  for (const [id, op] of Object.entries(PAYPAL_OPERATIONS) as [PayPalOperationId, (typeof PAYPAL_OPERATIONS)[PayPalOperationId]][]) {
    const pattern = new RegExp(`^${op.path.replace(/\{[a-z_]+\}/gu, "[^/]+")}$`, "u");
    if (op.method === method && pattern.test(path)) {
      return id;
    }
  }
  return null;
}

export function createPayPalFake(options: PayPalFakeOptions = {}): PayPalFake {
  const clock = options.clock ?? Date.now;
  const behaviour: FakeBehaviour = { ...DEFAULT_BEHAVIOUR, ...options.behaviour };
  const state = new FakeState(new FakeIds(options.seed ?? 0x5eed), clock, behaviour);
  const baseUrl = (options.baseUrl ?? FAKE_BASE_URL).replace(/\/+$/u, "");
  const mountPath = options.mountPath ?? "";
  const credentials = options.credentials ?? FAKE_CREDENTIALS;
  const deliver = options.deliver ?? ((url: string, init: RequestInit) => fetch(url, init));
  const faults: (FakeFault & { remaining: number })[] = [];
  const requests: RecordedRequest[] = [];
  let publicUrl = `${baseUrl}${mountPath}`;
  let pendingDelivery: Promise<void> = Promise.resolve();

  const flush = async (): Promise<readonly FakeDelivery[]> => {
    for (const delivery of state.deliveries) {
      const subscription = state.subscriptions.get(delivery.subscriptionId);
      const event = state.events.get(delivery.eventId);
      if (delivery.state !== "pending" || subscription?.url === null || subscription === undefined || event === undefined) {
        continue;
      }
      delivery.attempts += 1;
      const transmissionId = state.ids.transmissionId();
      const transmissionTime = new Date(clock()).toISOString();
      const signature = await sign(signatureInput(transmissionId, transmissionTime, subscription.id, event.raw));
      try {
        const response = await deliver(subscription.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "PAYPAL-AUTH-ALGO": AUTH_ALGO,
            "PAYPAL-CERT-URL": certUrl(host),
            "PAYPAL-TRANSMISSION-ID": transmissionId,
            "PAYPAL-TRANSMISSION-SIG": signature,
            "PAYPAL-TRANSMISSION-TIME": transmissionTime,
          },
          body: event.raw,
        });
        await response.text();
        delivery.lastStatus = response.status;
        delivery.state = response.status >= 200 && response.status < 300 ? "delivered" : delivery.attempts >= 3 ? "failed" : "pending";
      } catch {
        delivery.lastStatus = 0;
        delivery.state = delivery.attempts >= 3 ? "failed" : "pending";
      }
    }
    return state.deliveries.map((d) => ({ ...d }));
  };

  const host: FakeHost = {
    state,
    credentials,
    publicUrl: () => publicUrl,
    announce: (eventType: string, invoice: FakeInvoice) => {
      const rendered = renderInvoice(host, invoice);
      const now = new Date(clock()).toISOString();
      state.emit(eventType, (id) =>
        JSON.stringify({
          id,
          event_version: "1.0",
          create_time: now,
          resource_type: "invoices",
          event_type: eventType,
          summary: EVENT_SUMMARIES[eventType] ?? eventType,
          resource_version: "2.0",
          resource: behaviour.eventResource === "flat" ? rendered : { invoice: rendered },
          links: [
            { href: `${publicUrl}/v1/notifications/webhooks-events/${id}`, rel: "self", method: "GET" },
            { href: `${publicUrl}/v1/notifications/webhooks-events/${id}/resend`, rel: "resend", method: "POST" },
          ],
        }),
      );
      if (options.autoDeliver === true) {
        pendingDelivery = pendingDelivery.then(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                void flush().then(
                  () => {
                    resolve();
                  },
                  () => {
                    resolve();
                  },
                );
              }, 0);
            }),
        );
      }
    },
    flush: async () => {
      await flush();
    },
    inject: (fault: unknown) => {
      fake.inject(fault as FakeFault);
    },
  };

  const app = createFakeApp(host);

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = mountPath !== "" && url.pathname.startsWith(mountPath) ? url.pathname.slice(mountPath.length) || "/" : url.pathname;
    const op = operationOf(request.method, path);
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
    const authorization = request.headers.get("authorization") ?? "";
    const record: RecordedRequest = {
      op,
      method: request.method,
      path,
      query: url.search,
      requestId: request.headers.get("paypal-request-id"),
      prefer: request.headers.get("prefer"),
      authorization: authorization.startsWith("Basic ") ? "basic" : authorization.startsWith("Bearer ") ? "bearer" : "none",
      body,
      status: 0,
      response: null,
    };
    requests.push(record);
    const fault = op === null ? undefined : faults.find((f) => f.op === op && f.remaining > 0);
    if (fault !== undefined) {
      fault.remaining -= 1;
    }
    if (fault?.noAnswer === "before") {
      throw new TypeError("fetch failed (PayPal fake: the connection dropped before PayPal processed the request)");
    }
    if (fault?.status !== undefined) {
      const { name, message } = PAYPAL_ERRORS[fault.status] ?? { name: "INTERNAL_SERVER_ERROR", message: "An internal server error occurred." };
      const text = JSON.stringify({ name, message, debug_id: state.ids.debugId() });
      record.status = fault.status;
      record.response = text;
      return new Response(text, { status: fault.status, headers: { "Content-Type": "application/json", ...(fault.retryAfterSeconds === undefined ? {} : { "Retry-After": String(fault.retryAfterSeconds) }) } });
    }
    const replayKey = record.requestId === null || op === null || !PAYPAL_OPERATIONS[op].write ? null : `${op} ${path} ${record.requestId}`;
    const replay = replayKey === null || !behaviour.honourRequestId ? undefined : state.replies.get(replayKey);
    let response: Response;
    if (replay === undefined) {
      const routed = new Request(new URL(`${path}${url.search}`, "http://paypal.fake"), { method: request.method, headers: request.headers, ...(body === null ? {} : { body }) });
      response = await app.fetch(routed);
    } else {
      response = new Response(replay.body === "" ? null : replay.body, { status: replay.status, headers: { "Content-Type": "application/json" } });
    }
    const text = await response.text();
    record.status = response.status;
    record.response = text === "" ? null : text;
    if (replayKey !== null && behaviour.honourRequestId && response.status < 300) {
      state.replies.set(replayKey, { status: response.status, body: text });
    }
    if (fault?.noAnswer === "after") {
      record.status = 0;
      throw new TypeError("fetch failed (PayPal fake: the connection dropped after PayPal processed the request)");
    }
    return new Response(text === "" || response.status === 204 ? null : text, { status: response.status, headers: response.headers });
  };

  const fake: PayPalFake = {
    baseUrl,
    credentials,
    webhookId: FAKE_WEBHOOK_ID,
    fetch: (input, init) => handle(input instanceof Request && init === undefined ? input : new Request(input, init)),
    app,
    state,
    requests,
    connect: ({ publicUrl: base, webhookUrl }) => {
      if (base !== undefined) {
        publicUrl = base.replace(/\/+$/u, "");
      }
      const subscription = state.subscriptions.get(FAKE_WEBHOOK_ID);
      if (webhookUrl !== undefined && subscription !== undefined) {
        subscription.url = webhookUrl;
      }
    },
    pay: (invoiceId, amount) => {
      const cents = amount === undefined ? undefined : centsOf(amount);
      if (cents === null) {
        throw new RangeError("amount must be a PayPal value such as 60.00");
      }
      const payment = state.payerPays(invoiceId, cents);
      const invoice = state.get(invoiceId);
      host.announce(invoice.status === "PAYMENT_PENDING" ? "INVOICING.INVOICE.UPDATED" : "INVOICING.INVOICE.PAID", invoice);
      return payment.paymentId;
    },
    clearPending: (invoiceId) => {
      state.clearPending(invoiceId);
      host.announce("INVOICING.INVOICE.PAID", state.get(invoiceId));
    },
    forceStatus: (invoiceId, status) => {
      state.forceStatus(invoiceId, status);
      host.announce(status === "CANCELLED" || status === "AUTO_CANCELLED" ? "INVOICING.INVOICE.CANCELLED" : "INVOICING.INVOICE.UPDATED", state.get(invoiceId));
    },
    inject: (fault) => {
      faults.push({ ...fault, remaining: fault.times ?? 1 });
    },
    flush,
    settled: async () => {
      await pendingDelivery;
    },
    revokeTokens: () => {
      state.revokeTokens();
    },
    invoice: (invoiceId) => {
      const invoice = state.invoices.get(invoiceId);
      return invoice === undefined ? null : renderInvoice(host, invoice);
    },
    handle,
  };
  return fake;
}
