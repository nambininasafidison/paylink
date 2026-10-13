// SPDX-License-Identifier: MIT
/**
 * The Mezo edition's own pieces, in the Precision Terminal's existing grammar (no stylesheet of their own):
 *
 * - the lead's notes on MUSD and the BTC network fee, and the test-MUSD walkthrough (Mezo's own pages only);
 * - the payer's rows when the wallet lacks MUSD (borrowed, never from a faucet) or BTC for the fee;
 * - the fee line under the route: about what the payment costs in BTC, from the chain's current fees.
 *
 * Facts and their sources: docs/research/mezo.md (§4 MUSD, §8 test funds, §11 routes). Called only from branches the
 * build folds to the Mezo edition, so no other edition carries this module.
 */
import type { ChainDefinition, PayLinkFunction, Token } from "@paylink/chains";
import { LOCALE_INFO } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";
import { approveCall, gasLimitFor } from "@paylink/sdk";
import type { DecodedInvoiceLink, PaymentPath } from "@paylink/sdk";
import type { Address } from "viem";
import type { App } from "../../app/context.ts";
import type { ChainClient } from "../../core/clients.ts";
import { displayAmount } from "../../core/format.ts";
import { ext } from "../../ui/atoms.ts";
import { h } from "../../ui/h.ts";
import type { Child } from "../../ui/h.ts";
import { MEZO_LINKS } from "./links.ts";

/** "Links: a · b" at the end of a sentence: each an external link, the drawn arrow included. */
function links(...items: readonly (readonly [string, string])[]): Child[] {
  return items.flatMap(([href, label], i) => [i === 0 ? " " : " · ", ext(href, label)]);
}

/** The lead's notes: what MUSD is, who pays the BTC fee and why PayLink cannot, and the issuer's powers. */
export function mezoNotes(app: App): HTMLElement {
  const { t } = app.i18n;
  const items: readonly (readonly [string, string])[] = [
    [t("mezo.notes.musd"), t("mezo.notes.musdText")],
    [t("mezo.notes.fee"), t("mezo.notes.feeText")],
    [t("mezo.notes.gasless"), t("mezo.notes.gaslessText")],
    [t("mezo.notes.issuer"), t("mezo.notes.issuerText")],
  ];
  return h(
    "aside",
    { class: "about notes", attrs: { "aria-labelledby": "mezo-notes" } },
    h("h2", { class: "eyebrow", attrs: { id: "mezo-notes" } }, t("mezo.notes.title")),
    h("ul", { class: "note-list" }, items.map(([bold, text]) => h("li", null, h("b", null, bold), " ", text))),
  );
}

/** Test BTC, borrowed test MUSD, then paying: Mezo's faucet, Discord and testnet app, in the lead's step grammar. */
export function mezoTestSteps(app: App): HTMLElement {
  const { t } = app.i18n;
  const items: readonly (readonly [string, string, Child[] | null])[] = [
    [t("mezo.test.btc"), t("mezo.test.btcText"), links([MEZO_LINKS.faucet, t("mezo.link.faucet")], [MEZO_LINKS.discord, t("mezo.link.discord")])],
    [t("mezo.test.borrow"), t("mezo.test.borrowText"), [...links([MEZO_LINKS.borrow, t("mezo.link.borrow")]), ". ", t("mezo.test.borrowAlt"), " ", ext(MEZO_LINKS.borrowAlt, "mezo.org"), "."]],
    [t("mezo.test.pay"), t("mezo.test.payText"), null],
  ];
  return h(
    "aside",
    { class: "about", attrs: { "aria-labelledby": "mezo-test" } },
    h("h2", { class: "eyebrow", attrs: { id: "mezo-test" } }, t("mezo.test.title")),
    h(
      "ol",
      { class: "steps" },
      items.map(([name, text, more], i) =>
        h("li", null, h("span", { class: "step-n" }, String(i + 1).padStart(2, "0")), h("b", null, name), h("p", null, text), more === null ? null : h("p", { class: "step-links" }, ...more)),
      ),
    ),
  );
}

/** The payer's row when the wallet holds too little MUSD: test MUSD is borrowed against test BTC, no faucet gives it. */
export function musdFundsRow(app: App, token: Token, balance: bigint): HTMLElement {
  const { t } = app.i18n;
  return h(
    "div",
    { class: "funds" },
    h("p", { class: "funds-held" }, t("funds.held", { amount: displayAmount(balance, token, app.locale), symbol: token.symbol })),
    h("p", { class: "funds-how" }, t("mezo.funds.musd"), ...links([MEZO_LINKS.borrow, t("mezo.link.borrow")], [MEZO_LINKS.faucet, t("mezo.link.faucet")])),
  );
}

/** The payer's row when the wallet holds no BTC for the fee (the router's `needs-gas`): Mezo's faucet. */
export function btcFundsRow(app: App, chain: ChainDefinition): HTMLElement {
  const { t } = app.i18n;
  const coin = chain.nativeCurrency;
  return h(
    "div",
    { class: "funds funds-btc" },
    h("p", { class: "funds-held" }, t("funds.held", { amount: displayAmount(0n, { decimals: coin.decimals }, app.locale), symbol: coin.symbol })),
    h("p", { class: "funds-how" }, t("mezo.funds.btc"), ...links([MEZO_LINKS.faucet, t("mezo.link.faucet")], [MEZO_LINKS.discord, t("mezo.link.discord")])),
  );
}

/**
 * `value` base units of a coin with `decimals` as satoshis (10^-8 of the coin), to two significant digits, rounded
 * half up, with the language's decimal separator: integer arithmetic only.
 */
export function satsText(value: bigint, decimals: number, locale: Locale): string {
  const scale = decimals - 8;
  if (value <= 0n) {
    return "0";
  }
  const digits = value.toString().length;
  const drop = BigInt(Math.max(0, digits - 2));
  const unitOf = 10n ** drop;
  const rounded = ((value + unitOf / 2n) / unitOf) * unitOf;
  const text = rounded.toString().padStart(scale + 1, "0");
  const whole = text.slice(0, text.length - scale) || "0";
  const fraction = scale > 0 ? text.slice(text.length - scale).replace(/0+$/, "") : "";
  return fraction === "" ? whole : `${whole}${LOCALE_INFO[locale].decimalSeparator}${fraction}`;
}

/** The PayLink function each wallet path settles with, and whether an approve transaction comes first. */
const SETTLES: Readonly<Partial<Record<PaymentPath, { readonly fn: PayLinkFunction; readonly approve: boolean }>>> = {
  permit: { fn: "payWithPermit", approve: false },
  "approve-pay": { fn: "pay", approve: true },
  "batched-approve-pay": { fn: "pay", approve: true },
};

/** The gas limit PayLink sets for the settlement call of `path` when it uses its measured gas, or `null` (no wallet path). */
export function settlementGas(chain: ChainDefinition, path: PaymentPath): bigint | null {
  const settles = SETTLES[path];
  if (settles === undefined || chain.gas === null) {
    return null;
  }
  return gasLimitFor(chain, settles.fn, chain.gas.limits[settles.fn].floor);
}

/**
 * An upper estimate of a payment's network fee, in the gas coin's base units: the gas limit PayLink sets for the
 * settlement call when it uses its measured gas (`clamp(floor × 1.10, floor, ceiling)`), plus the approve's own
 * estimate × 1.10 when one comes first, times the chain's current `2 × base fee + tip`. Mezo charges at least half
 * the gas limit and at most all of it, so the payer pays no more than this at today's price.
 */
export async function feeUpperBound(client: Pick<ChainClient, "estimateFees" | "estimateGas">, chain: ChainDefinition, path: PaymentPath, link: DecodedInvoiceLink, payer: Address, amount: bigint): Promise<bigint | null> {
  const settle = settlementGas(chain, path);
  if (settle === null) {
    return null;
  }
  let approve = 0n;
  if (SETTLES[path]?.approve === true && link.token.kind === "erc20") {
    // An open amount not typed yet: approving 1 base unit writes the same allowance slot, so it costs the same gas.
    const call = approveCall(link.token.address, link.target.deployment.address, amount > 0n ? amount : 1n);
    const estimated = await client.estimateGas({ from: payer, to: call.to, data: call.data, value: 0n });
    approve = (estimated * 110n + 99n) / 100n;
  }
  const fees = await client.estimateFees();
  return (settle + approve) * fees.maxFeePerGas;
}

/** The fee lines a pay view shows, by the route note they follow. */
const feeNotes = new WeakMap<HTMLElement, HTMLElement>();

/**
 * Under the route note: "Network fee: about 0.0038 sat, paid in BTC by your wallet", for the route the router picked
 * (`null`: none, the line goes). Read in the background; a network that does not answer leaves no line.
 */
export function showFee(app: App, routeNote: HTMLElement, input: { readonly chain: ChainDefinition; readonly client: ChainClient; readonly path: PaymentPath | null; readonly link: DecodedInvoiceLink; readonly payer: Address; readonly amount: bigint }): void {
  const { t } = app.i18n;
  let note = feeNotes.get(routeNote);
  if (note === undefined) {
    note = h("p", { class: "route-note fee-note", attrs: { title: t("mezo.fee.basis") } });
    feeNotes.set(routeNote, note);
    routeNote.after(note);
  }
  const line = note;
  line.textContent = "";
  if (input.path === null) {
    return;
  }
  const asked = input.path;
  line.dataset["path"] = asked;
  void feeUpperBound(input.client, input.chain, asked, input.link, input.payer, input.amount)
    .then((fee) => {
      if (line.dataset["path"] === asked) {
        line.textContent = fee === null ? "" : t("mezo.fee.line", { sats: satsText(fee, input.chain.nativeCurrency.decimals, app.locale) });
      }
    })
    .catch(() => {
      line.textContent = "";
    });
}
