// SPDX-License-Identifier: MIT
/**
 * The two Durable Objects of the API (docs/paypal/SPEC.md §6.1, §11), SQLite-backed (the only kind the Workers Free plan
 * offers, Cloudflare Durable Objects pricing page): `Payee`, one per payee address (twins, proposals, auto-records,
 * alerts, audit, quotas), and `Global`, one for the deployment (PayPal token, AI budget, webhook ids, the cron's schedule,
 * health facts). Both are caches, never sources of truth (§11 "Rebuild").
 *
 * Owner: reconciler workstream. Scaffold: the classes exist (deploy/wrangler.toml binds and migrates them) and expose no
 * method yet; `durableStores` answers 501 `not-implemented` for every call.
 */
import { DurableObject } from "cloudflare:workers";
import type { Address } from "@paylink/api-contract";
import { createMemoryStores } from "../store/memory.ts";
import type { StoreFactory } from "../store/types.ts";
import type { Env } from "./env.ts";

export class Payee extends DurableObject<Env> {}

export class Global extends DurableObject<Env> {}

/** The name of a payee's Durable Object: one per address, lowercase. */
export const payeeObjectName = (address: Address): string => `payee:${address.toLowerCase()}`;
/** The name of the deployment's one Global Durable Object. */
export const GLOBAL_OBJECT_NAME = "global";

/** The stores over the Durable Object stubs. */
export function durableStores(env: Env): StoreFactory {
  // Scaffold: the classes are bound and migrated but have no RPC method yet, so every call answers 501 through the same
  // surface as the in-memory stores. The ids are already the ones the implementation will use.
  const pending = createMemoryStores();
  return {
    payee: (address: Address) => {
      env.PAYEE.idFromName(payeeObjectName(address));
      return pending.payee(address);
    },
    global: () => {
      env.GLOBAL.idFromName(GLOBAL_OBJECT_NAME);
      return pending.global();
    },
  };
}
