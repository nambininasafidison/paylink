// SPDX-License-Identifier: MIT
/**
 * Payment rails (edition extension point 3): how a payment reaches the chain. The SDK's PaymentRouter
 * (`selectPaymentPath`) ranks the settlement paths for a link and a payer; each rail declares which paths it can carry
 * out, and the payer view uses the best path some ready rail supports.
 *
 * Today: the payer's own wallet (`wallet.ts`: `permit`, `approve-pay`). Tier T1: the gasless relayer
 * (`relayed-authorization`, apps/relayer) and the payer's own submission of the same authorisation
 * (`self-authorization`, with the retry rules of invoice spec §8.6), each as another rail.
 */
import type { ChainDefinition } from "@paylink/chains";
import type { DecodedInvoiceLink, PaymentPath } from "@paylink/sdk";
import type { Hex, TransactionReceipt } from "viem";
import type { AccountProvider } from "../accounts/types.ts";
import type { ChainClient } from "../core/clients.ts";

/** Progress a rail reports, for the status line and the signing display. */
export type PaymentStep =
  | { readonly kind: "simulate" }
  | { readonly kind: "sign-permit" }
  | { readonly kind: "approve" }
  | { readonly kind: "approve-sent"; readonly txHash: Hex }
  | { readonly kind: "confirm" }
  | { readonly kind: "sent"; readonly txHash: Hex }
  | { readonly kind: "mined"; readonly txHash: Hex };

export interface PaymentContext {
  readonly link: DecodedInvoiceLink;
  readonly chain: ChainDefinition;
  readonly account: AccountProvider;
  readonly client: ChainClient;
  /** The amount paid, in base units (the invoice amount, or the payer's choice for an open amount). */
  readonly amount: bigint;
  readonly payerRef: Hex;
  /** Chain time (latest block timestamp), never the device clock. */
  readonly now: bigint;
  readonly onStep: (step: PaymentStep) => void;
}

export interface PaymentOutcome {
  readonly txHash: Hex;
  readonly receipt: TransactionReceipt;
  /** Block-level log index of the `Paid` event the transaction emitted. */
  readonly logIndex: number;
  /** Milliseconds from the moment the payer confirmed to the receipt. */
  readonly elapsedMs: number;
}

export interface PaymentRail {
  readonly id: string;
  /** Router paths this rail can execute. */
  readonly paths: readonly PaymentPath[];
  /** Whether the rail can serve this chain now (the relayer answers its health check, for example). */
  ready(chain: ChainDefinition): Promise<boolean>;
  execute(path: PaymentPath, context: PaymentContext): Promise<PaymentOutcome>;
}
