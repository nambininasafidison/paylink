// SPDX-License-Identifier: MIT
/**
 * The chains a relayer serves and the only transactions it may sign.
 *
 * - Testnets only: `RELAYER_PK` is a throwaway testnet key (PAYLINK-V2-SPEC §3.7, §6.1), so a mainnet is never
 *   relayed, whatever the registry says. Only enabled v2 chains of the registry qualify; local anvil chains only
 *   in the Node adapter.
 * - `assertSendable` is the single choke point every signature goes through. It allows exactly: `payWithAuthorization`
 *   and `cancelBySig` to the chain's canonical deployment; the faucet's `requestFunds(address)` on a chain whose
 *   registry lists one; and a zero-value self-transfer that voids a stuck nonce. Value is always 0: Monad's reserve
 *   rule makes value spends revert, and the relayer has no reason to move its own coin (§0 decision 5).
 */
import type { ChainDefinition, GasBounds, Registry } from "@paylink/chains";
import { createRegistry } from "@paylink/chains";
import { payLinkV2Abi } from "@paylink/sdk";
import { encodeFunctionData, getAbiItem, isAddressEqual, parseAbi, toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";

export const FAUCET_ABI = parseAbi(["function requestFunds(address recipient)"]);

export const SELECTORS = Object.freeze({
  payWithAuthorization: toFunctionSelector(getAbiItem({ abi: payLinkV2Abi, name: "payWithAuthorization" })),
  cancelBySig: toFunctionSelector(getAbiItem({ abi: payLinkV2Abi, name: "cancelBySig" })),
  requestFunds: toFunctionSelector(getAbiItem({ abi: FAUCET_ABI, name: "requestFunds" })),
});

/** True when the relayer may serve `chain`: an enabled v2 testnet (a local one only when `allowLocal`). */
export function isRelayable(chain: ChainDefinition, allowLocal: boolean): boolean {
  return chain.protocol === "v2" && chain.status === "enabled" && chain.testnet && (allowLocal || !chain.local);
}

/** The registry restricted to the chains the relayer serves. */
export function relayRegistry(source: Registry, options: { readonly allowLocal: boolean }): Registry {
  return createRegistry(source.chains.filter((chain) => isRelayable(chain, options.allowLocal)));
}

/** The faucet a chain offers for onboarding, with its gas bounds, or `null`. */
export function faucetOf(chain: ChainDefinition): { readonly address: Address; readonly gas: GasBounds } | null {
  const faucet = chain.contracts.ausdFaucet;
  return faucet?.gas === undefined ? null : { address: faucet.address, gas: faucet.gas };
}

export function faucetCall(faucet: Address, recipient: Address): { readonly to: Address; readonly data: Hex; readonly value: bigint } {
  return { to: faucet, data: encodeFunctionData({ abi: FAUCET_ABI, functionName: "requestFunds", args: [recipient] }), value: 0n };
}

export class UnsendableTransactionError extends Error {
  constructor(reason: string) {
    super(`refusing to sign: ${reason}`);
    this.name = "UnsendableTransactionError";
  }
}

/**
 * Throws `UnsendableTransactionError` unless the transaction is one the relayer may sign on `chain` from `self`.
 * Called immediately before every signature, including replacements.
 */
export function assertSendable(chain: ChainDefinition, self: Address, tx: { readonly to: Address; readonly data: Hex; readonly value: bigint }): void {
  if (tx.value !== 0n) {
    throw new UnsendableTransactionError("the relayer never sends value");
  }
  if (!chain.testnet) {
    throw new UnsendableTransactionError(`chain ${String(chain.chainId)} is not a testnet`);
  }
  const selector = tx.data.slice(0, 10).toLowerCase();
  const deployment = chain.deployment;
  if (deployment !== null && deployment.status !== "revoked" && isAddressEqual(tx.to, deployment.address)) {
    if (selector === SELECTORS.payWithAuthorization || selector === SELECTORS.cancelBySig) {
      return;
    }
    throw new UnsendableTransactionError(`selector ${selector} is not relayable`);
  }
  const faucet = faucetOf(chain);
  if (faucet !== null && isAddressEqual(tx.to, faucet.address)) {
    if (selector === SELECTORS.requestFunds && tx.data.length === 2 + 2 * (4 + 32)) {
      return;
    }
    throw new UnsendableTransactionError(`faucet call ${selector} is not requestFunds(address)`);
  }
  if (isAddressEqual(tx.to, self) && tx.data === "0x") {
    return; // voids a stuck nonce
  }
  throw new UnsendableTransactionError(`${tx.to} is neither the canonical deployment nor the faucet`);
}
