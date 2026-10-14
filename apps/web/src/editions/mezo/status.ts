// SPDX-License-Identifier: MIT
/**
 * The Mezo edition's lines on the Status page, read live like every other light there:
 *
 * - "MUSD on the network", per Mezo chain: the registry's dollar answers with its symbol and decimals, its EIP-712
 *   domain (ERC-5267), the EIP-2612 permit functions and no EIP-3009 (`authorizationState` reverts), exactly as the
 *   registry describes it (docs/research/mezo.md §4). Green when chain and registry agree, red when they do not.
 * - "Network fee", per Mezo chain: paid in BTC by the payer, about how much a `payWithPermit` costs at today's price.
 * - "Gasless payments", under the services: none on Mezo, and why (MUSD has no EIP-3009; §11).
 *
 * Called only from a branch the build folds to the Mezo edition.
 */
import type { ChainDefinition, Erc20Token } from "@paylink/chains";
import { readTokenDomain } from "@paylink/sdk";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, zeroAddress, zeroHash } from "viem";
import type { App } from "../../app/context.ts";
import type { ChainClient } from "../../core/clients.ts";
import { h } from "../../ui/h.ts";
import { satsText, settlementGas } from "./ui.ts";

type Light = "ok" | "wait" | "err" | "off";

function light(name: string): { element: HTMLLIElement; set(state: Light, detail: string): void } {
  const detail = h("span", { class: "vstrip-detail" });
  const element = h("li", { attrs: { "data-lamp": "busy" } }, h("span", { class: "vstrip-name" }, name), detail);
  return {
    element,
    set(state, text) {
      element.setAttribute("data-lamp", state === "off" ? "" : state);
      detail.textContent = text;
    },
  };
}

/** EIP-2612's two views, and EIP-3009's `authorizationState`: plain ABI data (no call at module load, nothing kept elsewhere). */
const PERMIT_ABI = [
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
] as const;
const EIP3009_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** True when the call answers, false when the token reverts (the function is not there). Network errors propagate. */
async function answers(client: ChainClient, to: `0x${string}`, data: `0x${string}`): Promise<boolean> {
  try {
    const result = await client.call({ to, data });
    return result.data !== undefined && result.data !== "0x";
  } catch (error) {
    if (error instanceof Error && /revert/i.test(`${error.name} ${error.message}`)) {
      return false;
    }
    throw error;
  }
}

/** What the chain says about a registry dollar, compared with the registry. */
export interface TokenReading {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly permit: boolean;
  readonly authorization: boolean;
  readonly matches: boolean;
}

/** Reads the token on the chain and compares it with its registry entry. */
export async function readToken(client: ChainClient, chain: ChainDefinition, token: Erc20Token): Promise<TokenReading> {
  const raw = async (data: `0x${string}`): Promise<`0x${string}`> => (await client.call({ to: token.address, data })).data ?? "0x";
  const [symbolData, decimalsData, domain] = await Promise.all([
    raw(encodeFunctionData({ abi: erc20Abi, functionName: "symbol" })),
    raw(encodeFunctionData({ abi: erc20Abi, functionName: "decimals" })),
    readTokenDomain(client, chain.chainId, token.address),
  ]);
  const symbol = decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data: symbolData });
  const decimals = decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: decimalsData });
  const [nonces, separator, authorization] = await Promise.all([
    answers(client, token.address, encodeFunctionData({ abi: PERMIT_ABI, functionName: "nonces", args: [zeroAddress] })),
    answers(client, token.address, encodeFunctionData({ abi: PERMIT_ABI, functionName: "DOMAIN_SEPARATOR" })),
    answers(client, token.address, encodeFunctionData({ abi: EIP3009_ABI, functionName: "authorizationState", args: [zeroAddress, zeroHash] })),
  ]);
  const permit = nonces && separator;
  const stated = token.eip712Domain;
  const matches =
    symbol === token.symbol &&
    decimals === token.decimals &&
    permit === token.capabilities.eip2612 &&
    authorization === token.capabilities.eip3009 &&
    (stated === null || (stated.name === domain.name && stated.version === domain.version));
  return { name: domain.name, symbol, decimals, permit, authorization, matches };
}

/** The relayer the Status page asks about: only one that serves a chain of the edition (none serves Mezo testnet today). */
export function mezoRelayerUrl(app: App): string | null {
  return app.registry.chains.some((chain) => app.relayer.endpoint(chain.chainId) !== null) ? (app.config.relayer?.url ?? null) : null;
}

/**
 * The Relayer line when no relayer serves the edition: "Not configured" only when /config.json names none; a relayer
 * that serves other chains only (today's, for Monad testnet, Base Sepolia and Arbitrum Sepolia) "does not serve Mezo
 * testnet".
 */
export function mezoRelayerNone(app: App): string {
  return app.config.relayer === null ? app.i18n.t("status.relayer.none") : app.i18n.t("mezo.status.relayerNone");
}

/** Adds the Mezo lines: under each chain of `board` (one item per registry chain, in order), and after `relayerLine`. */
export function mezoStatus(app: App, board: HTMLElement, relayerLine: HTMLElement): void {
  const { t } = app.i18n;
  app.registry.chains.forEach((chain, index) => {
    const strip = board.children.item(index)?.querySelector(".vstrip");
    const token = chain.tokens.find((x): x is Erc20Token => x.kind === "erc20" && x.listing === "default");
    if (strip === null || strip === undefined || token === undefined) {
      return;
    }
    const tokenLine = light(t("mezo.status.token"));
    const feeLine = light(t("mezo.status.fee"));
    strip.append(tokenLine.element, feeLine.element);
    const client = app.client(chain);
    void readToken(client, chain, token).then(
      (reading) => {
        tokenLine.set(
          reading.matches ? "ok" : "err",
          reading.matches ? t("mezo.status.tokenOk", { name: reading.name, symbol: reading.symbol, decimals: reading.decimals }) : t("mezo.status.tokenErr"),
        );
      },
      () => {
        tokenLine.set("wait", t("status.code.unknown"));
      },
    );
    // A permit payment: the gas limit PayLink sets for `payWithPermit`, at the chain's current `2 × base fee + tip`.
    const gas = settlementGas(chain, "permit");
    void client.estimateFees().then(
      (fees) => {
        feeLine.set(gas === null ? "wait" : "ok", gas === null ? t("status.code.unknown") : t("mezo.status.feeValue", { sats: satsText(gas * fees.maxFeePerGas, chain.nativeCurrency.decimals, app.locale) }));
      },
      () => {
        feeLine.set("wait", t("status.code.unknown"));
      },
    );
  });
  const gasless = light(t("mezo.status.gasless"));
  gasless.set("off", t("mezo.status.gaslessValue"));
  relayerLine.after(gasless.element);
}
