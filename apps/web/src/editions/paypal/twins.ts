// SPDX-License-Identifier: MIT
/**
 * What this device last read about each invoice's PayPal twin (docs/paypal/SPEC.md §11 "Browser": the twin number and
 * rail per invoice), for the ledger's rail column and its CSV. A cache in `localStorage`, nothing more: it is never
 * read as "paid", it holds no secret and no amount, and the API rebuilds it (`GET /v1/twin/:key`). The device store's
 * IndexedDB schema is shared by every edition on this origin and stays as it is.
 *
 * Owner: web edition workstream.
 */
import { INVOICE_KEY_PATTERN, statusClassOf } from "@paylink/api-contract";
import type { InvoiceKey, PayPalStatusClass, TwinView } from "@paylink/api-contract";

const STORAGE_KEY = "paylink.paypal.twins";
/** Twins kept at most (the oldest read go first). */
const MAX_ENTRIES = 300;

export interface CachedTwin {
  /** `PL-<chainId>-<12 hex>`: PayPal's invoice number. */
  readonly number: string;
  /** PayPal's status as last read. */
  readonly status: string;
  readonly statusClass: PayPalStatusClass;
  /** When the API last read it from PayPal (ISO). */
  readonly checkedAt: string;
}

type Entries = Record<string, CachedTwin>;

function load(): Entries {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const entries: Entries = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as Partial<CachedTwin> | null;
      if (INVOICE_KEY_PATTERN.test(key) && typeof v?.number === "string" && v.number.length <= 64 && typeof v.status === "string" && v.status.length <= 64 && typeof v.checkedAt === "string") {
        entries[key] = { number: v.number, status: v.status, statusClass: statusClassOf(v.status), checkedAt: v.checkedAt.slice(0, 40) };
      }
    }
    return entries;
  } catch {
    return {};
  }
}

/** The twin last seen for `key`, if this device saw one. */
export function cachedTwin(key: InvoiceKey): CachedTwin | null {
  return load()[key.toLowerCase()] ?? null;
}

/** Remembers what the API just said about a twin. */
export function rememberTwin(twin: Pick<TwinView, "key" | "number" | "status" | "checkedAt">): void {
  try {
    const entries = load();
    entries[twin.key.toLowerCase()] = { number: twin.number, status: twin.status, statusClass: statusClassOf(twin.status), checkedAt: twin.checkedAt };
    const kept = Object.entries(entries)
      .sort(([, a], [, b]) => b.checkedAt.localeCompare(a.checkedAt))
      .slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept.map(([k, v]) => [k, { number: v.number, status: v.status, checkedAt: v.checkedAt }]))));
  } catch {
    // Storage refused: the ledger reads the twin from the API instead.
  }
}
