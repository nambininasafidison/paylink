// SPDX-License-Identifier: MIT
/**
 * In-memory stores for the Node entry and tests: the same contract as the Durable Objects (src/worker/durable.ts), held
 * by the process and lost when it stops (which loses no truth: the state is a rebuildable cache).
 *
 * Owner: reconciler workstream. Scaffold: every method answers 501 `not-implemented`.
 */
import { pendingMethod } from "../core/not-implemented.ts";
import type { GlobalStore, PayeeStore, StoreFactory } from "./types.ts";

export function createMemoryStores(): StoreFactory {
  const pending = pendingMethod("the in-memory store");
  const payee = (address: PayeeStore["payee"]): PayeeStore => ({
    payee: address,
    getTwin: pending,
    putTwin: pending,
    listTwins: pending,
    getProposal: pending,
    putProposal: pending,
    listProposals: pending,
    transitionProposal: pending,
    putAutoRecord: pending,
    listAutoRecords: pending,
    putAlert: pending,
    clearAlert: pending,
    listAlerts: pending,
    audit: pending,
    listAudit: pending,
    useQuota: pending,
    purge: pending,
  });
  const global: GlobalStore = {
    getToken: pending,
    putToken: pending,
    spendAiBudget: pending,
    markWebhookEvent: pending,
    scheduleCheck: pending,
    unscheduleCheck: pending,
    dueChecks: pending,
    noteHealth: pending,
    readHealth: pending,
    purge: pending,
  };
  return { payee, global: () => global };
}
