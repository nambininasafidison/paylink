// SPDX-License-Identifier: MIT
/**
 * `/pay/#2.<chainId>.<inv>.<sig>[.<memo>]`: the payer's view (invoice spec §13.2).
 *
 * The fragment is decoded strictly against the edition's registry (the contract address never comes from the link),
 * then four lamps are lit from the chain: signature, network, contract, payable. Each lamp has a neutral name and a
 * state word (OK, Check, Stop, Not needed), so neither a screen reader nor a red/green colour-blind reader is told
 * "Signature valid" next to a failing check. Any red lamp locks the Pay key; an unknown one keeps it waiting; none is
 * left checking once the link is known to be closed. The payee is shown grouped by four with any saved label, or with the amber
 * "first payment to this address" warning. The memo is the sender's own words, stripped of bidi and control
 * characters and labelled as such. Payer copy says "digital dollars", never "blockchain".
 *
 * Payment: the SDK's PaymentRouter ranks the paths for the token and the payer's account; the first one a ready rail
 * of the edition can execute is used. Who pays the network fee (the assurance line and the lead's step 02) is said
 * from that route, never from the edition alone; "Pay with Base" is said only to a Base app or Coinbase Wallet. The
 * outcome is verified as a receipt on the chain before "Approved" lights.
 *
 * A gasless payment can land after the payer stopped waiting for it (a slow relayer: invoice spec §8.6). The device
 * keeps the signed authorisation; once the token reports it used, the view finds the payment it made (no signature,
 * no transaction), verifies it and shows the same "Approved" and receipt, never a red error: on the next press of the
 * Pay key (which offers to send the same signature again) and whenever the link is opened again.
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
import { isBaseWallet } from "../accounts/eip6963.ts";
import type { AccountProvider } from "../accounts/types.ts";
import type { PageDefinition } from "../app/boot.ts";
import { networkName, plateText } from "../app/chains.ts";
import type { App } from "../app/context.ts";
import { intro, steps } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { showFundsIfShort } from "../app/funds.ts";
import { choosePath } from "../app/payer.ts";
import type { PathChoice } from "../app/payer.ts";
import { payeeIdentity as receiptIdentity, proofSlip } from "../app/proof-slip.ts";
import { pickWallet } from "../app/wallet-ui.ts";
import { chainTime } from "../core/clients.ts";
import type { ChainClient } from "../core/clients.ts";
import { AppError, decodeUiError } from "../core/errors.ts";
import { displayAmount, parseTypedAmount } from "../core/format.ts";
import { ariaryLabel } from "../core/fx.ts";
import { receiptUrl } from "../core/links.ts";
import { recoverConsumedPayment, RelayFallbackError } from "../rails/authorization.ts";
import type { PaymentOutcome, PaymentStep } from "../rails/types.ts";
import { checkLink } from "../read/checks.ts";
import type { LinkChecks } from "../read/checks.ts";
import { parseStoredContact, parseStoredReceipt, receiptId } from "../store/db.ts";
import { addr, ext, fact, hexGroups, lamp, num, setStatus, statusLine, unit } from "../ui/atoms.ts";
import type { LampKind } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { announce, copyText } from "../ui/live.ts";
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
    const passkeys = app.edition.accountLayers.some((layer) => layer.kind === "passkey");
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
        // Who pays the fee is said once the route is known (bill → feeCopy); until then only what is certain.
        [t("pay.step2.title"), passkeys ? t("pay.step2.key") : t("pay.step2.pending")],
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

/** A lamp's state: green, amber, red, blinking while it is read, or a hollow ring when the check does not apply. */
type VLamp = "ok" | "wait" | "err" | "busy" | "off";

/**
 * One lamp of the verification strip: a neutral name ("Signature"), the state in words ("OK", "Stop"), and the detail.
 * The state word is text, so the lamp's meaning never rests on its colour.
 */
function stripItem(name: string, words: Readonly<Record<VLamp, string>>): { element: HTMLLIElement; set(lampState: VLamp, detail: string, word?: string): void } {
  const wordEl = h("span", { class: "vstrip-state" }, words.busy);
  const detailEl = h("span", { class: "vstrip-detail" });
  const element = h("li", { attrs: { "data-lamp": "busy" } }, h("span", { class: "vstrip-name" }, h("span", null, name), wordEl), detailEl);
  return {
    element,
    set(lampState, detail, word) {
      element.setAttribute("data-lamp", lampState);
      wordEl.textContent = word ?? words[lampState];
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

  const words: Record<VLamp, string> = { ok: t("verify.state.ok"), wait: t("verify.state.wait"), err: t("verify.state.err"), busy: t("verify.state.busy"), off: t("verify.state.off") };
  const sig = stripItem(t("verify.signature"), words);
  const net = stripItem(t("verify.network"), words);
  const genuine = stripItem(t("verify.contract"), words);
  const payable = stripItem(t("verify.payable"), words);
  for (const item of [sig, net, genuine, payable]) {
    item.set("busy", "");
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
  const assure = h("p", { class: "assure" });
  const stepText = ui.aside.querySelector<HTMLElement>(".steps li:nth-child(2) p");
  /**
   * Who pays the network fee, from the route the router picked (`null` until one is): covered on the relayed route,
   * the payer's own on every other. The assurance line and the lead's step 02 never contradict the route note.
   */
  const feeCopy = (path: PaymentPath | null): void => {
    const covered = path === "relayed-authorization";
    const own = path !== null && !covered;
    if (passkeys) {
      assure.textContent = own ? t("pay.assureKeyOwn") : t("pay.assureKey");
    } else {
      assure.textContent = covered ? t("pay.assureCovered") : own ? t("pay.assure") : t("pay.assurePending");
    }
    if (stepText !== null) {
      stepText.textContent = passkeys ? (own ? t("pay.step2.keyOwn") : t("pay.step2.key")) : covered ? t("pay.step2.covered") : own ? t("pay.step2.text") : t("pay.step2.pending");
    }
  };
  feeCopy(null);
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
    assure,
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
  /** Whether this view already looked for the payment of an earlier, used authorisation on its own (once). */
  let recoveryTried = false;

  void payeeIdentity(app, invoice.payee).then((who) => {
    payeeLabel = who.label;
    identity.textContent = who.label === null ? "" : t("pay.saved", { label: who.label });
    firstWarning.hidden = who.label !== null || who.paidBefore;
  });

  const lockKey = (label: string): void => {
    key.textContent = label;
    key.disabled = true;
    delete key.dataset["action"];
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
      feeCopy(null);
      return;
    }
    const baseWallet = app.edition.payWithBase && isBaseWallet(account.connector);
    routeNote.textContent = routeText(app, choice, baseWallet);
    feeCopy(choice.ok ? choice.path : null);
    if (choice.ok && choice.path === "batched-approve-pay" && baseWallet) {
      // "Pay with Base" names the payer's own wallet: only the Base app or Coinbase Wallet hears it.
      key.textContent = t("pay.payWithBase");
    }
    if (choice.ok) {
      showSigning(account, choice.path);
    } else if (choice.reason === "authorization-consumed") {
      // The payer's earlier signature was used: the payment went through (a relay that landed late). Its receipt is
      // found and shown; nothing is signed or sent, and the money is never asked for twice.
      replace(signSlot);
      key.textContent = t("pay.recover");
      key.disabled = false;
      key.dataset["action"] = "recover";
      if (!recoveryTried) {
        recoveryTried = true;
        startRecovery(now);
      }
      return;
    } else {
      lockKey(t("pay.waitRelayer"));
      key.dataset["action"] = "recheck";
      key.disabled = false;
      key.textContent = t("pay.retryRelayer");
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
      net.set("off", t("verify.network.notNeeded"));
      lockKey(t("pay.locked"));
      return;
    }
    const states = [checks.signature.state, checks.contract.state, checks.payable.state];
    if (states.includes("err")) {
      // Any red lamp locks the key, whatever the others say; the wallet's network no longer matters (never left
      // "checking" on a paid, cancelled, expired or refused link).
      net.set("off", t("verify.network.notNeeded"));
      lockKey(t("pay.locked"));
      if (checks.payable.state === "err" && (checks.payable.status === "paid" || checks.payable.status === "sold-out")) {
        // Paid, possibly by this payer: an earlier signature a late relay used is found and shown, and a receipt
        // this device already holds is one press away.
        if (account !== null && !recoveryTried) {
          recoveryTried = true;
          startRecovery(checks.payable.now, true);
        }
        void showOwnReceipt();
      }
      return;
    }
    if (states.includes("unknown")) {
      net.set("wait", t("verify.unknown"));
      key.textContent = t("pay.retryChecks");
      key.disabled = false;
      key.dataset["action"] = "recheck";
      return;
    }
    if (account === null) {
      feeCopy(null);
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
    for (const item of [sig, net, genuine, payable]) {
      item.set("busy", "");
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
        // A used signature whose payment the network does not show yet is not a failure: amber, and searched again.
        setStatus(status, error instanceof AppError && error.key === "pay.error.consumed" ? "warn" : "err", decoded.message, decoded.code);
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
   * Finds the payment an earlier, used authorisation of this payer made, verifies it and shows it as paid. Reads only:
   * nothing is signed or sent. `quiet`: the link is closed anyway, so finding nothing says nothing.
   */
  const startRecovery = (now: bigint, quiet = false): void => {
    const account = app.session.account();
    if (account === null || busy || paid) {
      return;
    }
    busy = true;
    key.disabled = true;
    key.setAttribute("aria-busy", "true");
    recoverEarlier(app, { link, chain, client, account, now, status, quiet, onDone: done })
      .catch((error: unknown) => {
        if (quiet) {
          // The link is closed anyway: a read that failed here changes nothing on screen.
          return;
        }
        const decoded = decodeUiError(app, error);
        setStatus(status, error instanceof AppError && error.key === "pay.error.consumed" ? "warn" : "err", decoded.message, decoded.code);
      })
      .finally(() => {
        busy = false;
        key.removeAttribute("aria-busy");
        if (!paid && key.dataset["action"] === "recover") {
          key.disabled = false;
        }
      });
  };

  /** A receipt this device holds for this link (it paid it here): one press away on a link that is closed. */
  const showOwnReceipt = async (): Promise<void> => {
    const receipts = (await app.store.listReceipts().catch(() => [])).map(parseStoredReceipt);
    const own = receipts.filter((r) => r !== null && r.role === "paid" && r.chainId === chain.chainId && r.invoiceKey.toLowerCase() === link.key.toLowerCase()).at(-1);
    if (own === undefined || own === null || paid) {
      return;
    }
    stateNote.hidden = false;
    stateNote.querySelector(".state-own")?.remove();
    stateNote.append(h("span", { class: "state-own" }, " ", t("pay.note.yours"), " ", h("a", { attrs: { href: receiptUrl(app.site, own.fragment) } }, t("receipt.open"))));
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
    } else if (action === "recover") {
      void chainTime(client)
        .catch(() => BigInt(Math.floor(Date.now() / 1000)))
        .then((now) => {
          startRecovery(now);
        });
    }
  });

  const done = (outcome: Settled): void => {
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
      // Closed by this very payment: a hollow lamp and "Closed", never a green "payable".
      payable.set("off", outcome.elapsedMs === null ? t("pay.verdict.earlier") : t("verify.payable.paidNow"), t("verify.state.closed"));
    } else {
      // Seats and receive cards stay open: re-read the count this payment just moved.
      void readLinkState(client, link.target.deployment.address, link.key)
        .then((state) => {
          progress.textContent = progressText(app, invoice.maxPayments, state.payments);
        })
        .catch(() => undefined);
    }
    const seconds = outcome.elapsedMs === null ? null : formatSeconds(app.locale, outcome.elapsedMs / 1000);
    screen.append(
      h(
        "div",
        { class: "verdict", attrs: { role: "status" } },
        h("b", null, t("pay.verdict.approved")),
        h("span", null, fixed ? t("pay.verdict.paidInFull") : t("pay.verdict.sent", { amount: shown, symbol: token.symbol })),
        h("span", { class: "verdict-time" }, seconds === null ? t("pay.verdict.earlier") : t("pay.verdict.settled", { seconds })),
      ),
    );
    ui.voice("paid");
    ui.plate(plateText(chain), "ok");
    setStatus(status, "ok", seconds === null ? t("pay.status.recovered", { amount: shown, symbol: token.symbol }) : t("pay.status.done", { amount: shown, symbol: token.symbol, seconds }));
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

/** The route in plain words: who signs, who pays the network fee. `baseWallet`: the payer's wallet is the Base app. */
function routeText(app: App, choice: PathChoice, baseWallet: boolean): string {
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
      return baseWallet ? t("pay.route.base") : t("pay.route.batch");
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
  readonly onDone: (outcome: Settled) => void;
}

/** A verified payment, ready to show: `elapsedMs` is `null` when this device did not watch it settle. */
interface Settled {
  readonly amount: bigint;
  readonly txHash: `0x${string}`;
  readonly logIndex: number;
  readonly elapsedMs: number | null;
  readonly slip: HTMLElement;
  readonly receiptLink: string;
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
      throw new AppError("pay.error.amount", {}, "AmountInvalid");
    }
    if (amount === 0n) {
      input.amountInput.focus();
      throw new AppError("pay.error.amount", {}, "AmountInvalid");
    }
  }
  const shown = displayAmount(amount, token, app.locale);
  const choice = input.forced ?? (await choosePath(app, client, account, link, input.now));
  if (!choice.ok && choice.reason === "authorization-consumed") {
    // Paid already, with the payer's earlier signature (a relay that landed late): its receipt, not a second payment.
    await recoverEarlier(app, { ...input, quiet: false });
    return;
  }
  if (!choice.ok) {
    throw choice.reason === "needs-gas" ? new AppError("pay.route.needsGas", {}, "FeeServiceDown") : new AppError("pay.route.none", {}, "NoPaymentRoute");
  }
  // The contract's own checks, predicted in its order, before any prompt (invoice spec §7.2).
  const fn = SETTLEMENT_FN[choice.path] ?? "pay";
  const state = await readLinkState(client, link.target.deployment.address, link.key);
  const predicted = predictPayment({ invoice: link.invoice, verifyingContract: link.target.deployment.address, state, now: input.now, fn, amount, payer: account.address, signatureValid: true });
  if (predicted !== null) {
    throw new AppError("pay.error.predicted", { reason: app.i18n.lookup(predicted.i18nKey, predicted.params) ?? predicted.name }, "WouldRevert");
  }
  // Funds: the token amount, and gas only when the payer sends the transaction.
  if (token.kind === "erc20") {
    const balance = await client.erc20(token.address, "balanceOf", [account.address]);
    if (balance < amount) {
      throw new AppError(account.kind === "passkey" ? "pay.error.balanceKey" : "pay.error.balance", { balance: displayAmount(balance, token, app.locale), symbol: token.symbol }, "BalanceTooLow");
    }
  }
  if (choice.payerPaysGas && (await client.getBalance(account.address)) === 0n) {
    throw new AppError("pay.error.gas", { coin: chain.nativeCurrency.symbol }, "NoFeeCoin");
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
  await finish(app, input, outcome);
}

/**
 * The payment an earlier, used authorisation of this payer made (invoice spec §8.6 "consumed"), found on the chain and
 * shown like any other: verified, kept on the device, "Approved". Throws `pay.error.consumed` when the network does
 * not show it yet (unless `quiet`).
 */
async function recoverEarlier(app: App, input: Pick<PayInput, "link" | "chain" | "client" | "account" | "now" | "status" | "onDone"> & { readonly quiet: boolean }): Promise<void> {
  const { t } = app.i18n;
  if (!input.quiet) {
    setStatus(input.status, "", t("pay.status.recovering"));
  }
  const found = await recoverConsumedPayment({
    authorizations: app.store.authorizations,
    registry: app.registry,
    client: input.client,
    now: input.now,
    link: input.link,
    chain: input.chain,
    payer: input.account.address,
  });
  if (found.state === "found") {
    await finish(app, input, found.outcome);
    return;
  }
  if (found.state === "missing" && !input.quiet) {
    throw new AppError("pay.error.consumed", {}, "AuthorizationUsed");
  }
  if (!input.quiet) {
    setStatus(input.status, "", "");
  }
}

/** Verifies the outcome as a receipt on the chain, keeps it on the device, and hands the slip to the view. */
async function finish(app: App, input: Pick<PayInput, "link" | "chain" | "client" | "onDone">, outcome: PaymentOutcome): Promise<void> {
  const { t } = app.i18n;
  const { link, chain, client } = input;
  const reference = { chainId: chain.chainId, txHash: outcome.txHash, logIndex: outcome.logIndex };
  const verification = await verifyReceipt({ registry: app.registry, client, reference, paid: link });
  if (!verification.valid) {
    throw new AppError("pay.error.receipt", { reason: app.i18n.lookup(verification.i18nKey, verification.params) ?? verification.failure }, "ReceiptMismatch");
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
  const receiptLink = receiptUrl(app.site, fragment);
  const slip = proofSlip(app, {
    proof,
    chain,
    url: receiptLink,
    identity: await receiptIdentity(app, proof),
    checks: [
      ["ok", t("receipt.check.paid")],
      ["ok", t("receipt.check.contract")],
      ["ok", t("receipt.check.invoice")],
    ],
  });
  input.onDone({ amount: proof.amount, txHash: outcome.txHash, logIndex: outcome.logIndex, elapsedMs: outcome.elapsedMs, slip, receiptLink });
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
