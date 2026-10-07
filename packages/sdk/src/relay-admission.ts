// SPDX-License-Identifier: MIT
/**
 * The relayer's admission policy against post-simulation reverts (invoice spec §13.3, THREAT_MODEL T-03, T-13,
 * T-46; audit findings A-02, A-03 and A-04).
 *
 * Simulating with `eth_call` before sending does not protect a relayer. Several parties can make a request that
 * passes simulation revert on inclusion, and on a chain that charges the gas limit (Monad) the relayer pays the
 * full limit of the reverted transaction:
 * - a payee with code answers `isValidSignature` differently at inclusion: block-dependent logic costs the attacker
 *   nothing per grief, and one storage write flips every relay already queued for it;
 * - even an EOA payee needs no code: one `cancel` of a receive card reverts every relay queued for that card;
 * - a payer can set an EIP-7702 delegation between simulation and inclusion, so the token checks its signature
 *   through the delegate; one type-4 transaction can carry many authorization tuples;
 * - any time bound that ends just after the simulated block (the payer's `validBefore`, the invoice's
 *   `validUntil`, a cancellation's `deadline`) reverts in the next block with no transaction at all (A-04).
 * The authorizations stay unconsumed, so the same requests can be replayed, and sybil payers holding one base unit
 * each defeat per-payer caps. A daily gas budget caps the monetary loss but turns the attack into an outage.
 *
 * Defences, all enforced by `RelayAdmissionLedger` (pure and storage-agnostic; the relayer's Durable Object
 * persists `snapshot()`):
 * 1. Time: `checkRelayPayRequest` and `checkRelayCancelRequest` refuse any time bound that ends within the chain's
 *    relay margin; `admit` checks it again against the relayer's clock. A bound can then only pass during
 *    inclusion latency longer than the margin, which is the relayer's own doing.
 * 2. Bound what is in flight: by default 1 relay per invoice key, 1 per payee, 1 per payer and 4 per token, so one
 *    attacker action reverts at most one paid relay per payee, and the token-wide bound caps the total. Each
 *    requester gets at most 20 relays an hour, whatever their outcome.
 * 3. Reputation, by cause: a relay that reverts after its simulation passed is attributed from chain evidence
 *    (`attributeRelayRevert`), and only the party that caused it is banned for a day (see `REVERT_PENALTIES`). A
 *    payer-side failure never bans the payee or the invoice, so a sybil payer cannot shut an honest merchant out;
 *    the same authorization landing first by another route (`superseded`) bans nobody. Strikes count against the
 *    requester (an IPv4 address or an IPv6 /64, `requesterFromIp`); three strikes ban it.
 * 4. Code: payees with code are relayed only when their code hash is on an allowlist of known wallets; payers with
 *    code (smart accounts, EIP-7702 delegated EOAs) are not relayed at all, as invoice spec §8.3 routes them to the
 *    allowance path. Both fall back to submitting themselves.
 * 5. The relayer simulates again against the pending block immediately before broadcast, and re-checks the time
 *    margin there (`assertRelayWindow`). That narrows the window, it does not close it, so it never replaces 1 to 4.
 */
import type { Address, Hex } from "viem";
import { PayLinkError } from "./errors.ts";
import type { CheckedPayRequest, CheckedRelayCall } from "./relayer.ts";
import type { RequesterId } from "./requester.ts";

export interface RelayAdmissionPolicy {
  /** Relays in flight per invoice key (chain-scoped). */
  readonly maxInFlightPerKey: number;
  /** Relays in flight per payee: one payee action (a toggle, a cancel) reverts at most this many. */
  readonly maxInFlightPerPayee: number;
  /** Relays in flight per payer: one payer delegation reverts at most this many. */
  readonly maxInFlightPerPayer: number;
  /** Relays in flight per token (chain-scoped): the bound that sybil payees and payers cannot multiply. */
  readonly maxInFlightPerToken: number;
  /** Code hashes of payee wallets trusted to answer ERC-1271 the same way at simulation and at inclusion. */
  readonly payeeCodeHashAllowlist: readonly Hex[];
  /** Relay `payWithAuthorization` for payers with code. Off: invoice spec §8.3 routes them to the allowance path. */
  readonly relayPayersWithCode: boolean;
  /** How long a key, payee, payer or requester stays banned after a revert attributed to it. */
  readonly banSeconds: number;
  /** Post-simulation reverts attributed to one requester within `banSeconds` before it is banned. */
  readonly maxRequesterStrikes: number;
  /**
   * Relays admitted per requester within `requesterWindowSeconds`, settled or not: successful relays cost gas too.
   * A relay that is dropped before inclusion (no gas spent) is given back.
   */
  readonly maxRelaysPerRequester: number;
  readonly requesterWindowSeconds: number;
}

export const DEFAULT_RELAY_ADMISSION_POLICY: RelayAdmissionPolicy = Object.freeze({
  maxInFlightPerKey: 1,
  maxInFlightPerPayee: 1,
  maxInFlightPerPayer: 1,
  maxInFlightPerToken: 4,
  payeeCodeHashAllowlist: Object.freeze([]),
  relayPayersWithCode: false,
  banSeconds: 86_400,
  maxRequesterStrikes: 3,
  maxRelaysPerRequester: 20,
  requesterWindowSeconds: 3_600,
});

/** A relay the ledger admitted; hand it back to `release` exactly once, with what happened on chain. */
export interface RelayTicket {
  readonly id: string;
  readonly kind: "pay" | "cancel";
  readonly chainId: number;
  /** The canonical deployment the call goes to. */
  readonly contract: Address;
  readonly key: Hex;
  readonly payee: Address;
  /** `null` for a cancellation. */
  readonly payer: Address | null;
  readonly token: Address;
  /** Who asked for it: an IPv4 address or an IPv6 /64 (`requesterFromIp`). */
  readonly requester: RequesterId;
  /** The relayer's clock at admission (unix seconds). */
  readonly admittedAt: bigint;
  /** The last block timestamp at which the call passes its time bounds (`RelayWindow.validThrough`). */
  readonly validThrough: bigint;
  /** keccak256 of the payee's and the payer's code at check time, `null` for none: a change at inclusion is evidence. */
  readonly payeeCodeHash: Hex | null;
  readonly payerCodeHash: Hex | null;
  /** For a payment, what identifies it on chain; `null` for a cancellation. */
  readonly payment: { readonly nonce: Hex; readonly amount: bigint; readonly payerRef: Hex } | null;
}

export type AdmissionRefusal =
  | "payee-code-not-allowlisted"
  | "payer-has-code"
  | "insufficient-validity"
  | "banned-requester"
  | "banned-key"
  | "banned-payee"
  | "banned-payer"
  | "requester-rate-limit"
  | "in-flight-key"
  | "in-flight-payee"
  | "in-flight-payer"
  | "in-flight-token";

export type Admission =
  | { readonly admitted: true; readonly ticket: RelayTicket }
  /**
   * The relayer answers with this reason and the client falls back to self-submission. `retryAfter` is when a ban
   * or a rate window ends; `null` for in-flight limits (retry when the pending relay resolves), for code policies
   * and for an insufficient validity (never: the time bounds only get closer).
   */
  | { readonly admitted: false; readonly reason: AdmissionRefusal; readonly retryAfter: bigint | null };

/**
 * Why a relay reverted on inclusion although its simulation passed, from chain evidence (`attributeRelayRevert`):
 * - `superseded`: the same payment (the same authorization) or the same cancellation landed first by another route,
 *   such as the payer's own resubmission (invoice spec §8.6) or a copy of the relayer's calldata: nothing went wrong;
 * - `late-inclusion`: a time bound passed although the margin held at admission: the relayer's own latency;
 * - `payer`: the payer cancelled or spent the authorization elsewhere, moved its balance, or changed its code;
 * - `payee`: the payee cancelled the invoice, or its signature (code) stopped verifying;
 * - `sold-out`: another payment took the invoice's last seat, a race the evidence pins on no party;
 * - `token`: the token is paused or blocks an account (an issuer action);
 * - `unattributed`: no evidence points at a party (for example no revert data could be obtained).
 */
export type RevertCause = "superseded" | "late-inclusion" | "payer" | "payee" | "sold-out" | "token" | "unattributed";

export interface RevertAttribution {
  readonly cause: RevertCause;
  /** The evidence, for logs: a short code such as `payer-code-changed` or `contract:SoldOut`. */
  readonly detail: string;
}

/**
 * - `settled`: included with status 1;
 * - `dropped`: never included (replaced, or abandoned before broadcast, including a failed pre-broadcast
 *   simulation): no gas was spent, so nobody is blamed and the requester's relay is given back;
 * - a `RevertAttribution`: included with status 0 although the simulation passed.
 */
export type RelayOutcome = "settled" | "dropped" | RevertAttribution;

type Party = "key" | "payee" | "payer";

/**
 * What a revert costs whom (invoice spec §13.3: penalties follow the cause, never the ticket). `ban` parties are
 * banned for `banSeconds`; `banIfCode` parties only when they had code at check time (code is the only way an
 * account can behave differently at inclusion without leaving other evidence); `strike` counts against the
 * requester.
 */
export const REVERT_PENALTIES: Readonly<Record<RevertCause, { readonly ban: readonly Party[]; readonly banIfCode: readonly Party[]; readonly strike: boolean }>> = Object.freeze({
  superseded: { ban: [], banIfCode: [], strike: false },
  "late-inclusion": { ban: [], banIfCode: [], strike: false },
  payer: { ban: ["payer"], banIfCode: [], strike: true },
  payee: { ban: ["key", "payee"], banIfCode: [], strike: true },
  "sold-out": { ban: ["key"], banIfCode: [], strike: false },
  token: { ban: [], banIfCode: [], strike: false },
  unattributed: { ban: ["key"], banIfCode: ["payee", "payer"], strike: true },
});

/** What `release` did, for the relayer's logs and alerts. */
export interface RelayRelease {
  /** `settled`, `dropped`, or the revert's cause. */
  readonly outcome: "settled" | "dropped" | RevertCause;
  /** Dimensions banned by this release, until `bannedUntil`. */
  readonly banned: readonly (Party | "requester")[];
  readonly bannedUntil: bigint | null;
  /** The requester received a strike. */
  readonly struck: boolean;
}

/** JSON-safe state for a Durable Object's storage. Times and amounts are decimal strings. */
export interface RelayAdmissionSnapshot {
  readonly version: 2;
  readonly nextId: number;
  readonly inFlight: readonly RelayTicketJson[];
  readonly bans: Readonly<Record<string, string>>;
  readonly strikes: Readonly<Record<string, WindowCountJson>>;
  readonly relays: Readonly<Record<string, WindowCountJson>>;
}

interface WindowCountJson {
  readonly count: number;
  readonly since: string;
}

interface RelayTicketJson extends Omit<RelayTicket, "requester" | "admittedAt" | "validThrough" | "payment"> {
  readonly requester: string;
  readonly admittedAt: string;
  readonly validThrough: string;
  readonly payment: { readonly nonce: Hex; readonly amount: string; readonly payerRef: Hex } | null;
}

interface WindowCount {
  count: number;
  since: bigint;
}

const lower = (value: string): string => value.toLowerCase();

/** The dimensions one ticket occupies, as counter keys. */
function dimensions(ticket: Pick<RelayTicket, "chainId" | "key" | "payee" | "payer" | "token">): {
  readonly key: string;
  readonly payee: string;
  readonly payer: string | null;
  readonly token: string;
} {
  const chain = String(ticket.chainId);
  return {
    key: `key:${chain}:${lower(ticket.key)}`,
    payee: `payee:${chain}:${lower(ticket.payee)}`,
    payer: ticket.payer === null ? null : `payer:${chain}:${lower(ticket.payer)}`,
    token: `token:${chain}:${lower(ticket.token)}`,
  };
}

const requesterKey = (requester: string): string => `requester:${requester}`;

function isPayRequest(checked: CheckedPayRequest | CheckedRelayCall): checked is CheckedPayRequest {
  return "payer" in checked;
}

function ticketToJson(ticket: RelayTicket): RelayTicketJson {
  return {
    ...ticket,
    admittedAt: ticket.admittedAt.toString(),
    validThrough: ticket.validThrough.toString(),
    payment: ticket.payment === null ? null : { ...ticket.payment, amount: ticket.payment.amount.toString() },
  };
}

function ticketFromJson(json: RelayTicketJson): RelayTicket {
  return {
    ...json,
    requester: json.requester as RequesterId,
    admittedAt: BigInt(json.admittedAt),
    validThrough: BigInt(json.validThrough),
    payment: json.payment === null ? null : { ...json.payment, amount: BigInt(json.payment.amount) },
  };
}

/** Adds one to a fixed window that starts at its first count; returns the updated window. */
function bump(previous: WindowCount | undefined, now: bigint, windowSeconds: bigint): WindowCount {
  return previous !== undefined && now - previous.since < windowSeconds ? { count: previous.count + 1, since: previous.since } : { count: 1, since: now };
}

/**
 * In-flight bounds, rate limits and reputation for one relayer (one per chain in the Durable Object design, or one
 * shared: every counter is chain-scoped). Not thread-safe by itself; the Durable Object serialises calls.
 */
export class RelayAdmissionLedger {
  readonly policy: RelayAdmissionPolicy;
  private nextId: number;
  private readonly tickets = new Map<string, RelayTicket>();
  private readonly counts = new Map<string, number>();
  private readonly bans = new Map<string, bigint>();
  private readonly strikes = new Map<string, WindowCount>();
  private readonly relays = new Map<string, WindowCount>();

  constructor(policy: Partial<RelayAdmissionPolicy> = {}, snapshot?: RelayAdmissionSnapshot) {
    this.policy = Object.freeze({ ...DEFAULT_RELAY_ADMISSION_POLICY, ...policy });
    const positive = [
      this.policy.maxInFlightPerKey,
      this.policy.maxInFlightPerPayee,
      this.policy.maxInFlightPerPayer,
      this.policy.maxInFlightPerToken,
      this.policy.banSeconds,
      this.policy.maxRequesterStrikes,
      this.policy.maxRelaysPerRequester,
      this.policy.requesterWindowSeconds,
    ];
    if (!positive.every((limit) => Number.isSafeInteger(limit) && limit >= 1)) {
      throw new PayLinkError("E_INVALID_ARGUMENT", "relay admission limits and windows must be positive integers", { rule: "RelayPolicy" });
    }
    if (snapshot !== undefined && (snapshot as { readonly version: unknown }).version !== 2) {
      throw new PayLinkError("E_INVALID_ARGUMENT", "unsupported relay admission snapshot version", { rule: "RelaySnapshot" });
    }
    this.nextId = snapshot?.nextId ?? 1;
    for (const ticket of snapshot?.inFlight ?? []) {
      this.occupy(ticketFromJson(ticket));
    }
    for (const [key, until] of Object.entries(snapshot?.bans ?? {})) {
      this.bans.set(key, BigInt(until));
    }
    for (const [target, source] of [
      [this.strikes, snapshot?.strikes ?? {}],
      [this.relays, snapshot?.relays ?? {}],
    ] as const) {
      for (const [key, window] of Object.entries(source)) {
        target.set(key, { count: window.count, since: BigInt(window.since) });
      }
    }
  }

  /**
   * Decides whether to relay a request that passed `checkRelayPayRequest` or `checkRelayCancelRequest`. On
   * admission the ticket occupies its key, payee, payer and token until `release`, and counts against the
   * requester's rate. `now` is the relayer's clock in unix seconds.
   */
  admit(checked: CheckedPayRequest | CheckedRelayCall, requester: RequesterId, now: bigint): Admission {
    const pay = isPayRequest(checked);
    const draft = {
      chainId: checked.target.chain.chainId,
      key: checked.key,
      payee: checked.payee,
      payer: pay ? checked.payer : null,
      token: checked.token.address,
    };
    const refused = (reason: AdmissionRefusal, retryAfter: bigint | null = null): Admission => ({ admitted: false, reason, retryAfter });

    if (checked.payeeCode.kind !== "none") {
      const allowed = this.policy.payeeCodeHashAllowlist.some((hash) => lower(hash) === lower(checked.payeeCode.codeHash ?? ""));
      if (!allowed) {
        return refused("payee-code-not-allowlisted");
      }
    }
    if (pay && checked.payerCode.kind !== "none" && !this.policy.relayPayersWithCode) {
      return refused("payer-has-code");
    }
    // Defence in depth for A-04: the check applied the margin at chain time; a request admitted later (queued, or
    // checked against a stale block) must still have it on the relayer's clock.
    if (checked.validThrough < now + checked.minRemainingSeconds) {
      return refused("insufficient-validity");
    }

    const dims = dimensions(draft);
    const who = requesterKey(requester);
    const banChecks: [string | null, AdmissionRefusal][] = [
      [who, "banned-requester"],
      [dims.key, "banned-key"],
      [dims.payee, "banned-payee"],
      [dims.payer, "banned-payer"],
    ];
    for (const [dimension, reason] of banChecks) {
      const until = dimension === null ? undefined : this.bans.get(dimension);
      if (dimension === null || until === undefined) {
        continue;
      }
      if (now < until) {
        return refused(reason, until);
      }
      this.bans.delete(dimension); // expired
    }

    const window = BigInt(this.policy.requesterWindowSeconds);
    const rate = this.relays.get(who);
    if (rate !== undefined && now - rate.since < window && rate.count >= this.policy.maxRelaysPerRequester) {
      return refused("requester-rate-limit", rate.since + window);
    }

    const limitChecks: [string | null, number, AdmissionRefusal][] = [
      [dims.key, this.policy.maxInFlightPerKey, "in-flight-key"],
      [dims.payee, this.policy.maxInFlightPerPayee, "in-flight-payee"],
      [dims.payer, this.policy.maxInFlightPerPayer, "in-flight-payer"],
      [dims.token, this.policy.maxInFlightPerToken, "in-flight-token"],
    ];
    for (const [dimension, limit, reason] of limitChecks) {
      if (dimension !== null && (this.counts.get(dimension) ?? 0) >= limit) {
        return refused(reason);
      }
    }

    const ticket: RelayTicket = {
      id: String(this.nextId),
      kind: pay ? "pay" : "cancel",
      ...draft,
      contract: checked.target.deployment.address,
      requester,
      admittedAt: now,
      validThrough: checked.validThrough,
      payeeCodeHash: checked.payeeCode.codeHash,
      payerCodeHash: pay ? checked.payerCode.codeHash : null,
      payment: pay ? { nonce: checked.nonce, amount: checked.amount, payerRef: checked.payerRef } : null,
    };
    this.nextId += 1;
    this.occupy(ticket);
    this.relays.set(who, bump(rate, now, window));
    return { admitted: true, ticket };
  }

  /**
   * Frees the ticket's slots and applies what the outcome costs (`REVERT_PENALTIES`). For a revert, pass the
   * attribution from `attributeRelayRevert`, never a guess: banning by ticket rather than by cause lets a sybil
   * payer shut out an honest payee (audit finding A-04).
   */
  release(ticket: RelayTicket, outcome: RelayOutcome, now: bigint): RelayRelease {
    const held = this.tickets.get(ticket.id);
    if (held === undefined) {
      throw new PayLinkError("E_INVALID_ARGUMENT", `relay ticket ${ticket.id} is not in flight`, { rule: "RelayTicket" });
    }
    this.tickets.delete(ticket.id);
    const dims = dimensions(held);
    for (const dimension of [dims.key, dims.payee, dims.payer, dims.token]) {
      if (dimension !== null) {
        const left = (this.counts.get(dimension) ?? 0) - 1;
        if (left > 0) {
          this.counts.set(dimension, left);
        } else {
          this.counts.delete(dimension);
        }
      }
    }
    const who = requesterKey(held.requester);
    if (outcome === "dropped") {
      // No gas was spent: give the requester its relay back, if its window is still the one that counted it.
      const rate = this.relays.get(who);
      if (rate !== undefined && rate.since <= held.admittedAt && rate.count > 0) {
        this.relays.set(who, { count: rate.count - 1, since: rate.since });
      }
    }
    if (typeof outcome === "string") {
      return { outcome, banned: [], bannedUntil: null, struck: false };
    }

    const penalty = REVERT_PENALTIES[outcome.cause];
    const until = now + BigInt(this.policy.banSeconds);
    const hasCode: Readonly<Record<Party, boolean>> = { key: false, payee: held.payeeCodeHash !== null, payer: held.payerCodeHash !== null };
    const parties = [...penalty.ban, ...penalty.banIfCode.filter((party) => hasCode[party])];
    const banned: (Party | "requester")[] = [];
    for (const party of parties) {
      const dimension = dims[party];
      if (dimension !== null) {
        this.bans.set(dimension, until);
        banned.push(party);
      }
    }
    if (penalty.strike) {
      const strike = bump(this.strikes.get(who), now, BigInt(this.policy.banSeconds));
      if (strike.count >= this.policy.maxRequesterStrikes) {
        this.bans.set(who, until);
        this.strikes.delete(who);
        banned.push("requester");
      } else {
        this.strikes.set(who, strike);
      }
    }
    return { outcome: outcome.cause, banned, bannedUntil: banned.length > 0 ? until : null, struck: penalty.strike };
  }

  /** Relays currently in flight. */
  inFlight(): readonly RelayTicket[] {
    return [...this.tickets.values()];
  }

  /** Bans still active at `now`, as dimension → end time. */
  activeBans(now: bigint): ReadonlyMap<string, bigint> {
    return new Map([...this.bans].filter(([, until]) => now < until));
  }

  /** JSON-safe state, to persist after every `admit` and `release`. */
  snapshot(): RelayAdmissionSnapshot {
    const windows = (source: Map<string, WindowCount>): Record<string, WindowCountJson> =>
      Object.fromEntries([...source].map(([key, window]) => [key, { count: window.count, since: window.since.toString() }]));
    return {
      version: 2,
      nextId: this.nextId,
      inFlight: this.inFlight().map(ticketToJson),
      bans: Object.fromEntries([...this.bans].map(([key, until]) => [key, until.toString()])),
      strikes: windows(this.strikes),
      relays: windows(this.relays),
    };
  }

  private occupy(ticket: RelayTicket): void {
    this.tickets.set(ticket.id, ticket);
    const dims = dimensions(ticket);
    for (const dimension of [dims.key, dims.payee, dims.payer, dims.token]) {
      if (dimension !== null) {
        this.counts.set(dimension, (this.counts.get(dimension) ?? 0) + 1);
      }
    }
  }
}
