// SPDX-License-Identifier: MIT
/**
 * Every failure, in the user's language, with its engraved support code (v1: "Error code SoldOut"). The SDK decoder
 * maps contract errors, token reverts, wallet rejections and transport failures to i18n keys; this adds the app's own
 * errors and the wallet codes the SDK leaves generic. Revert data is untrusted: its parameters are only ever text.
 */
import { decodeError, decodeRevertData } from "@paylink/sdk";
import type { MessageKey, ParamsOf } from "@paylink/i18n";
import type { App } from "../app/context.ts";
import { WalletError } from "../accounts/types.ts";
import { TransactionRevertedError } from "../rails/wallet.ts";

/** An error the app raises itself, already phrased as an i18n key. */
export class AppError<K extends MessageKey = MessageKey> extends Error {
  readonly key: K;
  readonly params: ParamsOf<K>;

  constructor(key: K, params: ParamsOf<K>, message?: string) {
    super(message ?? key);
    this.name = "AppError";
    this.key = key;
    this.params = params;
  }
}

export interface UiError {
  readonly message: string;
  /** "Error code SoldOut": shown muted under the sentence, for support. */
  readonly code: string;
  /** Machine name of the error (for tests and the e2e suite). */
  readonly name: string;
}

export function decodeUiError(app: Pick<App, "i18n">, error: unknown): UiError {
  const { t, lookup } = app.i18n;
  const code = (name: string): string => t("common.errorCode", { code: name });
  if (error instanceof AppError) {
    const appError = error as AppError;
    const message = lookup(appError.key, appError.params) ?? t("error.unknown");
    return { message, code: code(appError.key), name: appError.key };
  }
  if (error instanceof WalletError && (error.code === 4902 || error.code === 4901)) {
    return { message: t("error.wallet.wrongNetwork"), code: code(`EIP1193 ${String(error.code)}`), name: "WrongNetwork" };
  }
  if (error instanceof WalletError && error.code === -32002) {
    return { message: t("wallet.pending"), code: code("EIP1193 -32002"), name: "RequestPending" };
  }
  const decoded = error instanceof TransactionRevertedError
    ? error.revertData === null
      ? { name: "Reverted", i18nKey: "error.contract.revertedWithoutReason" as const, params: {} }
      : decodeRevertData(error.revertData)
    : decodeError(error);
  if (decoded.name === "Unknown" && error instanceof WalletError) {
    return { message: t("error.wallet.failed"), code: code(`EIP1193 ${String(error.code)}`), name: "WalletError" };
  }
  const message = lookup(decoded.i18nKey, decoded.params) ?? t("error.unknown");
  return { message, code: code(decoded.name), name: decoded.name };
}
