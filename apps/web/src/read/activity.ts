// SPDX-License-Identifier: MIT
/**
 * A payee's payment history and record, read model chain > device > indexer (ADR 0009, spec §3.8):
 *
 * - **Indexer** (when `/config.json` names one for the chain): the full history since the deployment, the payee's
 *   totals and "N payments received since <first payment>". Labelled as coming from the history service.
 * - **Chain** (no indexer, or it failed): the public RPCs' bounded `eth_getLogs` over the latest blocks only
 *   (`CHAIN_SCAN_REQUESTS` requests of the chain's log range: on Monad testnet 100 blocks each), so the line says
 *   "in the last <window>", never "since".
 *
 * Neither ever decides a payment state or proves a payment: the ledger's states come from `statesOf`, and every row
 * here links to a receipt the receipt page verifies on RPC. A payee address is public on-chain data; nothing else is
 * sent anywhere.
 *
 * No runtime import beyond this folder's history modules: the SDK's `Paid` decoder comes in through `ActivitySource`
 * (`read/paid-reader.ts`). A page with a tight first-load budget (the pay view: PAYLINK-V2-SPEC §4.4, 110 kB) can then
 * load this module lazily without the bundler moving shared code out of its first load.
 */
import type { ChainDefinition } from "@paylink/chains";
import type { LogLike, PaidEvent } from "@paylink/sdk";
import type { Address, Hex, RpcLog } from "viem";
import type { App } from "../app/context.ts";
import type { ChainClient } from "../core/clients.ts";
import { headBlock, logRange, scanLogs } from "./history.ts";
import { IndexerError, indexerFor } from "./indexer.ts";
import type { IndexedPayee, IndexerClient, IndexerFailure } from "./indexer.ts";

/** Requests of the chain's log range scanned when there is no indexer (Monad testnet: 10 × 100 blocks). */
export const CHAIN_SCAN_REQUESTS = 10;
/** Payments listed at most. */
export const HISTORY_LIMIT = 25;

/** One payment received, from either source. */
export interface ActivityPayment {
  readonly chainId: number;
  readonly key: Hex;
  readonly payer: Address;
  readonly token: Address;
  readonly amount: bigint;
  /** Zero-based payment number within its link. */
  readonly index: number;
  /** Block time, unix seconds; `null` when the chain scan could not read the block. */
  readonly timestamp: bigint | null;
  readonly blockNumber: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
}

/** What the chain scan covered on one chain. */
export interface ScanWindow {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /** Time covered, in seconds (head time less the first scanned block's time). */
  readonly seconds: bigint;
}

export type PayeeActivity =
  | {
      readonly source: "indexer";
      readonly summaries: readonly IndexedPayee[];
      readonly payments: readonly ActivityPayment[];
    }
  | {
      readonly source: "chain";
      readonly payments: readonly ActivityPayment[];
      readonly windows: readonly ScanWindow[];
      /** Why the indexer was not used: not configured (`null`) or how it failed. */
      readonly indexerProblem: IndexerFailure | null;
    }
  | {
      readonly source: "none";
      readonly indexerProblem: IndexerFailure | null;
    };

/** How to read a `Paid` log: the SDK's strict decoder and the event topic (`read/paid-reader.ts`). */
export interface PaidLogReader {
  readonly topic: Hex;
  readonly decode: (log: LogLike) => PaidEvent | null;
}

export interface ActivitySource {
  readonly indexer: IndexerClient | null;
  readonly paid: PaidLogReader;
  /** The chains to read: each with its client and canonical deployment. */
  readonly chains: readonly { readonly chain: ChainDefinition; readonly client: Pick<ChainClient, "getBlock" | "getBlockNumber" | "getLogs">; readonly contract: Address }[];
}

/**
 * The edition's chains that have a canonical deployment (or only `chainIds`), each with its registry RPC client, and
 * the history service of `/config.json`.
 */
export function activitySource(app: Pick<App, "config" | "registry" | "client">, paid: PaidLogReader, chainIds?: readonly number[]): ActivitySource {
  const chains = app.registry.chains.flatMap((chain) => {
    const target = app.registry.v2Target(chain.chainId);
    return target === undefined || (chainIds !== undefined && !chainIds.includes(chain.chainId)) ? [] : [{ chain, client: app.client(chain), contract: target.deployment.address }];
  });
  return { indexer: indexerFor(app.config), paid, chains };
}

/** The payee's record ("N payments received since <date> · M payers"), on one chain or across chains. */
export interface TrustFigures {
  readonly payments: number;
  readonly payers: number;
  /** Earliest first payment across the summaries; `null` when none was ever received. */
  readonly since: bigint | null;
}

/** Sums indexer summaries (one per chain) into the payee's record (the trust line). */
export function trustFigures(summaries: readonly IndexedPayee[]): TrustFigures {
  let since: bigint | null = null;
  for (const s of summaries) {
    if (s.firstPaidAt !== null && (since === null || s.firstPaidAt < since)) {
      since = s.firstPaidAt;
    }
  }
  return {
    payments: summaries.reduce((n, s) => n + s.payments, 0),
    // Unique per chain; a payer active on two chains counts twice. Labelled "payers", never "people".
    payers: summaries.reduce((n, s) => n + s.uniquePayers, 0),
    since,
  };
}

/** Recent `Paid` logs to `payee` from the chains' own RPCs, newest first, within `CHAIN_SCAN_REQUESTS` log ranges. */
export async function scanRecentPayments(source: Pick<ActivitySource, "chains" | "paid">, payee: Address, limit = HISTORY_LIMIT): Promise<{ payments: ActivityPayment[]; windows: ScanWindow[] }> {
  // The payee as a 32-byte topic: twelve zero bytes, then the address.
  const payeeTopic = `0x${"0".repeat(24)}${payee.slice(2).toLowerCase()}` as Hex;
  const results = await Promise.all(
    source.chains.map(async ({ chain, client, contract }) => {
      const head = await headBlock(client);
      const range = logRange(chain);
      const span = range * BigInt(CHAIN_SCAN_REQUESTS);
      const from = head.number >= span ? head.number - span + 1n : 0n;
      const found: { log: RpcLog; event: PaidEvent }[] = [];
      await scanLogs(client, { address: contract, topics: [source.paid.topic, null, payeeTopic] }, { from, to: head.number, range }, (log) => {
        const event = log.removed ? null : source.paid.decode({ address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex === null ? null : Number(log.logIndex) });
        if (event !== null && event.contract.toLowerCase() === contract.toLowerCase() && event.payee.toLowerCase() === payee.toLowerCase() && log.transactionHash !== null && log.blockNumber !== null) {
          found.push({ log, event });
        }
        // Keep scanning until the window ends or enough payments are found (newest first).
        return Promise.resolve(found.length >= limit ? true : null);
      });
      const first = await client.getBlock({ blockNumber: from }).catch(() => null);
      const times = new Map<bigint, bigint | null>();
      for (const { log } of found) {
        const block = BigInt(log.blockNumber ?? "0x0");
        if (!times.has(block)) {
          times.set(block, await client.getBlock({ blockNumber: block }).then((b) => b.timestamp, () => null));
        }
      }
      const payments = found.map(({ log, event }): ActivityPayment => {
        const block = BigInt(log.blockNumber ?? "0x0");
        return {
          chainId: chain.chainId,
          key: event.key,
          payer: event.payer.toLowerCase() as Address,
          token: event.token.toLowerCase() as Address,
          amount: event.amount,
          index: event.index,
          timestamp: times.get(block) ?? null,
          blockNumber: block,
          txHash: (log.transactionHash ?? "0x").toLowerCase() as Hex,
          logIndex: event.logIndex ?? 0,
        };
      });
      const window: ScanWindow = { chainId: chain.chainId, fromBlock: from, toBlock: head.number, seconds: first === null || head.timestamp < first.timestamp ? 0n : head.timestamp - first.timestamp };
      return { payments, window };
    }),
  );
  return { payments: newestFirst(results.flatMap((r) => r.payments)).slice(0, limit), windows: results.map((r) => r.window) };
}

/** Newest first: time, then block, then log index. */
export function newestFirst(payments: readonly ActivityPayment[]): ActivityPayment[] {
  return [...payments].sort((a, b) => {
    const ta = a.timestamp ?? -1n;
    const tb = b.timestamp ?? -1n;
    if (ta !== tb) {
      return ta > tb ? -1 : 1;
    }
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber > b.blockNumber ? -1 : 1;
    }
    return b.logIndex - a.logIndex;
  });
}

/**
 * The payee's history: from the indexer when it serves every chain asked for and answers, else from the chains'
 * bounded log scan, else nothing (both unavailable). Never throws.
 */
export async function readPayeeActivity(source: ActivitySource, payee: Address, limit = HISTORY_LIMIT): Promise<PayeeActivity> {
  const chainIds = source.chains.map((c) => c.chain.chainId);
  let indexerProblem: IndexerFailure | null = null;
  const indexer = source.indexer;
  if (indexer !== null && chainIds.length > 0 && chainIds.every((id) => indexer.serves(id))) {
    try {
      const [summaries, payments] = await Promise.all([indexer.payee(payee, chainIds), indexer.payments(payee, chainIds, limit)]);
      return {
        source: "indexer",
        summaries,
        payments: payments.map((p): ActivityPayment => ({ chainId: p.chainId, key: p.key, payer: p.payer, token: p.token, amount: p.amount, index: p.index, timestamp: p.timestamp, blockNumber: p.blockNumber, txHash: p.txHash, logIndex: p.logIndex })),
      };
    } catch (error) {
      indexerProblem = error instanceof IndexerError ? error.code : "offline";
    }
  }
  if (source.chains.length === 0) {
    return { source: "none", indexerProblem };
  }
  try {
    const scan = await scanRecentPayments(source, payee, limit);
    return { source: "chain", payments: scan.payments, windows: scan.windows, indexerProblem };
  } catch {
    return { source: "none", indexerProblem };
  }
}
