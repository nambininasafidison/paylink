// SPDX-License-Identifier: MIT
/**
 * Payment rails (edition extension point 3): how a payment reaches the chain. The SDK's PaymentRouter
 * (`selectPaymentPath`) ranks the settlement paths for a link and a payer; each rail declares which paths it can carry
 * out, and the payer view uses the best path some ready rail supports.
 *
 * Rails:
 * - `wallet.ts`: the payer's own wallet (`permit`, `approve-pay`, `native`);
 * - `authorization.ts`: one EIP-3009 authorisation, submitted gaslessly by the relayer (`relayed-authorization`,
 *   apps/relayer) or by the payer (`self-authorization`), with the retry rules of invoice spec §8.6: the signed
 *   authorisation is stored before it is sent anywhere, and every retry resubmits it;
 * - `batch.ts`: EIP-5792 `wallet_sendCalls([approve, pay])` for smart-account payers (`batched-approve-pay`, the Base
 *   edition's "Pay with Base").
 */
import type { ChainDefinition, Registry } from "@paylink/chains";
import type { DecodedInvoiceLink, OutstandingAuthorizationStore, PaymentPath } from "@paylink/sdk";
import type { Hex, TransactionReceipt } from "viem";
import type { AccountProvider } from "../accounts/types.ts";
import type { ChainClient } from "../core/clients.ts";
import type { RelayerClient } from "../core/relayer.ts";

/** Progress a rail reports, for the status line and the signing display. */
export type PaymentStep =
  | { readonly kind: "simulate" }
  | { readonly kind: "sign-permit" }
  | { readonly kind: "approve" }
  | { readonly kind: "approve-sent"; readonly txHash: Hex }
  | { readonly kind: "confirm" }
  | { readonly kind: "sent"; readonly txHash: Hex }
  | { readonly kind: "mined"; readonly txHash: Hex }
  /** The payer signs the EIP-3009 authorisation (a fingerprint for a passkey). */
  | { readonly kind: "sign-authorization" }
  /** An authorisation signed earlier and still valid is sent again: nothing new is signed (invoice spec §8.6). */
  | { readonly kind: "resubmit" }
  /** Handed to the relayer, which answered with a transaction. */
  | { readonly kind: "relayed"; readonly txHash: Hex }
  /** EIP-5792: the wallet shows one approval for the whole batch. */
  | { readonly kind: "batch" };

/** What rails read besides the payment itself. */
export interface RailEnv {
  readonly registry: Registry;
  readonly relayer: RelayerClient;
  /** The device's outstanding EIP-3009 authorisations (persisted before any relay). */
  readonly authorizations: OutstandingAuthorizationStore;
}

export interface PaymentContext extends RailEnv {
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
  /** Milliseconds from the moment the payer confirmed (the signature or the wallet's approval) to the receipt. */
  readonly elapsedMs: number;
}

export interface PaymentRail {
  readonly id: string;
  /** Router paths this rail can execute. */
  readonly paths: readonly PaymentPath[];
  /** Whether the rail can serve this chain now (the relayer answers its health check, for example). */
  ready(chain: ChainDefinition, env: RailEnv): Promise<boolean>;
  execute(path: PaymentPath, context: PaymentContext): Promise<PaymentOutcome>;
}
