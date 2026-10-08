// SPDX-License-Identifier: MIT
/**
 * The relayer's operating limits (PAYLINK-V2-SPEC §3.7 pipeline steps 4 and 5, THREAT_MODEL T-03, T-33). They are
 * code, not configuration: a change is a reviewed commit and a redeploy, never a dashboard edit.
 *
 * The admission policy against post-simulation reverts (in-flight bounds, attribution bans, requester strikes and
 * hourly rate) is `RelayAdmissionLedger`'s default, unchanged (invoice spec §13.3 reference policy).
 */
import type { ChainDefinition, Token } from "@paylink/chains";
import type { RelayAdmissionPolicy } from "@paylink/sdk";

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
 * Per-chain limits. Monad testnet: a pay relay costs about 0.028 MON (a 275k limit at about 102 gwei, all of it
 * charged; measured on an anvil fork of Monad testnet on 2026-10-07, test/integration/fork.test.ts), so 1 MON a day
 * is about 35 relays and the key holds about two days of budget (spec §3.7: at most ~2 MON). The Sepolia rollups
 * cost a few thousandths of a cent per relay; their budgets only stop a runaway.
 */
const CHAIN_LIMITS: Readonly<Record<string, ChainLimits>> = {
  "monad-testnet": {
    dailyGasBudgetWei: 1n * ETHER,
    maxFeePerGasWei: 500n * GWEI,
    maxRelaysPerDay: 300,
    maxRelaysPerPayerPerDay: 30,
    maxOnboardsPerDay: 100,
    maxOnboardsPerAddressPerDay: 1,
    maxOnboardsPerRequesterPerDay: 3,
  },
  "base-sepolia": {
    dailyGasBudgetWei: ETHER / 200n,
    maxFeePerGasWei: 10n * GWEI,
    maxRelaysPerDay: 300,
    maxRelaysPerPayerPerDay: 30,
    maxOnboardsPerDay: 0,
    maxOnboardsPerAddressPerDay: 0,
    maxOnboardsPerRequesterPerDay: 0,
  },
  "arbitrum-sepolia": {
    dailyGasBudgetWei: ETHER / 200n,
    maxFeePerGasWei: 10n * GWEI,
    maxRelaysPerDay: 300,
    maxRelaysPerPayerPerDay: 30,
    maxOnboardsPerDay: 0,
    maxOnboardsPerAddressPerDay: 0,
    maxOnboardsPerRequesterPerDay: 0,
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
};

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
