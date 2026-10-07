// SPDX-License-Identifier: MIT
/**
 * PaymentRouter (PAYLINK-V2-SPEC §3.5): picks one settlement path per (token capabilities × account kind ×
 * relayer health × outstanding authorization), with the fallbacks a payer can switch to. Pure: the caller
 * supplies the facts.
 *
 * | Situation                                                     | Path                       | Payer needs           |
 * |---------------------------------------------------------------|----------------------------|-----------------------|
 * | EIP-3009 token, code-less EOA or passkey payer, relayer up    | relayed-authorization      | 1 signature, 0 gas    |
 * | Same, relayer down                                            | self-authorization, permit | gas                   |
 * | An authorization for this link is still live (§8.6)           | resubmit it: relayed/self  | 0 gas / gas           |
 * | An authorization for this link was consumed (§8.6)            | none: verify the receipt   | —                     |
 * | EIP-2612 token                                                | permit                     | 1 signature + 1 tx    |
 * | Smart-account payer, including an EIP-7702 delegated EOA      | batched-approve-pay        | 1 approval (EIP-5792) |
 * | Anything else                                                 | approve-pay                | 2 tx                  |
 * | Native coin                                                   | native                     | coin                  |
 *
 * Retry safety (invoice spec §8.6): while an earlier authorization for the same link and payer is live, the only
 * paths offered resubmit that very authorization (to the relayer, or by the payer). Permit and approve-and-pay
 * would be a second, independent payment that settles alongside the first wherever `maxPayments != 1`; they open
 * again only once the authorization is cancelled on the token or has expired.
 */
import type { TokenCapabilities } from "@paylink/chains";
import type { Hex } from "viem";
import type { AuthorizationAssessment } from "./attempts.ts";
import { EIP7702_DELEGATION_PREFIX } from "./constants.ts";

/** A settlement path, named after what the payer does. */
export type PaymentPath =
  | "relayed-authorization" // payWithAuthorization, submitted by the relayer
  | "self-authorization" // payWithAuthorization, submitted by the payer ("pay with your own gas")
  | "permit" // payWithPermit
  | "batched-approve-pay" // EIP-5792 wallet_sendCalls([approve, pay])
  | "approve-pay" // approve (exact amount), then pay
  | "native"; // payNative

/**
 * The payer's account (§8.3). Only a code-less account can use EIP-3009: tokens verify the payer's v, r, s with
 * ECDSA when it has no code and with ERC-1271 when it has code (Circle FiatToken v2.2), so a smart account, or an
 * EOA with an EIP-7702 delegation, is a `smart-account` here. Use `payerAccountKind` to classify from code.
 */
export type PayerAccountKind = "eoa" | "passkey" | "smart-account";

/**
 * Classifies a payer from `eth_getCode(payer)`. Any code, including the EIP-7702 designator `0xef0100 ‖ delegate`,
 * makes it a `smart-account`: its EIP-3009 signature would be checked through ERC-1271, and its answer can change
 * between a relayer's simulation and inclusion. `passkey` marks a code-less passkey-derived account (Mera).
 */
export function payerAccountKind(code: Hex | undefined, options: { readonly passkey?: boolean } = {}): PayerAccountKind {
  if (code !== undefined && code !== "0x") {
    return "smart-account";
  }
  return options.passkey === true ? "passkey" : "eoa";
}

/** True when the code is an EIP-7702 delegation designator. */
export function isDelegatedCode(code: Hex | undefined): boolean {
  return code?.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX) === true;
}

export interface RouteInput {
  readonly capabilities: TokenCapabilities;
  readonly account: PayerAccountKind;
  /** The smart account supports EIP-5792 atomic batches. */
  readonly supportsBatch?: boolean;
  /** `GET /v1/health` answered and the relayer serves this chain. */
  readonly relayerHealthy: boolean;
  /** The payer holds the gas coin (a Mera passkey account on Monad usually holds none). Default true. */
  readonly payerHasGas?: boolean;
  /**
   * The device's outstanding EIP-3009 authorization for this link and payer, assessed on chain
   * (`assessOutstanding`), or `null` when the device holds none. Required: the router must know.
   */
  readonly outstanding: AuthorizationAssessment | null;
}

/** Set when a live authorization is outstanding: every offered path resubmits it; nothing is signed again. */
export interface ResubmitOnly {
  /** The stored authorization stops being valid at this chain time; other paths open then, or after a cancel. */
  readonly validBefore: bigint;
  /** Paths withheld until the authorization is cancelled on the token or has expired. */
  readonly withheld: readonly PaymentPath[];
}

export type Route =
  | {
      readonly available: true;
      readonly path: PaymentPath;
      readonly fallbacks: readonly PaymentPath[];
      readonly payerPaysGas: boolean;
      readonly resubmit: ResubmitOnly | null;
    }
  /** Nothing works until the relayer is back or the payer gets gas. */
  | {
      readonly available: false;
      readonly reason: "needs-gas";
      readonly whenRelayerReturns: PaymentPath | null;
      readonly resubmit: ResubmitOnly | null;
    }
  /** The outstanding authorization was used (or cancelled elsewhere): show "already paid" and verify the receipt. */
  | { readonly available: false; readonly reason: "authorization-consumed" };

const PAYER_PAYS_GAS: Readonly<Record<PaymentPath, boolean>> = {
  "relayed-authorization": false,
  "self-authorization": true,
  permit: true,
  "batched-approve-pay": true,
  "approve-pay": true,
  native: true,
};

function route(paths: readonly PaymentPath[], payerHasGas: boolean, gasless: PaymentPath | null, resubmit: ResubmitOnly | null): Route {
  const usable = paths.filter((path) => payerHasGas || !PAYER_PAYS_GAS[path]);
  const [path, ...fallbacks] = usable;
  if (path === undefined) {
    return { available: false, reason: "needs-gas", whenRelayerReturns: gasless, resubmit };
  }
  return { available: true, path, fallbacks, payerPaysGas: PAYER_PAYS_GAS[path], resubmit };
}

/** The preferred path and its fallbacks, best first. */
export function selectPaymentPath(input: RouteInput): Route {
  const { capabilities, account, relayerHealthy, outstanding } = input;
  const payerHasGas = input.payerHasGas ?? true;
  if (outstanding?.state === "consumed") {
    return { available: false, reason: "authorization-consumed" };
  }
  if (outstanding?.state === "live") {
    // Resubmit the stored authorization, nothing else (§8.6).
    const paths: PaymentPath[] = relayerHealthy ? ["relayed-authorization", "self-authorization"] : ["self-authorization"];
    const withheld: PaymentPath[] = [
      ...(capabilities.eip2612 ? (["permit"] as const) : []),
      "batched-approve-pay",
      "approve-pay",
    ];
    return route(paths, payerHasGas, "relayed-authorization", { validBefore: outstanding.validBefore, withheld });
  }
  if (capabilities.native) {
    return route(["native"], payerHasGas, null, null);
  }
  if (account === "smart-account") {
    return route(input.supportsBatch === true ? ["batched-approve-pay", "approve-pay"] : ["approve-pay"], payerHasGas, null, null);
  }
  const paths: PaymentPath[] = [];
  if (capabilities.eip3009) {
    if (relayerHealthy) {
      paths.push("relayed-authorization");
    }
    paths.push("self-authorization");
  }
  if (capabilities.eip2612) {
    paths.push("permit");
  }
  paths.push("approve-pay");
  return route(paths, payerHasGas, capabilities.eip3009 ? "relayed-authorization" : null, null);
}
