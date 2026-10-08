// SPDX-License-Identifier: MIT
/**
 * The ledger as CSV (PAYLINK-V2-SPEC §3.6): RFC 4180 (CRLF line ends, fields quoted when they hold a comma, a quote, CR
 * or LF, quotes doubled), ISO 8601 UTC times, CAIP-2 chains and CAIP-10 accounts. Amounts are exact decimals in token
 * units plus the base units, never floats. Memos are the user's own text: a field that a spreadsheet would evaluate as
 * a formula (leading `=`, `+`, `-`, `@`, tab or CR) is prefixed with an apostrophe (OWASP CSV injection).
 */
import { invoiceKind } from "@paylink/sdk";
import { plainAmount } from "../core/format.ts";
import type { LedgerRow } from "./ledger.ts";

export const CSV_COLUMNS = [
  "invoice_key",
  "chain",
  "contract",
  "payee",
  "token",
  "token_symbol",
  "kind",
  "amount",
  "amount_base_units",
  "max_payments",
  "payments",
  "total_received",
  "total_received_base_units",
  "status",
  "valid_after",
  "valid_until",
  "last_paid_at",
  "created_at",
  "memo",
  "link",
] as const;

/** One RFC 4180 field. */
export function csvField(value: string): string {
  const neutralised = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

/** Unix seconds to ISO 8601 UTC without milliseconds; empty for 0 (no bound). */
export function isoTime(seconds: bigint | number): string {
  const n = Number(seconds);
  return n === 0 ? "" : new Date(n * 1000).toISOString().replace(".000Z", "Z");
}

const caip10 = (chainId: number, address: string): string => `eip155:${String(chainId)}:${address}`;

export function ledgerCsv(rows: readonly LedgerRow[], linkOf: (row: LedgerRow) => string): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const { link, chain, state } = row;
    const invoice = link.invoice;
    const fields = [
      link.key,
      chain.caip2,
      caip10(chain.chainId, link.target.deployment.address),
      caip10(chain.chainId, invoice.payee),
      caip10(chain.chainId, invoice.token),
      link.token.symbol,
      invoiceKind(invoice),
      invoice.amount === 0n ? "" : plainAmount(invoice.amount, link.token),
      invoice.amount.toString(),
      String(invoice.maxPayments),
      state === null ? "" : String(state.payments),
      state === null ? "" : plainAmount(state.total, link.token),
      state === null ? "" : state.total.toString(),
      row.status,
      isoTime(invoice.validAfter),
      isoTime(invoice.validUntil),
      state === null ? "" : isoTime(state.lastPaidAt),
      new Date(row.record.createdAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
      link.memo ?? "",
      linkOf(row),
    ];
    lines.push(fields.map(csvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
