// SPDX-License-Identifier: MIT
/**
 * What the history service changes on screen, on both paths of the read model (ADR 0009):
 * - the ledger's "Payments received" block: from the history service (record since the first payment, volumes, rows
 *   with receipts to verify on RPC), else from the chain's latest blocks ("in the last …"), else "unavailable";
 * - the status page's history-service light, from Envio's `_meta`.
 */
import "fake-indexeddb/auto";
import { createTranslator, EN } from "@paylink/i18n";
import { decodeReceiptFragment, fragmentOf, PAID_TOPIC } from "@paylink/sdk";
import { encodeAbiParameters, pad, toHex } from "viem";
import type { Address, Hex, RpcLog } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/app/boot.ts";
import type { App } from "../src/app/context.ts";
import type { RuntimeConfig } from "../src/core/config.ts";
import { activityBlock } from "../src/pages/ledger-history.ts";
import { statusPage } from "../src/pages/status.ts";
import type { LedgerSnapshot } from "../src/read/ledger.ts";
import { CHAIN_ID, CONTRACT, fakeChain, issue, localChain, registry, TOKEN_ADDRESS } from "./helpers.ts";

const PAYEE: Address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAYER: Address = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const INDEXER = "https://indexer.dev.hyperindex.xyz/abc123/v1/graphql";
const T0 = 1_791_504_000n;
const TX: Hex = `0x${"cd".repeat(32)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** A history service answering GraphQL from fixed data, or failing like a dead endpoint. */
function stubIndexer(data: Record<string, unknown> | null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === INDEXER && data !== null) {
        return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
      }
      return Promise.reject(new TypeError("network disabled in unit tests"));
    }),
  );
}

/** The local chain: head 100 (fake chain), 2 s blocks, with `logs` answered by block range. */
function chainWithLogs(logs: readonly RpcLog[], down = false) {
  const fake = fakeChain();
  fake.down = down;
  const client = {
    ...fake.client,
    getBlock: ({ blockNumber }: { blockNumber: bigint }) => (down ? Promise.reject(new Error("down")) : Promise.resolve({ number: blockNumber, timestamp: T0 + blockNumber * 2n })),
    getLogs: ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      down ? Promise.reject(new Error("down")) : Promise.resolve(logs.filter((log) => BigInt(log.blockNumber ?? "0x0") >= fromBlock && BigInt(log.blockNumber ?? "0x0") <= toBlock)),
  };
  return client;
}

function app(options: { indexer: boolean; logs?: readonly RpcLog[]; chainDown?: boolean }): App {
  const config: RuntimeConfig = { version: 1, banner: null, relayer: null, indexer: options.indexer ? { url: INDEXER, chains: [CHAIN_ID] } : null, rpc: {} };
  const client = chainWithLogs(options.logs ?? [], options.chainDown === true);
  return {
    i18n: createTranslator("en", EN, { fallback: EN }),
    locale: "en",
    registry,
    config,
    site: { origin: "https://paylink-mg.pages.dev", base: "/" },
    client: () => client,
  } as unknown as App;
}

function paidLog(block: bigint, logIndex: number): RpcLog {
  return {
    address: CONTRACT,
    topics: [PAID_TOPIC, `0x${"ab".repeat(32)}`, pad(PAYEE, { size: 32 }), pad(PAYER, { size: 32 })],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "bytes32" }], [TOKEN_ADDRESS, 2_500_000n, 0, `0x${"00".repeat(32)}`]),
    blockNumber: toHex(block),
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: TX,
    transactionIndex: "0x0",
    logIndex: toHex(logIndex),
    removed: false,
  };
}

/** Waits until the block shows (its words loaded) and has replaced its "reading" line. */
async function settled(block: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    expect(block.hidden).toBe(false);
    expect(block.querySelector(".loading")).toBeNull();
  });
}

describe("ledger: payments received", () => {
  it("shows the history service's record, volumes and rows, each with a receipt to verify on the network", async () => {
    // Issued ten minutes before its payment.
    const own = await issue({ memo: "Logo design, invoice 042", createdAt: Number(T0 + 86_400n - 600n) * 1000 });
    const key = own.link.key;
    stubIndexer({
      Payee: [{ chainId: CHAIN_ID, payee: PAYEE, payments: 12, links: 4, uniquePayers: 5, cancellations: 0, firstPaidAt: String(T0), lastPaidAt: String(T0 + 86_400n) }],
      PayeeToken: [{ chainId: CHAIN_ID, token: TOKEN_ADDRESS.toLowerCase(), payments: 12, volume: "306000000" }],
      Payment: [
        { chainId: CHAIN_ID, key, payee: PAYEE, payer: PAYER, token: TOKEN_ADDRESS.toLowerCase(), amount: "25500000", index: 0, payerRef: `0x${"00".repeat(32)}`, blockNumber: "90", timestamp: String(T0 + 86_400n), txHash: TX, logIndex: 3 },
        { chainId: CHAIN_ID, key: `0x${"ef".repeat(32)}`, payee: PAYEE, payer: PAYER, token: `0x${"99".repeat(20)}`, amount: "7", index: 1, payerRef: `0x${"00".repeat(32)}`, blockNumber: "80", timestamp: String(T0), txHash: TX, logIndex: 1 },
      ],
      Invoice: [],
    });
    const snapshot: LedgerSnapshot = { rows: [{ record: own.record, link: own.link, chain: localChain(), state: { payments: 1, cancelled: false, lastPaidAt: T0 + 86_400n, total: 25_500_000n }, status: "paid" }], totals: [], open: 0, unreachable: [], skipped: 0 };
    const block = activityBlock(app({ indexer: true }), PAYEE, snapshot);
    // Hidden until the `history` words are loaded: never an empty heading.
    expect(block.hidden).toBe(true);
    await settled(block);
    expect(block.querySelector("h3")?.textContent).toBe("Payments received");
    expect(block.querySelector(".activity-record")?.textContent).toBe("12 payments received since Oct 9, 2026 · 5 payers");
    expect(block.querySelector(".activity-volumes")?.textContent).toContain("306.00");
    expect(block.textContent).toContain("From the PayLink history service (Envio)");
    const rows = [...block.querySelectorAll("ul.links > li")];
    expect(rows).toHaveLength(2);
    // A link issued on this device shows its memo; another shows its key.
    expect(rows[0]?.querySelector(".row-memo")?.textContent).toBe("Logo design, invoice 042");
    expect(rows[1]?.querySelector(".row-memo")?.textContent).toBe("Payment 2 on link 0xefef…efef");
    // An unlisted token is shown in base units, never formatted as a listed one.
    expect(rows[1]?.querySelector(".row-amt")?.textContent).toBe("7units");
    const href = rows[0]?.querySelector("a")?.getAttribute("href") ?? "";
    expect(href.startsWith("https://paylink-mg.pages.dev/r/#")).toBe(true);
    const receipt = decodeReceiptFragment(fragmentOf(href), registry);
    expect(receipt).toMatchObject({ chainId: CHAIN_ID, txHash: TX, logIndex: 3 });
    expect(receipt.invoice?.key).toBe(key);
    // The one-off invoice was paid (chain time) ten minutes after this device issued it.
    expect(block.querySelector(".activity-settle")?.textContent).toBe("Time to get paid: 10 minutes (one invoice from this device)");
  });

  it("falls back to the network's latest blocks when there is no history service", async () => {
    const block = activityBlock(app({ indexer: false, logs: [paidLog(99n, 0), paidLog(98n, 1)] }), PAYEE, null);
    await settled(block);
    // Head 100, 2 s blocks: the scan covers blocks 0 to 100, 200 s.
    expect(block.querySelector(".activity-record")?.textContent).toBe("2 payments in the last 3 minutes");
    expect(block.textContent).toContain("From the network's latest blocks only");
    expect(block.querySelectorAll("ul.links > li")).toHaveLength(2);
    expect(block.querySelector(".activity-settle")).toBeNull();
  });

  it("falls back to the network when the history service is down, and says so when both are", async () => {
    stubIndexer(null);
    const fallback = activityBlock(app({ indexer: true }), PAYEE, null);
    await settled(fallback);
    expect(fallback.querySelector(".activity-record")?.textContent).toMatch(/^No payment on the network in the last /);
    const none = activityBlock(app({ indexer: true, chainDown: true }), PAYEE, null);
    await settled(none);
    expect(none.querySelector(".warn-note")?.textContent).toMatch(/^History unavailable: neither/);
  });

  it("says history is unavailable rather than reading forever when a row cannot be drawn", async () => {
    const broken = { totals: [], open: 0, unreachable: [], skipped: 0, get rows(): never { throw new Error("broken snapshot"); } } as unknown as LedgerSnapshot;
    const block = activityBlock(app({ indexer: false, logs: [paidLog(99n, 0)] }), PAYEE, broken);
    await settled(block);
    expect(block.querySelector(".warn-note")?.textContent).toMatch(/^History unavailable: neither/);
  });
});

describe("status: history service light", () => {
  it("shows the block the history service has processed on each of the edition's networks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/config.json")) {
          return Promise.resolve(new Response(JSON.stringify({ version: 1, banner: null, relayer: null, indexer: { url: INDEXER, chains: [10143, 84532] }, rpc: {} }), { status: 200 }));
        }
        if (url === INDEXER) {
          return Promise.resolve(new Response(JSON.stringify({ data: { _meta: [{ chainId: 10143, progressBlock: 69400123, isReady: true }, { chainId: 84532, progressBlock: "47900000", isReady: false }] } }), { status: 200 }));
        }
        return Promise.reject(new TypeError("network disabled in unit tests"));
      }),
    );
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://paylink-mg.pages.dev/status/");
    await boot(statusPage);
    const light = (): Element | undefined => [...document.querySelectorAll(".vstrip li")].find((li) => li.querySelector(".vstrip-name")?.textContent === "History service");
    await vi.waitFor(() => {
      expect(light()?.querySelector(".vstrip-detail")?.textContent).toContain("block");
    });
    expect(light()?.getAttribute("data-lamp")).toBe("wait");
    expect(light()?.querySelector(".vstrip-detail")?.textContent).toBe("Monad testnet: indexed to block 69400123 · Base Sepolia: catching up, block 47900000");
  });
});
