// SPDX-License-Identifier: MIT
/**
 * "Was I really paid?" on the Mezo ledger (Wave 2): the merchant pastes what a client sent, and the answer comes from
 * Mezo testnet alone (`verify.ts`): Paid, with the amount, the token, the block, the time and the invoice it paid;
 * Not received; Pending; or Can't tell yet, with the reason. In the Precision Terminal's existing grammar (a view, a
 * field, a key, lamps, facts, amber and red notes); called only from a branch the build folds to the Mezo edition.
 */
import { explorerBlockUrl, explorerTxUrl } from "@paylink/chains";
import type { ChainDefinition } from "@paylink/chains";
import { formatDateTime } from "@paylink/i18n";
import type { Hex } from "viem";
import type { App } from "../../app/context.ts";
import { pickWallet } from "../../app/wallet-ui.ts";
import { displayAmount, shortHex } from "../../core/format.ts";
import { editionChains } from "../../core/registry.ts";
import { deviceInvoices } from "../../read/ledger.ts";
import { ext, fact, lamp } from "../../ui/atoms.ts";
import type { LampKind } from "../../ui/atoms.ts";
import { h, replace } from "../../ui/h.ts";
import type { Child } from "../../ui/h.ts";
import { checkPayment, CHECK_MAX_TEXT } from "./verify.ts";
import type { CheckResult, Finding, Verdict } from "./verify.ts";

const VERDICT: Readonly<Record<Verdict, { readonly lamp: LampKind; readonly label: "mezo.check.verdict.paid" | "mezo.check.verdict.notReceived" | "mezo.check.verdict.pending" | "mezo.check.verdict.unknown" }>> = {
  paid: { lamp: "paid", label: "mezo.check.verdict.paid" },
  "not-received": { lamp: "err", label: "mezo.check.verdict.notReceived" },
  pending: { lamp: "wait", label: "mezo.check.verdict.pending" },
  unknown: { lamp: "off", label: "mezo.check.verdict.unknown" },
};

/** The Mezo chain the check reads: the edition's chain with a PayLinkV2 deployment. */
function checkedChain(app: App): ChainDefinition | undefined {
  return editionChains(app.registry).find((c) => c.deployed)?.chain;
}

const refText = (ref: string): string => (ref.startsWith("0x") ? shortHex(ref as Hex) : ref);

/** The panel (a view of the ledger page). */
export function checkPanel(app: App): HTMLElement {
  const { t } = app.i18n;
  const input = h("textarea", { attrs: { id: "check-text", rows: "4", maxlength: String(CHECK_MAX_TEXT), spellcheck: "false", placeholder: t("mezo.check.placeholder"), "aria-describedby": "check-hint" } });
  const out = h("div", { class: "check-out", attrs: { "aria-live": "polite" } });
  const key = h("button", { class: "key key-primary", attrs: { type: "button" } }, t("mezo.check.key"));
  const run = async (): Promise<void> => {
    const account = app.session.account();
    const chain = checkedChain(app);
    if (account === null) {
      replace(out, h("p", { class: "warn-note" }, t("mezo.check.connect")), h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { void pickWallet(app); } } }, t("app.connect")));
      return;
    }
    if (input.value.trim() === "" || chain === undefined) {
      replace(out, h("p", { class: "warn-note" }, t(chain === undefined ? "mezo.check.unavailable" : "mezo.check.empty")));
      return;
    }
    key.disabled = true;
    replace(out, h("p", { class: "loading", attrs: { role: "status" } }, t("mezo.check.reading")));
    try {
      const invoices = (await deviceInvoices({ store: app.store, registry: app.registry, payee: account.address, role: "issued" })).rows.map((row) => row.link).filter((link) => link.chainId === chain.chainId);
      const result = await checkPayment(input.value, { registry: app.registry, chainId: chain.chainId, client: app.client(chain), merchant: account.address, invoices, host: new URL(app.site.origin).host });
      replace(out, renderResult(app, chain, result));
    } catch {
      replace(out, h("p", { class: "warn-note" }, t("mezo.check.unavailable")));
    } finally {
      key.disabled = false;
    }
  };
  key.addEventListener("click", () => {
    void run();
  });
  return h(
    "section",
    { class: "view view-check", attrs: { id: "check", "aria-labelledby": "check-head" } },
    h("div", { class: "view-head" }, h("h2", { attrs: { id: "check-head" } }, t("mezo.check.title"))),
    h("p", { class: "state-note" }, t("mezo.check.lede")),
    h("div", { class: "field" }, h("label", { attrs: { for: "check-text" } }, t("mezo.check.label")), input, h("p", { class: "field-hint", attrs: { id: "check-hint" } }, t("mezo.check.hint"))),
    key,
    out,
  );
}

/** One line per finding that is not a payment to this merchant. */
function findingLine(app: App, finding: Exclude<Finding, { kind: "paid" }>): string {
  const { t } = app.i18n;
  switch (finding.kind) {
    case "other-payee":
      return t(finding.source === "invoice" || finding.source === "amount" ? "mezo.check.find.notYours" : "mezo.check.find.otherPayee", { ref: refText(finding.ref), payee: shortHex(finding.payee) });
    case "other-invoice":
      return t("mezo.check.find.otherInvoice", { ref: refText(finding.ref), invoice: finding.memo ?? shortHex(finding.key) });
    case "unpaid":
      return t(finding.cancelled ? "mezo.check.find.cancelled" : "mezo.check.find.unpaid", { invoice: finding.memo ?? shortHex(finding.key) });
    case "no-tx":
      return t("mezo.check.find.noTx", { ref: refText(finding.ref) });
    case "pending":
      return t("mezo.check.find.pending", { ref: refText(finding.ref) });
    case "reverted":
      return t("mezo.check.find.reverted", { ref: refText(finding.ref) });
    case "not-paylink":
      return t("mezo.check.find.notPaylink", { ref: refText(finding.ref) });
    case "forged":
      return t("mezo.check.find.forged", { ref: refText(finding.ref), why: app.i18n.lookup(finding.i18nKey, finding.params) ?? "" });
    case "bad-link":
      return t("mezo.check.find.badLink", { host: finding.host });
    case "unavailable":
      return t("mezo.check.find.unavailable", { ref: refText(finding.ref) });
  }
}

function renderResult(app: App, chain: ChainDefinition, result: CheckResult): HTMLElement {
  const { t } = app.i18n;
  const verdict = VERDICT[result.verdict];
  const explorer = chain.explorers[0];
  const lede =
    result.verdict === "paid"
      ? t("mezo.check.paid")
      : result.verdict === "not-received"
        ? t("mezo.check.notReceived")
        : result.verdict === "pending"
          ? t("mezo.check.pending")
          : t(result.reason === "unavailable" ? "mezo.check.unavailable" : "mezo.check.nothing");
  const blocks: Child[] = [];
  for (const finding of result.findings) {
    if (finding.kind !== "paid") {
      continue;
    }
    const symbol = finding.token.symbol;
    blocks.push(
      h(
        "div",
        { class: "details check-paid" },
        h(
          "dl",
          null,
          fact(t("mezo.check.fact.amount"), h("b", null, `${displayAmount(finding.amount, finding.token, app.locale)} ${symbol}`), finding.payments > 1 ? h("span", { class: "sub" }, t("mezo.check.payments", { count: finding.payments })) : null),
          fact(t("mezo.check.fact.invoice"), finding.memo ?? shortHex(finding.key), h("span", { class: "sub" }, t("mezo.check.toYou")), finding.source === "amount" ? h("span", { class: "sub" }, t("mezo.check.byAmount")) : null),
          fact(t("mezo.check.fact.time"), formatDateTime(app.locale, finding.timestamp)),
          fact(t("mezo.check.fact.block"), finding.blockNumber === null ? "—" : explorer === undefined ? finding.blockNumber.toString() : ext(explorerBlockUrl(explorer, finding.blockNumber), finding.blockNumber.toString())),
          finding.txHash === null ? null : fact(t("mezo.check.fact.tx"), explorer === undefined ? shortHex(finding.txHash) : ext(explorerTxUrl(explorer, finding.txHash), shortHex(finding.txHash))),
          finding.payer === null ? null : fact(t("mezo.check.fact.from"), shortHex(finding.payer)),
        ),
      ),
    );
  }
  const others = result.findings.filter((f): f is Exclude<Finding, { kind: "paid" }> => f.kind !== "paid");
  return h(
    "div",
    { class: "check-result", attrs: { "data-verdict": result.verdict } },
    h("p", { class: "state-note check-verdict" }, lamp(verdict.lamp, t(verdict.label), true)),
    h("p", { class: result.verdict === "paid" ? "state-note" : result.verdict === "not-received" ? "warn-note is-err" : "warn-note" }, lede),
    blocks,
    result.amountMismatch
      ? h("p", { class: "warn-note" }, t("mezo.check.mismatch", { claimed: result.claimed.map((c) => `${c.value} ${c.unit}`).join(", ") }))
      : null,
    others.length === 0 ? null : h("ul", { class: "note-list check-findings" }, others.map((f) => h("li", null, findingLine(app, f)))),
    result.foreignHosts.length === 0 ? null : h("p", { class: "warn-note is-err" }, t("mezo.check.foreign", { host: result.foreignHosts.join(", ") })),
  );
}
