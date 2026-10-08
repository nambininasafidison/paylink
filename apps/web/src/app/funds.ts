// SPDX-License-Identifier: MIT
/**
 * Test dollars for a tester (PAYLINK-V2-SPEC §2.1 T1 "testnet onboarding"): in the Monad edition the relayer asks
 * Monad testnet's AUSD faucet to fund the account (`POST /v1/10143/onboard`, `requestFunds(address)`), so neither a
 * merchant nor a payer ever needs MON; elsewhere the edition links to the token issuer's own faucet page.
 *
 * Testnet only, by construction: the relayer serves onboarding only on chains whose registry entry names a faucet, and
 * refuses mainnets. The faucet has one global 60 s cooldown, so a refusal says when to try again.
 */
import type { ChainDefinition, Token } from "@paylink/chains";
import type { Address } from "viem";
import { pollingIntervalFor } from "../core/clients.ts";
import { displayAmount } from "../core/format.ts";
import { RelayerProblem } from "../core/relayer.ts";
import { ext, setStatus, statusLine } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { announce } from "../ui/live.ts";
import type { App } from "./context.ts";

/** Whether the relayer can fund accounts on this chain now. */
export async function canOnboard(app: App, chain: ChainDefinition): Promise<boolean> {
  if (app.edition.testFunds?.kind !== "relayer" || chain.contracts.ausdFaucet === undefined || !chain.testnet) {
    return false;
  }
  const availability = await app.relayer.availability(chain.chainId);
  return availability.kind === "up" && availability.health.operations.onboard;
}

/**
 * A row under the Pay key (or on the KeyCard) when the account holds too little: its balance, and the way to get test
 * dollars. Calls `onFunded` once the faucet's transaction is mined. Resolves `null` when nothing is to be shown.
 */
export async function fundsRow(app: App, options: { readonly chain: ChainDefinition; readonly token: Token; readonly owner: Address; readonly balance: bigint; readonly onFunded: () => void }): Promise<HTMLElement | null> {
  const { t } = app.i18n;
  const { chain, token, owner, balance } = options;
  const testFunds = app.edition.testFunds;
  if (testFunds === null || !chain.testnet || token.kind !== "erc20") {
    return null;
  }
  const held = h("p", { class: "funds-held" }, t("funds.held", { amount: displayAmount(balance, token, app.locale), symbol: token.symbol }));
  if (testFunds.kind === "link") {
    return h("div", { class: "funds" }, held, h("p", { class: "funds-how" }, t("funds.link", { symbol: token.symbol }), " ", ext(testFunds.url, testFunds.name)));
  }
  if (!(await canOnboard(app, chain))) {
    return h("div", { class: "funds" }, held, h("p", { class: "funds-how" }, t("funds.unavailable", { symbol: token.symbol })));
  }
  const status = statusLine();
  const key = h("button", { class: "key key-line funds-key", attrs: { type: "button" } }, t("funds.get", { symbol: token.symbol }));
  key.addEventListener("click", () => {
    key.disabled = true;
    key.setAttribute("aria-busy", "true");
    setStatus(status, "", t("funds.asking"));
    void (async () => {
      try {
        const accepted = await app.relayer.onboard(chain.chainId, owner);
        setStatus(status, "", t("funds.sent"));
        const receipt = await app.client(chain).waitForReceipt(accepted.txHash, { pollingMs: pollingIntervalFor(chain), timeoutMs: 90_000 });
        if (receipt.status !== "success") {
          throw new RelayerProblem({ code: "faucet-unavailable", status: 503, detail: "the faucet transaction reverted", fallback: "retry", retryAfter: 60 });
        }
        setStatus(status, "ok", t("funds.done", { symbol: token.symbol }));
        announce(t("funds.done", { symbol: token.symbol }));
        options.onFunded();
      } catch (error) {
        const wait = error instanceof RelayerProblem && error.retryAfter !== null ? Math.max(1, Math.ceil(error.retryAfter)) : 60;
        setStatus(status, "err", error instanceof RelayerProblem && error.code === "faucet-unavailable" ? t("funds.cooldown", { seconds: wait }) : t("funds.failed"), error instanceof RelayerProblem ? t("common.errorCode", { code: error.code }) : undefined);
        key.disabled = false;
      } finally {
        key.removeAttribute("aria-busy");
      }
    })();
  });
  const row = h("div", { class: "funds" }, held, h("p", { class: "funds-how" }, t("funds.relayer", { symbol: token.symbol })), key, status);
  return row;
}

/** Replaces `slot` with the funds row when `balance` is below `needed` (or zero for an open amount). */
export async function showFundsIfShort(
  app: App,
  slot: HTMLElement,
  options: { readonly chain: ChainDefinition; readonly token: Token; readonly owner: Address; readonly needed: bigint; readonly onFunded: () => void },
): Promise<bigint | null> {
  const { chain, token, owner, needed } = options;
  if (token.kind !== "erc20") {
    replace(slot);
    return null;
  }
  let balance: bigint;
  try {
    balance = await app.client(chain).erc20(token.address, "balanceOf", [owner]);
  } catch {
    replace(slot);
    return null;
  }
  const short = needed === 0n ? balance === 0n : balance < needed;
  replace(slot, short ? await fundsRow(app, { chain, token, owner, balance, onFunded: options.onFunded }) : null);
  return balance;
}
