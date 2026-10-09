// SPDX-License-Identifier: MIT
/**
 * The history service's client: apps/indexer (Envio HyperIndex) behind its GraphQL endpoint (PAYLINK-V2-SPEC §3.8,
 * ADR 0009). The service is a third-party cache, so this module is read with suspicion:
 *
 * - the endpoint comes from the same-origin `/config.json` only, and only for the chains it lists;
 * - every answer is parsed strictly (lowercase hex of the right length, safe integers, amounts as exact integers); a
 *   malformed answer is an `IndexerError`, never a partial success;
 * - what it returns is history to show, labelled as such. It never decides a payment state, never gates a payment
 *   and never stands in for a receipt: payment and receipt modules do not import it (test/indexer.test.ts checks),
 *   and every receipt link built from its rows is re-verified on RPC by the receipt page.
 *
 * Requests carry no credentials and no referrer, and ask only about public on-chain data (an address, chain IDs,
 * invoice keys). No runtime import, so a page with a tight first-load budget can load it lazily without the bundler
 * moving shared code out of that first load.
 */
import type { Address, Hex } from "viem";
import type { RuntimeConfig } from "../core/config.ts";

/** One `Paid` event as the indexer recorded it (entity `Payment`). */
export interface IndexedPayment {
  readonly chainId: number;
  readonly key: Hex;
  readonly payee: Address;
  readonly payer: Address;
  readonly token: Address;
  readonly amount: bigint;
  readonly index: number;
  readonly payerRef: Hex;
  readonly blockNumber: bigint;
  /** Block time, unix seconds. */
  readonly timestamp: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
}

/** Per-token volume of a payee on one chain (entity `PayeeToken`). */
export interface IndexedTokenVolume {
  readonly token: Address;
  readonly payments: number;
  readonly volume: bigint;
}

/** A payee on one chain (entity `Payee` with its `PayeeToken` rows). */
export interface IndexedPayee {
  readonly chainId: number;
  readonly payee: Address;
  readonly payments: number;
  readonly links: number;
  readonly uniquePayers: number;
  readonly cancellations: number;
  readonly firstPaidAt: bigint | null;
  readonly lastPaidAt: bigint | null;
  readonly tokens: readonly IndexedTokenVolume[];
}

/** One link's first payment time (entity `Invoice`). */
export interface IndexedFirstPayment {
  readonly key: Hex;
  readonly payments: number;
  readonly firstPaidAt: bigint | null;
}

/** How far the indexer has processed a chain (Envio's `_meta` view). */
export interface IndexerProgress {
  readonly chainId: number;
  readonly progressBlock: bigint;
  readonly ready: boolean;
}

export type IndexerFailure = "offline" | "http" | "graphql" | "shape";

/** The history service could not be read, or answered something this client does not accept. */
export class IndexerError extends Error {
  readonly code: IndexerFailure;
  constructor(code: IndexerFailure, detail: string) {
    super(`indexer ${code}: ${detail}`);
    this.name = "IndexerError";
    this.code = code;
  }
}

export interface IndexerClient {
  /** The GraphQL endpoint, for the status page. */
  readonly url: string;
  /** Whether `/config.json` lists this chain for the history service. */
  serves(chainId: number): boolean;
  /** The payee's totals on each served chain where it has any activity. */
  payee(payee: Address, chainIds: readonly number[]): Promise<IndexedPayee[]>;
  /** The latest payments to `payee` on the served chains, newest first (at most `limit`, capped at 100). */
  payments(payee: Address, chainIds: readonly number[], limit: number): Promise<IndexedPayment[]>;
  /** First payment time of each key on one chain (keys the indexer has not seen are absent). */
  firstPayments(chainId: number, keys: readonly Hex[]): Promise<IndexedFirstPayment[]>;
  /** Processed block per chain, for the status page. */
  progress(): Promise<IndexerProgress[]>;
}

type Fetch = typeof fetch;

const TIMEOUT_MS = 8_000;
/** Largest answer accepted, in characters: 100 payments are about 60 kB. */
const MAX_BODY = 512 * 1024;
const MAX_LIMIT = 100;
/** Keys per `firstPayments` query (the ledger asks for the device's invoices of one chain). */
const MAX_KEYS = 256;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]{0,77})$/;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

function fail(detail: string): never {
  throw new IndexerError("shape", detail);
}

function address(value: unknown, field: string): Address {
  return typeof value === "string" && ADDRESS.test(value) ? (value as Address) : fail(`${field} is not a lowercase address`);
}

function hex32(value: unknown, field: string): Hex {
  return typeof value === "string" && HEX32.test(value) ? (value as Hex) : fail(`${field} is not 32 lowercase hex bytes`);
}

function int(value: unknown, field: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${field} is not a non-negative safe integer`);
}

/**
 * A `BigInt` column. Hasura serialises Postgres `numeric` as a string of digits or as a JSON number depending on its
 * settings; a number is accepted only while it is exact (a safe integer), so an amount is never silently rounded.
 */
function big(value: unknown, field: string): bigint {
  if (typeof value === "string" && DIGITS.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return fail(`${field} is not an exact non-negative integer`);
}

const optionalBig = (value: unknown, field: string): bigint | null => (value === null || value === undefined ? null : big(value, field));

function list(value: unknown, field: string, max: number): readonly unknown[] {
  return Array.isArray(value) && value.length <= max ? value : fail(`${field} is not a list of at most ${String(max)}`);
}

export function parsePayment(value: unknown): IndexedPayment {
  if (!isRecord(value)) {
    return fail("payment is not an object");
  }
  return {
    chainId: int(value["chainId"], "chainId"),
    key: hex32(value["key"], "key"),
    payee: address(value["payee"], "payee"),
    payer: address(value["payer"], "payer"),
    token: address(value["token"], "token"),
    amount: big(value["amount"], "amount"),
    index: int(value["index"], "index"),
    payerRef: hex32(value["payerRef"], "payerRef"),
    blockNumber: big(value["blockNumber"], "blockNumber"),
    timestamp: big(value["timestamp"], "timestamp"),
    txHash: hex32(value["txHash"], "txHash"),
    logIndex: int(value["logIndex"], "logIndex"),
  };
}

const PAYMENT_FIELDS = "chainId key payee payer token amount index payerRef blockNumber timestamp txHash logIndex";

const PAYEE_QUERY = `query PayLinkPayee($payee: String!, $chains: [Int!]!) {
  Payee(where: {payee: {_eq: $payee}, chainId: {_in: $chains}}, order_by: {chainId: asc}) {
    chainId payee payments links uniquePayers cancellations firstPaidAt lastPaidAt
  }
  PayeeToken(where: {payee: {_eq: $payee}, chainId: {_in: $chains}}, order_by: [{chainId: asc}, {token: asc}]) {
    chainId token payments volume
  }
}`;

const PAYMENTS_QUERY = `query PayLinkPayments($payee: String!, $chains: [Int!]!, $limit: Int!) {
  Payment(where: {payee: {_eq: $payee}, chainId: {_in: $chains}}, order_by: [{timestamp: desc}, {logIndex: desc}], limit: $limit) {
    ${PAYMENT_FIELDS}
  }
}`;

const FIRST_QUERY = `query PayLinkFirstPayments($chainId: Int!, $keys: [String!]!) {
  Invoice(where: {chainId: {_eq: $chainId}, key: {_in: $keys}}) {
    key payments firstPaidAt
  }
}`;

const PROGRESS_QUERY = `query PayLinkProgress {
  _meta { chainId progressBlock isReady }
}`;

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** The history service for `config`, or `null` when `/config.json` names none. */
export function indexerClient(config: Pick<RuntimeConfig, "indexer">, fetcher: Fetch = (...args) => fetch(...args)): IndexerClient | null {
  const endpoint = config.indexer;
  if (endpoint === null) {
    return null;
  }
  // Same rule as core/config.ts `endpointFor`: the endpoint serves only the chains it lists.
  const serves = (chainId: number): boolean => endpoint.chains.includes(chainId);
  const served = (chainIds: readonly number[]): number[] => [...new Set(chainIds)].filter(serves);

  const query = async (text: string, variables: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> => {
    let body: string;
    let status: number;
    try {
      const response = await withTimeout(
        async (signal) =>
          await fetcher(endpoint.url, {
            method: "POST",
            signal,
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ query: text, variables }),
          }),
        TIMEOUT_MS,
      );
      status = response.status;
      body = await response.text();
    } catch (error) {
      throw new IndexerError("offline", error instanceof Error ? error.message : "unreachable");
    }
    if (status < 200 || status > 299) {
      throw new IndexerError("http", `HTTP ${String(status)}`);
    }
    if (body.length > MAX_BODY) {
      fail("answer too large");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fail("answer is not JSON");
    }
    if (!isRecord(parsed)) {
      return fail("answer is not an object");
    }
    if (parsed["errors"] !== undefined) {
      const first = Array.isArray(parsed["errors"]) && isRecord(parsed["errors"][0]) ? parsed["errors"][0]["message"] : null;
      throw new IndexerError("graphql", typeof first === "string" ? first.slice(0, 200) : "query refused");
    }
    return isRecord(parsed["data"]) ? parsed["data"] : fail("answer has no data");
  };

  return {
    url: endpoint.url,
    serves,

    async payee(payee, chainIds) {
      const chains = served(chainIds);
      if (chains.length === 0) {
        return [];
      }
      const data = await query(PAYEE_QUERY, { payee: payee.toLowerCase(), chains });
      const tokens = new Map<number, IndexedTokenVolume[]>();
      for (const row of list(data["PayeeToken"], "PayeeToken", 1000)) {
        if (!isRecord(row)) {
          fail("PayeeToken row is not an object");
        }
        const chainId = int(row["chainId"], "chainId");
        const entry = tokens.get(chainId) ?? [];
        entry.push({ token: address(row["token"], "token"), payments: int(row["payments"], "payments"), volume: big(row["volume"], "volume") });
        tokens.set(chainId, entry);
      }
      return list(data["Payee"], "Payee", chains.length).map((row): IndexedPayee => {
        if (!isRecord(row)) {
          return fail("Payee row is not an object");
        }
        const chainId = int(row["chainId"], "chainId");
        const who = address(row["payee"], "payee");
        if (who !== payee.toLowerCase() || !chains.includes(chainId)) {
          fail("Payee row is for another payee or chain");
        }
        return {
          chainId,
          payee: who,
          payments: int(row["payments"], "payments"),
          links: int(row["links"], "links"),
          uniquePayers: int(row["uniquePayers"], "uniquePayers"),
          cancellations: int(row["cancellations"], "cancellations"),
          firstPaidAt: optionalBig(row["firstPaidAt"], "firstPaidAt"),
          lastPaidAt: optionalBig(row["lastPaidAt"], "lastPaidAt"),
          tokens: tokens.get(chainId) ?? [],
        };
      });
    },

    async payments(payee, chainIds, limit) {
      const chains = served(chainIds);
      const capped = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
      if (chains.length === 0) {
        return [];
      }
      const data = await query(PAYMENTS_QUERY, { payee: payee.toLowerCase(), chains, limit: capped });
      const rows = list(data["Payment"], "Payment", capped).map(parsePayment);
      for (const row of rows) {
        if (row.payee !== payee.toLowerCase() || !chains.includes(row.chainId)) {
          fail("Payment row is for another payee or chain");
        }
      }
      return rows;
    },

    async firstPayments(chainId, keys) {
      const wanted = [...new Set(keys.map((k) => k.toLowerCase()))].slice(0, MAX_KEYS);
      if (!served([chainId]).includes(chainId) || wanted.length === 0) {
        return [];
      }
      const data = await query(FIRST_QUERY, { chainId, keys: wanted });
      return list(data["Invoice"], "Invoice", wanted.length).map((row): IndexedFirstPayment => {
        if (!isRecord(row)) {
          return fail("Invoice row is not an object");
        }
        const key = hex32(row["key"], "key");
        if (!wanted.includes(key)) {
          fail("Invoice row for a key that was not asked for");
        }
        return { key, payments: int(row["payments"], "payments"), firstPaidAt: optionalBig(row["firstPaidAt"], "firstPaidAt") };
      });
    },

    async progress() {
      const data = await query(PROGRESS_QUERY, {});
      return list(data["_meta"], "_meta", 64).map((row): IndexerProgress => {
        if (!isRecord(row)) {
          return fail("_meta row is not an object");
        }
        // Envio starts a chain's progress below its start block (-1) until the first batch is written.
        const raw = row["progressBlock"];
        const started = !(typeof raw === "number" && Number.isSafeInteger(raw) && raw < 0) && !(typeof raw === "string" && /^-[0-9]{1,20}$/.test(raw));
        return { chainId: int(row["chainId"], "chainId"), progressBlock: started ? big(raw, "progressBlock") : 0n, ready: started && row["isReady"] === true };
      });
    },
  };
}

const clients = new WeakMap<object, IndexerClient | null>();

/** The history service of a loaded `/config.json`, one client per configuration object. */
export function indexerFor(config: Pick<RuntimeConfig, "indexer">): IndexerClient | null {
  if (!clients.has(config)) {
    clients.set(config, indexerClient(config));
  }
  return clients.get(config) ?? null;
}
