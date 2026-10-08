// SPDX-License-Identifier: MIT
/**
 * The payee's books (ADR 0009, read model chain > device > indexer):
 *
 *   1. the device lists the invoices this payee signed here (the chain never sees memos);
 *   2. the chain decides every state: `statesOf` in batches of 256 per chain, with chain time for expiry;
 *   3. the indexer (tier T1) may add history, labelled as such, and never decides a state.
 *
 * A chain that cannot be read leaves its rows "unconfirmed": a device record alone never reads as paid.
 */
import type { ChainDefinition, Registry, Token } from "@paylink/chains";
import { linkStatus, readLinkStates } from "@paylink/sdk";
import type { DecodedInvoiceLink, LinkState, LinkStatus } from "@paylink/sdk";
import type { Address } from "viem";
import { chainTime } from "../core/clients.ts";
import type { ChainClient } from "../core/clients.ts";
import type { DeviceStore, InvoiceRecord, InvoiceRole } from "../store/db.ts";
import { parseStoredInvoice } from "../store/db.ts";

/** A chain answer, or why there is none. */
export type RowStatus = LinkStatus | "unconfirmed";

export interface LedgerRow {
  readonly record: InvoiceRecord;
  readonly link: DecodedInvoiceLink;
  readonly chain: ChainDefinition;
  /** From `statesOf`; `null` when the chain could not be read. */
  readonly state: LinkState | null;
  readonly status: RowStatus;
}

export interface TokenTotal {
  readonly chain: ChainDefinition;
  readonly token: Token;
  /** Sum of `LinkState.total` over the confirmed rows: what the chain says these invoices brought in. */
  readonly total: bigint;
  readonly payments: number;
}

export interface LedgerSnapshot {
  readonly rows: readonly LedgerRow[];
  readonly totals: readonly TokenTotal[];
  /** Rows that are payable now. */
  readonly open: number;
  /** Chain IDs whose RPCs failed. */
  readonly unreachable: readonly number[];
  /** Stored records that no longer validate, or belong to chains outside this edition. */
  readonly skipped: number;
}

export interface LedgerSource {
  readonly store: DeviceStore;
  readonly registry: Registry;
  readonly clientFor: (chain: ChainDefinition) => ChainClient;
  /** Only invoices whose payee is this address; every stored one when `null`. */
  readonly payee: Address | null;
  readonly role: InvoiceRole;
}

/** Device records of a role, validated against the registry, newest first. */
export async function deviceInvoices(source: Pick<LedgerSource, "store" | "registry" | "payee" | "role">): Promise<{ rows: { record: InvoiceRecord; link: DecodedInvoiceLink }[]; skipped: number }> {
  const raw = await source.store.listInvoices();
  const rows: { record: InvoiceRecord; link: DecodedInvoiceLink }[] = [];
  let skipped = 0;
  for (const value of raw) {
    const parsed = parseStoredInvoice(value, source.registry);
    if (parsed === null) {
      skipped += 1;
      continue;
    }
    if (parsed.record.role !== source.role) {
      continue;
    }
    if (source.payee !== null && parsed.link.invoice.payee.toLowerCase() !== source.payee.toLowerCase()) {
      continue;
    }
    rows.push(parsed);
  }
  rows.sort((a, b) => b.record.createdAt - a.record.createdAt);
  return { rows, skipped };
}

/** Reads the books: device records merged with the chain's state, one `statesOf` batch series and one block per chain. */
export async function readLedger(source: LedgerSource): Promise<LedgerSnapshot> {
  const { rows: device, skipped } = await deviceInvoices(source);
  const byChain = new Map<number, { record: InvoiceRecord; link: DecodedInvoiceLink }[]>();
  for (const row of device) {
    const list = byChain.get(row.link.chainId) ?? [];
    list.push(row);
    byChain.set(row.link.chainId, list);
  }
  const unreachable: number[] = [];
  const results = await Promise.all(
    [...byChain].map(async ([chainId, list]) => {
      const chain = source.registry.getOrThrow(chainId);
      const client = source.clientFor(chain);
      try {
        const [states, now] = await Promise.all([
          readLinkStates(client, list[0]?.link.target.deployment.address ?? "0x0000000000000000000000000000000000000000", list.map((r) => r.link.key)),
          chainTime(client),
        ]);
        return list.map((r, i): LedgerRow => {
          const state = states[i] ?? null;
          return { ...r, chain, state, status: state === null ? "unconfirmed" : linkStatus(r.link.invoice, state, now) };
        });
      } catch {
        unreachable.push(chainId);
        return list.map((r): LedgerRow => ({ ...r, chain, state: null, status: "unconfirmed" }));
      }
    }),
  );
  const rows = results.flat().sort((a, b) => b.record.createdAt - a.record.createdAt);
  return { rows, totals: totals(rows), open: rows.filter((r) => r.status === "payable").length, unreachable, skipped };
}

/** Confirmed totals per (chain, token), in first-seen order. */
export function totals(rows: readonly LedgerRow[]): TokenTotal[] {
  const map = new Map<string, { chain: ChainDefinition; token: Token; total: bigint; payments: number }>();
  for (const row of rows) {
    if (row.state === null) {
      continue;
    }
    const id = `${String(row.chain.chainId)}:${row.link.token.address.toLowerCase()}`;
    const entry = map.get(id) ?? { chain: row.chain, token: row.link.token, total: 0n, payments: 0 };
    entry.total += row.state.total;
    entry.payments += row.state.payments;
    map.set(id, entry);
  }
  return [...map.values()];
}

/** How a row reads on the tape: lamp class and label key. Expired with no payment is "overdue" (amber: follow up). */
export function rowLamp(row: Pick<LedgerRow, "status" | "state">): { readonly lamp: "open" | "paid" | "closed" | "overdue" | "busy"; readonly label: RowLabel } {
  switch (row.status) {
    case "payable":
      return { lamp: "open", label: "open" };
    case "paid":
      return { lamp: "paid", label: "paid" };
    case "sold-out":
      return { lamp: "paid", label: "soldOut" };
    case "expired":
      return (row.state?.payments ?? 0) === 0 ? { lamp: "overdue", label: "overdue" } : { lamp: "closed", label: "expired" };
    case "cancelled":
      return { lamp: "closed", label: "cancelled" };
    case "not-yet-valid":
      return { lamp: "closed", label: "scheduled" };
    case "unconfirmed":
      return { lamp: "busy", label: "unconfirmed" };
  }
}

export type RowLabel = "open" | "paid" | "soldOut" | "overdue" | "expired" | "cancelled" | "scheduled" | "unconfirmed";

export type LedgerFilter = "all" | "open" | "paid" | "closed";

export function matchesFilter(row: Pick<LedgerRow, "status" | "state">, filter: LedgerFilter): boolean {
  const { lamp } = rowLamp(row);
  switch (filter) {
    case "all":
      return true;
    case "open":
      return lamp === "open" || lamp === "busy";
    case "paid":
      return (row.state?.payments ?? 0) > 0;
    case "closed":
      return lamp === "closed" || lamp === "overdue" || row.status === "paid" || row.status === "sold-out";
  }
}
