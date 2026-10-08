// SPDX-License-Identifier: MIT
/**
 * ChainSender: the relayer for one chain (PAYLINK-V2-SPEC §3.7, ADR 0007, invoice spec §13.3). The Worker runs one
 * per chain inside a Durable Object, which serialises it; the Node adapter runs the same class in process.
 *
 * Pipeline of a relay (`pay`, `cancel`):
 * 1. the body already passed the zod schema (HTTP layer); the SDK parser applies EIP-55 and the integer bounds;
 * 2. the chain is a relayable testnet with a canonical, non-revoked deployment;
 * 3. `checkRelayPayRequest` / `checkRelayCancelRequest` at the latest block: invoice decoding rules, the payee
 *    signature with the contract's dispatch, the recomputed binding nonce, the payer's signature with the token's
 *    dispatch, the time windows and the relay margin on every bound;
 * 4. the token is an EIP-3009 registry token and the amount at least one cent;
 * 5. per-requester and per-chain request rates, per-payer and per-chain daily caps;
 * 6. `RelayAdmissionLedger.admit`: in-flight bounds, attribution bans, requester strikes and hourly rate, code
 *    policy, the margin again on the relayer's clock; then an `eth_call` simulation at the checked block;
 * 7. in the send section (one at a time): the margin against the pending block, `eth_call` and `eth_estimateGas`
 *    against the pending block, `gasLimit = clamp(estimate × 1.10, floor, ceiling)` from `@paylink/chains`, fee caps,
 *    the daily gas budget and the balance, the nonce, `assertSendable`, sign, persist, broadcast;
 * 8. return the transaction hash.
 * The tracker (`tick`) then follows each nonce to its receipt: settled, dropped, or reverted after a passing
 * simulation, in which case `attributeRelayRevert` names the cause from chain evidence and the ledger bans only
 * that party. A nonce still pending after `replaceAfterSeconds` is re-sent with the same nonce and fees × 1.25, up to
 * `maxReplacements` times; past that, or once the call's time bounds have passed, the nonce is voided with a
 * zero-value self-transfer rather than paying for a certain revert.
 *
 * Onboarding (`onboard`, Monad testnet only) sends the registry faucet's `requestFunds(address)` through the same
 * send section, gas bounds and budget. The relayer never moves tokens or coin of its own.
 */
import type { ChainDefinition, GasBounds, Registry } from "@paylink/chains";
import {
  assertRelayWindow,
  attributeRelayRevert,
  checkRelayCancelRequest,
  checkRelayPayRequest,
  clampGasLimit,
  decodeError,
  gasBounds,
  invoiceKey,
  isPayLinkError,
  parseCancelAuthorizationJson,
  parseRelayPayRequest,
  paymentNonce,
  readAuthorizationState,
  readLinkState,
  RelayAdmissionLedger,
  replayRevertData,
  revertDataOf,
} from "@paylink/sdk";
import type { Admission, CheckedPayRequest, CheckedRelayCall, RelayOutcome, RelayTicket, RelayWindow, RequesterId, RevertAttribution } from "@paylink/sdk";
import { BaseError, ExecutionRevertedError, getAddress, HttpRequestError, isAddress, isAddressEqual, keccak256, TimeoutError } from "viem";
import type { Address, Hex, PrivateKeyAccount, PublicClient, TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertSendable, faucetCall, faucetOf, isRelayable } from "./chains.ts";
import { RequestLimiter, SerialQueue } from "./limits.ts";
import type { Logger } from "./log.ts";
import { errorMessage, requesterTag, silentLogger } from "./log.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import type { ChainLimits, RelayerPolicy } from "./policy.ts";
import type { Problem } from "./problem.ts";
import { problem, secondsUntil } from "./problem.ts";
import type { Attempt, PendingTx, SenderState, StateStore, TxKind } from "./state.ts";
import { MAX_RECENT, prune, restoreState, secondsToMidnight } from "./state.ts";

/** One relay request, as the HTTP layer hands it over (plain JSON: it crosses the Durable Object RPC boundary). */
export interface RelayInput {
  /** The body, already validated by the operation's zod schema. */
  readonly body: unknown;
  /** The requester identity (`requesterFromIp`): an IPv4 address or an IPv6 /64. */
  readonly requester: string;
  readonly requestId: string;
}

export interface Accepted {
  /** `submitted`: broadcast now; `pending`: the same request is already in flight; `settled`: it already landed. */
  readonly status: "submitted" | "pending" | "settled";
  readonly kind: TxKind;
  readonly chainId: number;
  readonly txHash: Hex;
  /** True when an identical request was already relayed: nothing new was sent. */
  readonly duplicate: boolean;
  /** The invoice key (pay, cancel) or the funded address (onboard). */
  readonly subject: Hex;
  /** The transaction's nonce and gas limit (decimal), for a new submission. */
  readonly nonce?: number;
  readonly gasLimit?: string;
}

export type EngineResult =
  | { readonly ok: true; readonly httpStatus: 200 | 202; readonly body: Accepted }
  | { readonly ok: false; readonly problem: Problem };

export type ChainState = "ready" | "not-configured" | "awaiting-deployment" | "unfunded" | "rpc-error";

/** What `GET /v1/health` reports per chain. Public data only. */
export interface ChainStatus {
  readonly chainId: number;
  readonly name: string;
  readonly label: string;
  readonly state: ChainState;
  /** The relayer's address on this chain (fund it with the native coin), `null` when no key is configured. */
  readonly relayer: Address | null;
  readonly balanceWei: string | null;
  /** The balance below which the chain reports `unfunded`: one pay relay at the gas ceiling and twice the base fee. */
  readonly minBalanceWei: string | null;
  readonly deployment: Address | null;
  readonly operations: { readonly pay: boolean; readonly cancel: boolean; readonly onboard: boolean };
  readonly pending: number;
  readonly inFlight: number;
  readonly blockNumber: string | null;
  readonly relayMarginSeconds: number | null;
  readonly budget: { readonly day: string; readonly limitWei: string; readonly spentWei: string; readonly reservedWei: string };
}

export interface EngineOptions {
  /** The relay registry (`relayRegistry`): only chains the relayer serves. */
  readonly registry: Registry;
  readonly chainId: number;
  /** The raw `RELAYER_PK` secret, or `undefined`. Validated here and never logged. */
  readonly privateKey: string | undefined;
  readonly client: PublicClient;
  readonly store: StateStore;
  readonly policy?: RelayerPolicy;
  readonly logger?: Logger;
  /** Milliseconds since the epoch (tests drive it). */
  readonly clock?: () => number;
  /** Asks the host to call `tick()` at this time (Durable Object alarm, or a timer). */
  readonly wake?: (atMs: number) => void | Promise<void>;
  /** Accept local (anvil) chains: the Node adapter only. */
  readonly allowLocal?: boolean;
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** `RELAYER_PK` as a private key, or `null` when it is missing or not a valid secp256k1 scalar. */
export function parsePrivateKey(raw: string | undefined): Hex | null {
  const text = raw?.trim() ?? "";
  const hex = /^0x[0-9a-fA-F]{64}$/u.test(text) ? text : /^[0-9a-fA-F]{64}$/u.test(text) ? `0x${text}` : null;
  if (hex === null) {
    return null;
  }
  const scalar = BigInt(hex);
  return scalar > 0n && scalar < SECP256K1_N ? (hex.toLowerCase() as Hex) : null;
}

const seconds = (ms: number): bigint => BigInt(Math.floor(ms / 1000));

/** True for failures of the transport (the RPC endpoint was unreachable or slow), not answers from the node. */
function isTransportFailure(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null;
}

/** True when the node answered with a revert (with or without revert data), as opposed to a transport or node failure. */
function isRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) {
    return false;
  }
  return revertDataOf(error) !== null || error.walk((e) => e instanceof ExecutionRevertedError || (e instanceof BaseError && /revert/iu.test(e.shortMessage))) !== null;
}

function payLinkProblem(error: unknown): Problem {
  if (isPayLinkError(error)) {
    const rule = error.params["rule"] ?? error.code;
    if (error.code === "E_CHAIN_UNKNOWN") {
      return problem("chain-not-ready", "PayLink has no canonical deployment on this chain yet");
    }
    if (error.code === "E_DEPLOYMENT_INACTIVE") {
      return problem("chain-not-ready", "the canonical deployment on this chain is revoked");
    }
    const fallback = rule === "RelayValidityTooShort" || rule === "AuthorizationWindow" ? "self-submit" : "none";
    return problem("rejected", error.message, { rule, fallback });
  }
  throw error;
}

interface Pipeline {
  readonly kind: TxKind;
  readonly call: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  readonly bounds: GasBounds;
  readonly window: RelayWindow | null;
  readonly ticket: RelayTicket | null;
  readonly dedupeId: string | null;
  readonly subject: Hex;
  readonly log: Logger;
}

type SendOutcome = { readonly ok: true; readonly body: Accepted } | { readonly ok: false; readonly problem: Problem };

export class ChainEngine {
  readonly chain: ChainDefinition;
  readonly policy: RelayerPolicy;
  private readonly limits: ChainLimits;
  private readonly account: PrivateKeyAccount | null;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private readonly queue = new SerialQueue();
  private readonly limiter: RequestLimiter;
  private ledger: RelayAdmissionLedger;
  private state: SenderState;
  private accountCodeCheckedAt = -Infinity;
  private statusCache: { readonly at: number; readonly value: ChainStatus } | null = null;

  private readonly options: EngineOptions;

  private constructor(options: EngineOptions, chain: ChainDefinition, state: SenderState) {
    this.options = options;
    this.chain = chain;
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.limits = this.policy.limits(chain);
    this.clock = options.clock ?? Date.now;
    const key = parsePrivateKey(options.privateKey);
    this.account = key === null ? null : privateKeyToAccount(key);
    this.logger = (options.logger ?? silentLogger).child({ chainId: chain.chainId, ...(this.account === null ? {} : { relayer: this.account.address }) });
    this.limiter = new RequestLimiter(this.policy.requestsPerMinutePerRequester, this.policy.requestsPerMinutePerChain, this.clock());
    this.state = state;
    this.ledger = new RelayAdmissionLedger(this.policy.admission, state.ledger);
  }

  /** Loads the chain's state and returns its sender. Throws when the chain is not relayable. */
  static async open(options: EngineOptions): Promise<ChainEngine> {
    const chain = options.registry.get(options.chainId);
    if (chain === undefined || !isRelayable(chain, options.allowLocal ?? false)) {
      throw new Error(`chain ${String(options.chainId)} is not relayable`);
    }
    const now = seconds((options.clock ?? Date.now)());
    const state = restoreState(await options.store.load(), chain.chainId, now);
    const engine = new ChainEngine(options, chain, state);
    if (options.privateKey !== undefined && engine.account === null) {
      engine.logger.log("error", "relayer.key-invalid", { detail: "RELAYER_PK is not a 32-byte secp256k1 private key" });
    }
    if (state.pending.length > 0) {
      await engine.wakeAt(engine.clock());
    }
    return engine;
  }

  /** The relayer's address, or `null` when no valid key is configured. */
  get address(): Address | null {
    return this.account?.address ?? null;
  }

  /** A copy of the persisted state (tests and diagnostics). */
  snapshot(): SenderState {
    return structuredClone({ ...this.state, ledger: this.ledger.snapshot() });
  }

  // ------------------------------------------------------------------------------------------------ operations

  /** `POST /v1/{chainId}/pay`: relays `payWithAuthorization`. */
  async pay(input: RelayInput): Promise<EngineResult> {
    return await this.handle("pay", input, async (log, requester) => {
      const deployment = this.deploymentProblem();
      if (deployment !== null) {
        return deployment;
      }
      let request;
      try {
        request = parseRelayPayRequest(input.body);
      } catch (error) {
        return isPayLinkError(error) ? problem("invalid-request", error.message, { rule: error.code }) : rethrow(error);
      }
      // A resubmission of a relay in flight or settled (spec §8.6) is answered from memory, before any check that
      // time could now fail (the margin) and without RPC: the binding nonce names exactly one payment.
      const key = invoiceKey({ chainId: this.chain.chainId, verifyingContract: this.deploymentAddress() }, request.invoice);
      const { authorization } = request;
      const dedupeId = `pay:${paymentNonce({ key, payer: authorization.payer, amount: authorization.amount, payerRef: authorization.payerRef, payerSalt: authorization.payerSalt }).toLowerCase()}`;
      const duplicate = this.duplicateOf(dedupeId, "pay", key);
      if (duplicate !== null) {
        return duplicate;
      }
      const block = await this.options.client.getBlock({ blockTag: "latest" });
      let checked: CheckedPayRequest;
      try {
        checked = await checkRelayPayRequest({ registry: this.options.registry, pathChainId: this.chain.chainId, request, client: this.options.client, now: block.timestamp });
      } catch (error) {
        return payLinkProblem(error);
      }
      const minimum = this.policy.minRelayAmount(checked.token);
      if (checked.amount < minimum) {
        return problem("rejected", `the relayer does not relay payments below ${minimum.toString()} base units of ${checked.token.symbol}`, { rule: "BelowMinimumAmount", fallback: "self-submit" });
      }
      const payerKey = checked.payer.toLowerCase();
      const counters = this.state.counters;
      if (counters.relays >= this.limits.maxRelaysPerDay || (counters.perPayer[payerKey] ?? 0) >= this.limits.maxRelaysPerPayerPerDay) {
        const until = secondsToMidnight(this.now());
        return problem("refused", "the daily relay cap for this chain or this payer is reached", { reason: "daily-cap", retryAfter: until, fallback: "self-submit" });
      }
      return await this.admitAndSend(log, requester, checked, block.number, {
        kind: "pay",
        call: checked.call,
        bounds: gasBounds(this.chain, "payWithAuthorization"),
        dedupeId,
        subject: checked.key,
        onSent: () => {
          this.state = { ...this.state, counters: { ...this.state.counters, relays: this.state.counters.relays + 1, perPayer: { ...this.state.counters.perPayer, [payerKey]: (this.state.counters.perPayer[payerKey] ?? 0) + 1 } } };
        },
        explain: async (error) => await this.explainPayFailure(error, checked),
      });
    });
  }

  /** `POST /v1/{chainId}/cancel`: relays `cancelBySig`. */
  async cancel(input: RelayInput): Promise<EngineResult> {
    return await this.handle("cancel", input, async (log, requester) => {
      const deployment = this.deploymentProblem();
      if (deployment !== null) {
        return deployment;
      }
      let request;
      try {
        request = parseCancelAuthorizationJson(input.body);
      } catch (error) {
        return isPayLinkError(error) ? problem("invalid-request", error.message, { rule: error.code }) : rethrow(error);
      }
      const key = invoiceKey({ chainId: this.chain.chainId, verifyingContract: this.deploymentAddress() }, request.invoice);
      const dedupeId = `cancel:${key.toLowerCase()}`;
      const duplicate = this.duplicateOf(dedupeId, "cancel", key);
      if (duplicate !== null) {
        return duplicate;
      }
      const block = await this.options.client.getBlock({ blockTag: "latest" });
      let checked: CheckedRelayCall;
      try {
        checked = await checkRelayCancelRequest({ registry: this.options.registry, pathChainId: this.chain.chainId, request, client: this.options.client, now: block.timestamp });
      } catch (error) {
        return payLinkProblem(error);
      }
      if (this.state.counters.relays >= this.limits.maxRelaysPerDay) {
        return problem("refused", "the daily relay cap for this chain is reached", { reason: "daily-cap", retryAfter: secondsToMidnight(this.now()), fallback: "self-submit" });
      }
      return await this.admitAndSend(log, requester, checked, block.number, {
        kind: "cancel",
        call: checked.call,
        bounds: gasBounds(this.chain, "cancelBySig"),
        dedupeId,
        subject: checked.key,
        onSent: () => {
          this.state = { ...this.state, counters: { ...this.state.counters, relays: this.state.counters.relays + 1 } };
        },
        explain: async (error) => await this.explainCancelFailure(error, checked),
      });
    });
  }

  /** `POST /v1/{chainId}/onboard`: asks the chain's testnet faucet to fund an address (Monad testnet AUSD). */
  async onboard(input: RelayInput): Promise<EngineResult> {
    return await this.handle("onboard", input, async (log, requester) => {
      const faucet = faucetOf(this.chain);
      if (faucet === null || this.limits.maxOnboardsPerDay <= 0) {
        return problem("onboarding-unavailable", `chain ${String(this.chain.chainId)} has no faucet the relayer may call`);
      }
      const body = input.body as { readonly address?: unknown };
      if (typeof body.address !== "string" || !isAddress(body.address, { strict: true })) {
        return problem("invalid-request", "$.address: must be an address with a valid EIP-55 checksum", { rule: "Address" });
      }
      const recipient = getAddress(body.address);
      if (this.account !== null && isAddressEqual(recipient, this.account.address)) {
        return problem("invalid-request", "the relayer does not fund itself", { rule: "Address" });
      }
      const recipientKey = recipient.toLowerCase();
      const counters = this.state.counters;
      if (
        counters.onboards >= this.limits.maxOnboardsPerDay ||
        (counters.perAddress[recipientKey] ?? 0) >= this.limits.maxOnboardsPerAddressPerDay ||
        (counters.perRequester[requester] ?? 0) >= this.limits.maxOnboardsPerRequesterPerDay
      ) {
        return problem("refused", "the daily onboarding cap for this chain, this address or this requester is reached", { reason: "daily-cap", retryAfter: secondsToMidnight(this.now()), fallback: "none" });
      }
      const call = faucetCall(faucet.address, recipient);
      const block = await this.options.client.getBlock({ blockTag: "latest" });
      try {
        await this.options.client.call({ account: this.requireAccount().address, to: call.to, data: call.data, value: 0n, blockNumber: block.number });
      } catch (error) {
        return this.faucetProblem(error);
      }
      const sent = await this.queue.run(async () => await this.send({ kind: "onboard", call, bounds: faucet.gas, window: null, ticket: null, dedupeId: null, subject: recipient, log }, block.number, (error) => Promise.resolve(this.faucetProblem(error))));
      if (!sent.ok) {
        return sent.problem;
      }
      const after = this.state.counters;
      this.state = {
        ...this.state,
        counters: {
          ...after,
          onboards: after.onboards + 1,
          perAddress: { ...after.perAddress, [recipientKey]: (after.perAddress[recipientKey] ?? 0) + 1 },
          perRequester: { ...after.perRequester, [requester]: (after.perRequester[requester] ?? 0) + 1 },
        },
      };
      await this.save();
      return { ok: true, httpStatus: 202, body: sent.body };
    });
  }

  /** The chain's health, cached for 10 s so that health checks cannot amplify into RPC load. */
  async status(): Promise<ChainStatus> {
    const now = this.clock();
    if (this.statusCache !== null && now - this.statusCache.at < 10_000) {
      return this.statusCache.value;
    }
    const value = await this.readStatus();
    this.statusCache = { at: now, value };
    return value;
  }

  /**
   * The tracker: follows every pending nonce to its receipt, replaces or voids stuck ones, releases admission
   * tickets with their outcome, and prunes expired counters. Returns the delay before the next pass, or `null`
   * when nothing is pending. Hosts call it from an alarm or a timer; it never throws on RPC failures.
   */
  async tick(): Promise<number | null> {
    return await this.queue.run(async () => {
      try {
        if (this.state.pending.length > 0) {
          const latestNonce = this.account === null ? null : await this.options.client.getTransactionCount({ address: this.account.address, blockTag: "latest" });
          for (const record of [...this.state.pending].sort((a, b) => a.nonce - b.nonce)) {
            await this.track(record, latestNonce);
          }
        }
      } catch (error) {
        this.logger.log("warn", "tracker.error", { error: errorMessage(error) });
      }
      await this.save();
      const next = this.state.pending.length > 0 ? this.policy.trackIntervalMs : null;
      if (next !== null) {
        await this.wakeAt(this.clock() + next);
      }
      return next;
    });
  }

  // ------------------------------------------------------------------------------------------------ pipeline

  private async handle(op: TxKind, input: RelayInput, body: (log: Logger, requester: RequesterId) => Promise<EngineResult | Problem>): Promise<EngineResult> {
    const requester = input.requester as RequesterId;
    const log = this.logger.child({ requestId: input.requestId, op, requesterTag: requesterTag(requester) });
    const started = this.clock();
    let result: EngineResult;
    try {
      if (this.account === null) {
        result = { ok: false, problem: problem("relayer-unavailable", "the relayer has no valid key configured (RELAYER_PK)", { fallback: "self-submit" }) };
      } else {
        const wait = this.limiter.take(requester, started);
        if (wait !== null) {
          result = { ok: false, problem: problem("rate-limited", "too many requests from this network or for this chain", { retryAfter: wait, fallback: "retry" }) };
        } else {
          const outcome = await body(log, requester);
          result = "code" in outcome ? { ok: false, problem: outcome } : outcome;
        }
      }
    } catch (error) {
      log.log("error", "request.error", { error: errorMessage(error) });
      result = { ok: false, problem: isTransportFailure(error) ? problem("upstream-error", "the chain's RPC endpoints did not answer", { retryAfter: 5, fallback: "self-submit" }) : problem("internal", "unexpected error", { fallback: "self-submit" }) };
    }
    log.log(result.ok ? "info" : result.problem.status >= 500 ? "warn" : "info", "request.done", {
      ms: this.clock() - started,
      outcome: result.ok ? result.body.status : result.problem.code,
      ...(result.ok ? { txHash: result.body.txHash, subject: result.body.subject } : { rule: result.problem.rule, reason: result.problem.reason }),
    });
    return result;
  }

  private deploymentProblem(): Problem | null {
    const deployment = this.chain.deployment;
    if (deployment === null) {
      return problem("chain-not-ready", `PayLink has no canonical deployment on chain ${String(this.chain.chainId)} yet`, { fallback: "none" });
    }
    if (deployment.status === "revoked") {
      return problem("chain-not-ready", "the canonical deployment on this chain is revoked", { fallback: "none" });
    }
    return null;
  }

  /** The canonical deployment's address (callers checked `deploymentProblem` first). */
  private deploymentAddress(): Address {
    const deployment = this.chain.deployment;
    if (deployment === null) {
      throw new Error("no deployment");
    }
    return deployment.address;
  }

  private requireAccount(): PrivateKeyAccount {
    if (this.account === null) {
      throw new Error("no relayer key");
    }
    return this.account;
  }

  private now(): bigint {
    return seconds(this.clock());
  }

  /** An identical request in flight or recently settled: answered idempotently, nothing is sent (spec §8.6). */
  private duplicateOf(dedupeId: string, kind: TxKind, subject: Hex): EngineResult | null {
    const pending = this.state.pending.find((record) => record.dedupeId === dedupeId);
    const latest = pending?.attempts.at(-1);
    if (pending !== undefined && latest !== undefined) {
      return { ok: true, httpStatus: 200, body: { status: "pending", kind, chainId: this.chain.chainId, txHash: latest.hash, duplicate: true, subject } };
    }
    const recent = this.state.recent.find((relay) => relay.id === dedupeId);
    if (recent !== undefined) {
      return { ok: true, httpStatus: 200, body: { status: "settled", kind, chainId: this.chain.chainId, txHash: recent.txHash, duplicate: true, subject } };
    }
    return null;
  }

  private async admitAndSend(
    log: Logger,
    requester: RequesterId,
    checked: CheckedPayRequest | CheckedRelayCall,
    checkedAt: bigint,
    plan: Omit<Pipeline, "window" | "ticket" | "log"> & { readonly onSent: () => void; readonly explain: (error: unknown) => Promise<Problem> },
  ): Promise<EngineResult | Problem> {
    const admission: Admission = this.ledger.admit(checked, requester, this.now());
    if (!admission.admitted) {
      return this.refusal(admission.reason, admission.retryAfter);
    }
    const { ticket } = admission;
    try {
      await this.save();
      const account = this.requireAccount();
      try {
        await this.options.client.call({ account: account.address, to: plan.call.to, data: plan.call.data, value: 0n, blockNumber: checkedAt });
      } catch (error) {
        await this.releaseDropped(ticket, log, "simulation");
        return await plan.explain(error);
      }
      const pipeline: Pipeline = { ...plan, window: checked, ticket, log };
      const sent = await this.queue.run(async () => await this.send(pipeline, checkedAt, plan.explain));
      if (!sent.ok) {
        return sent.problem;
      }
      plan.onSent();
      await this.save();
      return { ok: true, httpStatus: 202, body: sent.body };
    } catch (error) {
      // Unexpected failure before a transaction was recorded: give the ticket back (no gas was spent).
      if (!this.state.pending.some((record) => record.ticketId === ticket.id)) {
        await this.releaseDropped(ticket, log, "error").catch(() => undefined);
      }
      throw error;
    }
  }

  private refusal(reason: string, retryAfter: bigint | null): Problem {
    const inFlight = reason.startsWith("in-flight-");
    const policy = reason === "payee-code-not-allowlisted" || reason === "payer-has-code" || reason === "insufficient-validity";
    const base = { reason, fallback: "self-submit" as const, ...(retryAfter === null ? {} : { retryAfter: secondsUntil(retryAfter, this.now()) }) };
    if (inFlight) {
      return { ...problem("refused", "a relay for this invoice, payee, payer or token is already in flight; resubmit the same authorisation later or yourself", base), status: 409 };
    }
    if (policy) {
      return { ...problem("refused", "the relayer does not relay for this account or time window; submit the transaction yourself", base), status: 422 };
    }
    return problem("refused", "the relayer will not relay for this invoice, account or network now", base);
  }

  /** Why a pay simulation failed, with a clean answer for replays and closed invoices whatever the token's error format. */
  private async explainPayFailure(error: unknown, checked: CheckedPayRequest): Promise<Problem> {
    if (!isRevert(error)) {
      return isTransportFailure(error) ? problem("upstream-error", "the chain's RPC endpoints did not answer", { retryAfter: 5, fallback: "self-submit" }) : this.simulationProblem(error);
    }
    const reader = { call: async ({ to, data }: { to: Address; data: Hex }) => await this.options.client.call({ to, data }) };
    if (await readAuthorizationState({ client: reader, token: checked.token.address, payer: checked.payer, nonce: checked.nonce }).catch(() => false)) {
      const recent = this.state.recent.find((relay) => relay.id === `pay:${checked.nonce.toLowerCase()}`);
      return problem("already-settled", "this authorisation has already been used on the token", { fallback: "none", ...(recent === undefined ? {} : { txHash: recent.txHash }) });
    }
    const decoded = decodeError(error);
    if (decoded.source === "contract" && ["Cancelled", "SoldOut", "Expired", "NotYetValid"].includes(decoded.name)) {
      return problem("invoice-closed", `the invoice does not accept this payment (${decoded.name})`, { error: { name: decoded.name, source: decoded.source, i18nKey: decoded.i18nKey }, fallback: "none" });
    }
    return this.simulationProblem(error);
  }

  private async explainCancelFailure(error: unknown, checked: CheckedRelayCall): Promise<Problem> {
    if (!isRevert(error)) {
      return isTransportFailure(error) ? problem("upstream-error", "the chain's RPC endpoints did not answer", { retryAfter: 5, fallback: "self-submit" }) : this.simulationProblem(error);
    }
    const reader = { call: async ({ to, data }: { to: Address; data: Hex }) => await this.options.client.call({ to, data }) };
    const state = await readLinkState(reader, checked.target.deployment.address, checked.key).catch(() => null);
    if (state?.cancelled === true) {
      return problem("already-cancelled", "this invoice is already cancelled", { fallback: "none" });
    }
    return this.simulationProblem(error);
  }

  private simulationProblem(error: unknown): Problem {
    const decoded = decodeError(error);
    return problem("simulation-failed", `the transaction would revert (${decoded.name})`, { error: { name: decoded.name, source: decoded.source, i18nKey: decoded.i18nKey }, fallback: "none" });
  }

  private faucetProblem(error: unknown): Problem {
    if (isTransportFailure(error)) {
      return problem("upstream-error", "the chain's RPC endpoints did not answer", { retryAfter: 5, fallback: "retry" });
    }
    const decoded = decodeError(error);
    // The AUSD faucet's cooldown is global and 60 s long (packages/chains, measured on a fork): retry after it.
    return problem("faucet-unavailable", `the faucet refused (${decoded.selector ?? decoded.name}); it pays out at most once a minute for everyone`, { retryAfter: 60, fallback: "retry" });
  }

  /**
   * The send section, run one at a time: re-checks against the pending block, sizes gas and fees, reserves the
   * budget, signs and broadcasts. Any refusal releases the admission ticket as `dropped` (no gas spent).
   */
  private async send(pipeline: Pipeline, checkedAt: bigint, explain: (error: unknown) => Promise<Problem>): Promise<SendOutcome> {
    const { client } = this.options;
    const account = this.requireAccount();
    const { log } = pipeline;
    const fail = async (failure: Problem, stage: string): Promise<SendOutcome> => {
      if (pipeline.ticket !== null) {
        await this.releaseDropped(pipeline.ticket, log, stage);
      }
      return { ok: false, problem: failure };
    };
    try {
      await this.assertAccountUsable(account.address);
    } catch (error) {
      return await fail(problem("relayer-unavailable", errorMessage(error), { fallback: "self-submit" }), "account");
    }
    const pending = await client.getBlock({ blockTag: "pending" });
    if (pipeline.window !== null) {
      try {
        assertRelayWindow(pipeline.window, pending.timestamp);
      } catch (error) {
        return await fail(payLinkProblem(error), "margin");
      }
    }
    const simulate = async (blockTag: "pending" | "latest"): Promise<bigint> => {
      const request = { account: account.address, to: pipeline.call.to, data: pipeline.call.data, value: 0n, blockTag } as const;
      await client.call(request);
      return await client.estimateGas(request);
    };
    let estimate: bigint;
    try {
      estimate = await simulate("pending");
    } catch (error) {
      if (isRevert(error) || isTransportFailure(error)) {
        return await fail(await explain(error), "pending-simulation");
      }
      // A node that cannot serve the pending block (anvil with a busy mempool answers "Required data unavailable"):
      // simulate on the latest block instead. Monad, Base and Arbitrum Sepolia serve `pending` (checked 2026-10-07).
      try {
        estimate = await simulate("latest");
      } catch (latestError) {
        return await fail(await explain(latestError), "simulation");
      }
    }
    let gas: bigint;
    try {
      gas = clampGasLimit(estimate, pipeline.bounds);
    } catch (error) {
      if (isPayLinkError(error, "E_GAS_ABOVE_CEILING")) {
        return await fail(problem("gas-above-ceiling", error.message, { rule: error.code, fallback: "self-submit" }), "gas");
      }
      throw error;
    }
    const fees = await this.fees(pending.baseFeePerGas);
    if (fees === null) {
      return await fail(problem("fees-too-high", "network fees are above the relayer's cap", { retryAfter: 60, fallback: "self-submit" }), "fees");
    }
    const reservation = gas * fees.maxFeePerGas;
    const budget = this.state.budget;
    if (BigInt(budget.spentWei) + BigInt(budget.reservedWei) + reservation > this.limits.dailyGasBudgetWei) {
      return await fail(problem("budget-exhausted", "the relayer's gas budget for today is spent", { retryAfter: secondsToMidnight(this.now()), fallback: "self-submit" }), "budget");
    }
    // The balance must cover this transaction on top of everything still pending (each at its reserved worst case).
    const balance = await client.getBalance({ address: account.address, blockTag: "pending" });
    const outstanding = BigInt(this.state.budget.reservedWei);
    if (balance < reservation + outstanding) {
      log.log("warn", "relayer.unfunded", { balanceWei: balance.toString(), neededWei: (reservation + outstanding).toString() });
      return await fail(problem("relayer-unavailable", "the relayer's balance cannot pay for this transaction", { fallback: "self-submit" }), "balance");
    }
    for (let attempt = 0; ; attempt += 1) {
      const nonce = await this.allocateNonce(account.address);
      const tx = { to: pipeline.call.to, data: pipeline.call.data, value: 0n };
      assertSendable(this.chain, account.address, tx);
      const raw = await account.signTransaction({ ...tx, chainId: this.chain.chainId, type: "eip1559", gas, nonce, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      const hash = keccak256(raw);
      const sentAt = Number(this.now());
      const record: PendingTx = {
        kind: pipeline.kind,
        nonce,
        from: account.address,
        to: tx.to,
        data: tx.data,
        ticketId: pipeline.ticket?.id ?? null,
        dedupeId: pipeline.dedupeId,
        validThrough: pipeline.window === null ? null : pipeline.window.validThrough.toString(),
        // The checked block: the pending-block simulation ran later, so attribution searching from here misses nothing.
        simulatedAt: checkedAt.toString(),
        reservedWei: reservation.toString(),
        attempts: [{ hash, raw, gas: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), sentAt, void: false }],
        missingPasses: 0,
        evidenceFailures: 0,
      };
      // Persist before broadcasting: a crash after the broadcast must not lose track of the nonce or the ticket.
      this.state = {
        ...this.state,
        nextNonce: nonce + 1,
        pending: [...this.state.pending, record],
        budget: { ...this.state.budget, reservedWei: (BigInt(this.state.budget.reservedWei) + reservation).toString() },
      };
      try {
        await this.save();
      } catch (error) {
        this.state = {
          ...this.state,
          pending: this.state.pending.filter((p) => p !== record),
          budget: { ...this.state.budget, reservedWei: (BigInt(this.state.budget.reservedWei) - reservation).toString() },
        };
        throw error;
      }
      const broadcast = await this.broadcast(raw);
      if (broadcast === "sent" || broadcast === "unknown") {
        log.log("info", "tx.sent", { kind: pipeline.kind, txHash: hash, nonce, gas: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), estimate: estimate.toString(), ticket: pipeline.ticket?.id ?? null });
        await this.wakeAt(this.clock() + this.policy.trackIntervalMs);
        return {
          ok: true,
          body: { status: "submitted", kind: pipeline.kind, chainId: this.chain.chainId, txHash: hash, duplicate: false, subject: pipeline.subject, nonce, gasLimit: gas.toString() },
        };
      }
      // Refused by the node: forget the record and the reservation.
      this.state = {
        ...this.state,
        nextNonce: broadcast === "nonce-too-low" ? null : this.state.nextNonce,
        pending: this.state.pending.filter((p) => p !== record),
        budget: { ...this.state.budget, reservedWei: (BigInt(this.state.budget.reservedWei) - reservation).toString() },
      };
      await this.save();
      if (broadcast === "nonce-too-low" && attempt === 0) {
        log.log("warn", "tx.nonce-resync", { nonce });
        continue;
      }
      const failure =
        broadcast === "insufficient-funds"
          ? problem("relayer-unavailable", "the relayer's balance cannot pay for this transaction", { fallback: "self-submit" })
          : problem("upstream-error", `the node refused the transaction (${broadcast})`, { retryAfter: 5, fallback: "self-submit" });
      return await fail(failure, "broadcast");
    }
  }

  /** `eth_sendRawTransaction`, classified. `unknown`: the transport failed, so the transaction may have propagated. */
  private async broadcast(raw: Hex): Promise<"sent" | "unknown" | "nonce-too-low" | "insufficient-funds" | "rejected"> {
    try {
      await this.options.client.sendRawTransaction({ serializedTransaction: raw });
      return "sent";
    } catch (error) {
      if (isTransportFailure(error)) {
        return "unknown";
      }
      const text = errorMessage(error).toLowerCase();
      if (text.includes("already known") || text.includes("known transaction")) {
        return "sent";
      }
      if (text.includes("nonce too low") || text.includes("nonce is too low") || text.includes("invalid nonce")) {
        return "nonce-too-low";
      }
      if (text.includes("insufficient funds")) {
        return "insufficient-funds";
      }
      this.logger.log("warn", "tx.rejected", { error: errorMessage(error) });
      return "rejected";
    }
  }

  /** The next nonce: never below the chain's pending count, never one of a transaction still tracked. */
  private async allocateNonce(address: Address): Promise<number> {
    const chainPending = await this.options.client.getTransactionCount({ address, blockTag: "pending" });
    const tracked = this.state.pending.filter((p) => isAddressEqual(p.from, address)).reduce((max, p) => Math.max(max, p.nonce + 1), 0);
    return Math.max(this.state.nextNonce ?? 0, chainPending, tracked);
  }

  /** EIP-1559 fees: tip from the node, `maxFeePerGas = 2 × baseFee + tip`, capped; `null` when the cap cannot cover base + tip. */
  private async fees(baseFee: bigint | null | undefined): Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint } | null> {
    const base = baseFee ?? (await this.options.client.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n;
    const tip = await this.options.client.estimateMaxPriorityFeePerGas();
    const cap = this.limits.maxFeePerGasWei;
    if (base + tip > cap) {
      return null;
    }
    const wanted = base * 2n + tip;
    return { maxFeePerGas: wanted > cap ? cap : wanted, maxPriorityFeePerGas: tip };
  }

  /** The relayer's own account must have no code: it is never EIP-7702-delegated (spec §3.7). Checked every 10 minutes. */
  private async assertAccountUsable(address: Address): Promise<void> {
    if (this.clock() - this.accountCodeCheckedAt < 600_000) {
      return;
    }
    const code = await this.options.client.getCode({ address });
    if (code !== undefined && code !== "0x") {
      throw new Error("the relayer account has code (an EIP-7702 delegation?): refusing to sign");
    }
    this.accountCodeCheckedAt = this.clock();
  }

  private async releaseDropped(ticket: RelayTicket, log: Logger, stage: string): Promise<void> {
    if (this.ledger.inFlight().some((held) => held.id === ticket.id)) {
      this.ledger.release(ticket, "dropped", this.now());
      log.log("info", "ticket.dropped", { ticket: ticket.id, stage });
      await this.save();
    }
  }

  // ------------------------------------------------------------------------------------------------ tracker

  private async track(record: PendingTx, latestNonce: number | null): Promise<void> {
    const { client } = this.options;
    for (const attempt of [...record.attempts].reverse()) {
      const receipt = await client.getTransactionReceipt({ hash: attempt.hash }).catch((error: unknown) => {
        if (error instanceof BaseError && error.name === "TransactionReceiptNotFoundError") {
          return null;
        }
        throw error;
      });
      if (receipt !== null) {
        await this.finalize(record, attempt, receipt);
        return;
      }
    }
    if (latestNonce !== null && latestNonce > record.nonce && isAddressEqual(record.from, this.requireAccount().address)) {
      // The nonce is used but none of our transactions has a receipt (yet): wait a few passes, then call it dropped.
      if (record.missingPasses + 1 >= 5) {
        await this.finalize(record, null, null);
      } else {
        this.replacePending(record, { ...record, missingPasses: record.missingPasses + 1 });
      }
      return;
    }
    const latest = record.attempts.at(-1);
    if (latest === undefined || this.account === null || !isAddressEqual(record.from, this.account.address)) {
      return;
    }
    if (Number(this.now()) - latest.sentAt >= this.policy.replaceAfterSeconds) {
      await this.replace(record, latest);
    }
  }

  /** Re-sends a stuck nonce with fees × (1 + bump): the same call while it can still succeed, else a void. */
  private async replace(record: PendingTx, latest: Attempt): Promise<void> {
    const { client } = this.options;
    const account = this.requireAccount();
    const pending = await client.getBlock({ blockTag: "pending" });
    const expired = record.validThrough !== null && pending.timestamp > BigInt(record.validThrough);
    const voiding = latest.void || expired || record.attempts.length > this.policy.maxReplacements;
    const bump = (value: bigint): bigint => (value * BigInt(100 + this.policy.feeBumpPercent) + 99n) / 100n;
    const tip = bump(BigInt(latest.maxPriorityFeePerGas));
    const base = pending.baseFeePerGas ?? 0n;
    const maxFee = [bump(BigInt(latest.maxFeePerGas)), base * 2n + tip].reduce((a, b) => (a > b ? a : b));
    if (maxFee > this.limits.maxFeePerGasWei) {
      this.logger.log("warn", "tx.stuck", { nonce: record.nonce, detail: "a replacement would exceed the fee cap" });
      return;
    }
    const tx = voiding ? { to: account.address, data: "0x" as Hex, value: 0n } : { to: record.to, data: record.data, value: 0n };
    // A void is a plain transfer; estimate it on the latest block (some nodes cannot estimate on a pending block
    // that holds the account's own stuck transaction).
    const gas = voiding ? await client.estimateGas({ account: account.address, to: account.address, value: 0n, blockTag: "latest" }) : BigInt(latest.gas);
    assertSendable(this.chain, account.address, tx);
    const raw = await account.signTransaction({ ...tx, chainId: this.chain.chainId, type: "eip1559", gas, nonce: record.nonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
    const attempt: Attempt = { hash: keccak256(raw), raw, gas: gas.toString(), maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: tip.toString(), sentAt: Number(this.now()), void: voiding };
    const reservation = gas * maxFee;
    const delta = reservation - BigInt(record.reservedWei);
    this.replacePending(record, { ...record, attempts: [...record.attempts, attempt], reservedWei: (delta > 0n ? reservation : BigInt(record.reservedWei)).toString() });
    if (delta > 0n) {
      this.state = { ...this.state, budget: { ...this.state.budget, reservedWei: (BigInt(this.state.budget.reservedWei) + delta).toString() } };
    }
    await this.save();
    const outcome = await this.broadcast(raw);
    this.logger.log(outcome === "sent" || outcome === "unknown" ? "info" : "warn", voiding ? "tx.voided" : "tx.replaced", { nonce: record.nonce, txHash: attempt.hash, maxFeePerGas: maxFee.toString(), outcome });
  }

  /** Settles a pending nonce: budget, admission ticket (with the revert's attributed cause), recent relays. */
  private async finalize(record: PendingTx, attempt: Attempt | null, receipt: TransactionReceipt | null): Promise<void> {
    const now = this.now();
    let outcome: RelayOutcome;
    if (attempt === null || receipt === null || attempt.void) {
      outcome = "dropped";
    } else if (receipt.status === "success") {
      outcome = "settled";
    } else {
      const attribution = await this.attribute(record, attempt, receipt);
      if (attribution === null) {
        return; // evidence unavailable for now: keep the ticket in flight, retry on the next pass
      }
      outcome = attribution;
    }
    const cost =
      receipt === null || attempt === null
        ? 0n
        : (this.chain.gasModel.chargesGasLimit && BigInt(attempt.gas) > receipt.gasUsed ? BigInt(attempt.gas) : receipt.gasUsed) * receipt.effectiveGasPrice;
    const reserved = BigInt(this.state.budget.reservedWei) - BigInt(record.reservedWei);
    this.state = {
      ...this.state,
      pending: this.state.pending.filter((p) => p.nonce !== record.nonce || !isAddressEqual(p.from, record.from)),
      budget: { ...this.state.budget, spentWei: (BigInt(this.state.budget.spentWei) + cost).toString(), reservedWei: (reserved > 0n ? reserved : 0n).toString() },
      recent:
        outcome === "settled" && record.dedupeId !== null && receipt !== null
          ? [...this.state.recent, { id: record.dedupeId, txHash: receipt.transactionHash, at: Number(now) }].slice(-MAX_RECENT)
          : this.state.recent,
    };
    const ticket = record.ticketId === null ? undefined : this.ledger.inFlight().find((held) => held.id === record.ticketId);
    const release = ticket === undefined ? null : this.ledger.release(ticket, outcome, now);
    this.logger.log(outcome === "settled" || outcome === "dropped" ? "info" : "warn", "tx.final", {
      kind: record.kind,
      nonce: record.nonce,
      txHash: receipt?.transactionHash ?? null,
      outcome: typeof outcome === "string" ? outcome : outcome.cause,
      detail: typeof outcome === "string" ? undefined : outcome.detail,
      costWei: cost.toString(),
      banned: release === null ? undefined : release.banned.map(String),
      struck: release?.struck,
    });
  }

  /** The cause of a post-simulation revert from chain evidence, or `null` to retry later. */
  private async attribute(record: PendingTx, attempt: Attempt, receipt: TransactionReceipt): Promise<RevertAttribution | null> {
    const ticket = record.ticketId === null ? undefined : this.ledger.inFlight().find((held) => held.id === record.ticketId);
    if (ticket === undefined) {
      return { cause: "unattributed", detail: "no-ticket" };
    }
    const { client } = this.options;
    try {
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      const revertData = await replayRevertData({
        client,
        from: record.from,
        call: { to: record.to, data: record.data, value: 0n },
        gas: BigInt(attempt.gas),
        blockNumber: receipt.blockNumber,
      });
      return await attributeRelayRevert({
        client,
        registry: this.options.registry,
        ticket,
        inclusion: { blockNumber: receipt.blockNumber, timestamp: block.timestamp },
        simulatedAt: BigInt(record.simulatedAt) > receipt.blockNumber ? receipt.blockNumber : BigInt(record.simulatedAt),
        revertData,
      });
    } catch (error) {
      const failures = record.evidenceFailures + 1;
      this.logger.log("warn", "tx.evidence-error", { nonce: record.nonce, failures, error: errorMessage(error) });
      if (failures < this.policy.maxEvidenceAttempts) {
        this.replacePending(record, { ...record, evidenceFailures: failures });
        return null;
      }
      return { cause: "unattributed", detail: "evidence-unavailable" };
    }
  }

  private replacePending(previous: PendingTx, next: PendingTx): void {
    this.state = { ...this.state, pending: this.state.pending.map((p) => (p === previous ? next : p)) };
  }

  // ------------------------------------------------------------------------------------------------ status, storage

  private async readStatus(): Promise<ChainStatus> {
    const chain = this.chain;
    const deployment = chain.deployment?.status === "revoked" ? null : (chain.deployment?.address ?? null);
    const faucet = faucetOf(chain) !== null && this.limits.maxOnboardsPerDay > 0;
    const budget = this.state.budget;
    const base: Omit<ChainStatus, "state" | "balanceWei" | "minBalanceWei" | "blockNumber"> = {
      chainId: chain.chainId,
      name: chain.name,
      label: chain.label,
      relayer: this.account?.address ?? null,
      deployment,
      operations: { pay: deployment !== null && this.account !== null, cancel: deployment !== null && this.account !== null, onboard: faucet && this.account !== null },
      pending: this.state.pending.length,
      inFlight: this.ledger.inFlight().length,
      relayMarginSeconds: chain.relay?.minRemainingSeconds ?? null,
      budget: { day: budget.day, limitWei: this.limits.dailyGasBudgetWei.toString(), spentWei: budget.spentWei, reservedWei: budget.reservedWei },
    };
    if (this.account === null) {
      return { ...base, state: "not-configured", balanceWei: null, minBalanceWei: null, blockNumber: null };
    }
    try {
      const [block, balance] = await Promise.all([this.options.client.getBlock({ blockTag: "latest" }), this.options.client.getBalance({ address: this.account.address })]);
      const min = gasBounds(chain, "payWithAuthorization").ceiling * (block.baseFeePerGas ?? 0n) * 2n;
      const state: ChainState = balance < min ? "unfunded" : deployment === null ? "awaiting-deployment" : "ready";
      return { ...base, state, balanceWei: balance.toString(), minBalanceWei: min.toString(), blockNumber: block.number.toString() };
    } catch (error) {
      this.logger.log("warn", "status.rpc-error", { error: errorMessage(error) });
      return { ...base, state: "rpc-error", balanceWei: null, minBalanceWei: null, blockNumber: null };
    }
  }

  private async save(): Promise<void> {
    const now = this.now();
    this.state = prune({ ...this.state, ledger: this.ledger.snapshot() }, now, this.policy.admission);
    this.ledger = new RelayAdmissionLedger(this.policy.admission, this.state.ledger);
    this.statusCache = null;
    await this.options.store.save(this.state);
  }

  private async wakeAt(atMs: number): Promise<void> {
    await this.options.wake?.(atMs);
  }
}

function rethrow(error: unknown): never {
  throw error;
}
