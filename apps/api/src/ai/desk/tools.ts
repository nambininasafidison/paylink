// SPDX-License-Identifier: MIT
/**
 * The desk model's tools (docs/paypal/SPEC.md §9.2 A2, §7.6): an allowlist of six read tools and `propose_action`,
 * nothing else (invariant AI-2, snapshot-tested in test/ai/invariants.test.ts).
 *
 * | Tool | Contract | Reads |
 * |---|---|---|
 * | `list_invoices` | PayPal Agent Toolkit 1.11.0 (`invoices.list`): `page`, `page_size`, `total_required` | the payee's open twins |
 * | `get_invoice` | toolkit (`invoices.get`): `invoice_id` | one of them, by PayPal id, invoice number or key |
 * | `search_invoicing` | toolkit (`invoices.search`), `resource_type: "invoice"` and the filters `status`, `invoice_number`, `reference` | the same twins, filtered |
 * | `chain_invoice_state` | PayLink: `invoice_key` | the twin's last chain state and verified payment |
 * | `list_chain_payments` | PayLink: `since` (the payee is never an argument: it is the session's) | verified chain payments of the payee's twins |
 * | `allowed_actions` | PayLink: `invoice_key` | the reconciler's fence for that twin |
 * | `propose_action` | PayLink: `kind`, `invoice_key`, `args`, `message`, `message_language` | queues a proposal if the fence holds it |
 *
 * The toolkit-named tools take a subset of the toolkit's parameters with the same names and constraints (parity test:
 * test/ai/parity.test.ts against the vendored sources of `@paypal/agent-toolkit` 1.11.0). They do not call PayPal: they
 * read the twins the sweep has just reconciled with P5 (one `GET` per twin, the Free plan's subrequest budget, §7.5),
 * and only the session payee's twins (the demo's PayPal merchant is shared, so a PayPal-wide list would leak other
 * payees' invoices). Their answers carry identifiers, statuses, amounts and dates only: no client name, email, note or
 * memo reaches the model.
 *
 * Owner: AI workstream.
 */
import { PAYPAL_INVOICE_STATUSES } from "@paylink/api-contract";
import * as z from "zod";
import type { TwinRecord } from "../../store/types.ts";
import type { AiTool, JsonSchema } from "../types.ts";

const INVOICE_ID = "^[A-Za-z0-9_-]{1,127}$";
const KEY = "^0x[0-9a-fA-F]{64}$";

const strictObject = (properties: Readonly<Record<string, JsonSchema>>, required: readonly string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

/** The tap kinds the model may name (`record_external_payment` is code's alone: automatic, never proposed). */
export const PROPOSABLE_KINDS = ["send_reminder", "share_reminder_text", "cancel_paylink", "cancel_paypal"] as const;

export const DESK_TOOLS: readonly AiTool[] = [
  {
    name: "list_invoices",
    description: "List the freelancer's open invoices (PayPal twins of PayLink invoices) with status, amount, due date and situation.",
    parameters: strictObject({
      page: { type: "integer", minimum: 1, maximum: 1000, description: "The page number of the result set to fetch." },
      page_size: { type: "integer", minimum: 1, maximum: 100, description: "The number of records to return per page (maximum 100)." },
      total_required: { type: "boolean", description: "Indicates whether the response should include the total count of items." },
    }),
  },
  {
    name: "get_invoice",
    description: "Get one of the freelancer's invoices by its PayPal invoice id (or its invoice number, or its PayLink key).",
    parameters: strictObject({ invoice_id: { type: "string", pattern: INVOICE_ID, description: "The ID of the invoice to retrieve." } }, ["invoice_id"]),
  },
  {
    name: "search_invoicing",
    description: "Search the freelancer's invoices by status, invoice number or reference (the PayLink key).",
    parameters: strictObject(
      {
        resource_type: { type: "string", enum: ["invoice"], description: "Which resource type to search: only 'invoice'." },
        page: { type: "integer", minimum: 1, maximum: 1000, description: "The page number of the result set to fetch." },
        page_size: { type: "integer", minimum: 1, maximum: 100, description: "The number of records to return per page (maximum 100)." },
        total_required: { type: "boolean", description: "Indicates whether the response should include the total count of matching invoices." },
        invoice_filters: strictObject({
          status: { type: "array", items: { type: "string", enum: [...PAYPAL_INVOICE_STATUSES] }, maxItems: 5, description: "Filters invoices by one or more statuses (up to 5)." },
          invoice_number: { type: "string", maxLength: 25, description: "Filters invoices by invoice number." },
          reference: { type: "string", maxLength: 120, description: "Filters invoices by reference value (the PayLink key)." },
        }),
      },
      ["resource_type"],
    ),
  },
  {
    name: "chain_invoice_state",
    description: "The PayLink invoice's state on Ethereum Sepolia (payable, paid, cancelled, expired) and its verified payment, if any.",
    parameters: strictObject({ invoice_key: { type: "string", pattern: KEY, description: "The PayLink invoice key (0x and 64 hex digits)." } }, ["invoice_key"]),
  },
  {
    name: "list_chain_payments",
    description: "Verified on-chain payments of the freelancer's invoices, newest first.",
    parameters: strictObject({ since: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "Only payments on or after this date (YYYY-MM-DD)." } }),
  },
  {
    name: "allowed_actions",
    description: "The actions code allows now for one invoice, with the exact values a proposal must use. Propose nothing else.",
    parameters: strictObject({ invoice_key: { type: "string", pattern: KEY, description: "The PayLink invoice key." } }, ["invoice_key"]),
  },
  {
    name: "propose_action",
    description: "Queue one proposal for the freelancer to approve or reject. Only an action listed by allowed_actions for that invoice, with exactly its values.",
    parameters: strictObject(
      {
        kind: { type: "string", enum: [...PROPOSABLE_KINDS], description: "The action, as allowed_actions lists it." },
        invoice_key: { type: "string", pattern: KEY, description: "The PayLink invoice key." },
        args: { type: "object", additionalProperties: { type: "string" }, description: "Optional: the values from allowed_actions, unchanged." },
        message: { type: "string", maxLength: 400, description: "For share_reminder_text: the reminder the freelancer will share with the client." },
        message_language: { type: "string", enum: ["en", "fr", "mg"], description: "The language of message." },
      },
      ["kind", "invoice_key"],
    ),
  },
];

/** The names of the allowlist, in order (the AI-2 snapshot). */
export const DESK_TOOL_NAMES = DESK_TOOLS.map((t) => t.name);

// ------------------------------------------------------------------------------------------ argument checks

const page = z.number().int().min(1).max(1000).optional();
const pageSize = z.number().int().min(1).max(100).optional();
const invoiceKey = z.string().regex(new RegExp(KEY, "u"));

/** What code accepts as each tool's arguments: the advertised schema, strictly (an unknown field is an error). */
export const TOOL_ARGUMENTS = {
  list_invoices: z.strictObject({ page, page_size: pageSize, total_required: z.boolean().optional() }),
  get_invoice: z.strictObject({ invoice_id: z.string().regex(new RegExp(INVOICE_ID, "u")) }),
  search_invoicing: z.strictObject({
    resource_type: z.literal("invoice"),
    page,
    page_size: pageSize,
    total_required: z.boolean().optional(),
    invoice_filters: z.strictObject({ status: z.array(z.enum(PAYPAL_INVOICE_STATUSES)).max(5).optional(), invoice_number: z.string().max(25).optional(), reference: z.string().max(120).optional() }).optional(),
  }),
  chain_invoice_state: z.strictObject({ invoice_key: invoiceKey }),
  list_chain_payments: z.strictObject({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional() }),
  allowed_actions: z.strictObject({ invoice_key: invoiceKey }),
  // `kind` is checked by the fence (an unknown or automatic kind is refused there, and logged `fence.reject`).
  propose_action: z.strictObject({
    kind: z.string().max(40),
    invoice_key: z.string().max(80),
    args: z.record(z.string().max(40), z.string().max(200)).optional(),
    message: z.string().max(2000).optional(),
    message_language: z.enum(["en", "fr", "mg"]).optional(),
  }),
} as const;

export type DeskToolName = keyof typeof TOOL_ARGUMENTS;

export const isDeskTool = (name: string): name is DeskToolName => Object.hasOwn(TOOL_ARGUMENTS, name);

// ------------------------------------------------------------------------------------------ views

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** USD as PayPal writes it (`"120.00"`), from 6-decimal base units (twins are whole cents, §7.2). */
export function usdOf(base: string): string {
  const units = BigInt(base);
  const cents = units / 10_000n;
  return `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** The client's language of a twin, when the twin records one (a later field; read defensively). */
function clientLanguageOf(twin: TwinRecord): string | null {
  const value = (twin as unknown as Readonly<Record<string, unknown>>)["clientLanguage"];
  return value === "en" || value === "fr" || value === "mg" ? value : null;
}

/** One invoice as the model sees it: identifiers, status, money and dates (module comment). */
export function invoiceView(twin: TwinRecord): Readonly<Record<string, unknown>> {
  return {
    id: twin.paypalId,
    invoice_number: twin.invoiceNumber,
    reference: twin.key,
    status: twin.lastStatus ?? "UNKNOWN",
    amount: { currency_code: "USD", value: usdOf(twin.amountBase) },
    paid_amount: twin.paidAmount === null ? null : { currency_code: "USD", value: twin.paidAmount },
    due_date: twin.dueDate,
    shared_on: twin.sentAt === null ? null : utcDay(twin.sentAt),
    last_paypal_reminder_on: twin.lastReminderAt === null ? null : utcDay(twin.lastReminderAt),
    situation: twin.situation,
    chain_rail: twin.rail,
    chain_state: twin.lastChainState,
    client_language: clientLanguageOf(twin),
    checked_at: new Date(twin.checkedAt).toISOString(),
  };
}

export function chainView(twin: TwinRecord): Readonly<Record<string, unknown>> {
  const p = twin.chainPayment;
  return {
    invoice_key: twin.key,
    chain_id: twin.chainId,
    state: twin.lastChainState ?? "unknown",
    rail: twin.rail,
    payment: p === null ? null : { tx_hash: p.txHash, amount: { currency_code: "USD", value: usdOf(p.amount) }, paid_on: utcDay(p.timestamp * 1000), rail: p.rail },
  };
}

/** Finds one of the payee's twins by PayPal id, invoice number or key (case-insensitive for the key). */
export function findTwin(twins: readonly TwinRecord[], id: string): TwinRecord | null {
  const lower = id.toLowerCase();
  return twins.find((t) => t.paypalId === id || t.invoiceNumber === id || t.key === lower) ?? null;
}

/** A page of the list (the toolkit's paging: `page` from 1, `page_size` up to 100, default 20). */
export function paged(items: readonly unknown[], args: { readonly page?: number | undefined; readonly page_size?: number | undefined; readonly total_required?: boolean | undefined }): Readonly<Record<string, unknown>> {
  const size = args.page_size ?? 20;
  const number = args.page ?? 1;
  const slice = items.slice((number - 1) * size, number * size);
  return { items: slice, page: number, page_size: size, ...(args.total_required === true ? { total_items: items.length } : {}) };
}
