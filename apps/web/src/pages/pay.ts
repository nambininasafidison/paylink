// SPDX-License-Identifier: MIT
/**
 * `/pay/#2.<chainId>.<inv>.<sig>[.<memo>]`: the payer's view (invoice spec §13.2).
 *
 * The fragment is decoded strictly against the edition's registry (the contract address never comes from the link),
 * then four lamps are lit from the chain: signature, network, genuine contract, still payable. Any red lamp locks the
 * Pay key; an unknown one keeps it waiting. The payee is shown grouped by four with any saved label, or with the amber
 * "first payment to this address" warning. The memo is the sender's own words, stripped of bidi and control
 * characters and labelled as such. Payer copy says "digital dollars", never "blockchain".
 *
 * Payment: the SDK's PaymentRouter ranks the paths for the token and the payer's account; the first one a ready rail
 * of the edition can execute is used (T0: the payer's wallet, `permit` or `approve-pay`). The outcome is verified as a
 * receipt on the chain before "Approved" lights.
 */
import type { ChainDefinition, Token } from "@paylink/chains";
import { formatDateTime, formatSeconds } from "@paylink/i18n";
import {
  DEFAULT_AUTHORIZATION_TTL_SECONDS,
  decodeInvoiceFragment,
  encodeReceiptFragment,
  fragmentOf,
  predictPayment,
  readLinkState,
  sanitizeMemoForDisplay,
  verifyReceipt,
  ZERO_HASH,
} from "@paylink/sdk";
import type { DecodedInvoiceLink, PaymentPath, SettlementFunction } from "@paylink/sdk";
import type { Address } from "viem";
import type { AccountProvider } from "../accounts/types.ts";
import type { PageDefinition } from "../app/boot.ts";
import { networkName, plateText } from "../app/chains.ts";
import type { App } from "../app/context.ts";
import { intro, steps } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { showFundsIfShort } from "../app/funds.ts";
import { choosePath } from "../app/payer.ts";
import type { PathChoice } from "../app/payer.ts";
import { pickWallet } from "../app/wallet-ui.ts";
import { chainTime } from "../core/clients.ts";
import type { ChainClient } from "../core/clients.ts";
import { AppError, decodeUiError } from "../core/errors.ts";
import { displayAmount, parseTypedAmount, shortHex } from "../core/format.ts";
import { ariaryLabel } from "../core/fx.ts";
import { receiptUrl } from "../core/links.ts";
import { RelayFallbackError } from "../rails/authorization.ts";
import type { PaymentStep } from "../rails/types.ts";
import { checkLink } from "../read/checks.ts";
import type { LinkChecks } from "../read/checks.ts";
import { parseStoredContact, parseStoredReceipt, receiptId } from "../store/db.ts";
import { addr, ext, fact, hexGroups, lamp, num, setStatus, statusLine, unit } from "../ui/atoms.ts";
import type { LampKind } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { announce, copyText } from "../ui/live.ts";
import { receiptSlip } from "../ui/receipt.ts";
import { signingDisplay } from "../ui/signing.ts";

const SETTLEMENT_FN: Readonly<Partial<Record<PaymentPath, SettlementFunction>>> = {
  permit: "payWithPermit",
  "approve-pay": "pay",
  "batched-approve-pay": "pay",
  native: "payNative",
  "relayed-authorization": "payWithAuthorization",
  "self-authorization": "payWithAuthorization",
};

export const payPage: PageDefinition = {
  route: "pay",
  payer: true,
  title: "pay.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    const specs: [string, string][] = [
      [t("pay.spec.fee"), "0%"],
      [t("pay.spec.custody"), t("common.none")],
      [t("pay.spec.checks"), "4"],
      [t("pay.spec.signup"), t("common.none")],
    ];
    ui.intro.append(
      intro({ kicker: t("pay.voice.bill.kicker"), title: [t("pay.voice.bill.h1a"), t("pay.voice.bill.h1b")], lede: t("pay.voice.bill.lede"), specs }),
      intro({ voice: "open-amount", kicker: t("pay.voice.open.kicker"), title: [t("pay.voice.open.h1a"), t("pay.voice.open.h1b")], lede: t("pay.voice.open.lede"), specs }),
      intro({ voice: "paid", kicker: t("pay.voice.paid.kicker"), title: [t("pay.voice.paid.h1a"), t("pay.voice.paid.h1b")], lede: t("pay.voice.paid.lede") }),
      intro({ voice: "settled", kicker: t("pay.voice.settled.kicker"), title: [t("pay.voice.settled.h1a"), t("pay.voice.settled.h1b")], lede: t("pay.voice.settled.lede") }),
      intro({ voice: "error", kicker: t("pay.voice.error.kicker"), title: [t("pay.voice.error.h1a"), t("pay.voice.error.h1b")], lede: t("pay.voice.error.lede") }),
      intro({ voice: "offline", kicker: t("pay.voice.offline.kicker"), title: [t("pay.voice.offline.h1a"), t("pay.voice.offline.h1b")], lede: t("pay.voice.offline.lede") }),
    );
    ui.aside.append(
      steps(t("pay.how"), [
        [t("pay.step1.title"), t("pay.step1.text")],
        [t("pay.step2.title"), t("pay.step2.text")],
        [t("pay.step3.title"), t("pay.step3.text")],
      ]),
    );
    const view = h("section", { class: "view view-pay", attrs: { "aria-labelledby": "pay-head" } });
    ui.views.append(view);
    const show = (): void => {
      renderPay(app, ui, view);
    };
    window.addEventListener("hashchange", show);
    show();
  },
};

function renderPay(app: App, ui: PageUi, view: HTMLElement): void {
  const { t } = app.i18n;
  ui.voice(null);
  const fragment = fragmentOf(location.href);
  const head = h("h2", { class: "sr-only", attrs: { id: "pay-head" } }, t("pay.head"));
  if (fragment === "") {
    ui.plate(t("pay.plate.empty"), "off");
    replace(view, head, lookup(app), h("p", { class: "state-note" }, t("pay.empty")));
    return;
  }
  let link: DecodedInvoiceLink;
  try {
    link = decodeInvoiceFragment(fragment, app.registry);
  } catch (error) {
    ui.voice("error");
    ui.plate(t("pay.plate.invalid"), "err");
    const decoded = decodeUiError(app, error);
    const status = statusLine();
    setStatus(status, "err", decoded.message, decoded.code);
    replace(view, head, lookup(app), h("div", { attrs: { role: "alert" } }, status, h("p", { class: "state-note load-note" }, t("pay.invalidNext"))));
    return;
  }
  replace(view, head);
  view.append(bill(app, ui, link));
}

/** Paste a link: the fragment is moved into this page's own hash, so nothing is sent anywhere. */
function lookup(app: App): HTMLElement {
  const { t } = app.i18n;
  const input = h("input", { attrs: { id: "paste", autocomplete: "off", spellcheck: "false", placeholder: t("pay.lookupPlaceholder") } });
  const open = (): void => {
    const value = input.value.trim();
    const fragment = value.includes("#") ? fragmentOf(value) : value;
    if (fragment !== "") {
      location.hash = fragment;
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      open();
    }
  });
  return h("div", { class: "lookup" }, h("label", { attrs: { for: "paste" } }, t("pay.lookup")), input, h("button", { class: "key", attrs: { type: "button" }, on: { click: open } }, t("pay.open")));
}

interface PayeeIdentity {
  readonly label: string | null;
  readonly paidBefore: boolean;
}

async function payeeIdentity(app: App, payee: Address): Promise<PayeeIdentity> {
  const [contacts, receipts] = await Promise.all([app.store.listContacts(), app.store.listReceipts()]);
  const contact = contacts.map(parseStoredContact).find((c) => c?.address.toLowerCase() === payee.toLowerCase());
  const paidBefore = receipts.map(parseStoredReceipt).some((r) => r?.role === "paid" && r.payee.toLowerCase() === payee.toLowerCase());
  return { label: contact?.label ?? null, paidBefore };
}

type VLamp = "ok" | "wait" | "err" | "busy";

function stripItem(name: string): { element: HTMLLIElement; set(lampState: VLamp, detail: string): void } {
  const detailEl = h("span", { class: "vstrip-detail" });
  const element = h("li", { attrs: { "data-lamp": "busy" } }, h("span", { class: "vstrip-name" }, name), detailEl);
  return {
    element,
    set(lampState, detail) {
      element.setAttribute("data-lamp", lampState);
      detailEl.textContent = detail;
    },
  };
}

function bill(app: App, ui: PageUi, link: DecodedInvoiceLink): HTMLElement {
  const { t } = app.i18n;
  const chain = link.target.chain;
  const token = link.token;
  const client = app.client(chain);
  const invoice = link.invoice;
  const fixed = invoice.amount !== 0n;
  const amountText = fixed ? displayAmount(invoice.amount, token, app.locale) : null;
  const passkeys = app.edition.accountLayers.some((layer) => layer.kind === "passkey");
  ui.plate(plateText(chain), "wait");
  ui.voice(fixed ? null : "open-amount");

  const pill = lamp("busy", t("pay.pill.checking"), true);
  const due = h("span", null, fixed ? t("pay.due") : t("pay.openAmount"));
  const memo = link.memo === null ? null : sanitizeMemoForDisplay(link.memo);
  const estimate = (amount: bigint): string | null => ariaryLabel(amount, token, app.fx, app.locale, (p) => t("fx.estimate", p));
  const fxLine = h("p", { class: "screen-fx", attrs: { title: app.fx === null ? null : t("fx.source", { source: app.fx.source }) } }, fixed ? estimate(invoice.amount) : null);
  const screen = h(
    "div",
    { class: "screen" },
    h("div", { class: "screen-top" }, pill, h("span", null, `${invoice.maxPayments === 0 ? t("ticket.card") : t("ticket.invoice")} · ${chain.label}`)),
    h("div", { class: "screen-label" }, due),
    h("div", { class: "amount" }, fixed && amountText !== null ? [num(amountText), " ", unit(token.symbol)] : num(t("ticket.any"), "any")),
    fxLine,
    memo === null || memo.trim() === "" ? null : h("p", { class: "screen-memo" }, h("span", { class: "from" }, t("pay.note")), h("q", null, memo)),
  );

  const sig = stripItem(t("verify.signature"));
  const net = stripItem(t("verify.network"));
  const genuine = stripItem(t("verify.contract"));
  const payable = stripItem(t("verify.payable"));
  for (const item of [sig, net, genuine, payable]) {
    item.set("busy", t("verify.checking"));
  }
  const strip = h("ul", { class: "vstrip", attrs: { "aria-label": t("verify.label") } }, sig.element, net.element, genuine.element, payable.element);

  const identity = h("span", { class: "saved" });
  let payeeLabel: string | null = null;
  const firstWarning = h("p", { class: "warn-note", attrs: { hidden: true } }, h("b", null, t("pay.firstPayment")), " ", t("pay.firstPaymentText"));
  const expiresFact = fact(t("pay.expires"), invoice.validUntil === 0n ? t("pay.noExpiry") : formatDateTime(app.locale, invoice.validUntil));
  const progress = h("dd", null, "…");
  const facts = h(
    "dl",
    { class: "facts" },
    fact(t("pay.to"), identity, addr(invoice.payee)),
    fact(t("pay.network"), t("pay.networkValue", { network: networkName(chain), symbol: token.symbol })),
    expiresFact,
    invoice.maxPayments === 1 ? null : h("div", null, h("dt", null, t("pay.received")), progress),
  );

  const amountInput = h("input", { class: "readout-input", attrs: { id: "pay-amount", inputmode: "decimal", placeholder: app.locale === "en" ? "0.00" : "0,00", autocomplete: "off" } });
  const typedFx = h("p", { class: "readout-hint readout-fx", attrs: { "aria-live": "polite" } });
  const routeNote = h("p", { class: "route-note" });
  const key = h("button", { class: "key key-primary", attrs: { type: "button", disabled: true } }, t("pay.checking"));
  const signSlot = h("div", { class: "sign-slot" });
  const fundsSlot = h("div", { class: "funds-slot" });
  const fallbackSlot = h("div", { class: "fallback-slot" });
  const status = statusLine();
  const slot = h("div", { class: "receipt-slot" });
  const payform = h(
    "div",
    { class: "payform" },
    fixed
      ? null
      : h(
          "div",
          { class: "readout" },
          h("div", { class: "readout-top" }, h("label", { attrs: { for: "pay-amount" } }, t("pay.yourAmount")), h("span", { attrs: { "aria-hidden": "true" } }, token.symbol)),
          amountInput,
          typedFx,
        ),
    signSlot,
    key,
    routeNote,
    fundsSlot,
    fallbackSlot,
    h("p", { class: "assure" }, passkeys ? t("pay.assureKey") : t("pay.assure")),
  );
  const stateNote = h("p", { class: "state-note", attrs: { hidden: true } });
  const billEl = h("div", { class: "bill" }, screen, strip, facts, firstWarning, payform, stateNote, status, slot, details(app, link));

  let checks: LinkChecks | null = null;
  let busy = false;
  let paid = false;
  let choice: PathChoice | null = null;
  /** The account the own-gas offer on screen was made for, or `null` when none is shown. */
  let offerFor: Address | null = null;
  /** The rail that sends the payer's own authorisation with their own gas, when this edition has one. */
  const ownGasRail = app.edition.rails.find((r) => r.paths.includes("self-authorization"));

  void payeeIdentity(app, invoice.payee).then((who) => {
    payeeLabel = who.label;
    identity.textContent = who.label === null ? "" : t("pay.saved", { label: who.label });
    firstWarning.hidden = who.label !== null || who.paidBefore;
  });

  const lockKey = (label: string): void => {
    key.textContent = label;
    key.disabled = true;
    replace(signSlot);
  };

  /** The amount the payer is about to pay, or `null` while an open amount is empty or malformed. */
  const typedAmount = (): bigint | null => {
    if (fixed) {
      return invoice.amount;
    }
    try {
      const value = parseTypedAmount(amountInput.value, token);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  };

  /** The signing display: what the next signature approves (a fingerprint shows no wallet popup to say it). */
  const showSigning = (account: AccountProvider, path: PaymentPath): void => {
    if (account.kind !== "passkey" || (path !== "relayed-authorization" && path !== "self-authorization")) {
      replace(signSlot);
      return;
    }
    const amount = typedAmount();
    const minutes = Number(DEFAULT_AUTHORIZATION_TTL_SECONDS / 60n);
    replace(
      signSlot,
      signingDisplay({
        kicker: t("sign.kicker"),
        band: chain.label,
        title: t("sign.payTitle"),
        amount: { label: t("sign.amount"), value: amount === null ? t("ticket.any") : displayAmount(amount, token, app.locale), unit: amount === null ? null : token.symbol },
        rows: [
          [t("sign.to"), h("span", null, payeeLabel === null ? null : h("span", { class: "sub" }, payeeLabel), addr(invoice.payee))],
          [t("sign.network"), `${networkName(chain)} · ${String(chain.chainId)}`],
          [t("sign.valid"), t("sign.validValue", { minutes })],
          [t("sign.fee"), path === "relayed-authorization" ? t("sign.feeCovered") : t("sign.feeOwn", { coin: chain.nativeCurrency.symbol })],
        ],
        note: t("sign.payNote"),
      }),
    );
  };

  /** The route for this payer, in plain words, with the funds row when the account holds too little. */
  const describe = async (account: AccountProvider): Promise<void> => {
    const now = await chainTime(client).catch(() => checks?.payable.state === "unknown" ? BigInt(Math.floor(Date.now() / 1000)) : (checks?.payable.now ?? BigInt(Math.floor(Date.now() / 1000))));
    try {
      choice = await choosePath(app, client, account, link, now);
    } catch {
      choice = null;
      routeNote.textContent = "";
      return;
    }
    routeNote.textContent = routeText(app, choice);
    if (choice.ok && choice.path === "batched-approve-pay" && app.edition.payWithBase) {
      key.textContent = t("pay.payWithBase");
    }
    if (choice.ok) {
      showSigning(account, choice.path);
    } else {
      lockKey(choice.reason === "authorization-consumed" ? t("pay.locked") : t("pay.waitRelayer"));
      key.dataset["action"] = "recheck";
      key.disabled = choice.reason === "authorization-consumed";
      if (!key.disabled) {
        key.textContent = t("pay.retryRelayer");
      }
    }
    const needed = typedAmount() ?? 0n;
    await showFundsIfShort(app, fundsSlot, {
      chain,
      token,
      owner: account.address,
      needed,
      onFunded: () => {
        // The row goes once the balance covers the payment; the confirmation stays on the status line.
        setStatus(status, "ok", t("funds.done", { symbol: token.symbol }));
        void refresh();
      },
    });
  };

  /** Re-evaluates the key from the checks, the session and the wallet's network. */
  const refresh = async (): Promise<void> => {
    if (busy || paid) {
      return;
    }
    const account = app.session.account();
    if (offerFor !== null && offerFor.toLowerCase() !== account?.address.toLowerCase()) {
      // The own-gas offer belongs to the account that signed: another account (or none) has nothing to resend.
      offerFor = null;
      replace(fallbackSlot);
    }
    if (checks === null) {
      lockKey(t("pay.checking"));
      return;
    }
    if (app.framed) {
      lockKey(t("pay.locked"));
      return;
    }
    const states = [checks.signature.state, checks.contract.state, checks.payable.state];
    if (states.includes("err")) {
      // Any red lamp locks the key, whatever the others say.
      lockKey(t("pay.locked"));
      return;
    }
    if (states.includes("unknown")) {
      key.textContent = t("pay.retryChecks");
      key.disabled = false;
      key.dataset["action"] = "recheck";
      return;
    }
    if (account === null) {
      net.set("wait", passkeys ? t("verify.network.key") : t("verify.network.connect"));
      key.textContent = passkeys ? t("pay.useKey") : t("pay.connect");
      key.disabled = false;
      key.dataset["action"] = "connect";
      return;
    }
    if (account.address.toLowerCase() === invoice.payee.toLowerCase()) {
      net.set("ok", t("verify.network.ok", { network: networkName(chain) }));
      lockKey(t("pay.locked"));
      stateNote.hidden = false;
      stateNote.textContent = t("pay.note.self");
      return;
    }
    if (account.kind === "passkey") {
      // A PayLink key signs for any network: nothing to switch, nothing to ask.
      await account.switchChain(chain);
    }
    let walletChain: number;
    try {
      walletChain = await account.chainId();
    } catch {
      walletChain = 0;
    }
    if (walletChain !== chain.chainId) {
      net.set("wait", t("verify.network.other"));
      key.textContent = t("pay.switch", { network: networkName(chain) });
      key.disabled = false;
      key.dataset["action"] = "switch";
      return;
    }
    net.set("ok", account.kind === "passkey" ? t("verify.network.keyOk", { network: networkName(chain) }) : t("verify.network.ok", { network: networkName(chain) }));
    key.textContent = fixed && amountText !== null ? t("pay.payKey", { amount: amountText, symbol: token.symbol }) : t("pay.sendKey", { symbol: token.symbol });
    key.disabled = false;
    key.dataset["action"] = "pay";
    await describe(account);
  };

  const runChecks = async (): Promise<void> => {
    checks = null;
    void refresh();
    for (const item of [sig, genuine, payable]) {
      item.set("busy", t("verify.checking"));
    }
    const result = await checkLink(link, client);
    checks = result;
    paintChecks(app, link, result, { sig, genuine, payable }, pill, due, progress, stateNote, ui);
    void refresh();
  };

  const startPayment = (forced: PathChoice | null): void => {
    const account = app.session.account();
    if (account === null || checks === null || checks.payable.state === "unknown") {
      return;
    }
    busy = true;
    key.disabled = true;
    key.setAttribute("aria-busy", "true");
    offerFor = null;
    replace(fallbackSlot);
    pay(app, { link, chain, token, client, account, now: checks.payable.now, amountInput, fixed, status, forced, onDone: done })
      .catch(async (error: unknown) => {
        if (error instanceof RelayFallbackError) {
          await offerFallback(error, account);
          return;
        }
        const decoded = decodeUiError(app, error);
        setStatus(status, "err", decoded.message, decoded.code);
      })
      .finally(() => {
        busy = false;
        key.removeAttribute("aria-busy");
        if (!paid) {
          void refresh();
        }
      });
  };

  /**
   * The relayer refused or failed: the same authorisation, sent by the payer with their own gas, when they have some
   * and the edition has a rail that sends it (spec §3.5, §3.7). The key is offered only when pressing it can pay.
   */
  const offerFallback = async (error: RelayFallbackError, account: AccountProvider): Promise<void> => {
    const problem = error.problem;
    const reason = relayerReason(app, problem.code, problem.retryAfter);
    setStatus(status, problem.fallback === "retry" ? "warn" : "err", reason, t("common.errorCode", { code: problem.reason ?? problem.rule ?? problem.code }));
    const balance = await client.getBalance(account.address).catch(() => 0n);
    if (problem.fallback === "none") {
      // Nobody can send it (the invoice closed, for one): the status line says why, there is nothing to offer.
      return;
    }
    offerFor = account.address;
    if (ownGasRail === undefined) {
      replace(fallbackSlot, h("p", { class: "field-hint" }, t("pay.fallback.retry")));
      return;
    }
    if (balance === 0n) {
      replace(fallbackSlot, h("p", { class: "field-hint" }, problem.fallback === "retry" ? t("pay.fallback.retry") : t("pay.fallback.noGas", { coin: chain.nativeCurrency.symbol })));
      return;
    }
    const own = h("button", { class: "key key-line", attrs: { type: "button", "data-path": "self-authorization" } }, t("pay.fallback.own", { coin: chain.nativeCurrency.symbol }));
    own.addEventListener("click", () => {
      const facts = choice?.facts;
      if (facts === undefined) {
        setStatus(status, "err", t("pay.fallback.retry"));
        return;
      }
      startPayment({ ok: true, path: "self-authorization", rail: ownGasRail, fallbacks: [], payerPaysGas: true, resubmit: true, facts });
    });
    replace(fallbackSlot, h("p", { class: "field-hint" }, t("pay.fallback.text")), own);
  };

  key.addEventListener("click", () => {
    const action = key.dataset["action"];
    if (action === "recheck") {
      app.relayer.invalidate();
      void runChecks();
    } else if (action === "connect") {
      void pickWallet(app).then(() => refresh());
    } else if (action === "switch") {
      const account = app.session.account();
      if (account !== null) {
        setStatus(status, "", t("wallet.switching"));
        account
          .switchChain(chain)
          .then(() => {
            setStatus(status, "", "");
          })
          .catch((error: unknown) => {
            const decoded = decodeUiError(app, error);
            setStatus(status, "err", decoded.message, decoded.code);
          })
          .finally(() => refresh());
      }
    } else if (action === "pay") {
      startPayment(null);
    }
  });

  const done = (outcome: { amount: bigint; txHash: `0x${string}`; logIndex: number; elapsedMs: number; slip: HTMLElement; receiptLink: string }): void => {
    paid = true;
    replace(signSlot);
    replace(fundsSlot);
    replace(fallbackSlot);
    const shown = displayAmount(outcome.amount, token, app.locale);
    billEl.classList.add("is-done");
    // This payer has now paid this address: the first-payment warning no longer applies.
    firstWarning.hidden = true;
    if (invoice.maxPayments === 1) {
      pill.className = "pill paid";
      pill.textContent = t("pay.pill.paid");
      due.textContent = t("pay.paid");
      payable.set("ok", t("verify.payable.paidNow"));
    } else {
      // Seats and receive cards stay open: re-read the count this payment just moved.
      void readLinkState(client, link.target.deployment.address, link.key)
        .then((state) => {
          progress.textContent = progressText(app, invoice.maxPayments, state.payments);
        })
        .catch(() => undefined);
    }
    const seconds = formatSeconds(app.locale, outcome.elapsedMs / 1000);
    screen.append(
      h(
        "div",
        { class: "verdict", attrs: { role: "status" } },
        h("b", null, t("pay.verdict.approved")),
        h("span", null, fixed ? t("pay.verdict.paidInFull") : t("pay.verdict.sent", { amount: shown, symbol: token.symbol })),
        h("span", { class: "verdict-time" }, t("pay.verdict.settled", { seconds })),
      ),
    );
    ui.voice("paid");
    ui.plate(plateText(chain), "ok");
    setStatus(status, "ok", t("pay.status.done", { amount: shown, symbol: token.symbol, seconds }));
    const copy = h("button", { class: "key key-line", attrs: { type: "button" } }, t("receipt.copy"));
    copy.addEventListener("click", () => {
      void copyText(outcome.receiptLink, copy, { idle: t("receipt.copy"), done: t("share.copied"), said: t("receipt.copiedSaid") });
    });
    replace(
      slot,
      outcome.slip,
      h("div", { class: "key-row" }, h("a", { class: "key key-line", attrs: { href: outcome.receiptLink } }, t("receipt.open")), copy),
      h("p", { class: "thanks" }, h("b", { attrs: { lang: "mg" } }, "Misaotra!"), h("span", { class: "gloss" }, t("pay.thanks.gloss")), t("pay.thanks.text")),
    );
    announce(t("pay.status.paidSaid", { amount: shown, symbol: token.symbol }));
  };

  app.session.subscribe(() => {
    void refresh();
  });
  amountInput.addEventListener("input", () => {
    setStatus(status, "", "");
    const amount = typedAmount();
    typedFx.textContent = amount === null ? "" : (estimate(amount) ?? "");
    const account = app.session.account();
    if (account !== null && choice?.ok === true) {
      showSigning(account, choice.path);
    }
  });
  void runChecks();
  return billEl;
}

/** Why the relayer did not take the payment, in the payer's words. */
function relayerReason(app: App, code: string, retryAfter: number | null): string {
  const { t } = app.i18n;
  switch (code) {
    case "offline":
    case "upstream-error":
    case "relayer-unavailable":
    case "invalid-response":
      return t("pay.relayer.offline");
    case "rate-limited":
    case "refused":
      return t("pay.relayer.busy", { seconds: Math.max(1, Math.ceil(retryAfter ?? 60)) });
    case "budget-exhausted":
    case "fees-too-high":
      return t("pay.relayer.budget");
    case "invoice-closed":
    case "already-cancelled":
      return t("pay.relayer.closed");
    default:
      return t("pay.relayer.refused");
  }
}

/** The route in plain words: who signs, who pays the network fee. */
function routeText(app: App, choice: PathChoice): string {
  const { t } = app.i18n;
  if (!choice.ok) {
    switch (choice.reason) {
      case "needs-gas":
        return t("pay.route.needsGas");
      case "authorization-consumed":
        return t("pay.route.consumed");
      case "none":
        return t("pay.route.none");
    }
  }
  if (choice.resubmit) {
    return t("pay.route.resubmit");
  }
  switch (choice.path) {
    case "permit":
      return t("pay.route.permit");
    case "approve-pay":
      return t("pay.route.approve");
    case "batched-approve-pay":
      return app.edition.payWithBase ? t("pay.route.base") : t("pay.route.batch");
    case "native":
      return t("pay.route.native");
    case "relayed-authorization":
      return t("pay.route.signature");
    case "self-authorization":
      return t("pay.route.ownGas");
  }
}

/** "3 payments received" (receive card) or "3 of 10 seats taken". */
function progressText(app: App, maxPayments: number, payments: number): string {
  return maxPayments === 0 ? app.i18n.plural("pay.paymentsReceived", payments, {}) : app.i18n.t("pay.seatsTaken", { paid: payments, max: maxPayments });
}

function paintChecks(
  app: App,
  link: DecodedInvoiceLink,
  checks: LinkChecks,
  items: Record<"sig" | "genuine" | "payable", { set(lampState: VLamp, detail: string): void }>,
  pill: HTMLElement,
  due: HTMLElement,
  progress: HTMLElement,
  stateNote: HTMLElement,
  ui: PageUi,
): void {
  const { t } = app.i18n;
  const chain = link.target.chain;
  const unknown = t("verify.unknown");
  switch (checks.signature.state) {
    case "ok":
      items.sig.set("ok", checks.signature.delegated ? t("verify.signature.delegated") : t("verify.signature.ok"));
      break;
    case "err":
      items.sig.set("err", t("verify.signature.err"));
      break;
    case "unknown":
      items.sig.set("wait", unknown);
  }
  switch (checks.contract.state) {
    case "ok":
      items.genuine.set("ok", t("verify.contract.ok", { release: link.target.deployment.release, network: networkName(chain) }));
      break;
    case "err":
      items.genuine.set("err", t("verify.contract.err"));
      break;
    case "unknown":
      items.genuine.set("wait", unknown);
  }
  const setPill = (kind: LampKind, text: string): void => {
    pill.className = `pill ${kind}`;
    pill.textContent = text;
  };
  if (checks.payable.state === "unknown") {
    items.payable.set("wait", unknown);
    setPill("wait", t("pay.pill.checking"));
    ui.voice("offline");
    ui.plate(plateText(chain), "wait");
    return;
  }
  const { status, link: state } = checks.payable;
  const invoice = link.invoice;
  const date = (seconds: bigint): string => formatDateTime(app.locale, seconds);
  progress.textContent = progressText(app, invoice.maxPayments, state.payments);
  const settled = (lampKind: LampKind, pillText: string, detail: string, note: string): void => {
    items.payable.set("err", detail);
    setPill(lampKind, pillText);
    stateNote.hidden = false;
    stateNote.textContent = note;
    ui.voice("settled");
  };
  switch (status) {
    case "payable":
      items.payable.set("ok", invoice.validUntil === 0n ? t("verify.payable.noExpiry") : t("verify.payable.until", { date: date(invoice.validUntil) }));
      setPill("open", t("pay.pill.open"));
      break;
    case "paid":
      due.textContent = t("pay.paid");
      settled("paid", t("pay.pill.paid"), t("verify.payable.paid"), t("pay.note.paid"));
      break;
    case "sold-out":
      settled("paid", t("pay.pill.soldOut"), t("verify.payable.soldOut", { max: invoice.maxPayments }), t("pay.note.soldOut"));
      break;
    case "cancelled":
      settled("closed", t("pay.pill.cancelled"), t("verify.payable.cancelled"), t("pay.note.cancelled"));
      break;
    case "expired":
      settled("closed", t("pay.pill.expired"), t("verify.payable.expired", { date: date(invoice.validUntil) }), t("pay.note.expired"));
      break;
    case "not-yet-valid":
      settled("closed", t("pay.pill.scheduled"), t("verify.payable.notYet", { date: date(invoice.validAfter) }), t("pay.note.scheduled", { date: date(invoice.validAfter) }));
      break;
  }
  const red = checks.signature.state === "err" || checks.contract.state === "err";
  if (red) {
    ui.voice("error");
    setPill("err", t("pay.pill.refused"));
  }
  const allGreen = checks.signature.state === "ok" && checks.contract.state === "ok" && status === "payable";
  ui.plate(plateText(chain), red ? "err" : allGreen ? "ok" : "wait");
}

interface PayInput {
  readonly link: DecodedInvoiceLink;
  readonly chain: ChainDefinition;
  readonly token: Token;
  readonly client: ChainClient;
  readonly account: AccountProvider;
  readonly now: bigint;
  readonly amountInput: HTMLInputElement;
  readonly fixed: boolean;
  readonly status: HTMLElement;
  /** A path the payer chose explicitly (the own-gas fallback after a relayer refusal); the router's choice otherwise. */
  readonly forced: PathChoice | null;
  readonly onDone: (outcome: { amount: bigint; txHash: `0x${string}`; logIndex: number; elapsedMs: number; slip: HTMLElement; receiptLink: string }) => void;
}

async function pay(app: App, input: PayInput): Promise<void> {
  const { t } = app.i18n;
  const { link, chain, token, client, account, status } = input;
  let amount = link.invoice.amount;
  if (!input.fixed) {
    try {
      amount = parseTypedAmount(input.amountInput.value, token);
    } catch {
      input.amountInput.focus();
      throw new AppError("pay.error.amount", {});
    }
    if (amount === 0n) {
      input.amountInput.focus();
      throw new AppError("pay.error.amount", {});
    }
  }
  const shown = displayAmount(amount, token, app.locale);
  const choice = input.forced ?? (await choosePath(app, client, account, link, input.now));
  if (!choice.ok) {
    throw new AppError(choice.reason === "authorization-consumed" ? "pay.route.consumed" : choice.reason === "needs-gas" ? "pay.route.needsGas" : "pay.route.none", {});
  }
  // The contract's own checks, predicted in its order, before any prompt (invoice spec §7.2).
  const fn = SETTLEMENT_FN[choice.path] ?? "pay";
  const state = await readLinkState(client, link.target.deployment.address, link.key);
  const predicted = predictPayment({ invoice: link.invoice, verifyingContract: link.target.deployment.address, state, now: input.now, fn, amount, payer: account.address, signatureValid: true });
  if (predicted !== null) {
    throw new AppError("pay.error.predicted", { reason: app.i18n.lookup(predicted.i18nKey, predicted.params) ?? predicted.name });
  }
  // Funds: the token amount, and gas only when the payer sends the transaction.
  if (token.kind === "erc20") {
    const balance = await client.erc20(token.address, "balanceOf", [account.address]);
    if (balance < amount) {
      throw new AppError(account.kind === "passkey" ? "pay.error.balanceKey" : "pay.error.balance", { balance: displayAmount(balance, token, app.locale), symbol: token.symbol });
    }
  }
  if (choice.payerPaysGas && (await client.getBalance(account.address)) === 0n) {
    throw new AppError("pay.error.gas", { coin: chain.nativeCurrency.symbol });
  }
  const onStep = (step: PaymentStep): void => {
    switch (step.kind) {
      case "simulate":
        setStatus(status, "", t("pay.status.simulate"));
        break;
      case "sign-permit":
        setStatus(status, "", t("pay.status.permit", { amount: shown, symbol: token.symbol }));
        break;
      case "approve":
        setStatus(status, "", t("pay.status.approve", { amount: shown, symbol: token.symbol }));
        break;
      case "approve-sent":
        setStatus(status, "", t("pay.status.approveSent"));
        break;
      case "confirm":
        setStatus(status, "", t("pay.status.confirm"));
        break;
      case "sent":
        setStatus(status, "", t("pay.status.sent"));
        break;
      case "mined":
        setStatus(status, "", t("pay.status.verifying"));
        break;
      case "sign-authorization":
        setStatus(status, "", account.kind === "passkey" ? t("pay.status.fingerprint", { amount: shown, symbol: token.symbol }) : t("pay.status.authorize", { amount: shown, symbol: token.symbol }));
        break;
      case "resubmit":
        setStatus(status, "", t("pay.status.resubmit"));
        break;
      case "relayed":
        setStatus(status, "", t("pay.status.relayed"));
        break;
      case "batch":
        setStatus(status, "", t("pay.status.batch", { amount: shown, symbol: token.symbol }));
        break;
    }
  };
  const outcome = await choice.rail.execute(choice.path, {
    link,
    chain,
    account,
    client,
    amount,
    payerRef: ZERO_HASH,
    now: input.now,
    onStep,
    registry: app.registry,
    relayer: app.relayer,
    authorizations: app.store.authorizations,
  });
  const reference = { chainId: chain.chainId, txHash: outcome.txHash, logIndex: outcome.logIndex };
  const verification = await verifyReceipt({ registry: app.registry, client, reference, paid: link });
  if (!verification.valid) {
    throw new AppError("pay.error.receipt", { reason: app.i18n.lookup(verification.i18nKey, verification.params) ?? verification.failure });
  }
  const proof = verification.proof;
  const fragment = encodeReceiptFragment(reference, link);
  await app.store.putReceipt({
    id: receiptId(chain.chainId, outcome.txHash, outcome.logIndex),
    chainId: chain.chainId,
    txHash: outcome.txHash,
    logIndex: outcome.logIndex,
    role: "paid",
    invoiceKey: link.key,
    payee: proof.payee,
    payer: proof.payer,
    token: proof.token,
    amount: proof.amount.toString(),
    blockTime: Number(proof.timestamp),
    fragment,
    savedAt: Date.now(),
  });
  const explorer = chain.explorers[0];
  const slip = receiptSlip({
    top: t("receipt.top"),
    verdict: t("receipt.approved"),
    valid: true,
    amount: displayAmount(proof.amount, token, app.locale),
    symbol: token.symbol,
    rows: [
      ...(link.memo === null ? [] : [[t("receipt.for"), sanitizeMemoForDisplay(link.memo)] as const]),
      [t("receipt.to"), shortHex(proof.payee)],
      [t("receipt.from"), shortHex(proof.payer)],
      [t("receipt.time"), formatDateTime(app.locale, proof.timestamp)],
      [t("receipt.network"), `${chain.label} · ${String(chain.chainId)}`],
      [t("receipt.tx"), explorer === undefined ? shortHex(outcome.txHash) : ext(`${explorer.url}/tx/${outcome.txHash}`, shortHex(outcome.txHash))],
    ],
    checks: [
      ["ok", t("receipt.check.paid")],
      ["ok", t("receipt.check.contract")],
      ["ok", t("receipt.check.invoice")],
    ],
    foot: t("receipt.foot", { network: networkName(chain) }),
    label: t("receipt.label"),
  });
  input.onDone({ amount: proof.amount, txHash: outcome.txHash, logIndex: outcome.logIndex, elapsedMs: outcome.elapsedMs, slip, receiptLink: receiptUrl(app.site, fragment) });
}

function details(app: App, link: DecodedInvoiceLink): HTMLElement {
  const { t } = app.i18n;
  const chain = link.target.chain;
  const explorer = chain.explorers[0];
  return h(
    "details",
    { class: "details" },
    h("summary", null, t("details.title")),
    h(
      "dl",
      null,
      fact(t("details.chain"), `${networkName(chain)} · ${chain.caip2}`),
      fact(t("details.contract"), explorer === undefined ? link.target.deployment.address : ext(`${explorer.url}/address/${link.target.deployment.address}`, link.target.deployment.address)),
      fact(t("details.token"), `${link.token.symbol} · ${link.token.address}`),
      fact(t("details.key"), hexGroups(link.key)),
      fact(t("details.payments"), link.invoice.maxPayments === 0 ? t("create.payments.unlimited") : String(link.invoice.maxPayments)),
    ),
  );
}
