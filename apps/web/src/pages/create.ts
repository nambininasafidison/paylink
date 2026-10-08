// SPDX-License-Identifier: MIT
/**
 * `/`: the payee's terminal. Fill in the invoice, read exactly what will be signed in the signing display, sign it in
 * the wallet (EIP-712, no transaction, no gas), then share the link: copy, WhatsApp, the system share sheet, the
 * printed card with its QR code, or straight to the till. Invoice spec §13.1 is applied by the SDK (`issueInvoice`):
 * registry deployment, allowlisted token, shape, payee = signer, signature verified with the contract's dispatch, so a
 * counterfactual smart-account payee is refused before anything is shared.
 */
import type { ChainDefinition, Token } from "@paylink/chains";
import { DEFAULT_INVOICE_TTL_SECONDS, expiresIn, hasMemo, isPayLinkError, issueInvoice, MAX_MEMO_BYTES, memoBytes, normalizeMemo, toSignedInvoiceJson } from "@paylink/sdk";
import type { Expiry, IssuedInvoice, IssuerWarning } from "@paylink/sdk";
import { formatDateTime } from "@paylink/i18n";
import type { AccountProvider } from "../accounts/types.ts";
import type { PageDefinition } from "../app/boot.ts";
import { bandOptions, initialChain, networkName, plateText } from "../app/chains.ts";
import type { App } from "../app/context.ts";
import { intro, routeHref, steps } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { pickWallet } from "../app/wallet-ui.ts";
import { chainTime } from "../core/clients.ts";
import { AppError, decodeUiError } from "../core/errors.ts";
import { displayAmount, parseTypedAmount, shortHex } from "../core/format.ts";
import { payUrl, tillUrl, whatsappUrl } from "../core/links.ts";
import { invoiceId } from "../store/db.ts";
import { addr, fact, setStatus, statusLine } from "../ui/atoms.ts";
import { bandSelector, confirmBox, segmented } from "../ui/controls.ts";
import { h, replace } from "../ui/h.ts";
import { copyText, printElement } from "../ui/live.ts";
import { ticket } from "../ui/ticket.ts";

type PaymentsChoice = "one" | "several" | "unlimited";
type ExpiryChoice = "1d" | "7d" | "30d" | "never";

const EXPIRY_SECONDS: Readonly<Record<Exclude<ExpiryChoice, "never">, bigint>> = { "1d": 86_400n, "7d": DEFAULT_INVOICE_TTL_SECONDS, "30d": 30n * 86_400n };
const MAX_SEATS = 1_000_000;

interface Draft {
  readonly chain: ChainDefinition;
  readonly token: Token;
  readonly amount: bigint;
  readonly memo: string | null;
  readonly maxPayments: number;
  readonly expiry: ExpiryChoice;
}

function listedTokens(chain: ChainDefinition): Token[] {
  return chain.tokens.filter((t) => t.listing !== "hidden");
}

export const createPage: PageDefinition = {
  route: "create",
  payer: false,
  title: "create.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(
      intro({
        kicker: t("create.kicker"),
        title: [t("create.h1a"), t("create.h1b")],
        lede: t("create.lede"),
        specs: [
          [t("create.spec.cost"), "0"],
          [t("create.spec.fee"), h("span", null, "0", h("small", null, "%"))],
          [t("create.spec.custody"), t("common.none")],
          [t("create.spec.signup"), t("common.none")],
        ],
      }),
    );
    ui.aside.append(
      steps(t("create.how"), [
        [t("create.step1.title"), t("create.step1.text")],
        [t("create.step2.title"), t("create.step2.text")],
        [t("create.step3.title"), t("create.step3.text")],
      ]),
    );
    renderTerminal(app, ui);
  },
};

function renderTerminal(app: App, ui: PageUi): void {
  const { t } = app.i18n;
  const preset = new URLSearchParams(location.search).get("preset");
  let chain = initialChain(app);
  if (chain === undefined) {
    ui.plate(t("app.plate.noChain"), "off");
    ui.views.append(h("section", { class: "view" }, h("p", { class: "state-note" }, t("create.noChains"))));
    return;
  }
  let token: Token | undefined = app.edition.defaultToken(chain);
  let payments: PaymentsChoice = preset === "card" ? "unlimited" : "one";
  let expiry: ExpiryChoice = preset === "card" ? "never" : "7d";
  let issued: IssuedInvoice | null = null;

  const meta = h("span", { class: "view-meta" });
  const notDeployed = h("div");
  const unitSlot = h("span", { attrs: { "aria-hidden": "true" } });
  const amountInput = h("input", {
    class: "readout-input",
    attrs: { id: "amount", inputmode: "decimal", placeholder: app.locale === "en" ? "0.00" : "0,00", autocomplete: "off", spellcheck: "false", "aria-describedby": "amount-hint" },
  });
  const amountHint = h("p", { class: "readout-hint", attrs: { id: "amount-hint" } }, t("create.amountHint"));
  const memoCount = h("span", { class: "count", attrs: { "aria-hidden": "true" } });
  const memoInput = h("input", { attrs: { id: "memo", autocomplete: "off", placeholder: t("create.memoPlaceholder"), "aria-describedby": "memo-hint" } });
  const seatsInput = h("input", { attrs: { id: "seats", type: "number", inputmode: "numeric", min: "2", max: String(MAX_SEATS), value: "2", "aria-describedby": "seats-hint" } });
  const seatsField = h(
    "div",
    { class: "field", attrs: { hidden: true } },
    h("label", { attrs: { for: "seats" } }, t("create.seats")),
    h("div", { class: "well with-unit" }, seatsInput, h("span", { attrs: { "aria-hidden": "true" } }, t("create.seatsUnit"))),
    h("p", { class: "field-hint", attrs: { id: "seats-hint" } }, t("create.seatsHint")),
  );
  const never = confirmBox(t("create.neverConfirm"), () => {
    clearOutput();
  });
  never.element.hidden = expiry !== "never";
  const status = statusLine();
  const signing = h("div");
  const out = h("div", { class: "out" });
  const key = h("button", { class: "key key-primary", attrs: { type: "button" } });

  const clearOutput = (): void => {
    replace(signing);
    setStatus(status, "", "");
  };
  const refreshKey = (): void => {
    key.textContent = app.session.account() === null ? t("create.connectFirst") : t("create.review");
    const account = app.session.account();
    meta.textContent = account === null ? "" : shortHex(account.address);
  };
  const refreshChain = (): void => {
    if (chain === undefined) {
      return;
    }
    const target = app.registry.v2Target(chain.chainId);
    ui.plate(plateText(chain), target === undefined ? "wait" : "ok");
    replace(
      notDeployed,
      target === undefined
        ? h(
            "p",
            { class: "warn-note" },
            h("b", null, t("chain.notDeployed")),
            " ",
            t("chain.notDeployedLong", { network: networkName(chain) }),
            " ",
            h("a", { attrs: { href: `/deploy/?chain=${chain.label.toLowerCase()}` } }, t("chain.deployLink")),
          )
        : null,
    );
    const tokens = listedTokens(chain);
    token = token !== undefined && tokens.some((x) => x.address === token?.address) ? token : app.edition.defaultToken(chain);
    if (tokens.length > 1) {
      const select = h(
        "select",
        { attrs: { "aria-label": t("create.token") }, on: { change: () => { token = tokens.find((x) => x.address === select.value); clearOutput(); } } },
        tokens.map((x) => h("option", { attrs: { value: x.address, selected: x.address === token?.address } }, x.symbol)),
      );
      replace(unitSlot, select);
      unitSlot.removeAttribute("aria-hidden");
    } else {
      replace(unitSlot, token?.symbol ?? "");
      unitSlot.setAttribute("aria-hidden", "true");
    }
  };
  const refreshMemo = (): void => {
    const used = memoBytes(normalizeMemo(memoInput.value.trim())).length;
    memoCount.textContent = t("create.memoCount", { used, max: MAX_MEMO_BYTES });
    memoCount.classList.toggle("is-over", used > MAX_MEMO_BYTES);
    memoInput.setAttribute("aria-invalid", used > MAX_MEMO_BYTES ? "true" : "false");
  };

  const bands = bandSelector(bandOptions(app), chain.chainId, t("create.network"), (id) => {
    chain = app.registry.get(id);
    clearOutput();
    refreshChain();
  });
  const paymentsSeg = segmented<PaymentsChoice>(
    "payments",
    t("create.payments"),
    [
      { value: "one", label: t("create.payments.single"), sub: t("create.payments.singleSub") },
      { value: "several", label: t("create.payments.several"), sub: t("create.payments.severalSub") },
      { value: "unlimited", label: t("create.payments.unlimited"), sub: t("create.payments.unlimitedSub") },
    ],
    payments,
    (value) => {
      payments = value;
      seatsField.hidden = value !== "several";
      clearOutput();
    },
  );
  const expirySeg = segmented<ExpiryChoice>(
    "expiry",
    t("create.expiry"),
    [
      { value: "1d", label: t("create.expiry.1d") },
      { value: "7d", label: t("create.expiry.7d") },
      { value: "30d", label: t("create.expiry.30d") },
      { value: "never", label: t("create.expiry.never") },
    ],
    expiry,
    (value) => {
      expiry = value;
      never.element.hidden = value !== "never";
      clearOutput();
    },
  );
  amountInput.addEventListener("input", clearOutput);
  memoInput.addEventListener("input", () => {
    refreshMemo();
    clearOutput();
  });
  seatsInput.addEventListener("input", clearOutput);

  /** Reads and checks the form; throws an AppError naming the field. */
  const readDraft = (): Draft => {
    if (chain === undefined || token === undefined) {
      throw new AppError("create.error.noToken", {});
    }
    if (app.registry.v2Target(chain.chainId) === undefined) {
      throw new AppError("chain.notDeployedLong", { network: networkName(chain) });
    }
    const typed = amountInput.value.trim();
    let amount = 0n;
    if (typed !== "") {
      try {
        amount = parseTypedAmount(typed, token);
      } catch (error) {
        amountInput.focus();
        throw isPayLinkError(error, "E_AMOUNT_PRECISION") ? new AppError("create.error.precision", { decimals: token.decimals }) : new AppError("create.error.amount", {});
      }
      if (amount === 0n) {
        amountInput.focus();
        throw new AppError("create.error.amount", {});
      }
    }
    const memo = memoInput.value.trim() === "" ? null : normalizeMemo(memoInput.value.trim());
    if (memo !== null && memoBytes(memo).length > MAX_MEMO_BYTES) {
      memoInput.focus();
      throw new AppError("create.error.memoTooLong", { used: memoBytes(memo).length, max: MAX_MEMO_BYTES });
    }
    let maxPayments = 1;
    if (payments === "unlimited") {
      maxPayments = 0;
    } else if (payments === "several") {
      const seats = Number(seatsInput.value);
      if (!Number.isInteger(seats) || seats < 2 || seats > MAX_SEATS) {
        seatsInput.focus();
        throw new AppError("create.error.seats", { max: MAX_SEATS });
      }
      maxPayments = seats;
    }
    if (expiry === "never" && !never.checked()) {
      throw new AppError("create.error.never", {});
    }
    return { chain, token, amount, memo, maxPayments, expiry };
  };

  const describe = (draft: Draft): { amount: string | null; payments: string; kind: string } => ({
    amount: draft.amount === 0n ? null : displayAmount(draft.amount, draft.token, app.locale),
    payments: draft.maxPayments === 1 ? t("create.payments.single") : draft.maxPayments === 0 ? t("create.payments.unlimited") : app.i18n.plural("create.seatsCount", draft.maxPayments, {}),
    kind: draft.maxPayments === 1 ? t("ticket.invoice") : draft.maxPayments === 0 ? t("ticket.card") : app.i18n.plural("create.seatsCount", draft.maxPayments, {}),
  });

  const sign = async (draft: Draft, account: AccountProvider): Promise<void> => {
    const client = app.client(draft.chain);
    setStatus(status, "", t("wallet.switching"));
    await account.switchChain(draft.chain);
    let now: bigint;
    try {
      now = await chainTime(client);
    } catch {
      now = BigInt(Math.floor(Date.now() / 1000));
    }
    const expiryValue: Expiry = draft.expiry === "never" ? { kind: "never", confirmed: true } : expiresIn(now, EXPIRY_SECONDS[draft.expiry]);
    setStatus(status, "", t("create.status.signing"));
    let result: IssuedInvoice;
    const params = { registry: app.registry, chainId: draft.chain.chainId, signer: account, draft: { payee: account.address, token: draft.token.address, amount: draft.amount, maxPayments: draft.maxPayments, expiry: expiryValue, memo: draft.memo } };
    try {
      result = await issueInvoice({ ...params, client });
    } catch (error) {
      if (decodeUiError(app, error).name === "RequestError" || decodeUiError(app, error).name === "TimeoutError") {
        // Offline: sign and check the ECDSA signature locally; the payer's client checks it on-chain before paying.
        result = await issueInvoice(params);
      } else {
        throw error;
      }
    }
    await app.store.putInvoice({
      id: invoiceId(result.signed.chainId, result.key),
      chainId: result.signed.chainId,
      key: result.key,
      signed: toSignedInvoiceJson(result.signed, result.key),
      role: "issued",
      createdAt: Date.now(),
    });
    issued = result;
    replace(signing);
    setStatus(status, "ok", t("create.status.done"));
    renderIssued(app, out, result, draft);
  };

  const review = (draft: Draft, account: AccountProvider): void => {
    const described = describe(draft);
    const target = app.registry.v2Target(draft.chain.chainId);
    const until = draft.expiry === "never" ? t("create.sign.never") : formatDateTime(app.locale, BigInt(Math.floor(Date.now() / 1000)) + EXPIRY_SECONDS[draft.expiry]);
    const confirm = h("button", { class: "key key-primary", attrs: { type: "button" } }, t("create.sign.confirm"));
    const edit = h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { clearOutput(); amountInput.focus(); } } }, t("create.sign.edit"));
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      confirm.setAttribute("aria-busy", "true");
      edit.disabled = true;
      sign(draft, account)
        .catch((error: unknown) => {
          const decoded = decodeUiError(app, error);
          setStatus(status, "err", decoded.message, decoded.code);
        })
        .finally(() => {
          confirm.disabled = false;
          confirm.removeAttribute("aria-busy");
          edit.disabled = false;
        });
    });
    replace(
      signing,
      h(
        "section",
        { class: "screen signing", attrs: { "aria-labelledby": "signing-title" } },
        h("div", { class: "screen-top" }, h("span", null, t("create.sign.kicker")), h("span", null, draft.chain.label)),
        h("h3", { attrs: { id: "signing-title" } }, t("create.sign.title")),
        h(
          "dl",
          { class: "readings" },
          h("div", { class: "is-amount" }, h("dt", null, t("create.sign.amount")), h("dd", null, described.amount ?? t("ticket.any"), described.amount === null ? null : h("span", { class: "unit" }, draft.token.symbol))),
          fact(t("create.sign.payee"), addr(account.address)),
          fact(t("create.sign.payments"), described.payments),
          fact(t("create.sign.expires"), until),
          draft.memo === null ? null : fact(t("create.sign.memo"), draft.memo),
          fact(t("create.sign.network"), `${networkName(draft.chain)} · ${draft.chain.chainId}`),
          fact(t("create.sign.contract"), target === undefined ? "—" : h("span", { class: "nowrap" }, shortHex(target.deployment.address, 8, 6))),
        ),
        h("p", { class: "signing-note" }, t("create.sign.note")),
      ),
      h("div", { class: "key-row" }, confirm, edit),
    );
    confirm.focus();
  };

  key.addEventListener("click", () => {
    void (async () => {
      replace(out);
      issued = null;
      try {
        const draft = readDraft();
        const account = app.session.account() ?? (await pickWallet(app));
        if (account === null) {
          return;
        }
        setStatus(status, "", "");
        review(draft, account);
      } catch (error) {
        const decoded = decodeUiError(app, error);
        setStatus(status, "err", decoded.message, decoded.code);
      }
    })();
  });

  app.session.subscribe(() => {
    refreshKey();
    if (issued !== null && app.session.account()?.address.toLowerCase() !== issued.signed.invoice.payee.toLowerCase()) {
      clearOutput();
    }
  });
  refreshChain();
  refreshMemo();
  refreshKey();

  ui.views.append(
    h(
      "section",
      { class: "view view-create", attrs: { "aria-labelledby": "create-head" } },
      h("div", { class: "view-head" }, h("h2", { attrs: { id: "create-head" } }, t("create.head")), meta),
      h("div", { class: "field" }, h("span", { class: "label" }, t("create.network")), bands.element),
      notDeployed,
      h(
        "div",
        { class: "readout" },
        h("div", { class: "readout-top" }, h("label", { attrs: { for: "amount" } }, t("create.amount")), unitSlot),
        amountInput,
        amountHint,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { attrs: { for: "memo" } }, t("create.memo"), h("span", { class: "opt" }, t("common.optional")), memoCount),
        memoInput,
        h("p", { class: "field-hint", attrs: { id: "memo-hint" } }, t("create.memoHint")),
      ),
      paymentsSeg.element,
      seatsField,
      expirySeg.element,
      never.element,
      key,
      signing,
      status,
      out,
    ),
  );
}

function warningText(app: App, warning: IssuerWarning): string {
  const { t } = app.i18n;
  switch (warning) {
    case "open-amount-single-use":
      return t("create.warn.openSingle");
    case "no-expiry":
      return t("create.warn.noExpiry");
    case "unlimited-payments":
      return t("create.warn.unlimited");
  }
}

function shareText(app: App, issued: IssuedInvoice, amount: string | null, url: string): string {
  const { t } = app.i18n;
  const memo = issued.signed.memo;
  if (amount === null) {
    return memo === null ? t("share.messageOpen", { url }) : t("share.messageOpenMemo", { memo, url });
  }
  const money = `${amount} ${issued.token.symbol}`;
  return memo === null ? t("share.messageAmount", { amount: money, url }) : t("share.messageMemo", { memo, amount: money, url });
}

/** The printed card, the copyable link, the share keys and the issuer's warnings. */
function renderIssued(app: App, out: HTMLElement, issued: IssuedInvoice, draft: Draft): void {
  const { t } = app.i18n;
  const url = payUrl(app.site, issued.fragment);
  const amount = draft.amount === 0n ? null : displayAmount(draft.amount, draft.token, app.locale);
  const terms = [
    `${draft.chain.label} · ${draft.chain.chainId}`,
    issued.signed.invoice.validUntil === 0n ? t("ticket.noExpiry") : t("ticket.expires", { date: formatDateTime(app.locale, issued.signed.invoice.validUntil, { dateStyle: "medium" }) }),
    ...(draft.maxPayments > 1 ? [app.i18n.plural("create.seatsCount", draft.maxPayments, {})] : []),
  ];
  const card = ticket({
    kind: draft.maxPayments === 1 ? t("ticket.invoice") : draft.maxPayments === 0 ? t("ticket.card") : t("ticket.seats"),
    amount,
    symbol: draft.token.symbol,
    anyAmount: t("ticket.any"),
    memo: hasMemo(issued.signed.invoice) ? issued.signed.memo : null,
    payee: issued.signed.invoice.payee,
    payeeLabel: t("ticket.payee"),
    terms,
    url,
    scan: t("ticket.scan"),
    scanSub: t("ticket.scanSub", { symbol: draft.token.symbol }),
    qrLabel: t("ticket.qr"),
    cardLabel: amount === null ? t("ticket.labelOpen") : t("ticket.label", { amount: `${amount} ${draft.token.symbol}` }),
  });
  const field = h("input", { attrs: { value: url, readonly: true, "aria-label": t("share.link") }, on: { focus: (e) => { (e.target as HTMLInputElement).select(); } } });
  const copy = h("button", { class: "key key-line", attrs: { type: "button" } }, t("share.copy"));
  copy.addEventListener("click", () => {
    void copyText(url, copy, { idle: t("share.copy"), done: t("share.copied"), said: t("share.copiedSaid") });
  });
  const message = shareText(app, issued, amount, url);
  const canShare = typeof navigator.share === "function";
  const warnings = [...issued.warnings.map((w) => warningText(app, w)), ...(issued.payeeAccount === "delegated" ? [t("create.warn.delegated")] : []), ...(issued.payeeAccount === "unchecked" ? [t("create.warn.unchecked")] : [])];
  replace(
    out,
    h(
      "div",
      { class: "issued" },
      card,
      h("div", { class: "share" }, field, copy),
      h(
        "div",
        { class: "share-keys" },
        h("a", { class: "key key-line ext", attrs: { href: whatsappUrl(message), target: "_blank", rel: "noopener noreferrer" } }, t("share.whatsapp")),
        canShare
          ? h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { navigator.share({ title: "PayLink", text: message }).catch(() => undefined); } } }, t("share.share"))
          : null,
        h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { printElement(card, "a6"); } } }, t("share.print")),
        h("a", { class: "key key-line", attrs: { href: tillUrl(app.site, issued.fragment) } }, t("share.till")),
      ),
      h("p", { class: "ticket-links" }, h("a", { attrs: { href: url } }, t("share.open")), h("a", { attrs: { href: routeHref(app, "ledger") } }, t("share.ledger"))),
      warnings.map((text) => h("p", { class: "warn-note" }, text)),
    ),
  );
  field.scrollLeft = field.scrollWidth;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => {
    out.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  });
}
