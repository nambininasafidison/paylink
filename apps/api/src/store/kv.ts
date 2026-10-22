// SPDX-License-Identifier: MIT
/**
 * The stores' logic, written once over a synchronous key-value interface (`SyncKv`) that both runtimes provide:
 *
 * - the Worker: a SQLite-backed Durable Object's `ctx.storage.kv` (`SyncKvStorage` in @cloudflare/workers-types
 *   5.20261006.1, the catalog's pin), each call wrapped in `ctx.storage.transactionSync` (src/worker/durable.ts);
 * - Node and tests: `memoryKv()`, a sorted map that copies values in and out with `structuredClone`, as a Durable Object
 *   serialises them (src/store/memory.ts).
 *
 * Every method here is synchronous, so one call is atomic in both: a compare-and-set cannot interleave with another call
 * (in the Durable Object, because no I/O happens inside the transaction; in Node, because no `await` does). Keys are
 * ASCII so that JavaScript's string order is the storage's byte order. Values are never mutated after a read.
 *
 * Key layout (one namespace per Durable Object):
 *
 * | Payee | `t:<K>` twin · `p:<id>` proposal · `r:<paymentId>` auto-record · `a:<K>` alert · `l:<seq>` audit · `m:seq` ·
 * |       | `q:<day>:<kind>` quota · `k:<K>` lock |
 * | Global | `token` · `b:<day>` AI budget · `q:<day>:<kind>` quota · `q:<day>:<kind>:<subject>` quota of one payee or
 * |        | source · `w:<eventId>` webhook · `n:<scope>:<nonce>` ·
 * |        | `ip:<paypalId>`, `ik:<K>` twin index · `c:<payee>:<K>` check · `d:<dueAt>:<payee>:<K>` due order ·
 * |        | `pp:<payee>` payee · `h:<fact>` health |
 *
 * Owner: reconciler workstream.
 */
import type { Address, InvoiceKey, ProposalState } from "@paylink/api-contract";
import type { AccessToken } from "../paypal/client.ts";
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
  PurgeReport,
  QuotaResult,
  ScheduledCheck,
  SubjectQuotaKind,
  TwinIndexEntry,
  TwinRecord,
  UtcDay,
} from "./types.ts";

/** The synchronous key-value surface of a SQLite-backed Durable Object (`ctx.storage.kv`), and of `memoryKv()`. */
export interface SyncKv {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the shape of SyncKvStorage.get (workers-types)
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list<T = unknown>(options?: { prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean }): Iterable<[string, T]>;
}

/** An in-memory `SyncKv`: keys in string order; values copied in and out like a Durable Object's. */
export function memoryKv(): SyncKv & { readonly size: () => number } {
  const map = new Map<string, unknown>();
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the shape of SyncKvStorage.get
    get: <T>(key: string) => (map.has(key) ? (structuredClone(map.get(key)) as T) : undefined),
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
    *list<T>(options: { prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean } = {}): Iterable<[string, T]> {
      const keys = [...map.keys()]
        .filter((k) => (options.prefix === undefined || k.startsWith(options.prefix)) && (options.start === undefined || k >= options.start) && (options.end === undefined || k < options.end))
        .sort();
      if (options.reverse === true) {
        keys.reverse();
      }
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      let n = 0;
      for (const k of keys) {
        if (n >= limit) {
          return;
        }
        n += 1;
        yield [k, structuredClone(map.get(k)) as T];
      }
    },
    size: () => map.size,
  };
}

/** A store interface with each async method made synchronous: what the cores implement. */
export type Sync<T> = { [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Retention (docs/paypal/SPEC.md §11, E). */
export const RETENTION = {
  closedTwinMs: 90 * DAY_MS,
  proposalMs: 30 * DAY_MS,
  auditMs: 90 * DAY_MS,
  quotaDays: 2,
  aiBudgetDays: 30,
  webhookEventMs: 7 * DAY_MS,
  twinIndexMs: 120 * DAY_MS,
  payeePurgeEveryMs: DAY_MS,
} as const;

const pad = (n: number, width: number): string => String(Math.max(0, Math.floor(n))).padStart(width, "0");
const lower = (address: string): string => address.toLowerCase();
/** Keys built from outside input are bounded and printable ASCII. */
function safeKeyPart(value: string, max: number): string {
  if (value.length === 0 || value.length > max || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new RangeError("store key part must be 1 to " + String(max) + " printable ASCII characters");
  }
  return value;
}
const dayMinus = (day: UtcDay, days: number): UtcDay => new Date(Date.parse(`${day}T00:00:00.000Z`) - days * DAY_MS).toISOString().slice(0, 10);
const utcDayOf = (ms: number): UtcDay => new Date(ms).toISOString().slice(0, 10);

function count(kv: SyncKv, key: string, limit: number, add = 1): QuotaResult {
  const used = kv.get<number>(key) ?? 0;
  if (!Number.isFinite(add) || add < 0) {
    throw new RangeError("a quota counts a finite, non-negative amount");
  }
  if (used + add > limit) {
    return { allowed: false, used, limit };
  }
  kv.put(key, used + add);
  return { allowed: true, used: used + add, limit };
}

function* entries<T>(kv: SyncKv, prefix: string): Iterable<[string, T]> {
  yield* kv.list<T>({ prefix });
}

/** The logic of `PayeeStore` (minus its `payee` member) over one payee's key-value space. */
export class PayeeStoreCore implements Sync<Omit<PayeeStore, "payee">> {
  readonly #kv: SyncKv;

  constructor(kv: SyncKv) {
    this.#kv = kv;
  }

  getTwin(key: InvoiceKey): TwinRecord | null {
    return this.#kv.get<TwinRecord>(`t:${lower(key)}`) ?? null;
  }

  putTwin(twin: TwinRecord): void {
    this.#kv.put(`t:${lower(twin.key)}`, twin);
  }

  listTwins(options: { readonly open?: boolean; readonly limit?: number } = {}): readonly TwinRecord[] {
    const twins = [...entries<TwinRecord>(this.#kv, "t:")].map(([, t]) => t).filter((t) => options.open !== true || (t.situation !== "S8" && t.situation !== "S9"));
    twins.sort((a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : 1));
    return options.limit === undefined ? twins : twins.slice(0, options.limit);
  }

  getProposal(id: string): ProposalRecord | null {
    return this.#kv.get<ProposalRecord>(`p:${safeKeyPart(id, 64)}`) ?? null;
  }

  putProposal(proposal: ProposalRecord): void {
    this.#kv.put(`p:${safeKeyPart(proposal.id, 64)}`, proposal);
  }

  listProposals(options: { readonly states?: readonly ProposalState[]; readonly key?: InvoiceKey } = {}): readonly ProposalRecord[] {
    const states = options.states === undefined ? null : new Set(options.states);
    const key = options.key === undefined ? null : lower(options.key);
    return [...entries<ProposalRecord>(this.#kv, "p:")]
      .map(([, p]) => p)
      .filter((p) => (states === null || states.has(p.state)) && (key === null || lower(p.key) === key))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
  }

  transitionProposal(id: string, from: ProposalState, to: ProposalState, now?: EpochMs): boolean {
    const current = this.getProposal(id);
    if (current?.state !== from) {
      return false;
    }
    this.putProposal({ ...current, state: to, updatedAt: now ?? current.updatedAt });
    return true;
  }

  putAutoRecord(record: AutoRecord): void {
    this.#kv.put(`r:${safeKeyPart(record.paymentId, 64)}`, record);
  }

  getAutoRecord(paymentId: string): AutoRecord | null {
    return this.#kv.get<AutoRecord>(`r:${safeKeyPart(paymentId, 64)}`) ?? null;
  }

  listAutoRecords(options: { readonly key?: InvoiceKey } = {}): readonly AutoRecord[] {
    const key = options.key === undefined ? null : lower(options.key);
    return [...entries<AutoRecord>(this.#kv, "r:")]
      .map(([, r]) => r)
      .filter((r) => key === null || lower(r.key) === key)
      .sort((a, b) => b.recordedAt - a.recordedAt);
  }

  putAlert(alert: AlertRecord): void {
    const existing = this.#kv.get<AlertRecord>(`a:${lower(alert.key)}`);
    // The same alert keeps its first time, so "raised at" means when the problem started.
    this.#kv.put(`a:${lower(alert.key)}`, existing?.code === alert.code && existing.situation === alert.situation ? { ...alert, raisedAt: existing.raisedAt } : alert);
  }

  clearAlert(key: InvoiceKey): void {
    this.#kv.delete(`a:${lower(key)}`);
  }

  listAlerts(): readonly AlertRecord[] {
    return [...entries<AlertRecord>(this.#kv, "a:")].map(([, a]) => a).sort((a, b) => b.raisedAt - a.raisedAt);
  }

  audit(entry: Omit<AuditEntry, "seq">): AuditEntry {
    const seq = (this.#kv.get<number>("m:seq") ?? 0) + 1;
    const line: AuditEntry = { seq, ...entry };
    this.#kv.put("m:seq", seq);
    this.#kv.put(`l:${pad(seq, 12)}`, line);
    return line;
  }

  listAudit(limit: number): readonly AuditEntry[] {
    return [...this.#kv.list<AuditEntry>({ prefix: "l:", reverse: true, limit })].map(([, e]) => e);
  }

  useQuota(day: UtcDay, kind: PayeeQuotaKind, limit: number): QuotaResult {
    return count(this.#kv, `q:${day}:${kind}`, limit);
  }

  lock(key: InvoiceKey, holder: string, now: EpochMs, ttlMs: number): boolean {
    const held = this.#kv.get<{ holder: string; until: EpochMs }>(`k:${lower(key)}`);
    if (held !== undefined && held.until > now && held.holder !== holder) {
      return false;
    }
    this.#kv.put(`k:${lower(key)}`, { holder, until: now + ttlMs });
    return true;
  }

  unlock(key: InvoiceKey, holder: string): void {
    const held = this.#kv.get<{ holder: string; until: EpochMs }>(`k:${lower(key)}`);
    if (held?.holder === holder) {
      this.#kv.delete(`k:${lower(key)}`);
    }
  }

  purge(now: EpochMs): PurgeReport {
    const kv = this.#kv;
    let removed = 0;
    const drop = (key: string): void => {
      if (kv.delete(key)) {
        removed += 1;
      }
    };
    const gone = new Set<string>();
    for (const [k, twin] of entries<TwinRecord>(kv, "t:")) {
      if (twin.closedAt !== null && now - twin.closedAt >= RETENTION.closedTwinMs) {
        gone.add(lower(twin.key));
        drop(k);
        drop(`a:${lower(twin.key)}`);
      }
    }
    for (const [k, p] of entries<ProposalRecord>(kv, "p:")) {
      if (now - p.createdAt >= RETENTION.proposalMs || gone.has(lower(p.key))) {
        drop(k);
      }
    }
    for (const [k, r] of entries<AutoRecord>(kv, "r:")) {
      if (now - r.recordedAt >= RETENTION.closedTwinMs || gone.has(lower(r.key))) {
        drop(k);
      }
    }
    for (const [k, line] of entries<AuditEntry>(kv, "l:")) {
      if (now - line.at < RETENTION.auditMs) {
        break; // audit keys are in time order
      }
      drop(k);
    }
    const oldest = dayMinus(utcDayOf(now), RETENTION.quotaDays - 1);
    for (const [k] of entries<number>(kv, "q:")) {
      if (k.slice(2, 12) < oldest) {
        drop(k);
      }
    }
    for (const [k, held] of entries<{ until: EpochMs }>(kv, "k:")) {
      if (held.until <= now) {
        drop(k);
      }
    }
    return { removed };
  }
}

/** The logic of `GlobalStore` over the deployment's key-value space. */
export class GlobalStoreCore implements Sync<GlobalStore> {
  readonly #kv: SyncKv;

  constructor(kv: SyncKv) {
    this.#kv = kv;
  }

  getToken(now: EpochMs): AccessToken | null {
    const token = this.#kv.get<AccessToken>("token");
    return token !== undefined && token.expiresAtMs > now ? token : null;
  }

  putToken(token: AccessToken): void {
    this.#kv.put("token", token);
  }

  spendAiBudget(day: UtcDay, neurons: number, ceiling: number): QuotaResult {
    return count(this.#kv, `b:${day}`, ceiling, neurons);
  }

  useQuota(day: UtcDay, kind: GlobalQuotaKind, limit: number): QuotaResult {
    return count(this.#kv, `q:${day}:${kind}`, limit);
  }

  useSubjectQuota(day: UtcDay, kind: SubjectQuotaKind, subject: string, amount: number, limit: number): QuotaResult {
    return count(this.#kv, `q:${day}:${kind}:${safeKeyPart(subject.toLowerCase(), 64)}`, limit, amount);
  }

  markWebhookEvent(eventId: string, now: EpochMs): "new" | "seen" {
    const key = `w:${safeKeyPart(eventId, 128)}`;
    if (this.#kv.get(key) !== undefined) {
      return "seen";
    }
    this.#kv.put(key, now);
    return "new";
  }

  markNonce(scope: "session", nonce: string, expiresAt: EpochMs, now: EpochMs): "new" | "seen" {
    const key = `n:${scope}:${safeKeyPart(nonce, 128)}`;
    const held = this.#kv.get<EpochMs>(key);
    if (held !== undefined) {
      return "seen";
    }
    this.#kv.put(key, Math.max(expiresAt, now));
    return "new";
  }

  indexTwin(entry: TwinIndexEntry, now: EpochMs): void {
    const value = { paypalId: entry.paypalId, payee: entry.payee, key: lower(entry.key) as InvoiceKey, at: now };
    this.#kv.put(`ip:${safeKeyPart(entry.paypalId, 64)}`, value);
    this.#kv.put(`ik:${lower(entry.key)}`, value);
  }

  findTwinByPayPalId(paypalId: string): TwinIndexEntry | null {
    const found = this.#kv.get<TwinIndexEntry>(`ip:${safeKeyPart(paypalId, 64)}`);
    return found === undefined ? null : { paypalId: found.paypalId, payee: found.payee, key: found.key };
  }

  findTwinByKey(key: InvoiceKey): TwinIndexEntry | null {
    const found = this.#kv.get<TwinIndexEntry>(`ik:${lower(key)}`);
    return found === undefined ? null : { paypalId: found.paypalId, payee: found.payee, key: found.key };
  }

  scheduleCheck(check: ScheduledCheck): void {
    const id = `${lower(check.payee)}:${lower(check.key)}`;
    const old = this.#kv.get<ScheduledCheck>(`c:${id}`);
    if (old !== undefined) {
      this.#kv.delete(`d:${pad(old.dueAt, 15)}:${id}`);
    }
    this.#kv.put(`c:${id}`, check);
    this.#kv.put(`d:${pad(check.dueAt, 15)}:${id}`, 1);
  }

  unscheduleCheck(payee: Address, key: InvoiceKey): void {
    const id = `${lower(payee)}:${lower(key)}`;
    const old = this.#kv.get<ScheduledCheck>(`c:${id}`);
    if (old !== undefined) {
      this.#kv.delete(`d:${pad(old.dueAt, 15)}:${id}`);
      this.#kv.delete(`c:${id}`);
    }
  }

  dueChecks(now: EpochMs, limit: number): readonly ScheduledCheck[] {
    const due: ScheduledCheck[] = [];
    for (const [k] of this.#kv.list({ prefix: "d:", end: `d:${pad(now + 1, 15)}`, limit })) {
      const check = this.#kv.get<ScheduledCheck>(`c:${k.slice(18)}`);
      if (check !== undefined) {
        due.push(check);
      }
    }
    return due;
  }

  notePayee(payee: Address, now: EpochMs): void {
    const key = `pp:${lower(payee)}`;
    if (this.#kv.get(key) === undefined) {
      this.#kv.put(key, { payee, firstSeen: now, purgedAt: 0 });
    }
  }

  payeesToPurge(now: EpochMs, limit: number): readonly Address[] {
    const out: Address[] = [];
    for (const [, p] of entries<{ payee: Address; purgedAt: EpochMs }>(this.#kv, "pp:")) {
      if (out.length >= limit) {
        break;
      }
      if (now - p.purgedAt >= RETENTION.payeePurgeEveryMs) {
        out.push(p.payee);
      }
    }
    return out;
  }

  markPayeePurged(payee: Address, now: EpochMs): void {
    const key = `pp:${lower(payee)}`;
    const p = this.#kv.get<{ payee: Address; firstSeen: EpochMs; purgedAt: EpochMs }>(key);
    this.#kv.put(key, { payee, firstSeen: p?.firstSeen ?? now, purgedAt: now });
  }

  noteHealth(fact: HealthFact, at: EpochMs, value?: number): void {
    this.#kv.put(`h:${fact}`, { at, value: value ?? null });
  }

  readHealth(): Readonly<Partial<Record<HealthFact, { readonly at: EpochMs; readonly value: number | null }>>> {
    const out: Partial<Record<HealthFact, { at: EpochMs; value: number | null }>> = {};
    for (const [k, v] of entries<{ at: EpochMs; value: number | null }>(this.#kv, "h:")) {
      out[k.slice(2) as HealthFact] = v;
    }
    return out;
  }

  purge(now: EpochMs): PurgeReport {
    const kv = this.#kv;
    let removed = 0;
    const drop = (key: string): void => {
      if (kv.delete(key)) {
        removed += 1;
      }
    };
    const today = utcDayOf(now);
    for (const [k] of entries<number>(kv, "b:")) {
      if (k.slice(2) < dayMinus(today, RETENTION.aiBudgetDays - 1)) {
        drop(k);
      }
    }
    for (const [k] of entries<number>(kv, "q:")) {
      if (k.slice(2, 12) < dayMinus(today, RETENTION.quotaDays - 1)) {
        drop(k);
      }
    }
    for (const [k, at] of entries<EpochMs>(kv, "w:")) {
      if (now - at >= RETENTION.webhookEventMs) {
        drop(k);
      }
    }
    for (const [k, until] of entries<EpochMs>(kv, "n:")) {
      if (until <= now) {
        drop(k);
      }
    }
    for (const prefix of ["ip:", "ik:"]) {
      for (const [k, entry] of entries<{ at: EpochMs }>(kv, prefix)) {
        if (now - entry.at >= RETENTION.twinIndexMs) {
          drop(k);
        }
      }
    }
    const token = kv.get<AccessToken>("token");
    if (token !== undefined && token.expiresAtMs <= now) {
      drop("token");
    }
    return { removed };
  }
}
