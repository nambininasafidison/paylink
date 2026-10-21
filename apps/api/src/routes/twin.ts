// SPDX-License-Identifier: MIT
/**
 * POST /v1/twin, GET /v1/twin/:key and the public GET /v1/rails/:key (docs/paypal/SPEC.md §7.2, §12.2, §13).
 *
 * POST /v1/twin (session): the signed PayLink link becomes its PayPal twin, once.
 *
 * 1. The link's fragment is decoded strictly by the SDK against the registry (invoice spec §10.5): a chain without a
 *    PayLinkV2 deployment in the registry answers 400 rule `E_CHAIN_UNKNOWN` (Ethereum Sepolia until the owner deploys,
 *    decision D-CHAIN). The chain must be the edition's; the payee the session's (403 `E_TWIN_NOT_PAYEE`); the
 *    signature the payee's over K (ECDSA, else ERC-1271 through the registry's RPC; 400 `E_TWIN_SIGNATURE`).
 * 2. Only what PayPal can mirror exactly becomes a twin: one payment (`E_TWIN_MULTI_PAYMENT`), a fixed amount
 *    (`E_TWIN_OPEN_AMOUNT`) in whole cents (`E_TWIN_PRECISION`, §7.2), in USDC or PayPal USD (`E_TWIN_TOKEN`), not
 *    expired (`E_TWIN_EXPIRED`), a due date not in the past (`E_TWIN_DUE_DATE`).
 * 3. A key the payee's store already holds is answered from PayPal again without counting a quota; a new one counts
 *    against the payee's and the deployment's daily twins (src/store/quotas.ts).
 * 4. `ensureTwin` (src/paypal/twin.ts): P2, then P3 and P4 only if needed, then P5; one PayPal invoice per K whatever
 *    fails on the way. A share PayPal scheduled (202) registers the twin and answers 409 `E_PAYPAL_SCHEDULED` (S0).
 * 5. The reconciler registers it with P5's answer (`registerTwin`, src/reconciler/engine.ts) and the view is answered:
 *    201 when this call made the twin, 200 when it already existed.
 *
 * GET /v1/twin/:key (session): the payee's twin from the store, read again (P5 and the chain, through the reconciler)
 * when the last read is older than 10 seconds (§7.5: at most one P5 per twin per 10 s while the till polls).
 *
 * GET /v1/rails/:key (public): only status, amount, currency, URL and the time of the last read (§12.2), cacheable for
 * 2 seconds; an unknown key answers `none`, never 404, so the route says nothing about which keys exist.
 *
 * Routes: twin.create, twin.get, rails.get. Owner: PayPal spine workstream.
 */
import { INVOICE_KEY_PATTERN, statusClassOf } from "@paylink/api-contract";
import type { Address, InvoiceKey, RailsResponse, TwinView } from "@paylink/api-contract";
import { registry as shippedRegistry } from "@paylink/chains";
import type { Registry } from "@paylink/chains";
import { decodeInvoiceFragment, isPayLinkError, verifySignatureWithCode } from "@paylink/sdk";
import type { DecodedInvoiceLink } from "@paylink/sdk";
import { z } from "zod";
import { chainClient } from "../chain/client.ts";
import { parseBody, readJson } from "../core/http.ts";
import { errorFields } from "../core/log.ts";
import { ProblemError } from "../core/problem.ts";
import type { ApiServices } from "../core/services.ts";
import { withPayPalProblems } from "../paypal/errors.ts";
import { TwinInputError, twinCreateBody } from "../paypal/invoice.ts";
import { ensureTwin } from "../paypal/twin.ts";
import { registerTwin, reconcileTwin } from "../reconciler/engine.ts";
import { usdFromBase, utcDay } from "../reconciler/money.ts";
import { chargeQuota } from "../store/quotas.ts";
import type { TwinRecord } from "../store/types.ts";
import type { RouteHandlers } from "./types.ts";
import { DEFAULT_BODY_LIMIT } from "./types.ts";

/** A twin read longer ago than this is read again on GET (§7.5). */
export const TWIN_FRESH_MS = 10_000;
/** `Cache-Control` of the public rails route (§13: 2 s cache). */
const RAILS_CACHE = "public, max-age=2";

const DATE = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u;

const TwinCreateSchema = z.strictObject({
  link: z.string().min(1).max(2048),
  recipient: z.strictObject({ givenName: z.string().max(140).optional(), email: z.string().max(254).optional() }).optional(),
  dueDate: z.string().regex(DATE).optional(),
});

const refuse = (rule: string, detail: string): ProblemError => new ProblemError("invalid-request", detail, { rule });

/** The view of a stored twin. */
export function twinView(twin: TwinRecord): TwinView {
  const status = twin.lastStatus ?? "DRAFT";
  return {
    key: twin.key,
    paypalId: twin.paypalId,
    number: twin.invoiceNumber,
    status,
    statusClass: statusClassOf(status),
    recipientViewUrl: twin.recipientViewUrl,
    amount: usdFromBase(twin.amountBase) ?? "0.00",
    currency: "USD",
    situation: twin.situation,
    checkedAt: new Date(twin.checkedAt).toISOString(),
  };
}

/** What the pay page may know about the PayPal rail of a twin (§12.2). */
export function railsView(twin: TwinRecord | null): RailsResponse {
  if (twin === null) {
    return { status: "none", amount: null, currency: null, url: null, checkedAt: null };
  }
  const base = { amount: usdFromBase(twin.amountBase), currency: "USD" as const, checkedAt: new Date(twin.checkedAt).toISOString() };
  const statusClass = twin.lastStatus === null ? "unknown" : statusClassOf(twin.lastStatus);
  // S0 is hands off; S3 (paid on chain) and S7 (closed on chain) are about to close the PayPal rail: never invite a payment.
  if (twin.situation === "S0") {
    return { ...base, status: "none", url: null };
  }
  switch (statusClass) {
    case "open":
      return twin.situation === "S3" || twin.situation === "S7" || twin.recipientViewUrl === null ? { ...base, status: "closed", url: null } : { ...base, status: "open", url: twin.recipientViewUrl };
    case "in-flight":
      return { ...base, status: "pending", url: null };
    case "paid":
    case "paid-outside":
      return { ...base, status: "paid", url: null };
    case "cancelled":
    case "refunded":
      return { ...base, status: "closed", url: null };
    case "not-sent":
    case "open-not-sent":
    case "unknown":
      return { ...base, status: "none", url: null };
  }
}

/** The signed link, decoded and checked against the session (step 1 of the module comment). */
async function signedLink(services: ApiServices, registry: Registry, link: string, payee: Address): Promise<DecodedInvoiceLink> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw refuse("E_TWIN_LINK", "the link is not a URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hash.length < 2) {
    throw refuse("E_TWIN_LINK", "the link must be a PayLink invoice link with its fragment");
  }
  let decoded: DecodedInvoiceLink;
  try {
    decoded = decodeInvoiceFragment(url.hash.slice(1), registry);
  } catch (error) {
    if (isPayLinkError(error)) {
      throw refuse(error.code, error.code === "E_CHAIN_UNKNOWN" ? "PayLinkV2 is not deployed on this link's chain yet" : "the link is not a valid PayLink invoice");
    }
    throw error;
  }
  if (decoded.chainId !== services.runtime.config.chainId) {
    throw refuse("E_TWIN_CHAIN", `twins are made for chain ${String(services.runtime.config.chainId)} only`);
  }
  if (decoded.invoice.payee.toLowerCase() !== payee.toLowerCase()) {
    throw new ProblemError("forbidden", "the invoice's payee is not the session's", { rule: "E_TWIN_NOT_PAYEE" });
  }
  if (!(await signedByPayee(services, registry, decoded))) {
    throw refuse("E_TWIN_SIGNATURE", "the payee's signature over the invoice does not verify");
  }
  return decoded;
}

/** ECDSA first (an EOA); only for an account with code, ERC-1271 through the registry's RPC (the SDK's dispatch). */
async function signedByPayee(services: ApiServices, registry: Registry, decoded: DecodedInvoiceLink): Promise<boolean> {
  const signer = decoded.invoice.payee;
  const offline = await verifySignatureWithCode({ signer, digest: decoded.key, signature: decoded.signature, code: undefined });
  if (offline.valid) {
    return true;
  }
  const chain = registry.get(decoded.chainId);
  if (chain === undefined) {
    return false;
  }
  try {
    const client = chainClient(services.runtime, chain);
    const code = await client.getCode({ address: signer });
    if (code === undefined || code === "0x") {
      return false;
    }
    const onChain = await verifySignatureWithCode({ signer, digest: decoded.key, signature: decoded.signature, client, code });
    return onChain.valid && onChain.method === "erc1271";
  } catch (error) {
    services.runtime.logger.log("warn", "twin.erc1271-unreadable", errorFields(error));
    throw new ProblemError("chain-unavailable", "the payee's account could not be read on the chain", { rule: "E_TWIN_ERC1271_UNREADABLE" });
  }
}

export function createTwinHandlers(options: { readonly registry?: Registry } = {}): RouteHandlers {
  const registry = options.registry ?? shippedRegistry;
  return {
    "twin.create": async ({ c, services, payee, now }) => {
      if (payee === null) {
        throw new ProblemError("unauthorized", "send Authorization: Bearer <session token>");
      }
      const body = parseBody(TwinCreateSchema, await readJson(c, DEFAULT_BODY_LIMIT));
      const decoded = await signedLink(services, registry, body.link, payee);
      const { invoice, token } = decoded;
      if (invoice.maxPayments !== 1) {
        throw refuse("E_TWIN_MULTI_PAYMENT", "only a one-off invoice can have a PayPal twin");
      }
      if (invoice.amount === 0n) {
        throw refuse("E_TWIN_OPEN_AMOUNT", "an open-amount invoice cannot have a PayPal twin");
      }
      const amountUsd = usdFromBase(invoice.amount.toString(), token.decimals);
      if (amountUsd === null) {
        throw refuse("E_TWIN_PRECISION", "the amount has a fraction of a cent, which PayPal cannot invoice");
      }
      if (token.symbol !== "USDC" && token.symbol !== "PYUSD") {
        throw refuse("E_TWIN_TOKEN", "twins are made for USDC and PayPal USD invoices only");
      }
      const nowS = BigInt(Math.floor(now / 1000));
      if (invoice.validUntil !== 0n && invoice.validUntil < nowS) {
        throw refuse("E_TWIN_EXPIRED", "the invoice has expired");
      }
      if (body.dueDate !== undefined && body.dueDate < utcDay(now)) {
        throw refuse("E_TWIN_DUE_DATE", "the due date is in the past");
      }

      const store = services.stores.payee(payee);
      const existing = await store.getTwin(decoded.key);
      if (existing === null) {
        await chargeQuota(services, payee, "twins", now);
      }
      let create;
      try {
        create = twinCreateBody({
          key: decoded.key,
          chainId: decoded.chainId,
          payee,
          amountUsd,
          description: decoded.memo,
          dueDate: body.dueDate ?? null,
          recipient:
            body.recipient === undefined
              ? null
              : { ...(body.recipient.givenName === undefined ? {} : { givenName: body.recipient.givenName }), ...(body.recipient.email === undefined ? {} : { email: body.recipient.email }) },
          payLink: new URL(body.link).protocol === "https:" ? { url: body.link, symbol: token.symbol } : null,
        });
      } catch (error) {
        if (error instanceof TwinInputError) {
          throw new ProblemError("invalid-request", error.message, { rule: "E_TWIN_INPUT", issues: [{ path: `$.${error.field}`, message: error.message }] });
        }
        throw error;
      }
      const ensured = await withPayPalProblems(() => ensureTwin(services.paypal, decoded.key, create));
      if (ensured.duplicates.length > 0) {
        services.runtime.logger.log("warn", "twin.duplicates", { count: ensured.duplicates.length });
      }
      const paypalInvoice = ensured.invoice;
      const firstSent = Date.parse(paypalInvoice.detail.metadata?.first_sent_time ?? "");
      const outcome = await registerTwin(
        services,
        {
          key: decoded.key,
          payee,
          chainId: decoded.chainId,
          paypalId: paypalInvoice.id ?? "",
          invoiceNumber: paypalInvoice.detail.invoice_number ?? create.detail.invoice_number ?? "",
          amountBase: invoice.amount.toString(),
          token: invoice.token,
          rail: token.symbol,
          validUntil: Number(invoice.validUntil),
          recipientViewUrl: paypalInvoice.detail.metadata?.recipient_view_url ?? null,
          hasRecipientEmail: (body.recipient?.email ?? "").trim() !== "",
          dueDate: body.dueDate ?? null,
          sentAt: ensured.send === 200 || ensured.send === "settled-by-read" ? now : Number.isNaN(firstSent) ? null : firstSent,
        },
        now,
        { invoice: paypalInvoice },
      );
      if (ensured.send === 202) {
        throw new ProblemError("conflict", "PayPal scheduled the invoice instead of sharing it now", { rule: "E_PAYPAL_SCHEDULED" });
      }
      const twin = outcome.status === "done" ? outcome.twin : await store.getTwin(decoded.key);
      if (twin === null) {
        throw new ProblemError("internal", "the twin was not stored");
      }
      return c.json(twinView(twin), ensured.origin === "created" && existing === null ? 201 : 200);
    },

    "twin.get": async ({ c, services, payee, now }) => {
      if (payee === null) {
        throw new ProblemError("unauthorized", "send Authorization: Bearer <session token>");
      }
      const key = c.req.param("key") ?? "";
      if (!INVOICE_KEY_PATTERN.test(key)) {
        throw refuse("E_TWIN_KEY", "the key must be 0x and 64 lowercase hex digits");
      }
      const store = services.stores.payee(payee);
      let twin = await store.getTwin(key as InvoiceKey);
      if (twin === null) {
        throw new ProblemError("not-found", "no twin for this key");
      }
      if (now - twin.checkedAt >= TWIN_FRESH_MS) {
        const outcome = await reconcileTwin(services, payee, key as InvoiceKey, now, { source: "sweep" });
        if (outcome.status === "done") {
          twin = outcome.twin;
        }
      }
      return c.json(twinView(twin), 200);
    },

    "rails.get": async ({ c, services }) => {
      const key = c.req.param("key") ?? "";
      if (!INVOICE_KEY_PATTERN.test(key)) {
        throw refuse("E_TWIN_KEY", "the key must be 0x and 64 lowercase hex digits");
      }
      const entry = await services.stores.global().findTwinByKey(key as InvoiceKey);
      const twin = entry === null ? null : await services.stores.payee(entry.payee).getTwin(key as InvoiceKey);
      c.header("Cache-Control", RAILS_CACHE);
      return c.json(railsView(twin), 200);
    },
  };
}

export const twinHandlers: RouteHandlers = createTwinHandlers();
