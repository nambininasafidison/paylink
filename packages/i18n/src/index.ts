// SPDX-License-Identifier: MIT
/**
 * `@paylink/i18n`: English, French and Malagasy for PayLink (PAYLINK-V2-SPEC §3.9). Whole sentences with named
 * placeholders, typed keys and parameters, plural families, Intl formatting. Malagasy strings are drafts until the
 * founder reviews them (`src/locales/mg.review.json`).
 *
 * @packageDocumentation
 */
export { formatAriary, formatCount, formatDateTime, formatRelative, formatSeconds } from "./format.ts";
export type { DateOptions } from "./format.ts";
export type { MessageKey, MessageParams, PluralBase, PluralParams } from "./generated/messages.ts";
export { interpolate, MISSING, placeholders } from "./interpolate.ts";
export type { ParamValue } from "./interpolate.ts";
export { DEFAULT_LOCALE, isLocale, LOCALE_INFO, LOCALES, negotiateLocale } from "./locales.ts";
export type { Locale, LocaleInfo } from "./locales.ts";
export { EN, loadMessages } from "./messages.ts";
export { createTranslator } from "./translator.ts";
export type { Messages, ParamsArg, ParamsOf, PlainMessageKey, Translator, TranslatorOptions } from "./translator.ts";
