# @paylink/i18n

PayLink's translations: English, French and Malagasy, with **typed keys and typed named placeholders**, plural selection by `Intl.PluralRules`, exact `Intl` formatting, and a completeness gate (PAYLINK-V2-SPEC §3.9). Isomorphic TypeScript, no dependencies.

## Use

```ts
import { createTranslator, EN, loadMessages, negotiateLocale } from "@paylink/i18n";

const locale = negotiateLocale(navigator.languages);            // "en" | "fr" | "mg"
const i18n = createTranslator(locale, await loadMessages(locale), { fallback: EN });
i18n.t("pay.payKey", { amount: "25.50", symbol: "AUSD" });     // a missing or misspelt parameter is a type error
i18n.plural("pay.paymentsReceived", 3, {});
i18n.lookup(sdkError.i18nKey, sdkError.params);                 // keys computed at run time (SDK errors): null if unknown
```

English ships with the code and is the fallback; French and Malagasy are separate chunks loaded on demand.

## Files

| File | Contents |
|---|---|
| `src/locales/en.json`, `fr.json`, `mg.json` | The catalogues translators edit: whole sentences with `{named}` placeholders; `*words*` is the one emphasis a message may carry |
| `src/locales/<feature>.en.json`, `.fr.json`, `.mg.json` | Feature catalogues: keys only some pages use (today `books`, the ledger backup). Each is a chunk of its own in every language, loaded by `featureTranslator(locale, feature)` on those pages, so the catalogue every page carries, the pay route's included, does not grow with them. Same rules as the core catalogue; a feature's keys start with its name |
| `src/features.ts` | `loadFeature`, `featureTranslator` (the core messages plus the feature's, English for anything missing) |
| `src/locales/mg.review.json` | The Malagasy keys drafted by Claude Code and awaiting the founder's review (spec §3.9: Malagasy is written or reviewed by the founder) |
| `src/generated/messages.ts` | Key and placeholder types derived from `en.json` and the English feature catalogues, with `Feature` and `FeatureKey` (`pnpm --filter @paylink/i18n run generate`) |
| `src/translator.ts`, `src/interpolate.ts` | `createTranslator`, `t`, `plural`, `lookup`; values are text, never markup or placeholders |
| `src/format.ts` | `formatDateTime`, `formatRelative`, `formatSeconds`, `formatCount`, `formatAriary` ("540 000 Ar": the format, never a rate) |
| `src/locales.ts` | `LOCALES`, `LOCALE_INFO` (BCP 47 tag, number and date locales, native name), `negotiateLocale` |

## Gates

- **Completeness** (`test/completeness.test.ts`): French and Malagasy carry exactly the English keys, with the same placeholders and the same emphasis; messages are plain, non-empty sentences without markup; every key the SDK's error decoder can produce is translated with the parameters the SDK guarantees; plural families have `.other`; French uses typographic (narrow no-break) spaces before high punctuation; the generated types are in step with `en.json` and the feature catalogues; each feature catalogue holds exactly its English keys in every language, only keys with its own prefix and none of the core catalogue's; the review list names only existing keys.
- **Translator and formatting** (`test/translator.test.ts`, `test/format.test.ts`): interpolation never interprets values, inherited properties are ignored, plurals, fallbacks, ariary and grouping per language, language negotiation.

The web app renders every route in all three languages in its unit tests, and the e2e suite switches EN → FR → MG on the live build.
