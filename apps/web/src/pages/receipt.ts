// SPDX-License-Identifier: MIT
/**
 * `/r/#2.<chainId>.<txHash>.<logIndex>[.<inv>.<sig>[.<memo>]]`: a receipt anyone can verify (invoice spec §12).
 *
 * Every opening re-reads the transaction receipt from the registry's RPCs: it must have succeeded, the log at that
 * index must be a well-formed `Paid` event of the canonical deployment, in an allowlisted token, and, when the link
 * carries the invoice, its key, payee, token and amount must match. The slip states what that proves, never a bare
 * "valid": the payee and the payer in full, grouped by four, and whose address the payee is as far as this device
 * knows (`app/proof-slip.ts`: a look-alike of the viewer's own address is told apart). "Could not check" is never shown
 * as either valid or invalid. Prints on an 80 mm roll or on A6, with the full transaction hash, the chain's CAIP-2 id
 * and the receipt link with its QR code, so the paper can be checked again.
 */
import { decodeReceiptFragment, fragmentOf, verifyReceipt } from "@paylink/sdk";
import type { DecodedReceiptLink, ReceiptProof } from "@paylink/sdk";
import type { PageDefinition } from "../app/boot.ts";
import { networkName, plateText } from "../app/chains.ts";
import type { App } from "../app/context.ts";
import { identityLine, payeeIdentity, proofSlip } from "../app/proof-slip.ts";
import type { PayeeIdentity } from "../app/proof-slip.ts";
import { intro, notes } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { decodeUiError } from "../core/errors.ts";
import { receiptUrl } from "../core/links.ts";
import { receiptId } from "../store/db.ts";
import { addr, fact, hexGroups, setStatus, statusLine } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { copyText, printElement } from "../ui/live.ts";

export const receiptPage: PageDefinition = {
  route: "receipt",
  payer: true,
  title: "receipt.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(
      intro({ kicker: t("receipt.voice.kicker"), title: [t("receipt.voice.h1a"), t("receipt.voice.h1b")], lede: t("receipt.voice.lede") }),
      intro({ voice: "unverified", kicker: t("receipt.voice.invalid.kicker"), title: [t("receipt.voice.invalid.h1a"), t("receipt.voice.invalid.h1b")], lede: t("receipt.voice.invalid.lede") }),
      intro({ voice: "offline", kicker: t("receipt.voice.offline.kicker"), title: [t("receipt.voice.offline.h1a"), t("receipt.voice.offline.h1b")], lede: t("receipt.voice.offline.lede") }),
    );
    ui.aside.append(
      notes(t("receipt.notes.title"), [
        [t("receipt.notes.proves"), t("receipt.notes.provesText")],
        [t("receipt.notes.identity"), t("receipt.notes.identityText")],
      ]),
    );
    const view = h("section", { class: "view view-receipt", attrs: { "aria-labelledby": "receipt-head" } });
    ui.views.append(view);
    const show = (): void => {
      void renderReceipt(app, ui, view);
    };
    window.addEventListener("hashchange", show);
    show();
  },
};

async function renderReceipt(app: App, ui: PageUi, view: HTMLElement): Promise<void> {
  const { t } = app.i18n;
  ui.voice(null);
  const head = h("div", { class: "view-head" }, h("h2", { attrs: { id: "receipt-head" } }, t("receipt.head")));
  const status = statusLine();
  const fragment = fragmentOf(location.href);
  if (fragment === "") {
    ui.plate(t("receipt.plate.empty"), "off");
    replace(view, head, h("p", { class: "state-note" }, t("receipt.empty")));
    return;
  }
  let decoded: DecodedReceiptLink;
  try {
    decoded = decodeReceiptFragment(fragment, app.registry);
  } catch (error) {
    ui.voice("unverified");
    ui.plate(t("pay.plate.invalid"), "err");
    const problem = decodeUiError(app, error);
    setStatus(status, "err", problem.message, problem.code);
    replace(view, head, status);
    return;
  }
  const chain = decoded.target.chain;
  ui.plate(plateText(chain), "wait");
  setStatus(status, "", t("receipt.checking", { network: networkName(chain) }));
  replace(view, head, status);
  const client = app.client(chain);
  let verification: Awaited<ReturnType<typeof verifyReceipt>>;
  try {
    verification = await verifyReceipt({ registry: app.registry, client, reference: decoded, ...(decoded.invoice === null ? {} : { paid: decoded.invoice }) });
  } catch {
    ui.voice("offline");
    setStatus(status, "warn", t("receipt.unreachable", { network: networkName(chain) }));
    view.append(h("div", { class: "key-row" }, h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { void renderReceipt(app, ui, view); } } }, t("common.retry"))));
    return;
  }
  if (!verification.valid) {
    ui.voice("unverified");
    ui.plate(plateText(chain), "err");
    const message = app.i18n.lookup(verification.i18nKey, verification.params) ?? t("error.unknown");
    setStatus(status, "err", message, t("common.errorCode", { code: verification.failure }));
    return;
  }
  ui.plate(plateText(chain), "ok");
  setStatus(status, "ok", verification.proof.finality === "finalized" ? t("receipt.status.final") : t("receipt.status.confirmed"));
  // Whose address the payee is: the account signed in here (restored silently, never a prompt) or a saved contact.
  const identity = await payeeIdentity(app, verification.proof);
  if (identity.kind === "you") {
    await app.store.putReceipt({
      id: receiptId(decoded.chainId, decoded.txHash, decoded.logIndex),
      chainId: decoded.chainId,
      txHash: decoded.txHash,
      logIndex: decoded.logIndex,
      role: "received",
      invoiceKey: verification.proof.key,
      payee: verification.proof.payee,
      payer: verification.proof.payer,
      token: verification.proof.token,
      amount: verification.proof.amount.toString(),
      blockTime: Number(verification.proof.timestamp),
      fragment,
      savedAt: Date.now(),
    });
  }
  const shown = proofView(app, decoded, verification.proof, fragment, identity);
  view.append(...shown);
  // Connecting (or switching account) here re-reads whose address the payee is: no reload needed to be told.
  const slip = shown[0];
  const proof = verification.proof;
  app.session.subscribe(() => {
    if (slip?.isConnected === true) {
      void payeeIdentity(app, proof).then((next) => {
        paintIdentity(app, slip, next);
      });
    }
  });
}

function proofView(app: App, decoded: DecodedReceiptLink, proof: ReceiptProof, fragment: string, identity: PayeeIdentity): HTMLElement[] {
  const { t } = app.i18n;
  const chain = decoded.target.chain;
  const token = proof.tokenInfo;
  const explorer = chain.explorers[0];
  const url = receiptUrl(app.site, fragment);
  const slip = proofSlip(app, {
    proof,
    chain,
    url,
    identity,
    checks: [
      ["ok", t("receipt.check.paid")],
      ["ok", t("receipt.check.contract")],
      [proof.invoice === null ? "off" : "ok", proof.invoice === null ? t("receipt.check.noInvoice") : t("receipt.check.invoice")],
      [proof.finality === "finalized" ? "ok" : "wait", proof.finality === "finalized" ? t("receipt.finalized") : t("receipt.confirmed")],
    ],
  });
  const copy = h("button", { class: "key key-line", attrs: { type: "button" } }, t("receipt.copy"));
  copy.addEventListener("click", () => {
    void copyText(url, copy, { idle: t("receipt.copy"), done: t("share.copied"), said: t("receipt.copiedSaid") });
  });
  return [
    slip,
    h(
      "div",
      { class: "share-keys" },
      h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { void printSlip(app, slip, "80mm"); } } }, t("receipt.print80")),
      h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { void printSlip(app, slip, "a6"); } } }, t("receipt.printA6")),
      copy,
      explorer === undefined ? null : h("a", { class: "key key-line ext", attrs: { href: `${explorer.url}/tx/${proof.txHash}`, target: "_blank", rel: "noopener noreferrer" } }, t("receipt.explorer")),
    ),
    h(
      "details",
      { class: "details" },
      h("summary", null, t("details.title")),
      h(
        "dl",
        null,
        fact(t("receipt.to"), addr(proof.payee)),
        fact(t("receipt.from"), addr(proof.payer)),
        fact(t("details.chain"), `${networkName(chain)} · ${chain.caip2}`),
        fact(t("details.contract"), proof.contract),
        fact(t("details.token"), `${token.symbol} · ${token.address}`),
        fact(t("details.key"), hexGroups(proof.key)),
        fact(t("details.tx"), hexGroups(proof.txHash)),
        fact(t("details.block"), proof.blockNumber.toString()),
        fact(t("details.logIndex"), String(proof.logIndex)),
        fact(t("details.payerRef"), hexGroups(proof.payerRef)),
      ),
    ),
  ];
}

/** Draws the receipt link's QR code into the slip's paper-only block, once (the QR library loads on first use). */
export async function drawSlipQr(app: Pick<App, "i18n">, slip: HTMLElement): Promise<void> {
  const frame = slip.querySelector<HTMLElement>(".receipt-verify .qr-frame[data-qr]");
  const url = frame?.getAttribute("data-qr") ?? null;
  if (frame === null || url === null || frame.childElementCount > 0) {
    return;
  }
  const { qrSvg } = await import("../ui/qr.ts");
  frame.append(qrSvg(url, app.i18n.t("receipt.qrLabel")));
}

/** Prints the slip on an 80 mm roll or on A6, with its QR code drawn first. */
export async function printSlip(app: Pick<App, "i18n">, slip: HTMLElement, size: "80mm" | "a6"): Promise<void> {
  await drawSlipQr(app, slip);
  printElement(slip, size);
}

/** Repaints the slip's identity line, when the account signed in here changes (the payee connects on the receipt). */
function paintIdentity(app: App, slip: HTMLElement, identity: PayeeIdentity): void {
  const line = slip.querySelector(".receipt-who");
  if (line !== null) {
    const who = identityLine(app, identity);
    line.setAttribute("data-lamp", who.lamp);
    line.textContent = who.text;
  }
}
