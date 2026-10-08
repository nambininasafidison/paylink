// SPDX-License-Identifier: MIT
/**
 * The payee's books (read model chain > device > indexer): device records, each state from `statesOf` and chain
 * time; a chain that cannot be read leaves rows "unconfirmed", never paid; the CSV export is RFC 4180 with CAIP ids.
 */
import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, ledgerCsv } from "../src/read/csv.ts";
import { deviceInvoices, matchesFilter, readLedger, rowLamp, totals } from "../src/read/ledger.ts";
import type { LedgerRow, RowStatus } from "../src/read/ledger.ts";
import { memoryStore } from "../src/store/db.ts";
import { CHAIN_ID, CONTRACT, fakeChain, issue, NOW, payer, registry } from "./helpers.ts";

async function books() {
  const store = memoryStore();
  const fake = fakeChain();
  const paid = await issue({ createdAt: 1, memo: "=cmd|' /C calc'!A0" });
  const open = await issue({ createdAt: 2, amount: 0n, maxPayments: 0, memo: null });
  const cancelled = await issue({ createdAt: 3 });
  for (const x of [paid, open, cancelled]) {
    await store.putInvoice(x.record);
  }
  await store.putInvoice({ ...paid.record, id: "31337:junk", createdAt: 4 });
  fake.states.set(paid.issued.key, { payments: 1, cancelled: false, lastPaidAt: NOW - 60n, total: 25_500_000n });
  fake.states.set(open.issued.key, { payments: 2, cancelled: false, lastPaidAt: NOW - 30n, total: 7_000_000n });
  fake.states.set(cancelled.issued.key, { payments: 0, cancelled: true, lastPaidAt: 0n, total: 0n });
  return { store, fake, paid, open, cancelled };
}

describe("readLedger", () => {
  it("merges device records with the chain's states, newest first, with totals per token", async () => {
    const { store, fake, paid, open, cancelled } = await books();
    const snapshot = await readLedger({ store, registry, clientFor: () => fake.client, payee: paid.issued.signed.invoice.payee, role: "issued" });
    expect(snapshot.rows.map((r) => r.link.key)).toEqual([cancelled.issued.key, open.issued.key, paid.issued.key]);
    expect(snapshot.rows.map((r) => r.status)).toEqual(["cancelled", "payable", "paid"]);
    expect(snapshot.open).toBe(1);
    expect(snapshot.skipped).toBe(1);
    expect(snapshot.unreachable).toEqual([]);
    expect(snapshot.totals).toHaveLength(1);
    expect(snapshot.totals[0]).toMatchObject({ total: 32_500_000n, payments: 3 });
    // One statesOf call for the whole chain.
    expect(fake.calls.filter((c) => c.to === CONTRACT)).toHaveLength(1);
  });

  it("shows only the connected payee's invoices", async () => {
    const { store, fake } = await books();
    const snapshot = await readLedger({ store, registry, clientFor: () => fake.client, payee: payer.address, role: "issued" });
    expect(snapshot.rows).toEqual([]);
    const cards = await deviceInvoices({ store, registry, payee: null, role: "card" });
    expect(cards.rows).toEqual([]);
  });

  it("leaves every row unconfirmed when the chain cannot be read: a device record alone is never paid", async () => {
    const { store, fake, paid } = await books();
    fake.down = true;
    const snapshot = await readLedger({ store, registry, clientFor: () => fake.client, payee: paid.issued.signed.invoice.payee, role: "issued" });
    expect(snapshot.unreachable).toEqual([CHAIN_ID]);
    expect(snapshot.rows.every((r) => r.status === "unconfirmed" && r.state === null)).toBe(true);
    expect(snapshot.totals).toEqual([]);
    expect(snapshot.open).toBe(0);
  });

  it("reads expiry on the chain's clock", async () => {
    const { store, fake, paid } = await books();
    fake.now = NOW + 8n * 86_400n;
    const snapshot = await readLedger({ store, registry, clientFor: () => fake.client, payee: paid.issued.signed.invoice.payee, role: "issued" });
    expect(snapshot.rows.map((r) => r.status)).toEqual(["cancelled", "expired", "paid"]);
  });
});

describe("lamps and filters", () => {
  const row = (status: RowStatus, payments = 0): Pick<LedgerRow, "status" | "state"> => ({ status, state: status === "unconfirmed" ? null : { payments, cancelled: status === "cancelled", lastPaidAt: 0n, total: 0n } });

  it("maps each status to its lamp, with unpaid expiry as overdue (amber)", () => {
    expect(rowLamp(row("payable"))).toEqual({ lamp: "open", label: "open" });
    expect(rowLamp(row("paid", 1))).toEqual({ lamp: "paid", label: "paid" });
    expect(rowLamp(row("sold-out", 3))).toEqual({ lamp: "paid", label: "soldOut" });
    expect(rowLamp(row("expired"))).toEqual({ lamp: "overdue", label: "overdue" });
    expect(rowLamp(row("expired", 2))).toEqual({ lamp: "closed", label: "expired" });
    expect(rowLamp(row("cancelled"))).toEqual({ lamp: "closed", label: "cancelled" });
    expect(rowLamp(row("not-yet-valid"))).toEqual({ lamp: "closed", label: "scheduled" });
    expect(rowLamp(row("unconfirmed"))).toEqual({ lamp: "busy", label: "unconfirmed" });
  });

  it("filters open, paid and closed rows", () => {
    expect(matchesFilter(row("payable"), "open")).toBe(true);
    expect(matchesFilter(row("unconfirmed"), "open")).toBe(true);
    expect(matchesFilter(row("payable", 2), "paid")).toBe(true);
    expect(matchesFilter(row("payable"), "paid")).toBe(false);
    expect(matchesFilter(row("expired"), "closed")).toBe(true);
    expect(matchesFilter(row("paid", 1), "closed")).toBe(true);
    expect(matchesFilter(row("payable"), "closed")).toBe(false);
    expect(matchesFilter(row("cancelled"), "all")).toBe(true);
  });

  it("totals only confirmed rows", () => {
    expect(totals([])).toEqual([]);
  });
});

describe("CSV export", () => {
  it("writes RFC 4180 rows with CAIP-2 and CAIP-10 ids, exact amounts, ISO times and neutralised memos", async () => {
    const { store, fake, paid } = await books();
    const snapshot = await readLedger({ store, registry, clientFor: () => fake.client, payee: paid.issued.signed.invoice.payee, role: "issued" });
    const csv = ledgerCsv(snapshot.rows, (r) => `https://paylink-mg.pages.dev/pay/#${r.link.key.slice(0, 6)}`);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines.at(-1)).toBe("");
    expect(lines).toHaveLength(snapshot.rows.length + 2);
    const last = lines[3] ?? "";
    const payee = paid.issued.signed.invoice.payee;
    expect(last).toContain(`eip155:${String(CHAIN_ID)}:${payee}`);
    expect(last).toContain(`eip155:${String(CHAIN_ID)}:${CONTRACT}`);
    expect(last).toContain(",25.5,25500000,1,1,25.5,25500000,paid,");
    expect(last).toContain("2026-10-15T00:00:00Z");
    expect(last).toContain(`"'=cmd|' /C calc'!A0"`.replace(/^"|"$/g, ""));
    expect(last).not.toMatch(/,=cmd/);
    expect(lines[2]).toContain(",AUSD,receive-card,,0,0,2,7,7000000,payable,");
  });
});
