// SPDX-License-Identifier: MIT
/**
 * The translator: typed keys, typed named parameters, plural families and a fallback to English for any key a
 * translation lacks (the completeness test makes that impossible in CI; the fallback only protects a hand-edited
 * deployment).
 */
import type { FeatureKey, MessageKey, MessageParams, PluralBase, PluralParams } from "./generated/messages.ts";
import { interpolate } from "./interpolate.ts";
import type { ParamValue } from "./interpolate.ts";
import { LOCALE_INFO } from "./locales.ts";
import type { Locale } from "./locales.ts";

/**
 * A language's messages: every key of the catalogue every page carries, and a feature catalogue's keys (`FeatureKey`)
 * once a page has loaded it (`featureTranslator`).
 */
export type Messages = Readonly<Record<Exclude<MessageKey, FeatureKey>, string>> & Readonly<Partial<Record<FeatureKey, string>>>;

/** Keys of the messages without placeholders (page titles, labels). */
export type PlainMessageKey = { [K in MessageKey]: [MessageParams[K]] extends [never] ? K : never }[MessageKey];

/** The parameter object of a message: its named placeholders, or an empty object when it has none. */
export type ParamsOf<K extends MessageKey> = [MessageParams[K]] extends [never] ? Readonly<Record<string, never>> : MessageParams[K];

/** `t(key)` for keys without placeholders, `t(key, { name })` for the others; the compiler checks the names. */
export type ParamsArg<K extends MessageKey> = [MessageParams[K]] extends [never] ? [params?: Readonly<Record<string, never>>] : [params: MessageParams[K]];

/** Function-valued members (not methods), so `const { t } = translator` is safe to destructure. */
export interface Translator {
  readonly locale: Locale;
  /** BCP 47 tag for `lang` attributes. */
  readonly tag: string;
  readonly t: <K extends MessageKey>(key: K, ...params: ParamsArg<K>) => string;
  /** A plural family (`<base>.one`, `<base>.other`, …) selected by `count` with Intl.PluralRules; `{count}` is filled in. */
  readonly plural: <B extends PluralBase>(base: B, count: number, params: Omit<PluralParams[B], "count">) => string;
  /**
   * An untyped key, for keys computed at run time (SDK error keys). Returns `null` when the key does not exist, so
   * callers choose their own fallback.
   */
  readonly lookup: (key: string, params?: Readonly<Record<string, ParamValue>>) => string | null;
}

export interface TranslatorOptions {
  /** English, used for keys the locale lacks. */
  readonly fallback?: Messages;
  /** Called for each placeholder that has no value (tests throw). */
  readonly onMissing?: (key: string, placeholder: string) => void;
}

export function createTranslator(locale: Locale, messages: Messages, options: TranslatorOptions = {}): Translator {
  const { fallback, onMissing } = options;
  const rules = new Intl.PluralRules(LOCALE_INFO[locale].dateLocale);
  const raw = (key: string): string | undefined => {
    const own = (messages as Readonly<Record<string, string>>)[key];
    if (own !== undefined && Object.hasOwn(messages, key)) {
      return own;
    }
    return fallback !== undefined && Object.hasOwn(fallback, key) ? (fallback as Readonly<Record<string, string>>)[key] : undefined;
  };
  const render = (key: string, params: Readonly<Record<string, ParamValue>>): string => {
    const message = raw(key);
    if (message === undefined) {
      onMissing?.(key, "*");
      return key;
    }
    return interpolate(message, params, (name) => onMissing?.(key, name));
  };
  return {
    locale,
    tag: LOCALE_INFO[locale].tag,
    t: (key, ...params) => render(key, params[0] ?? {}),
    plural: (base, count, params) => {
      const category = rules.select(count);
      const key = raw(`${base}.${category}`) === undefined ? `${base}.other` : `${base}.${category}`;
      return render(key, { ...(params as Readonly<Record<string, ParamValue>>), count: new Intl.NumberFormat(LOCALE_INFO[locale].numberLocale).format(count) });
    },
    lookup: (key, params = {}) => (raw(key) === undefined ? null : render(key, params)),
  };
}
