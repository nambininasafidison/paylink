// SPDX-License-Identifier: MIT
/**
 * The payer's facts and the path the PaymentRouter picks from them (PAYLINK-V2-SPEC §3.5), shared by the pay view and
 * Send. The router is the SDK's (`selectPaymentPath`); this gathers what it needs from the chain, the account, the
 * relayer and the device, and keeps the first path some ready rail of the edition executes.
 *
 * Account kind (invoice spec §8.3): a passkey account is `passkey`; an injected account with code (a smart account or an
 * EIP-7702 delegated EOA) is a `smart-account`, and so is one whose wallet reports EIP-5792 `atomic: supported` (an
 * undeployed smart account has no code yet, and its EIP-3009 signature could not be checked by the token).
 */
import { payerAccountKind, selectPaymentPath } from "@paylink/sdk";
import type { AuthorizationAssessment, DecodedInvoiceLink, PaymentPath, PayerAccountKind } from "@paylink/sdk";
import type { AccountProvider } from "../accounts/types.ts";
import type { ChainClient } from "../core/clients.ts";
import { assessStored } from "../rails/authorization.ts";
import type { PaymentRail } from "../rails/types.ts";
import type { App } from "./context.ts";

export interface PayerFacts {
  readonly account: PayerAccountKind;
  readonly supportsBatch: boolean;
  readonly relayerHealthy: boolean;
  readonly payerHasGas: boolean;
  readonly outstanding: AuthorizationAssessment | null;
}

export type PathChoice =
  | {
      readonly ok: true;
      readonly path: PaymentPath;
      readonly rail: PaymentRail;
      /** Other executable paths, best first (the pay view offers "pay with your own gas" from these). */
      readonly fallbacks: readonly PaymentPath[];
      readonly payerPaysGas: boolean;
      /** An authorisation signed earlier is resubmitted: nothing new is signed (invoice spec §8.6). */
      readonly resubmit: boolean;
      readonly facts: PayerFacts;
    }
  | { readonly ok: false; readonly reason: "needs-gas" | "authorization-consumed" | "none"; readonly facts: PayerFacts };

/** Reads the facts the router needs for this payer and link at chain time `now`. */
export async function payerFacts(app: App, client: ChainClient, account: AccountProvider, link: DecodedInvoiceLink, now: bigint): Promise<PayerFacts> {
  const chain = link.target.chain;
  const wantsBatch = app.edition.rails.some((r) => r.paths.includes("batched-approve-pay")) && account.sendCalls !== undefined;
  const [code, balance, availability, atomic, stored] = await Promise.all([
    account.kind === "passkey" ? Promise.resolve(undefined) : client.getCode({ address: account.address }),
    client.getBalance(account.address).catch(() => 0n),
    app.relayer.availability(chain.chainId),
    wantsBatch && account.atomicCapability !== undefined ? account.atomicCapability(chain.chainId) : Promise.resolve("unsupported" as const),
    assessStored({ authorizations: app.store.authorizations, registry: app.registry, client, now, link, chain, payer: account.address }),
  ]);
  let kind = payerAccountKind(code, { passkey: account.kind === "passkey" });
  if (kind === "eoa" && atomic === "supported") {
    kind = "smart-account";
  }
  return {
    account: kind,
    supportsBatch: atomic === "supported" || (atomic === "ready" && kind === "smart-account"),
    relayerHealthy: availability.kind === "up" && availability.health.operations.pay,
    payerHasGas: balance > 0n,
    outstanding: stored.assessment,
  };
}

/** The router's choice among the paths a ready rail of the edition can execute. */
export async function choosePath(app: App, client: ChainClient, account: AccountProvider, link: DecodedInvoiceLink, now: bigint): Promise<PathChoice> {
  const facts = await payerFacts(app, client, account, link, now);
  const route = selectPaymentPath({
    capabilities: link.token.capabilities,
    account: facts.account,
    supportsBatch: facts.supportsBatch,
    relayerHealthy: facts.relayerHealthy,
    payerHasGas: facts.payerHasGas,
    outstanding: facts.outstanding,
  });
  if (!route.available) {
    return { ok: false, reason: route.reason, facts };
  }
  const env = { registry: app.registry, relayer: app.relayer, authorizations: app.store.authorizations };
  const executable: { path: PaymentPath; rail: PaymentRail }[] = [];
  for (const path of [route.path, ...route.fallbacks]) {
    for (const rail of app.edition.rails) {
      if (rail.paths.includes(path) && (await rail.ready(link.target.chain, env))) {
        executable.push({ path, rail });
        break;
      }
    }
  }
  const [first, ...rest] = executable;
  if (first === undefined) {
    return { ok: false, reason: "none", facts };
  }
  const paysGas = (path: PaymentPath): boolean => path !== "relayed-authorization";
  return { ok: true, path: first.path, rail: first.rail, fallbacks: rest.map((e) => e.path), payerPaysGas: paysGas(first.path), resubmit: route.resubmit !== null, facts };
}
