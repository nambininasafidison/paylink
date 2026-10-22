// SPDX-License-Identifier: MIT
/**
 * In-memory stores for the Node entry and tests: the same code as the Durable Objects (src/store/kv.ts) over
 * `memoryKv()`, held by the process and lost when it stops (which loses no truth: the state is a rebuildable cache).
 * Each call runs synchronously before its promise settles, so it is atomic exactly as a Durable Object transaction is.
 *
 * Owner: reconciler workstream.
 */
import type { Address } from "@paylink/api-contract";
import { GlobalStoreCore, memoryKv, PayeeStoreCore } from "./kv.ts";
import type { Sync } from "./kv.ts";
import type { GlobalStore, PayeeStore, StoreFactory } from "./types.ts";

/** Runs a synchronous store call as a settled promise (a throw becomes a rejection, as over RPC). */
function settle<R>(call: () => R): Promise<R> {
  try {
    return Promise.resolve(call());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The async face of a synchronous core: every method of `names`, called inside `settle`. */
export function asyncOf<T extends object>(core: Sync<T>, names: readonly (keyof T & string)[]): T {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const method = core[name] as unknown as (...args: unknown[]) => unknown;
    out[name] = (...args: unknown[]) => settle(() => method.apply(core, args));
  }
  return out as T;
}

export const PAYEE_STORE_METHODS = [
  "getTwin",
  "putTwin",
  "listTwins",
  "getProposal",
  "putProposal",
  "listProposals",
  "transitionProposal",
  "putAutoRecord",
  "getAutoRecord",
  "listAutoRecords",
  "putAlert",
  "clearAlert",
  "listAlerts",
  "audit",
  "listAudit",
  "useQuota",
  "lock",
  "unlock",
  "purge",
] as const satisfies readonly (keyof Omit<PayeeStore, "payee">)[];

export const GLOBAL_STORE_METHODS = [
  "getToken",
  "putToken",
  "spendAiBudget",
  "useQuota",
  "useSubjectQuota",
  "markWebhookEvent",
  "markNonce",
  "indexTwin",
  "findTwinByPayPalId",
  "findTwinByKey",
  "scheduleCheck",
  "unscheduleCheck",
  "dueChecks",
  "notePayee",
  "payeesToPurge",
  "markPayeePurged",
  "noteHealth",
  "readHealth",
  "purge",
] as const satisfies readonly (keyof GlobalStore)[];

// Every method of each interface is listed (a missing one fails type-checking here).
type Unlisted<T, L extends readonly string[]> = Exclude<keyof T, L[number]>;
const payeeComplete: [Unlisted<Omit<PayeeStore, "payee">, typeof PAYEE_STORE_METHODS>] extends [never] ? true : never = true;
const globalComplete: [Unlisted<GlobalStore, typeof GLOBAL_STORE_METHODS>] extends [never] ? true : never = true;
export const STORE_METHOD_LISTS_COMPLETE = { payee: payeeComplete, global: globalComplete } as const;

/** Stores held by this process: one key-value space per payee (lowercase address) and one for the deployment. */
export function createMemoryStores(): StoreFactory {
  const payees = new Map<string, PayeeStore>();
  const global = asyncOf<GlobalStore>(new GlobalStoreCore(memoryKv()), GLOBAL_STORE_METHODS);
  return {
    payee: (address: Address): PayeeStore => {
      const id = address.toLowerCase();
      let store = payees.get(id);
      if (store === undefined) {
        store = { payee: address, ...asyncOf<Omit<PayeeStore, "payee">>(new PayeeStoreCore(memoryKv()), PAYEE_STORE_METHODS) };
        payees.set(id, store);
      }
      return store;
    },
    global: () => global,
  };
}
