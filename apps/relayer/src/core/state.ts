// SPDX-License-Identifier: MIT
/**
 * What a ChainSender keeps between requests and restarts: one JSON document per chain, written after every change
 * (Durable Object storage in the Worker, memory in the Node adapter). It holds no secret and no request body.
 *
 * Retention (THREAT_MODEL T-38): requester identities (an IPv4 address or an IPv6 /64) appear only in the admission
 * ledger's counters and bans and in the day's counters (onboarding, relays and gas per requester); `prune` drops each
 * entry when its window, ban or day ends, so none outlives a day. Nothing in the state links a requester to a payer
 * beyond an in-flight ticket.
 */
import type { RelayAdmissionPolicy, RelayAdmissionSnapshot } from "@paylink/sdk";
import { DEFAULT_RELAY_ADMISSION_POLICY } from "@paylink/sdk";
import type { Address, Hex } from "viem";

export type TxKind = "pay" | "cancel" | "onboard";

/** One signed transaction sent for a pending nonce. */
export interface Attempt {
  readonly hash: Hex;
  /** The signed transaction, for re-broadcast. */
  readonly raw: Hex;
  readonly gas: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  /** Unix seconds of the broadcast (relayer clock). */
  readonly sentAt: number;
  /** True for a zero-value self-transfer that voids the nonce instead of sending the call. */
  readonly void: boolean;
}

/** A nonce the relayer has signed for and not yet seen settled. */
export interface PendingTx {
  readonly kind: TxKind;
  readonly nonce: number;
  /** The relayer address that signed it (a rotated key's pending transactions are tracked, never replaced). */
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  /** The admission ticket's id (`RelayAdmissionLedger`), `null` for onboarding. */
  readonly ticketId: string | null;
  /** Duplicate-detection id: `pay:<payment nonce>` or `cancel:<key>`; `null` for onboarding. */
  readonly dedupeId: string | null;
  /** The call's last valid block timestamp (decimal), `null` when it has none (onboarding). */
  readonly validThrough: string | null;
  /** The block the last passing simulation ran against (decimal): attribution searches from there. */
  readonly simulatedAt: string;
  /** Gas cost reserved against the daily budget for the latest attempt (decimal wei). */
  readonly reservedWei: string;
  readonly attempts: readonly Attempt[];
  /** Tracker passes since the nonce was seen consumed without a receipt for any attempt. */
  readonly missingPasses: number;
  /** Tracker passes in which attribution evidence failed to load. */
  readonly evidenceFailures: number;
}

/** A recently settled relay, for idempotent answers to resubmissions (spec §8.6: retries resubmit the same body). */
export interface RecentRelay {
  readonly id: string;
  readonly txHash: Hex;
  /** Unix seconds. */
  readonly at: number;
}

export interface DayCounters {
  /** UTC date, `YYYY-MM-DD`. */
  readonly day: string;
  readonly relays: number;
  readonly onboards: number;
  readonly perPayer: Readonly<Record<string, number>>;
  readonly perAddress: Readonly<Record<string, number>>;
  /** Onboardings per requester. */
  readonly perRequester: Readonly<Record<string, number>>;
  /** Relays (pay and cancel) per requester. */
  readonly perRequesterRelays: Readonly<Record<string, number>>;
  /** Gas per `<kind>|<requester>` at the expected price (decimal wei), against `requesterShareBps`. */
  readonly perRequesterGasWei: Readonly<Record<string, string>>;
  /** Relayed payments received per payee, and relayed cancellations per payee (lower-case address). */
  readonly perPayeePays: Readonly<Record<string, number>>;
  readonly perPayeeCancels: Readonly<Record<string, number>>;
}

/** Settled and reserved gas of one kind of transaction (decimal wei). */
export interface KindBudget {
  readonly spentWei: string;
  readonly reservedWei: string;
}

export interface Budget {
  readonly day: string;
  /** Settled gas cost today (decimal wei). */
  readonly spentWei: string;
  /** Reserved for transactions still pending (decimal wei); carried over midnight. */
  readonly reservedWei: string;
  /** The same per kind of transaction, against each kind's share of the day's budget. */
  readonly byKind: Readonly<Record<TxKind, KindBudget>>;
}

export interface SenderState {
  readonly version: 1;
  readonly chainId: number;
  /** The next nonce to use, or `null` until the first send reads it from the chain. */
  readonly nextNonce: number | null;
  readonly pending: readonly PendingTx[];
  readonly ledger: RelayAdmissionSnapshot;
  readonly budget: Budget;
  readonly counters: DayCounters;
  readonly recent: readonly RecentRelay[];
}

/** Where a ChainSender persists its state. */
export interface StateStore {
  load(): Promise<unknown>;
  save(state: SenderState): Promise<void>;
}

export function memoryStore(): StateStore & { readonly current: () => SenderState | undefined } {
  let value: string | undefined;
  return {
    load: () => Promise.resolve(value === undefined ? undefined : (JSON.parse(value) as unknown)),
    save: (state) => {
      value = JSON.stringify(state);
      return Promise.resolve();
    },
    current: () => (value === undefined ? undefined : (JSON.parse(value) as SenderState)),
  };
}

/** UTC date of a unix-seconds time. */
export function utcDay(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight. */
export function secondsToMidnight(seconds: bigint): number {
  return 86_400 - Number(seconds % 86_400n);
}

const ZERO_KINDS: Readonly<Record<TxKind, KindBudget>> = { pay: { spentWei: "0", reservedWei: "0" }, cancel: { spentWei: "0", reservedWei: "0" }, onboard: { spentWei: "0", reservedWei: "0" } };

export function emptyCounters(day: string): DayCounters {
  return { day, relays: 0, onboards: 0, perPayer: {}, perAddress: {}, perRequester: {}, perRequesterRelays: {}, perRequesterGasWei: {}, perPayeePays: {}, perPayeeCancels: {} };
}

export function emptyState(chainId: number, nowSeconds: bigint): SenderState {
  const day = utcDay(nowSeconds);
  return {
    version: 1,
    chainId,
    nextNonce: null,
    pending: [],
    ledger: { version: 2, nextId: 1, inFlight: [], bans: {}, strikes: {}, relays: {} },
    budget: { day, spentWei: "0", reservedWei: "0", byKind: ZERO_KINDS },
    counters: emptyCounters(day),
    recent: [],
  };
}

/**
 * Loads a stored state for `chainId`, or a fresh one when there is none or it is of another version or chain. A
 * state saved before the per-kind budget and the per-requester and per-payee counters (2026-10-08) keeps its pending
 * transactions and gains those fields: the day's spending so far is counted against the payments' share, and each
 * pending transaction's reservation against its own kind.
 */
export function restoreState(stored: unknown, chainId: number, nowSeconds: bigint): SenderState {
  if (typeof stored !== "object" || stored === null) {
    return emptyState(chainId, nowSeconds);
  }
  const state = stored as Partial<SenderState>;
  if (state.version !== 1 || state.chainId !== chainId || state.ledger?.version !== 2 || !Array.isArray(state.pending) || state.budget === undefined || state.counters === undefined) {
    return emptyState(chainId, nowSeconds);
  }
  const reservedOf = (kind: TxKind): string => state.pending?.filter((p) => p.kind === kind).reduce((sum, p) => sum + BigInt(p.reservedWei), 0n).toString() ?? "0";
  const budget: Budget =
    (state.budget as Partial<Budget>).byKind === undefined
      ? { ...state.budget, byKind: { pay: { spentWei: state.budget.spentWei, reservedWei: reservedOf("pay") }, cancel: { spentWei: "0", reservedWei: reservedOf("cancel") }, onboard: { spentWei: "0", reservedWei: reservedOf("onboard") } } }
      : state.budget;
  const counters: DayCounters = { ...emptyCounters(state.counters.day), ...state.counters };
  return { ...(state as SenderState), budget, counters };
}

/** How long recent relays are remembered for duplicate answers. */
export const RECENT_SECONDS = 86_400;
/** At most this many recent relays are remembered. */
export const MAX_RECENT = 500;

/**
 * Drops what has expired at `nowSeconds`: ledger bans, strike and rate windows, recent relays, and the day's
 * counters and settled budget after midnight (reservations carry over).
 */
export function prune(state: SenderState, nowSeconds: bigint, admission: Partial<RelayAdmissionPolicy>): SenderState {
  const policy = { ...DEFAULT_RELAY_ADMISSION_POLICY, ...admission };
  const live = (since: string, window: number): boolean => BigInt(since) + BigInt(window) > nowSeconds;
  const ledger: RelayAdmissionSnapshot = {
    ...state.ledger,
    bans: Object.fromEntries(Object.entries(state.ledger.bans).filter(([, until]) => BigInt(until) > nowSeconds)),
    strikes: Object.fromEntries(Object.entries(state.ledger.strikes).filter(([, window]) => live(window.since, policy.banSeconds))),
    relays: Object.fromEntries(Object.entries(state.ledger.relays).filter(([, window]) => live(window.since, policy.requesterWindowSeconds))),
  };
  const day = utcDay(nowSeconds);
  const recent = state.recent.filter((relay) => BigInt(relay.at) + BigInt(RECENT_SECONDS) > nowSeconds).slice(-MAX_RECENT);
  const carried = (kind: TxKind): KindBudget => ({ spentWei: "0", reservedWei: state.budget.byKind[kind].reservedWei });
  return {
    ...state,
    ledger,
    recent,
    budget: state.budget.day === day ? state.budget : { day, spentWei: "0", reservedWei: state.budget.reservedWei, byKind: { pay: carried("pay"), cancel: carried("cancel"), onboard: carried("onboard") } },
    counters: state.counters.day === day ? state.counters : emptyCounters(day),
  };
}

/** `budget` with `deltaSpent` and `deltaReserved` (wei, may be negative) applied to the total and to `kind`. */
export function adjustBudget(budget: Budget, kind: TxKind, deltaSpent: bigint, deltaReserved: bigint): Budget {
  const floor = (value: bigint): string => (value > 0n ? value : 0n).toString();
  const own = budget.byKind[kind];
  return {
    ...budget,
    spentWei: floor(BigInt(budget.spentWei) + deltaSpent),
    reservedWei: floor(BigInt(budget.reservedWei) + deltaReserved),
    byKind: { ...budget.byKind, [kind]: { spentWei: floor(BigInt(own.spentWei) + deltaSpent), reservedWei: floor(BigInt(own.reservedWei) + deltaReserved) } },
  };
}
