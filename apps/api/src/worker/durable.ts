// SPDX-License-Identifier: MIT
/**
 * The two Durable Objects of the API (docs/paypal/SPEC.md §6.1, §11), SQLite-backed (the only kind the Workers Free plan
 * offers, Cloudflare Durable Objects pricing page; deploy/wrangler.toml migrates them with `new_sqlite_classes`): `Payee`,
 * one per payee address (twins, proposals, auto-records, alerts, audit, quotas, locks), and `Global`, one for the
 * deployment (PayPal token, AI budget, quotas, webhook ids, session nonces, the twin index, the cron's schedule, health
 * facts). Both are caches, never sources of truth (§11 "Rebuild").
 *
 * Each RPC method runs the shared store logic (src/store/kv.ts, the same code the Node entry and the tests run) on
 * `ctx.storage.kv`, the synchronous key-value API of SQLite-backed objects, inside `ctx.storage.transactionSync`: one
 * call is one transaction, with no I/O inside it, so compare-and-set methods are atomic (`SyncKvStorage` and
 * `transactionSync` as typed by @cloudflare/workers-types 5.20261006.1). test/store/workerd.test.ts runs a scripted
 * session of every method through these objects in workerd (`wrangler dev --local`, wrangler 4.148.0) and requires the
 * answers of the in-memory stores, call for call; on Cloudflare itself they are UNVERIFIED until the first deployment.
 *
 * Owner: reconciler workstream.
 */
import { DurableObject } from "cloudflare:workers";
import type { Address, InvoiceKey, ProposalState } from "@paylink/api-contract";
import type { AccessToken } from "../paypal/client.ts";
import { GlobalStoreCore, PayeeStoreCore } from "../store/kv.ts";
import type {
  AlertRecord,
  AuditEntry,
  AutoRecord,
  EpochMs,
  GlobalQuotaKind,
  GlobalStore,
  HealthFact,
  PayeeQuotaKind,
  PayeeStore,
  ProposalRecord,
  ScheduledCheck,
  StoreFactory,
  SubjectQuotaKind,
  TwinIndexEntry,
  TwinRecord,
  UtcDay,
} from "../store/types.ts";
import type { Env } from "./env.ts";

export class Payee extends DurableObject<Env> {
  #core: PayeeStoreCore | null = null;

  #tx<R>(call: (core: PayeeStoreCore) => R): R {
    this.#core ??= new PayeeStoreCore(this.ctx.storage.kv);
    const core = this.#core;
    return this.ctx.storage.transactionSync(() => call(core));
  }

  getTwin(key: InvoiceKey): TwinRecord | null {
    return this.#tx((c) => c.getTwin(key));
  }
  putTwin(twin: TwinRecord): void {
    this.#tx((c) => {
      c.putTwin(twin);
    });
  }
  listTwins(options?: { readonly open?: boolean; readonly limit?: number }): readonly TwinRecord[] {
    return this.#tx((c) => c.listTwins(options));
  }
  getProposal(id: string): ProposalRecord | null {
    return this.#tx((c) => c.getProposal(id));
  }
  putProposal(proposal: ProposalRecord): void {
    this.#tx((c) => {
      c.putProposal(proposal);
    });
  }
  listProposals(options?: { readonly states?: readonly ProposalState[]; readonly key?: InvoiceKey }): readonly ProposalRecord[] {
    return this.#tx((c) => c.listProposals(options));
  }
  transitionProposal(id: string, from: ProposalState, to: ProposalState, now?: EpochMs): boolean {
    return this.#tx((c) => c.transitionProposal(id, from, to, now));
  }
  putAutoRecord(record: AutoRecord): void {
    this.#tx((c) => {
      c.putAutoRecord(record);
    });
  }
  getAutoRecord(paymentId: string): AutoRecord | null {
    return this.#tx((c) => c.getAutoRecord(paymentId));
  }
  listAutoRecords(options?: { readonly key?: InvoiceKey }): readonly AutoRecord[] {
    return this.#tx((c) => c.listAutoRecords(options));
  }
  putAlert(alert: AlertRecord): void {
    this.#tx((c) => {
      c.putAlert(alert);
    });
  }
  clearAlert(key: InvoiceKey): void {
    this.#tx((c) => {
      c.clearAlert(key);
    });
  }
  listAlerts(): readonly AlertRecord[] {
    return this.#tx((c) => c.listAlerts());
  }
  audit(entry: Omit<AuditEntry, "seq">): AuditEntry {
    return this.#tx((c) => c.audit(entry));
  }
  listAudit(limit: number): readonly AuditEntry[] {
    return this.#tx((c) => c.listAudit(limit));
  }
  useQuota(day: UtcDay, kind: PayeeQuotaKind, limit: number): { allowed: boolean; used: number; limit: number } {
    return this.#tx((c) => c.useQuota(day, kind, limit));
  }
  lock(key: InvoiceKey, holder: string, now: EpochMs, ttlMs: number): boolean {
    return this.#tx((c) => c.lock(key, holder, now, ttlMs));
  }
  unlock(key: InvoiceKey, holder: string): void {
    this.#tx((c) => {
      c.unlock(key, holder);
    });
  }
  purge(now: EpochMs): { removed: number } {
    return this.#tx((c) => c.purge(now));
  }
}

export class Global extends DurableObject<Env> {
  #core: GlobalStoreCore | null = null;

  #tx<R>(call: (core: GlobalStoreCore) => R): R {
    this.#core ??= new GlobalStoreCore(this.ctx.storage.kv);
    const core = this.#core;
    return this.ctx.storage.transactionSync(() => call(core));
  }

  getToken(now: EpochMs): AccessToken | null {
    return this.#tx((c) => c.getToken(now));
  }
  putToken(token: AccessToken): void {
    this.#tx((c) => {
      c.putToken(token);
    });
  }
  spendAiBudget(day: UtcDay, neurons: number, ceiling: number): { allowed: boolean; used: number; limit: number } {
    return this.#tx((c) => c.spendAiBudget(day, neurons, ceiling));
  }
  useQuota(day: UtcDay, kind: GlobalQuotaKind, limit: number): { allowed: boolean; used: number; limit: number } {
    return this.#tx((c) => c.useQuota(day, kind, limit));
  }
  useSubjectQuota(day: UtcDay, kind: SubjectQuotaKind, subject: string, amount: number, limit: number): { allowed: boolean; used: number; limit: number } {
    return this.#tx((c) => c.useSubjectQuota(day, kind, subject, amount, limit));
  }
  markWebhookEvent(eventId: string, now: EpochMs): "new" | "seen" {
    return this.#tx((c) => c.markWebhookEvent(eventId, now));
  }
  markNonce(scope: "session", nonce: string, expiresAt: EpochMs, now: EpochMs): "new" | "seen" {
    return this.#tx((c) => c.markNonce(scope, nonce, expiresAt, now));
  }
  indexTwin(entry: TwinIndexEntry, now: EpochMs): void {
    this.#tx((c) => {
      c.indexTwin(entry, now);
    });
  }
  findTwinByPayPalId(paypalId: string): TwinIndexEntry | null {
    return this.#tx((c) => c.findTwinByPayPalId(paypalId));
  }
  findTwinByKey(key: InvoiceKey): TwinIndexEntry | null {
    return this.#tx((c) => c.findTwinByKey(key));
  }
  scheduleCheck(check: ScheduledCheck): void {
    this.#tx((c) => {
      c.scheduleCheck(check);
    });
  }
  unscheduleCheck(payee: Address, key: InvoiceKey): void {
    this.#tx((c) => {
      c.unscheduleCheck(payee, key);
    });
  }
  dueChecks(now: EpochMs, limit: number): readonly ScheduledCheck[] {
    return this.#tx((c) => c.dueChecks(now, limit));
  }
  notePayee(payee: Address, now: EpochMs): void {
    this.#tx((c) => {
      c.notePayee(payee, now);
    });
  }
  payeesToPurge(now: EpochMs, limit: number): readonly Address[] {
    return this.#tx((c) => c.payeesToPurge(now, limit));
  }
  markPayeePurged(payee: Address, now: EpochMs): void {
    this.#tx((c) => {
      c.markPayeePurged(payee, now);
    });
  }
  noteHealth(fact: HealthFact, at: EpochMs, value?: number): void {
    this.#tx((c) => {
      c.noteHealth(fact, at, value);
    });
  }
  readHealth(): Readonly<Partial<Record<HealthFact, { readonly at: EpochMs; readonly value: number | null }>>> {
    return this.#tx((c) => c.readHealth());
  }
  purge(now: EpochMs): { removed: number } {
    return this.#tx((c) => c.purge(now));
  }
}

/** The name of a payee's Durable Object: one per address, lowercase. */
export const payeeObjectName = (address: Address): string => `payee:${address.toLowerCase()}`;
/** The name of the deployment's one Global Durable Object. */
export const GLOBAL_OBJECT_NAME = "global";

/** The stores over the Durable Object stubs: each method is one RPC call, one transaction. */
export function durableStores(env: Env): StoreFactory {
  return {
    payee: (address: Address): PayeeStore => {
      const stub = env.PAYEE.get(env.PAYEE.idFromName(payeeObjectName(address)));
      // The stub's RPC methods return promises of the same structured-clone values (Workers RPC).
      const rpc = stub as unknown as Omit<PayeeStore, "payee">;
      return {
        payee: address,
        getTwin: (key) => rpc.getTwin(key),
        putTwin: (twin) => rpc.putTwin(twin),
        listTwins: (options) => rpc.listTwins(options),
        getProposal: (id) => rpc.getProposal(id),
        putProposal: (proposal) => rpc.putProposal(proposal),
        listProposals: (options) => rpc.listProposals(options),
        transitionProposal: (id, from, to, now) => rpc.transitionProposal(id, from, to, now),
        putAutoRecord: (record) => rpc.putAutoRecord(record),
        getAutoRecord: (paymentId) => rpc.getAutoRecord(paymentId),
        listAutoRecords: (options) => rpc.listAutoRecords(options),
        putAlert: (alert) => rpc.putAlert(alert),
        clearAlert: (key) => rpc.clearAlert(key),
        listAlerts: () => rpc.listAlerts(),
        audit: (entry) => rpc.audit(entry),
        listAudit: (limit) => rpc.listAudit(limit),
        useQuota: (day, kind, limit) => rpc.useQuota(day, kind, limit),
        lock: (key, holder, now, ttlMs) => rpc.lock(key, holder, now, ttlMs),
        unlock: (key, holder) => rpc.unlock(key, holder),
        purge: (now) => rpc.purge(now),
      };
    },
    global: (): GlobalStore => env.GLOBAL.get(env.GLOBAL.idFromName(GLOBAL_OBJECT_NAME)),
  };
}
