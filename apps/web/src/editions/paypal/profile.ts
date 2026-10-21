// SPDX-License-Identifier: MIT
/**
 * The PayPal edition (`/paypal/`, docs/paypal/SPEC.md §6.4 with the decisions of 2026-10-21, ADR 0018): PayLink Twin,
 * one invoice link payable on two rails, PayPal (its twin invoice, through apps/api) and USDC or PayPal USD on Ethereum
 * Sepolia, with a collections desk.
 *
 * - Accounts: EIP-6963 browser wallets only (D-SCOPE cuts passkeys: the Mera layer stays in the Monad edition).
 * - Rails: the payer's own EIP-3009 authorisation (`receiveWithAuthorization`, one signature and one transaction), then
 *   the wallet (permit or exact approve, then pay). No relayed rail: D-SCOPE cuts the relayer here, so the payer pays
 *   Sepolia gas in test ETH.
 * - Tabs: create, ledger, desk (this edition's own page), till.
 * - Test dollars: Circle's faucet for USDC. Test PayPal USD has no faucet a tester can rely on (docs/paypal/SPEC.md,
 *   decision D-CHAIN), so none is offered.
 *
 * Owner: web edition workstream (docs/paypal/SPEC.md "Ownership").
 */
import { eip6963Layer } from "../../accounts/eip6963.ts";
import { selfAuthorizationRail } from "../../rails/authorization.ts";
import { walletRail } from "../../rails/wallet.ts";
import type { EditionProfile } from "../types.ts";

export function paypalProfile(common: Pick<EditionProfile, "defaultToken" | "payWithBase">, base: string): EditionProfile {
  return {
    ...common,
    id: "paypal",
    base,
    tag: "PayPal",
    tabs: ["create", "ledger", "desk", "till"],
    accountLayers: [eip6963Layer()],
    rails: [selfAuthorizationRail(), walletRail()],
    fx: "MGA",
    testFunds: { kind: "link", url: "https://faucet.circle.com", name: "Circle Faucet" },
  };
}
