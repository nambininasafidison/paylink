// SPDX-License-Identifier: MIT
/**
 * A1, message to invoice draft (docs/paypal/SPEC.md §9.2, §14.2 F1, §14.3 "Assistant sheet"): the Assistant key above
 * the create form opens a sheet (the native `<dialog>`: focus moves in, is held there, and returns to the key) where
 * the payee pastes the client's message. `POST /v1/ai/draft` answers a draft that code made from the model's
 * extraction (the amount parsed by code from the text the model copied); the sheet shows it in an AI box, and
 * **Use draft** fills the form the payee then checks, edits and signs as always. **Write it myself** closes the sheet.
 *
 * States: empty · drafting (a skeleton where the readings will be) · draft · clarification needed (fixed questions) ·
 * unavailable ("Assistant unavailable. Write it yourself.": refused, timed out, invalid, not deployed yet) · resting (the
 * day's allocation is spent). Every state leaves the manual form one key away (U6).
 *
 * AI-4: the draft card carries `data-ai` and an "AI DRAFT" pill and is a paper box, never a display window; nothing
 * of it reaches the signing display except through the form, whose values the payee reviews and owns. Clarifications
 * are fixed codes rendered with owner-reviewed text, never model prose.
 *
 * Owner: web edition workstream.
 */
import { CLARIFICATION_CODES, DRAFT_MAX_TEXT } from "@paylink/api-contract";
import type { ClarificationCode, DraftResponse, InvoiceDraft } from "@paylink/api-contract";
import { LOCALE_INFO, formatDateTime } from "@paylink/i18n";
import type { PlainMessageKey } from "@paylink/i18n";
import type { App } from "../../app/context.ts";
import { pickWallet } from "../../app/wallet-ui.ts";
import { displayAmount, plainAmount } from "../../core/format.ts";
import { fact, lamp, setStatus, statusLine } from "../../ui/atoms.ts";
import { openModal } from "../../ui/dialog.ts";
import type { Modal } from "../../ui/dialog.ts";
import { h, replace } from "../../ui/h.ts";
import { ApiError, postDraft } from "./api.ts";
import { apiFor, failureText } from "./context.ts";
import { withSession } from "./session.ts";

/** The amounts of the edition's tokens: 6 decimals (USDC and PayPal USD, docs/research/paypal/sepolia.md). */
const USD_DECIMALS = { decimals: 6 } as const;

/** What a draft puts into the create form and, after signing, into the twin panel. */
export interface DraftPrefill {
  /** The amount as the form takes it ("120", "7.5"), or `null` when the draft has none. */
  readonly amount: string | null;
  readonly memo: string;
  readonly clientName: string | null;
  readonly clientEmail: string | null;
  readonly dueDate: string | null;
}

const CLARIFICATION_TEXT: Readonly<Record<ClarificationCode, PlainMessageKey>> = {
  amount_missing: "paypal.ai.q.amountMissing",
  amount_ambiguous: "paypal.ai.q.amountAmbiguous",
  several_amounts: "paypal.ai.q.severalAmounts",
  currency_not_usd: "paypal.ai.q.currency",
  due_date_unclear: "paypal.ai.q.dueUnclear",
  due_date_past: "paypal.ai.q.duePast",
  due_date_too_far: "paypal.ai.q.dueFar",
  payee_address_ignored: "paypal.ai.q.payeeIgnored",
};

/** The fixed question for a clarification code; a code this page does not know reads as a generic one. */
export function clarificationText(app: Pick<App, "i18n">, code: string): string {
  const { t } = app.i18n;
  return (CLARIFICATION_CODES as readonly string[]).includes(code) ? t(CLARIFICATION_TEXT[code as ClarificationCode]) : t("paypal.ai.q.other");
}

/** The form's values from a draft: the amount as code parsed it (never the model's text), the rest as drafted. */
export function prefillOf(draft: InvoiceDraft): DraftPrefill {
  return {
    amount: draft.amountBase === null || draft.currency !== "USD" ? null : plainAmount(BigInt(draft.amountBase), USD_DECIMALS),
    memo: draft.description.trim(),
    clientName: draft.clientName,
    clientEmail: draft.clientEmail,
    dueDate: draft.dueDate,
  };
}

const unixOfDate = (date: string): number => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000);

/** The AI box of a draft: its readings, the fixed clarification questions, and the two keys. */
export function draftCard(app: App, response: Extract<DraftResponse, { outcome: "draft" }>, keys: { readonly use: () => void; readonly manual: () => void }): HTMLElement {
  const { t } = app.i18n;
  const { draft } = response;
  const amount = draft.amountBase === null || draft.currency !== "USD" ? null : displayAmount(BigInt(draft.amountBase), USD_DECIMALS, app.locale);
  const use = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "use-draft" }, on: { click: keys.use } }, t("paypal.ai.use"));
  const manual = h("button", { class: "key key-text", attrs: { type: "button", "data-action": "manual" }, on: { click: keys.manual } }, t("paypal.ai.manual"));
  return h(
    "section",
    { class: "ai-box ai-draft", attrs: { "data-ai": "draft", "aria-labelledby": "ai-draft-title" } },
    h("div", { class: "ai-head" }, lamp("wait", t("paypal.ai.pill"), true), h("span", { class: "ai-model" }, t("paypal.ai.model", { model: response.model }))),
    h("h3", { class: "desk-card-title", attrs: { id: "ai-draft-title" } }, t("paypal.ai.draftTitle")),
    h(
      "dl",
      { class: "facts" },
      fact(t("paypal.ai.amount"), amount === null ? t("paypal.ai.none") : `${amount} USD`, draft.amountText === null ? null : h("span", { class: "sub" }, t("paypal.ai.asWritten", { text: draft.amountText }))),
      fact(t("paypal.ai.what"), draft.description === "" ? t("paypal.ai.none") : draft.description),
      fact(t("paypal.ai.client"), draft.clientName ?? t("paypal.ai.none"), draft.clientEmail === null ? null : h("span", { class: "sub" }, draft.clientEmail)),
      fact(t("paypal.ai.due"), draft.dueDate === null ? t("paypal.ai.none") : formatDateTime(app.locale, unixOfDate(draft.dueDate), { dateStyle: "medium" })),
      fact(t("paypal.ai.language"), draft.clientLanguage === null ? t("paypal.ai.none") : LOCALE_INFO[draft.clientLanguage].nativeName),
    ),
    response.clarifications.length === 0
      ? null
      : h("ul", { class: "ai-questions", attrs: { "aria-label": t("paypal.ai.questions") } }, response.clarifications.map((code) => h("li", { attrs: { "data-code": code } }, clarificationText(app, code)))),
    h("p", { class: "ai-note" }, response.confidence === "low" ? t("paypal.ai.lowConfidence") : t("paypal.ai.checkNote")),
    h("div", { class: "key-row" }, use, manual),
  );
}

/** Why there is no draft, in fixed words: resting (the day's allocation) or unavailable (anything else). */
function unavailableCard(app: App, reason: "resting" | "unavailable", code: string | null, manual: () => void): HTMLElement {
  const { t } = app.i18n;
  return h(
    "div",
    { class: ["warn-note", reason === "unavailable" ? "is-err" : null], attrs: { role: "status", "data-state": reason } },
    h("b", null, reason === "resting" ? t("paypal.ai.resting") : t("paypal.ai.unavailable")),
    " ",
    reason === "resting" ? t("paypal.ai.restingText") : t("paypal.ai.unavailableText"),
    code === null ? null : h("span", { class: "status-code" }, code),
    h("div", { class: "key-row" }, h("button", { class: "key key-line", attrs: { type: "button", "data-action": "manual" }, on: { click: manual } }, t("paypal.ai.manual"))),
  );
}

/** The drafting skeleton: the AI box, busy, with bars where the readings will be. */
function draftingCard(app: App): HTMLElement {
  const { t } = app.i18n;
  return h(
    "div",
    { class: "ai-box", attrs: { "data-ai": "drafting", "aria-busy": "true", role: "status" } },
    h("div", { class: "ai-head" }, lamp("busy", t("paypal.ai.pill"), true)),
    h("p", { class: "ai-note" }, t("paypal.ai.drafting")),
    h("div", { class: "ai-skeleton", attrs: { "aria-hidden": "true" } }, h("i"), h("i"), h("i")),
  );
}

/**
 * The Assistant row above the create form: the key that opens the sheet and one line on what it does. `onUse` gets
 * the draft's values; `onManual` puts the payee back in the form.
 */
export function assistantRow(app: App, onUse: (prefill: DraftPrefill) => void, onManual: () => void): HTMLElement {
  const { t } = app.i18n;
  const key = h("button", { class: "key key-line", attrs: { type: "button", "data-action": "assistant", "aria-haspopup": "dialog" } }, t("paypal.ai.key"));
  key.addEventListener("click", () => {
    openSheet(app, onUse, onManual);
  });
  return h("div", { class: "assist-row" }, key, h("p", { class: "field-hint" }, t("paypal.ai.keyHint")));
}

/** Opens the assistant sheet. */
export function openSheet(app: App, onUse: (prefill: DraftPrefill) => void, onManual: () => void): Modal {
  const { t } = app.i18n;
  const api = apiFor(app);
  const count = h("span", { class: "count", attrs: { "aria-hidden": "true" } });
  const input = h("textarea", {
    attrs: { id: "assist-text", maxlength: String(DRAFT_MAX_TEXT), rows: "6", spellcheck: "true", autocomplete: "off", placeholder: t("paypal.ai.placeholder"), "aria-describedby": "assist-privacy" },
  });
  const draftKey = h("button", { class: "key key-primary", attrs: { type: "button", "data-action": "draft" } }, t("paypal.ai.draft"));
  const status = statusLine();
  const result = h("div", { class: "assist-result" });
  let modal: Modal | null = null;
  /**
   * Closes the sheet, then runs `next` once the dialog has handed focus back to the Assistant key (its `close` event),
   * so a callback that moves focus (Write it myself: into the amount) is not undone by that hand-back.
   */
  const closeThen = (next: () => void): void => {
    if (modal?.element.open !== true) {
      next();
      return;
    }
    modal.element.addEventListener("close", next, { once: true });
    modal.close();
  };
  const manual = (): void => {
    closeThen(onManual);
  };
  const refreshCount = (): void => {
    count.textContent = t("paypal.ai.count", { used: input.value.length, max: DRAFT_MAX_TEXT });
  };
  input.addEventListener("input", refreshCount);
  refreshCount();
  const settle = (): void => {
    draftKey.disabled = false;
    draftKey.removeAttribute("aria-busy");
  };
  const run = async (): Promise<void> => {
    const message = input.value.trim();
    if (message === "") {
      setStatus(status, "err", t("paypal.ai.empty"));
      input.focus();
      return;
    }
    if (api === null) {
      replace(result, unavailableCard(app, "unavailable", t("common.errorCode", { code: "ApiNotConfigured" }), manual));
      return;
    }
    await app.session.ready;
    const account = app.session.account() ?? (await pickWallet(app));
    if (account === null) {
      setStatus(status, "", t("paypal.session.needWallet"));
      return;
    }
    draftKey.disabled = true;
    draftKey.setAttribute("aria-busy", "true");
    setStatus(status, "", "");
    replace(result, draftingCard(app));
    try {
      const response = await withSession(app, api, account, async (token) => {
        replace(result, draftingCard(app));
        setStatus(status, "", "");
        return await postDraft(api, token, { text: message, locale: app.locale });
      }, () => {
        setStatus(status, "", t("paypal.session.signing"));
      });
      if (response.outcome === "unavailable") {
        replace(result, unavailableCard(app, response.reason === "resting" ? "resting" : "unavailable", t("common.errorCode", { code: response.reason }), manual));
        return;
      }
      replace(
        result,
        draftCard(app, response, {
          use: () => {
            closeThen(() => {
              onUse(prefillOf(response.draft));
            });
          },
          manual,
        }),
      );
      result.querySelector<HTMLElement>("[data-action=use-draft]")?.focus();
    } catch (error) {
      const resting = error instanceof ApiError && error.code === "quota-exhausted";
      const assistantDown = error instanceof ApiError && (error.code === "assistant-unavailable" || error.code === "not-implemented" || error.code === "timeout" || error.code === "invalid-response" || error.code === "internal");
      if (resting || assistantDown) {
        replace(result, unavailableCard(app, resting ? "resting" : "unavailable", failureText(app, error).code, manual));
      } else {
        replace(result);
        const failure = failureText(app, error);
        setStatus(status, "err", failure.message, failure.code);
      }
    } finally {
      settle();
    }
  };
  draftKey.addEventListener("click", () => {
    void run();
  });
  modal = openModal(
    t("paypal.ai.sheetTitle"),
    t("paypal.ai.close"),
    h(
      "div",
      { class: "assist-sheet" },
      h("p", { class: "field-hint" }, t("paypal.ai.sheetLede")),
      h("div", { class: "field" }, h("label", { attrs: { for: "assist-text" } }, t("paypal.ai.label"), count), input),
      h("p", { class: "privacy", attrs: { id: "assist-privacy" } }, t("paypal.ai.privacy")),
      h("div", { class: "key-row" }, draftKey, h("button", { class: "key key-line", attrs: { type: "button", "data-action": "manual" }, on: { click: manual } }, t("paypal.ai.manual"))),
      status,
      result,
    ),
  );
  modal.element.classList.add("assist-dialog");
  input.focus();
  return modal;
}
