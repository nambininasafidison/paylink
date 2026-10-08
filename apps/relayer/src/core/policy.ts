// SPDX-License-Identifier: MIT
/**
 * The relayer's operating limits (PAYLINK-V2-SPEC §3.7 pipeline steps 4 and 5, THREAT_MODEL T-03, T-33). They are
 * code, not configuration: a change is a reviewed commit and a redeploy, never a dashboard edit.
 *
 * The admission policy against post-simulation reverts (in-flight bounds, attribution bans, requester strikes and
 * hourly rate) is `RelayAdmissionLedger`'s default, unchanged (invoice spec §13.3 reference policy).
 *
 * The daily gas budget is split so that no single party can drain it with relays that succeed (review 2026-10-08):
 * one share per kind of transaction (a flood of cancellations or faucet drips cannot spend the payments' gas), at
 * most a fifth of each share per requester per UTC day (gas at the expected price, persisted with the day's
 * counters), a daily relay count per requester, and per-payee caps on payments received and cancellations.
 */
import type { ChainDefinition, Token } from "@paylink/chains";
import type { RelayAdmissionPolicy } from "@paylink/sdk";
import type { TxKind } from "./state.ts";

export interface ChainLimits {
  /**
   * Gas the relayer may spend per UTC day, in wei of the native coin. Each send reserves `gasLimit × maxFeePerGas`
   * until its receipt settles the actual cost (on Monad the whole limit is charged).
   */
  readonly dailyGasBudgetWei: bigint;
  /** Highest `maxFeePerGas` the relayer signs. Above `baseFee + tip` the relayer refuses (`fees-too-high`). */
  readonly maxFeePerGasWei: bigint;
  /** Relays (pay and cancel) broadcast per UTC day on the chain. */
  readonly maxRelaysPerDay: number;
  /** Relays per payer per UTC day. */
  readonly maxRelaysPerPayerPerDay: number;
  /** Faucet drips per UTC day on the chain, per address and per requester (onboarding, testnet only). */
  readonly maxOnboardsPerDay: number;
  readonly maxOnboardsPerAddressPerDay: number;
  readonly maxOnboardsPerRequesterPerDay: number;
  /**
   * The daily budget's share for each kind of transaction, in basis points (they sum to 10,000): a kind never spends
   * another kind's gas. Each share is checked like the whole budget (settled + reserved + this reservation).
   */
  readonly budgetShareBps: Readonly<Record<TxKind, number>>;
  /**
   * The most one requester (an IPv4 address or an IPv6 /64) may spend of a kind's share per UTC day, in basis points
   * of that share, counted at the expected price (`gasLimit × (baseFee + tip)`, what Monad charges).
   */
  readonly requesterShareBps: number;
  /** Relays (pay and cancel) per requester per UTC day, on top of the admission ledger's hourly rate. */
  readonly maxRelaysPerRequesterPerDay: number;
  /** Relayed payments received per payee per UTC day. */
  readonly maxPaysPerPayeePerDay: number;
  /** Relayed cancellations (`cancelBySig`) per payee per UTC day. */
  readonly maxCancelsPerPayeePerDay: number;
}

export interface RelayerPolicy {
  /** Overrides of `DEFAULT_RELAY_ADMISSION_POLICY` (none in production). */
  readonly admission: Partial<RelayAdmissionPolicy>;
  /** Token bucket per requester (IPv4 address or IPv6 /64), all endpoints of a chain: capacity and refill per minute. */
  readonly requestsPerMinutePerRequester: number;
  /** Token bucket for the whole chain, protecting the public RPC endpoints' rate limits. */
  readonly requestsPerMinutePerChain: number;
  /** A transaction still pending after this long is replaced with the same nonce and higher fees (§3.7: 30 s). */
  readonly replaceAfterSeconds: number;
  /** Fee increase per replacement, in percent (§3.7: ×1.25; nodes require at least +10 %). */
  readonly feeBumpPercent: number;
  /** Fee-bump replacements of the same call before the nonce is voided with a zero-value self-transfer. */
  readonly maxReplacements: number;
  /** How often pending transactions are polled while any are in flight. */
  readonly trackIntervalMs: number;
  /** Tracker passes during which attribution evidence may fail to load before the revert is ruled `unattributed`. */
  readonly maxEvidenceAttempts: number;
  /** Minimum payment relayed, in base units of `token`. */
  readonly minRelayAmount: (token: Token) => bigint;
  readonly limits: (chain: ChainDefinition) => ChainLimits;
}

const GWEI = 1_000_000_000n;
const ETHER = 10n ** 18n;

/**
 * Per-chain limits. Monad testnet charges the whole gas limit at about 102 gwei (the 100-gwei minimum base fee and a
 * tip): a pay relay costs about 0.028 MON (a 275k limit, measured on an anvil fork of Monad testnet on 2026-10-07,
 * test/integration/fork.test.ts), a `cancelBySig` 0.009 to 0.014 MON (89k to 134k), a faucet drip 0.013 to 0.020 MON
 * (130k to 195k). The key holds about two days of budget (spec §3.7: at most ~2 MON). Shares of the 1 MON day:
 * - payments 0.6 MON, about 21 relays; one requester at most 0.12 MON (4 relays);
 * - cancellations 0.1 MON, 7 to 11; one requester at most 0.02 MON (2), and 3 per payee;
 * - onboarding 0.3 MON: 15 drips at the 195k ceiling and 102 gwei cost 0.298 MON (policy.test.ts checks the fit).
 * Draining a share therefore takes at least five requesters (IPv4 addresses or IPv6 /64s): THREAT_MODEL T-03.
 * The Sepolia rollups cost a few thousandths of a cent per relay; their budgets only stop a runaway.
 */
const CHAIN_LIMITS: Readonly<Record<string, ChainLimits>> = {
  "monad-testnet": {
    dailyGasBudgetWei: 1n * ETHER,
    maxFeePerGasWei: 500n * GWEI,
    maxRelaysPerDay: 300,
    maxRelaysPerPayerPerDay: 10,
    maxOnboardsPerDay: 15,
    maxOnboardsPerAddressPerDay: 1,
    maxOnboardsPerRequesterPerDay: 3,
    budgetShareBps: { pay: 6_000, cancel: 1_000, onboard: 3_000 },
    requesterShareBps: 2_000,
    maxRelaysPerRequesterPerDay: 10,
    maxPaysPerPayeePerDay: 20,
    maxCancelsPerPayeePerDay: 3,
  },
  "base-sepolia": {
    dailyGasBudgetWei: ETHER / 200n,
    maxFeePerGasWei: 10n * GWEI,
    maxRelaysPerDay: 300,
    maxRelaysPerPayerPerDay: 10,
    maxOnboardsPerDay: 0,
    maxOnboardsPerAddressPerDay: 0,
    maxOnboardsPerRequesterPerDay: 0,
    budgetShareBps: { pay: 8_000, cancel: 2_000, onboard: 0 },
    requesterShareBps: 2_000,
    maxRelaysPerRequesterPerDay: 10,
    maxPaysPerPayeePerDay: 20,
    maxCancelsPerPayeePerDay: 3,
  },
  "arbitrum-sepolia": {
    dailyGasBudgetWei: ETHER / 200n,
    maxFeePerGasWei: 10n * GWEI,
    maxRelaysPerDay: 300,
    maxRelaysPerPayerPerDay: 10,
    maxOnboardsPerDay: 0,
    maxOnboardsPerAddressPerDay: 0,
    maxOnboardsPerRequesterPerDay: 0,
    budgetShareBps: { pay: 8_000, cancel: 2_000, onboard: 0 },
    requesterShareBps: 2_000,
    maxRelaysPerRequesterPerDay: 10,
    maxPaysPerPayeePerDay: 20,
    maxCancelsPerPayeePerDay: 3,
  },
};

/** Local anvil chains (tests, e2e, demo recording): generous, so that only the admission policy is exercised. */
const LOCAL_LIMITS: ChainLimits = {
  dailyGasBudgetWei: 100n * ETHER,
  maxFeePerGasWei: 1_000n * GWEI,
  maxRelaysPerDay: 10_000,
  maxRelaysPerPayerPerDay: 1_000,
  maxOnboardsPerDay: 1_000,
  maxOnboardsPerAddressPerDay: 1,
  maxOnboardsPerRequesterPerDay: 1_000,
  budgetShareBps: { pay: 6_000, cancel: 2_000, onboard: 2_000 },
  requesterShareBps: 10_000,
  maxRelaysPerRequesterPerDay: 10_000,
  maxPaysPerPayeePerDay: 1_000,
  maxCancelsPerPayeePerDay: 1_000,
};

/** Zero everything: a chain the relayer does not know limits for is not relayed. */
const NO_LIMITS: ChainLimits = {
  dailyGasBudgetWei: 0n,
  maxFeePerGasWei: 0n,
  maxRelaysPerDay: 0,
  maxRelaysPerPayerPerDay: 0,
  maxOnboardsPerDay: 0,
  maxOnboardsPerAddressPerDay: 0,
  maxOnboardsPerRequesterPerDay: 0,
  budgetShareBps: { pay: 0, cancel: 0, onboard: 0 },
  requesterShareBps: 0,
  maxRelaysPerRequesterPerDay: 0,
  maxPaysPerPayeePerDay: 0,
  maxCancelsPerPayeePerDay: 0,
};

/** The share of the daily budget a kind of transaction may spend (wei). */
export function kindBudgetWei(limits: ChainLimits, kind: TxKind): bigint {
  return (limits.dailyGasBudgetWei * BigInt(limits.budgetShareBps[kind])) / 10_000n;
}

/** The most one requester may spend of a kind's share per UTC day (wei, at the expected price). */
export function requesterBudgetWei(limits: ChainLimits, kind: TxKind): bigint {
  return (kindBudgetWei(limits, kind) * BigInt(limits.requesterShareBps)) / 10_000n;
}

/** One cent of a dollar token (10^(decimals - 2) base units): smaller payments are refused, so that sybil payers holding one base unit cost more than they grief. */
export function oneCent(token: Pick<Token, "decimals">): bigint {
  return token.decimals >= 2 ? 10n ** BigInt(token.decimals - 2) : 1n;
}

export const DEFAULT_POLICY: RelayerPolicy = Object.freeze({
  admission: {},
  requestsPerMinutePerRequester: 30,
  requestsPerMinutePerChain: 600,
  replaceAfterSeconds: 30,
  feeBumpPercent: 25,
  maxReplacements: 3,
  trackIntervalMs: 1_000,
  maxEvidenceAttempts: 30,
  minRelayAmount: oneCent,
  limits: (chain: ChainDefinition): ChainLimits => (chain.local ? LOCAL_LIMITS : (CHAIN_LIMITS[chain.key] ?? NO_LIMITS)),
});

/** `DEFAULT_POLICY` with overrides (tests and the Node adapter only; the Worker uses the defaults). */
export function withPolicy(overrides: Partial<RelayerPolicy> = {}): RelayerPolicy {
  return Object.freeze({ ...DEFAULT_POLICY, ...overrides });
}
