// SPDX-License-Identifier: MIT
/**
 * The ledger backup panel (Monad edition, ADR 0016): the passkey's second key at work. Under the ledger, a dark display
 * window says what the ledger key locks, where it comes from (a second PRF namespace of the same PayLink key, never the
 * key that signs, never stored) and what it is bound to; then two keys.
 *
 * - **Back up my ledger**: one fingerprint for the ledger namespace, the books of this account on this network are
 *   encrypted (`envelope.ts`) and saved as a file. Nothing to back up is said plainly.
 * - **Restore from a file**: the file is read and checked first (a PayLink ledger backup, a network this edition serves,
 *   this account's books), and shown on a second window; "Unlock and restore" then asks for one fingerprint, checks
 *   the key, decrypts and authenticates, validates every record and merges it into this device's books.
 *
 * Every failure is a sentence with its support code ("Error code BooksTampered"). The restore runs in two presses
 * because a passkey prompt needs a fresh user gesture on some platforms (Safari), and choosing a file is not one.
 */
import { featureTranslator, formatDateTime } from "@paylink/i18n";
import { getAddress } from "viem";
import type { Address } from "viem";
import { BOOKS_NAMESPACE } from "../accounts/namespaces.ts";
import type { PasskeyLayer } from "../accounts/passkey.ts";
import type { AccountProvider } from "../accounts/types.ts";
import { networkName } from "../app/chains.ts";
import type { App } from "../app/context.ts";
import { decodeUiError } from "../core/errors.ts";
import { addr, fact, setStatus, statusLine } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { download } from "../ui/live.ts";
import { collectBooks, mergeBooks, upgradeContent } from "./content.ts";
import { BooksError, chainIdOf, MAX_FILE_BYTES, openBooks, parseBooksFile, sealBooks, serializeBooksFile } from "./envelope.ts";
import type { BooksFailure, BooksFile } from "./envelope.ts";
import { ledgerKeyOutput } from "./key.ts";
import type { LoadNamespaceModule } from "./key.ts";
import "./books.css";

export interface BooksPanelHooks {
  /** Called after a restore wrote records, so the page can read its books again. */
  restored(): void;
  /** How the Mera chunk is loaded for the ledger key (`key.ts`); tests inject a fake authenticator. */
  readonly load?: LoadNamespaceModule;
}

/** Support codes, engraved under each failure (same convention as `core/errors.ts`). */
const CODES: Readonly<Record<BooksFailure, string>> = {
  unreadable: "BooksFileInvalid",
  "too-large": "BooksFileTooLarge",
  newer: "BooksFileNewer",
  "wrong-key": "BooksWrongKey",
  tampered: "BooksTampered",
  "other-account": "BooksOtherAccount",
  "other-network": "BooksOtherNetwork",
  empty: "BooksEmpty",
};

/** The failure as the page says it, with its support code (`i18n` carries the books feature catalogue). */
export function describeBooksError(app: Pick<App, "i18n">, error: unknown): { readonly message: string; readonly code: string } {
  const { t } = app.i18n;
  if (error instanceof BooksError) {
    const detail = error.detail ?? "";
    const message =
      error.failure === "other-account"
        ? t("books.error.otherAccount", { address: detail })
        : error.failure === "other-network"
          ? t("books.error.otherNetwork", { chain: detail })
          : t(
              (
                {
                  unreadable: "books.error.unreadable",
                  "too-large": "books.error.tooLarge",
                  newer: "books.error.newer",
                  "wrong-key": "books.error.wrongKey",
                  tampered: "books.error.tampered",
                  empty: "books.error.empty",
                } as const
              )[error.failure],
            );
    return { message, code: t("common.errorCode", { code: CODES[error.failure] }) };
  }
  const decoded = decodeUiError(app, error);
  return { message: decoded.message, code: decoded.code };
}

/** `paylink-ledger-backup-10143-0x1a2b3c-2026-10-09.json`: the network, the account's first hex digits, the day. */
export function backupFileName(file: Pick<BooksFile, "chain" | "merchant" | "createdAt">): string {
  return `paylink-ledger-backup-${String(chainIdOf(file))}-${file.merchant.slice(0, 8).toLowerCase()}-${file.createdAt.slice(0, 10)}.json`;
}

/**
 * The panel. Its strings are the `books` feature catalogue, a chunk of their own (payers never download them), so it
 * renders once they are loaded; then it follows the session: signed out it explains, signed in it offers both keys.
 */
export function booksPanel(app: App, layer: PasskeyLayer, hooks: BooksPanelHooks): HTMLElement {
  const section = h("section", { class: "view view-books", attrs: { "aria-labelledby": "books-head" } });
  void featureTranslator(app.locale, "books")
    .then((i18n) => {
      run({ ...app, i18n }, layer, hooks, section);
    })
    .catch(() => {
      const status = statusLine();
      setStatus(status, "err", app.i18n.t("error.unknown"));
      replace(section, status);
    });
  return section;
}

/** The panel's life, with the books translator in `app.i18n`. */
function run(app: App, layer: PasskeyLayer, hooks: BooksPanelHooks, section: HTMLElement): void {
  const { t } = app.i18n;
  const status = statusLine();
  const review = h("div", { class: "books-review" });
  let shown: Address | null | undefined;
  const ledgerKey = async (expected: Address): Promise<Uint8Array> => await ledgerKeyOutput(layer, expected, hooks.load);

  const fail = (error: unknown): void => {
    const described = describeBooksError(app, error);
    setStatus(status, "err", described.message, described.code);
  };

  const render = (account: AccountProvider | null): void => {
    replace(review);
    replace(status);
    status.className = "status";
    const head = h("div", { class: "view-head" }, h("h2", { attrs: { id: "books-head" } }, t("books.head")), h("span", { class: "view-meta" }, t("books.meta")));
    const readings = h(
      "dl",
      { class: "readings" },
      fact(t("books.locks"), t("books.locksValue")),
      fact(t("books.keyFrom"), t("books.keyFromValue")),
      fact(t("books.cipher"), t("books.cipherValue")),
      account === null ? null : fact(t("books.account"), addr(account.address)),
    );
    const screen = h(
      "div",
      { class: "screen books-screen" },
      h("div", { class: "screen-top" }, h("span", null, t("books.screen.kicker")), h("span", null, t("books.screen.namespace", { name: BOOKS_NAMESPACE }))),
      readings,
      h("p", { class: "signing-note" }, t("books.note")),
    );
    // The backup is bound to the network the account is on (a passkey account reports the edition's chain).
    void account?.chainId().then((chainId) => {
      const chain = app.registry.get(chainId);
      if (chain !== undefined && shown === account.address) {
        readings.append(fact(t("books.network"), networkName(chain)));
      }
    });
    if (account === null) {
      replace(section, head, screen, h("p", { class: "field-hint books-hint" }, t("books.signIn")));
      return;
    }
    const backup = h("button", { class: "key key-line", attrs: { type: "button", "data-books": "backup" } }, t("books.backup"));
    const restore = h("button", { class: "key key-line", attrs: { type: "button", "data-books": "restore" } }, t("books.restore"));
    const input = h("input", { class: "books-file", attrs: { type: "file", accept: "application/json,.json", tabindex: "-1", "aria-hidden": "true", id: "books-file" } });
    const keys = [backup, restore];
    const busy = (on: boolean, key?: HTMLButtonElement): void => {
      for (const k of keys) {
        k.disabled = on;
      }
      if (on && key !== undefined) {
        key.setAttribute("aria-busy", "true");
      } else {
        for (const k of keys) {
          k.removeAttribute("aria-busy");
        }
      }
    };
    backup.addEventListener("click", () => {
      replace(review);
      busy(true, backup);
      void backUp(app, ledgerKey, account, status)
        .catch(fail)
        .finally(() => {
          busy(false);
        });
    });
    restore.addEventListener("click", () => {
      input.value = "";
      input.click();
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file === undefined) {
        return;
      }
      replace(review);
      replace(status);
      status.className = "status";
      void choose(app, account, file)
        .then((parsed) => {
          showReview(app, ledgerKey, account, parsed, file.name, { review, status, home: restore, busy, fail, restored: () => { hooks.restored(); } });
        })
        .catch(fail);
    });
    replace(section, head, screen, h("div", { class: "key-row books-keys" }, backup, restore), input, review, status);
  };

  const follow = (): void => {
    const account = app.session.account();
    const address = account?.kind === "passkey" ? account.address : null;
    if (address !== shown) {
      shown = address;
      render(account?.kind === "passkey" ? account : null);
    }
  };
  app.session.subscribe(follow);
  follow();
  void app.session.ready.then(follow);
}

/** The ledger-key PRF output for an account (`key.ts`): one fingerprint. */
type LedgerKey = (expected: Address) => Promise<Uint8Array>;

async function backUp(app: App, ledgerKey: LedgerKey, account: AccountProvider, status: HTMLElement): Promise<void> {
  const { t } = app.i18n;
  const chainId = await account.chainId();
  if (app.registry.get(chainId) === undefined) {
    throw new BooksError("other-network", "the account is on a network this edition does not serve", { detail: `eip155:${String(chainId)}` });
  }
  const collected = await collectBooks(app.store, app.registry, { merchant: account.address, chainId });
  if (collected.records === 0) {
    throw new BooksError("empty", "nothing to back up");
  }
  setStatus(status, "", t("books.status.fingerprint"));
  const prfOutput = await ledgerKey(account.address);
  setStatus(status, "", t("books.status.sealing"));
  const file = await sealBooks(prfOutput, { merchant: account.address, chainId, content: collected.content });
  download(backupFileName(file), "application/json", serializeBooksFile(file));
  setStatus(status, "ok", app.i18n.plural("books.saved", collected.records, {}));
}

/** Reads and checks a chosen file before any passkey prompt. */
async function choose(app: App, account: AccountProvider, file: File): Promise<BooksFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new BooksError("too-large", "the file is larger than a ledger backup can be");
  }
  const parsed = parseBooksFile(await file.text());
  if (app.registry.get(chainIdOf(parsed)) === undefined) {
    throw new BooksError("other-network", "this edition does not serve the file's network", { detail: parsed.chain });
  }
  if (getAddress(parsed.merchant) !== getAddress(account.address)) {
    throw new BooksError("other-account", "the file holds another account's books", { detail: parsed.merchant });
  }
  return parsed;
}

interface ReviewSlots {
  readonly review: HTMLElement;
  readonly status: HTMLElement;
  /** Where focus goes when the file's window closes (the "Restore from a file" key). */
  readonly home: HTMLButtonElement;
  busy(on: boolean, key?: HTMLButtonElement): void;
  fail(error: unknown): void;
  restored(): void;
}

/** The chosen file on its own window, and the key that unlocks it. */
function showReview(app: App, ledgerKey: LedgerKey, account: AccountProvider, file: BooksFile, name: string, slots: ReviewSlots): void {
  const { t } = app.i18n;
  const chain = app.registry.getOrThrow(chainIdOf(file));
  const unlock = h("button", { class: "key key-primary", attrs: { type: "button", "data-books": "unlock" } }, t("books.unlock"));
  const cancel = h("button", { class: "key key-text", attrs: { type: "button" } }, t("books.cancel"));
  cancel.addEventListener("click", () => {
    replace(slots.review);
    slots.home.focus();
  });
  unlock.addEventListener("click", () => {
    unlock.disabled = true;
    cancel.disabled = true;
    slots.busy(true);
    unlock.setAttribute("aria-busy", "true");
    void (async () => {
      setStatus(slots.status, "", t("books.status.unlocking"));
      const prfOutput = await ledgerKey(account.address);
      const content = upgradeContent(file.schema, await openBooks(prfOutput, file));
      const result = await mergeBooks(app.store, app.registry, { merchant: file.merchant, chainId: chain.chainId }, content);
      const said = t("books.restored", { added: result.added, present: result.present });
      setStatus(slots.status, "ok", result.skipped === 0 ? said : `${said} ${app.i18n.plural("books.skipped", result.skipped, {})}`);
      replace(slots.review);
      slots.busy(false);
      slots.home.focus();
      if (result.added > 0) {
        slots.restored();
      }
    })()
      .catch((error: unknown) => {
        slots.fail(error);
        unlock.disabled = false;
        cancel.disabled = false;
        unlock.removeAttribute("aria-busy");
      })
      .finally(() => {
        slots.busy(false);
      });
  });
  replace(
    slots.review,
    h(
      "div",
      { class: "screen books-screen books-file-screen" },
      h("div", { class: "screen-top" }, h("span", null, t("books.file.kicker")), h("span", { class: "books-file-name" }, name.slice(0, 80))),
      h(
        "dl",
        { class: "readings" },
        fact(t("books.account"), addr(file.merchant)),
        fact(t("books.network"), networkName(chain)),
        fact(t("books.file.made"), formatDateTime(app.locale, Math.floor(Date.parse(file.createdAt) / 1000))),
      ),
    ),
    h("div", { class: "key-row books-keys" }, unlock, cancel),
  );
  unlock.focus();
}
