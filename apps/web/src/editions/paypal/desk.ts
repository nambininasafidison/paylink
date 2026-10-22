// SPDX-License-Identifier: MIT
/**
 * The desk's cards (docs/paypal/SPEC.md §10, §14.2 F5 and F6, §14.3 "Desk card" and "Tonga ve?"):
 *
 * - a proposal: what the reconciler's fence allows (or the assistant proposed inside it), as an exact-values grid the
 *   payee approves with a tap: the grid's labels are fixed text and its values are computed by code; the assistant's
 *   words, when there are any, sit apart in an AI box marked `data-ai` (AI-4). Approving sends the proposal's hash and
 *   its approval token (HMAC over the canonical proposal, §10.5); the executor reads PayPal and the chain again and acts
 *   only if the fence still allows it, else 409 (stale). Cancelling the token rail also needs the payee's own
 *   transaction (no relayer in this edition), signed in the wallet from the invoice this device holds.
 * - an automatic record (S3): a verified chain payment recorded on the PayPal twin by deterministic code, with Undo
 *   for 24 hours;
 * - an alert: paid on both rails (S4, a guide and nothing automatic) or hands off (S0);
 * - "Was I really paid?": the verdict comes from PayPal's GET and the chain only, never from the message (AI-6), with
 *   one lamp per source and "Can't check now" when a source does not answer.
 *
 * States of a card: proposal · approving · done · stale · rejected · expired · auto-record with Undo · alert.
 *
 * Owner: web edition workstream.
 */
import { PAYPAL_EDITION_CHAIN_ID } from "@paylink/api-contract";
import type { AlertView, ApproveResponse, AutoRecordView, CheckResponse, DeskAlertCode, DeskReasonCode, ExactValue, ProposalKind, ProposalView } from "@paylink/api-contract";
import { formatDateTime } from "@paylink/i18n";
import type { PlainMessageKey } from "@paylink/i18n";
import type { Hex } from "viem";
import type { App } from "../../app/context.ts";
import { cancelInvoice } from "../../app/cancel.ts";
import { routeHref } from "../../app/shell.ts";
import { shortHex } from "../../core/format.ts";
import { payUrl } from "../../core/links.ts";
import { invoiceId, parseStoredInvoice } from "../../store/db.ts";
import { fact, lamp, setStatus, statusLine } from "../../ui/atoms.ts";
import type { LampKind } from "../../ui/atoms.ts";
import { h, replace } from "../../ui/h.ts";
import type { Child } from "../../ui/h.ts";
import { announce, copyText } from "../../ui/live.ts";
import { encodeInvoiceFragment } from "@paylink/sdk";
import { ApiError } from "./api.ts";
import { failureText, seconds } from "./context.ts";

const REASON_TEXT: Readonly<Record<DeskReasonCode, PlainMessageKey>> = {
  "hands-off": "paypal.reason.handsOff",
  open: "paypal.reason.open",
  "reminder-due": "paypal.reason.reminderDue",
  "reminder-after-3-days": "paypal.reason.reminder3Days",
  "share-reminder": "paypal.reason.shareReminder",
  "paid-on-paypal": "paypal.reason.paidOnPaypal",
  "marked-paid-by-you": "paypal.reason.markedPaid",
  "paid-on-chain": "paypal.reason.paidOnChain",
  "paypal-still-open-after-record": "paypal.reason.stillOpen",
  "recorded-then-undone": "paypal.reason.undone",
  "record-missing": "paypal.reason.recordMissing",
  "paid-twice": "paypal.reason.paidTwice",
  "payment-in-flight": "paypal.reason.inFlight",
  "chain-payment-confirming": "paypal.reason.confirming",
  "paypal-cancelled": "paypal.reason.paypalCancelled",
  "chain-cancelled": "paypal.reason.chainCancelled",
  "chain-expired": "paypal.reason.chainExpired",
  "closed-paid-paypal": "paypal.reason.closedPaypal",
  "closed-paid-chain": "paypal.reason.closedChain",
  "closed-cancelled": "paypal.reason.closedCancelled",
  refunded: "paypal.reason.refunded",
};

const ALERT_TEXT: Readonly<Record<DeskAlertCode, PlainMessageKey>> = {
  "paypal-unreadable": "paypal.alert.paypalUnreadable",
  "chain-unreadable": "paypal.alert.chainUnreadable",
  "chain-not-deployed": "paypal.alert.notDeployed",
  "reference-mismatch": "paypal.alert.reference",
  "currency-mismatch": "paypal.alert.currency",
  "amount-mismatch": "paypal.alert.amount",
  "paid-amount-mismatch": "paypal.alert.paidAmount",
  "paypal-status-unknown": "paypal.alert.statusUnknown",
  "paypal-scheduled": "paypal.alert.scheduled",
  "paypal-draft": "paypal.alert.draft",
  "paid-without-transactions": "paypal.alert.noTransactions",
  "paypal-open-with-payments": "paypal.alert.openWithPayments",
  "chain-paid-unverified": "paypal.alert.unverified",
  "chain-payment-mismatch": "paypal.alert.chainMismatch",
  "paid-twice": "paypal.alert.paidTwice",
  "record-missing": "paypal.alert.recordMissing",
};

const KIND_TEXT: Readonly<Record<ProposalKind, PlainMessageKey>> = {
  send_reminder: "paypal.kind.sendReminder",
  share_reminder_text: "paypal.kind.shareReminder",
  cancel_paylink: "paypal.kind.cancelPaylink",
  cancel_paypal: "paypal.kind.cancelPaypal",
  record_external_payment: "paypal.kind.record",
};

/** The approve key of each kind: what the tap does, in words. */
const APPROVE_TEXT: Readonly<Record<ProposalKind, PlainMessageKey>> = {
  send_reminder: "paypal.approve.sendReminder",
  share_reminder_text: "paypal.approve.share",
  cancel_paylink: "paypal.approve.cancelPaylink",
  cancel_paypal: "paypal.approve.cancelPaypal",
  record_external_payment: "paypal.approve.record",
};

const EFFECT_TEXT: Readonly<Record<string, PlainMessageKey>> = {
  "paypal-sends-its-reminder": "paypal.effect.reminder",
  "you-share-the-text": "paypal.effect.share",
  "closes-the-token-rail": "paypal.effect.closeToken",
  "closes-the-paypal-rail": "paypal.effect.closePaypal",
  "records-on-paypal": "paypal.effect.record",
};

const LABEL_TEXT: Readonly<Record<ExactValue["label"], PlainMessageKey>> = {
  invoice: "paypal.exact.invoice",
  amount: "paypal.exact.amount",
  action: "paypal.exact.action",
  effect: "paypal.exact.effect",
  rail: "paypal.exact.rail",
  client: "paypal.exact.client",
  due: "paypal.exact.due",
  transaction: "paypal.exact.transaction",
};

const known = <K extends string>(table: Readonly<Record<K, PlainMessageKey>>, code: string): PlainMessageKey | null => (Object.hasOwn(table, code) ? table[code as K] : null);

export function reasonText(app: Pick<App, "i18n">, code: string): string {
  const key = known(REASON_TEXT, code);
  return key === null ? app.i18n.t("paypal.reason.other") : app.i18n.t(key);
}

export function alertText(app: Pick<App, "i18n">, code: string): string {
  const key = known(ALERT_TEXT, code);
  return key === null ? app.i18n.t("paypal.alert.other") : app.i18n.t(key);
}

/** One value of the grid: words for the codes PayLink fixed, the value itself otherwise (never model text). */
function exactValue(app: App, value: ExactValue): Child {
  const { t } = app.i18n;
  switch (value.label) {
    case "action": {
      const key = known(KIND_TEXT, value.value);
      return key === null ? value.value : t(key);
    }
    case "effect": {
      const key = known(EFFECT_TEXT, value.value);
      return key === null ? value.value : t(key);
    }
    case "rail":
      return h("span", { class: "rail-tag" }, value.value);
    case "transaction":
      return /^0x[0-9a-fA-F]{64}$/.test(value.value) ? h("span", { class: "nowrap", attrs: { title: value.value } }, shortHex(value.value as Hex, 10, 8)) : value.value;
    case "due": {
      const due = Date.parse(`${value.value}T12:00:00Z`);
      return Number.isNaN(due) ? value.value : formatDateTime(app.locale, Math.floor(due / 1000), { dateStyle: "medium" });
    }
    default:
      return value.value;
  }
}

/** The grid the payee approves, in a display window: fixed labels, values computed by code. */
export function exactGrid(app: App, proposal: Pick<ProposalView, "exact" | "invoiceNumber">): HTMLElement {
  const { t } = app.i18n;
  return h(
    "section",
    { class: "screen exact", attrs: { "aria-label": t("paypal.exact.title"), "data-exact": "" } },
    h("div", { class: "screen-top" }, h("span", null, t("paypal.exact.title")), h("span", null, proposal.invoiceNumber)),
    h(
      "dl",
      { class: "readings" },
      proposal.exact.map((value) => {
        const label = known(LABEL_TEXT, value.label);
        return h("div", { attrs: { "data-label": value.label, "data-value": value.value } }, h("dt", null, label === null ? value.label : t(label)), h("dd", null, exactValue(app, value)));
      }),
    ),
  );
}

/** The assistant's words on a proposal: an AI box, labelled, apart from the grid (AI-4). */
export function assistantNote(app: App, message: NonNullable<ProposalView["message"]>): HTMLElement {
  const { t } = app.i18n;
  return h(
    "section",
    { class: "ai-box", attrs: { "data-ai": "message", lang: message.language, "aria-label": t("paypal.assistant.pill") } },
    h("div", { class: "ai-head" }, lamp("wait", t("paypal.assistant.pill"), true), h("span", { class: "ai-model" }, t("paypal.assistant.written"))),
    h("p", { class: "ai-text" }, message.text),
    h("p", { class: "ai-note" }, message.grounded ? t("paypal.assistant.grounded") : t("paypal.assistant.template")),
  );
}

/** What the desk does with the API: the page passes these in, each already holding the session. */
export interface DeskActions {
  approve(proposal: ProposalView): Promise<ApproveResponse>;
  reject(proposal: ProposalView): Promise<void>;
  undo(record: AutoRecordView): Promise<void>;
  /** Reads the desk again (after a stale answer or a chain cancel). */
  reload(): void;
}

const STATE_LAMP: Readonly<Record<ProposalView["state"], LampKind>> = { open: "open", approving: "busy", done: "paid", stale: "wait", rejected: "closed", expired: "closed" };

/** The text the payee shares for a reminder: the assistant's draft when it has one, else PayLink's fixed sentence. */
async function shareText(app: App, proposal: ProposalView): Promise<string> {
  if (proposal.message !== null) {
    return proposal.message.text;
  }
  const stored = await app.store.getInvoice(invoiceId(PAYPAL_EDITION_CHAIN_ID, proposal.key)).catch(() => null);
  const parsed = stored === null ? null : parseStoredInvoice(stored, app.registry);
  const amount = `${proposal.amount} USD`;
  return parsed === null
    ? app.i18n.t("paypal.share.reminder", { number: proposal.invoiceNumber, amount })
    : app.i18n.t("paypal.share.reminderLink", { number: proposal.invoiceNumber, amount, url: payUrl(app.site, encodeInvoiceFragment(parsed.link)) });
}

/** Cancels the token rail of `proposal` from the invoice this device holds: the payee's own transaction. */
async function cancelOnChain(app: App, proposal: ProposalView, status: HTMLElement): Promise<boolean> {
  const { t } = app.i18n;
  const stored = await app.store.getInvoice(invoiceId(PAYPAL_EDITION_CHAIN_ID, proposal.key)).catch(() => null);
  const link = stored === null ? null : (parseStoredInvoice(stored, app.registry)?.link ?? null);
  const account = app.session.account();
  const notHere = (): false => {
    setStatus(status, "warn", t("paypal.cancel.notHere"));
    return false;
  };
  if (link === null || account === null) {
    return notHere();
  }
  if (link.invoice.payee.toLowerCase() !== account.address.toLowerCase()) {
    return notHere();
  }
  await cancelInvoice(app, link, account, (step) => {
    setStatus(status, "", step === "confirm" ? t("ledger.cancel.confirm") : step === "sent" ? t("ledger.cancel.sent") : t("ledger.cancel.sign"));
  });
  return true;
}

/** One proposal card. */
export function proposalCard(app: App, proposal: ProposalView, actions: DeskActions): HTMLLIElement {
  const { t } = app.i18n;
  const card = h("li", { class: "desk-card", attrs: { "data-kind": proposal.kind, "data-state": proposal.state, "data-origin": proposal.origin, "data-id": proposal.id } });
  const pill = h("span");
  const status = statusLine();
  const keys = h("div", { class: "key-row" });
  const setState = (state: ProposalView["state"] | "approving", label?: string): void => {
    card.setAttribute("data-state", state);
    card.classList.toggle("is-done", state === "done");
    card.classList.toggle("is-rejected", state === "rejected" || state === "expired");
    replace(pill, lamp(STATE_LAMP[state], label ?? t(`paypal.state.${state}` as "paypal.state.open"), true));
  };
  setState(proposal.state);
  const approveKey = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "approve" } }, t(APPROVE_TEXT[proposal.kind]));
  const rejectKey = h("button", { class: "key key-text", attrs: { type: "button", "data-action": "reject" } }, t("paypal.reject"));
  const busy = (on: boolean): void => {
    approveKey.disabled = on;
    rejectKey.disabled = on;
    if (on) {
      approveKey.setAttribute("aria-busy", "true");
    } else {
      approveKey.removeAttribute("aria-busy");
    }
  };
  const fail = (error: unknown): void => {
    if (error instanceof ApiError && error.code === "stale") {
      setState("stale");
      replace(keys, h("button", { class: "key key-line", attrs: { type: "button", "data-action": "reload" }, on: { click: () => { actions.reload(); } } }, t("paypal.readAgain")));
    }
    const failure = failureText(app, error);
    setStatus(status, error instanceof ApiError && error.code === "stale" ? "warn" : "err", failure.message, failure.code);
  };
  approveKey.addEventListener("click", () => {
    busy(true);
    setState("approving");
    setStatus(status, "", t("paypal.approving"));
    void (async () => {
      try {
        // The text to share is fetched before the tap's effect, so the share sheet opens on the same gesture's turn.
        const text = proposal.kind === "share_reminder_text" ? await shareText(app, proposal) : null;
        const answer = await actions.approve(proposal);
        if (answer.state === "signature-required") {
          setStatus(status, "", t("paypal.cancel.signing"));
          if (!(await cancelOnChain(app, proposal, status))) {
            setState("open");
            busy(false);
            return;
          }
          setState("done");
          setStatus(status, "ok", t("paypal.cancel.done"));
          announce(t("paypal.cancel.done"));
          replace(keys);
          return;
        }
        setState("done");
        replace(keys);
        if (text !== null) {
          setStatus(status, "ok", t("paypal.share.ready"));
          const share = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "share" } }, typeof navigator.share === "function" ? t("paypal.share.open") : t("paypal.share.copy"));
          share.addEventListener("click", () => {
            if (typeof navigator.share === "function") {
              navigator.share({ text }).catch(() => undefined);
            } else {
              void copyText(text, share, { idle: t("paypal.share.copy"), done: t("share.copied"), said: t("paypal.share.copied") });
            }
          });
          replace(keys, share);
          return;
        }
        if (answer.unconfirmed === true) {
          // PayPal did not answer the reminder: it may have gone, so it counts as sent (never repeated blind).
          setStatus(status, "warn", t("paypal.approve.unconfirmed"));
          announce(t("paypal.approve.unconfirmed"));
          return;
        }
        setStatus(status, "ok", t("paypal.approved"));
        announce(t("paypal.approved"));
      } catch (error) {
        if (card.getAttribute("data-state") === "approving") {
          setState("open");
        }
        busy(false);
        fail(error);
      }
    })();
  });
  rejectKey.addEventListener("click", () => {
    busy(true);
    void actions
      .reject(proposal)
      .then(() => {
        setState("rejected");
        replace(keys);
        setStatus(status, "", t("paypal.rejected"));
      })
      .catch((error: unknown) => {
        busy(false);
        fail(error);
      });
  });
  if (proposal.state === "open") {
    replace(keys, approveKey, rejectKey);
  } else if (proposal.state === "approving" && proposal.kind === "cancel_paylink") {
    setStatus(status, "", t("paypal.cancel.waiting"));
  }
  const rails = proposal.rail === null ? null : h("span", { class: "rail-tag" }, proposal.rail);
  replace(
    card,
    h("div", { class: "desk-card-head" }, pill, h("span", { class: "rail-tags" }, rails, h("span", { class: "view-meta" }, proposal.origin === "assistant" ? t("paypal.origin.assistant") : t("paypal.origin.reconciler")))),
    h("h3", { class: "desk-card-title" }, reasonText(app, proposal.reasonCode)),
    exactGrid(app, proposal),
    proposal.kind === "send_reminder" ? h("p", { class: "field-hint" }, t("paypal.reminder.standard")) : null,
    proposal.message === null ? null : assistantNote(app, proposal.message),
    keys,
    status,
  );
  return card;
}

/** An automatic record (S3) with its Undo key while the 24 hours run. */
export function recordCard(app: App, record: AutoRecordView, actions: DeskActions, now = Date.now()): HTMLLIElement {
  const { t } = app.i18n;
  const status = statusLine();
  const until = Date.parse(record.undoUntil);
  const open = !record.undone && !Number.isNaN(until) && until > now;
  const recorded = seconds(record.recordedAt);
  const card = h("li", { class: ["desk-card", record.undone ? "is-rejected" : null], attrs: { "data-kind": "auto-record", "data-state": record.undone ? "undone" : open ? "undo-open" : "final", "data-id": record.id } });
  const keys = h("div", { class: "key-row" });
  if (open) {
    const undo = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "undo" } }, app.i18n.plural("paypal.record.undoLeft", Math.max(1, Math.ceil((until - now) / 3_600_000)), {}));
    undo.addEventListener("click", () => {
      undo.disabled = true;
      undo.setAttribute("aria-busy", "true");
      void actions
        .undo(record)
        .then(() => {
          card.setAttribute("data-state", "undone");
          card.classList.add("is-rejected");
          replace(keys);
          setStatus(status, "ok", t("paypal.record.undone"));
          announce(t("paypal.record.undone"));
        })
        .catch((error: unknown) => {
          undo.disabled = false;
          undo.removeAttribute("aria-busy");
          const failure = failureText(app, error);
          setStatus(status, "err", failure.message, failure.code);
        });
    });
    keys.append(undo);
  }
  replace(
    card,
    h("div", { class: "desk-card-head" }, lamp(record.undone ? "closed" : "paid", record.undone ? t("paypal.record.undonePill") : t("paypal.record.pill"), true), h("span", { class: "rail-tags" }, h("span", { class: "rail-tag" }, record.rail), h("span", { class: "rail-tag" }, "PAYPAL"))),
    h("h3", { class: "desk-card-title" }, t("paypal.record.title", { number: record.invoiceNumber })),
    h(
      "section",
      { class: "screen exact", attrs: { "aria-label": t("paypal.exact.title") } },
      h("dl", { class: "readings" }, fact(t("paypal.exact.invoice"), record.invoiceNumber), fact(t("paypal.record.payment"), record.paymentId), fact(t("paypal.exact.transaction"), h("span", { class: "nowrap", attrs: { title: record.txHash } }, shortHex(record.txHash, 10, 8))), fact(t("paypal.record.when"), recorded === null ? "—" : formatDateTime(app.locale, recorded))),
    ),
    h("p", { class: "field-hint" }, record.undone ? t("paypal.record.undoneNote") : open ? t("paypal.record.note") : t("paypal.record.closedNote")),
    keys,
    status,
  );
  return card;
}

/**
 * A red alert: paid on both rails (with the guide), a record of a chain payment gone from PayPal (its two proposals are
 * on the desk), or hands off. Nothing on it acts. The card stays a list item (a list
 * holds list items only, WCAG 1.3.1); its content is the `alert` region, announced when the desk shows it.
 */
export function alertCard(app: App, alert: AlertView): HTMLLIElement {
  const { t } = app.i18n;
  const raised = seconds(alert.raisedAt);
  return h(
    "li",
    { class: "desk-card is-alert", attrs: { "data-kind": "alert", "data-situation": alert.situation, "data-code": alert.code } },
    h(
      "div",
      { attrs: { role: "alert" } },
      h("div", { class: "desk-card-head" }, lamp("err", alert.situation === "S4" ? t("paypal.alert.paidTwicePill") : alert.situation === "S3" ? t("paypal.alert.recordMissingPill") : t("paypal.alert.handsOffPill"), true), h("span", { class: "view-meta" }, alert.invoiceNumber ?? shortHex(alert.key))),
      h("h3", { class: "desk-card-title" }, alertText(app, alert.code)),
      alert.situation === "S4"
        ? h(
            "ol",
            { class: "desk-guide" },
            h("li", null, t("paypal.alert.guide1"), " ", h("a", { attrs: { href: routeHref(app, "send") } }, t("paypal.alert.guideSend"))),
            h("li", null, t("paypal.alert.guide2")),
            h("li", null, t("paypal.alert.guide3")),
          )
        : h("p", { class: "field-hint" }, alert.situation === "S3" ? t("paypal.alert.recordMissingNote") : t("paypal.alert.handsOffNote")),
      raised === null ? null : h("p", { class: "field-hint" }, t("paypal.alert.raised", { time: formatDateTime(app.locale, raised) })),
    ),
  );
}

const VERDICT_TEXT = {
  RECEIVED: ["paypal.check.received", "paypal.check.receivedText", ""],
  NOT_RECEIVED: ["paypal.check.notReceived", "paypal.check.notReceivedText", "is-err"],
  PARTLY_RECEIVED: ["paypal.check.partly", "paypal.check.partlyText", "is-wait"],
  UNAVAILABLE: ["paypal.check.unavailable", "paypal.check.unavailableText", "is-wait"],
} as const satisfies Readonly<Record<CheckResponse["verdict"], readonly [PlainMessageKey, PlainMessageKey, string]>>;

/** The verdict readout: one lamp per source, the payee's records it found, the links and their hosts, the verdict. */
export function verdictReadout(app: App, answer: CheckResponse): HTMLElement {
  const { t } = app.i18n;
  // A source that did not answer makes the verdict "can't check now", whatever else came back (never a guess).
  const verdict = answer.sources.paypal === "unavailable" || answer.sources.chain === "unavailable" ? "UNAVAILABLE" : answer.verdict;
  const [head, text, kind] = VERDICT_TEXT[verdict];
  const checked = seconds(answer.checkedAt);
  const source = (name: string, state: "checked" | "unavailable"): HTMLElement =>
    h("li", { attrs: { "data-lamp": state === "checked" ? "ok" : "wait", "data-source": name } }, h("span", { class: "vstrip-name" }, h("span", null, name), h("span", { class: "vstrip-state" }, state === "checked" ? t("paypal.check.sourceChecked") : t("paypal.check.sourceDown"))));
  return h(
    "section",
    { class: "screen check-verdict", attrs: { "aria-labelledby": "check-verdict-head", "data-verdict": verdict } },
    h("div", { class: "screen-top" }, h("span", null, t("paypal.check.kicker")), h("span", null, checked === null ? "" : formatDateTime(app.locale, checked, { timeStyle: "medium" }))),
    h("ul", { class: "vstrip" }, source(t("paypal.check.sourcePaypal"), answer.sources.paypal), source(t("paypal.check.sourceChain"), answer.sources.chain)),
    answer.matches.length === 0
      ? null
      : h("dl", { class: "readings" }, answer.matches.map((m) => fact(m.invoiceNumber, `${m.amount} USD · ${m.paidOn.length === 0 ? t("paypal.check.notPaid") : t("paypal.check.paidOn", { rails: m.paidOn.join(" + ") })}`))),
    answer.links.length === 0
      ? null
      : h("dl", { class: "readings" }, answer.links.map((l) => fact(t("paypal.check.link"), h("span", { class: l.allowed ? "ok" : "bad" }, `${l.host} · ${l.allowed ? t("paypal.check.linkKnown") : t("paypal.check.linkUnknown")}`)))),
    h("p", { class: "screen-sub" }, t(text)),
    h("div", { class: ["verdict", kind === "" ? null : kind], attrs: { role: "status" } }, h("b", { attrs: { id: "check-verdict-head" } }, t(head)), h("span", null, t("paypal.check.basis"))),
  );
}
