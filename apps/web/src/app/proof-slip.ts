// SPDX-License-Identifier: MIT
/**
 * The verified receipt slip, shared by the payer's view (just paid) and `/r/` (any receipt link). It shows what the
 * chain proves, in the terms of invoice spec §12 ("a verifier MUST display what the receipt proves: the payee …") and
 * §14.4 ("show the full address grouped in fours … never truncate"):
 *
 * - **Payee and payer in full**, grouped by four with the first and last groups bold, on screen and on paper. A short
 *   `0x90F8…c9C1` is 32 bits, which an address grinder matches in minutes: a fraudster could pay a look-alike of the
 *   merchant's address from his own invoice and show the merchant a genuine "Approved" receipt (THREAT_MODEL T-43).
 * - **Whose address that is**, from this device's own records and on screen only: the account signed in here ("Paid
 *   to you"), a saved contact ("Paid to Rakoto Design, a saved contact"), the payer's own payment ("Paid by you"), or,
 *   when an account is signed in and the payee is not it, an amber "Not paid to you". With no account and no contact,
 *   the line asks for the group-by-group comparison.
 * - **What re-proves the paper**: on screen the transaction stays short, with its explorer link; on paper the slip also
 *   carries the full transaction hash, the chain's CAIP-2 id, and the receipt link with its QR code (the same QR
 *   renderer as the receive card), so anyone holding the paper can check it against the network again. The QR code is
 *   drawn when the slip is printed (`pages/receipt.ts`): its library stays off the pay route (110 kB budget, spec §4.4).
 */
import type { ChainDefinition } from "@paylink/chains";
import { formatDateTime } from "@paylink/i18n";
import { sanitizeMemoForDisplay } from "@paylink/sdk";
import type { ReceiptProof } from "@paylink/sdk";
import type { Address } from "viem";
import { displayAmount, shortHex } from "../core/format.ts";
import { parseStoredContact } from "../store/db.ts";
import { addr, ext, hexGroups, lamp, num, unit } from "../ui/atoms.ts";
import type { LampKind } from "../ui/atoms.ts";
import { h } from "../ui/h.ts";
import type { App } from "./context.ts";

/** Whose address the payee is, as far as this device knows. */
export type PayeeIdentity =
  /** The account signed in here received it. */
  | { readonly kind: "you" }
  /** The account signed in here paid it; `label` is the payee's saved contact name, if any. */
  | { readonly kind: "by-you"; readonly label: string | null }
  /** The payee is a saved contact (and the account signed in here, if any, is neither party). */
  | { readonly kind: "contact"; readonly label: string }
  /** An account is signed in here, and the payee is another address that is not a saved contact. */
  | { readonly kind: "not-you" }
  /** Nothing to compare with: no account signed in here, no saved contact. */
  | { readonly kind: "unknown" };

const same = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase();

/** Reads the identity from the session (restored silently, never a prompt) and the address book. */
export async function payeeIdentity(app: App, proof: Pick<ReceiptProof, "payee" | "payer">): Promise<PayeeIdentity> {
  await app.session.ready;
  const account = app.session.account()?.address ?? null;
  const label = (await app.store.listContacts().catch(() => [])).map(parseStoredContact).find((c) => c !== null && same(c.address, proof.payee))?.label ?? null;
  return account !== null && same(account, proof.payee)
    ? { kind: "you" }
    : account !== null && same(account, proof.payer)
      ? { kind: "by-you", label }
      : label !== null
        ? { kind: "contact", label }
        : { kind: account === null ? "unknown" : "not-you" };
}

/** The identity line in words, with its lamp: green when this device knows the payee, amber when it is not you. */
export function identityLine(app: Pick<App, "i18n">, identity: PayeeIdentity): { readonly lamp: "ok" | "wait" | "off"; readonly text: string } {
  const { t } = app.i18n;
  switch (identity.kind) {
    case "you":
      return { lamp: "ok", text: t("receipt.who.you") };
    case "by-you":
      return { lamp: "ok", text: identity.label === null ? t("receipt.who.byYou") : t("receipt.who.byYouTo", { label: identity.label }) };
    case "contact":
      return { lamp: "ok", text: t("receipt.who.contact", { label: identity.label }) };
    case "not-you":
      return { lamp: "wait", text: t("receipt.who.notYou") };
    case "unknown":
      return { lamp: "off", text: t("receipt.who.unknown") };
  }
}

export interface ProofSlipInput {
  readonly proof: ReceiptProof;
  readonly chain: ChainDefinition;
  /** The receipt link, printed in full on paper with its QR code. */
  readonly url: string;
  readonly identity: PayeeIdentity;
  readonly checks: readonly (readonly [LampKind, string])[];
}

const printable = (url: string): string => url.replace(/^https?:\/\//, "");

/** One row of the slip: a label and its reading; `only` keeps it to the screen or to paper. */
function row(term: string, value: Parameters<typeof h>[2], only?: "screen" | "print"): HTMLElement {
  return h("div", { class: only === undefined ? null : `only-${only}` }, h("dt", null, term), h("dd", null, value));
}

/** The verified receipt slip (v1 `.receipt` + `.perf` grammar: paper in both themes, a zig-zag tear edge, a printer slot). */
export function proofSlip(app: App, input: ProofSlipInput): HTMLElement {
  const { t } = app.i18n;
  const { proof, chain } = input;
  const token = proof.tokenInfo;
  const explorer = chain.explorers[0];
  const memo = proof.memo === null ? null : sanitizeMemoForDisplay(proof.memo);
  const amount = displayAmount(proof.amount, token, app.locale);
  const who = identityLine(app, input.identity);
  return h(
    "div",
    { class: "receipt-wrap" },
    h(
      "div",
      { class: "receipt", attrs: { role: "group", "aria-label": t("receipt.label") } },
      h("div", { class: "receipt-top" }, h("span", null, t("receipt.top")), h("b", null, t("receipt.approved"))),
      h("p", { class: "receipt-who only-screen", attrs: { "data-lamp": who.lamp } }, who.text),
      h("div", { class: "receipt-amt" }, num(amount), unit(token.symbol)),
      h(
        "dl",
        null,
        memo === null ? null : row(t("receipt.for"), memo),
        row(t("receipt.to"), addr(proof.payee)),
        row(t("receipt.from"), addr(proof.payer)),
        row(t("receipt.time"), formatDateTime(app.locale, proof.timestamp)),
        row(t("receipt.network"), `${chain.label} · ${String(chain.chainId)}`),
        row(t("receipt.chain"), chain.caip2, "print"),
        row(t("receipt.tx"), explorer === undefined ? shortHex(proof.txHash) : ext(`${explorer.url}/tx/${proof.txHash}`, shortHex(proof.txHash)), "screen"),
        row(t("receipt.tx"), hexGroups(proof.txHash), "print"),
        row(t("details.logIndex"), String(proof.logIndex), "print"),
      ),
      h("div", { class: "checks-mini" }, input.checks.map(([kind, text]) => lamp(kind, text))),
      h(
        "div",
        { class: "receipt-verify only-print" },
        h("div", { class: "qr-frame", attrs: { "data-qr": input.url } }),
        h("div", { class: "receipt-verify-cap" }, h("b", null, t("receipt.verifyTitle")), h("span", null, t("receipt.verifyText")), h("code", { class: "printed-url" }, printable(input.url))),
      ),
      h("p", { class: "receipt-foot" }, t("receipt.foot", { network: chain.name })),
    ),
  );
}
