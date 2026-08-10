# VTID-03569 — Chinese on the gateway

**Profile:** `gateway_backend`

Backend half of the Chinese extension. The frontend half (catalog registration,
register rule, CJK font stack) is `exafyltd/vitana-v1#968`. Without this half a
Chinese user gets a Chinese app and **German push notifications**, because the
gateway emits those strings itself, from cron, with no client locale to consult.

The `supported_locales.informal_hint` correction ships separately as VTID-03575
(#3081): `supabase/migrations/` is outside every `VALIDATOR-CHECK` profile
allowlist while this PR touches `services/gateway/src/**`, which is a trigger
path, so carrying both would make this PR unpassable under any profile.

---

AC-1 — the gateway can emit every one of its 112 strings in Chinese

`src/i18n/locales/zh.json` is hand-written rather than machine-translated:
there is no translator for this catalog, and 112 keys is smaller than the
tooling to translate them would be.

TEST: `test/i18n/catalog-coverage.test.ts` → "zh has every key DE has" and
"zh has no empty values". Evidence: `outputs/zh-catalog-validation.txt` —
112/112 keys, no missing, no extras.

AC-2 — placeholders survive translation

A dropped or renamed `{placeholder}` renders a literal brace to a user, or
loses the value entirely. Chinese has no spaces around them, which makes this
easier to get wrong than in the European locales.

TEST: `test/i18n/catalog-coverage.test.ts` → "zh preserves every {placeholder}
exactly". Evidence: `outputs/zh-catalog-validation.txt` — 0 mismatches.

AC-3 — the register is informal

Chinese marks register with a distinct pronoun CHARACTER (您 polite, 你
ordinary) rather than with verb morphology, so this is decidable by character
count in a way the European locales are not.

TEST: `outputs/zh-catalog-validation.txt` — **0** occurrences of 您.

AC-4 — the script is Simplified, not Traditional

Script is a SEPARATE axis from register. A model told only "Chinese" can return
Traditional, which is wrong for `zh-CN` and which neither a register check
(pronouns) nor a coverage check (key counts) would notice.

TEST: `outputs/zh-catalog-validation.txt` — 0 Traditional-only characters,
19 distinct Simplified-only forms present.

Worth recording: the FIRST run of this check reported 7 hits and was WRONG —
the probe set included 步 and 迎, which are identical in both scripts. A shared
character is not evidence of anything. The corrected set contains only forms
whose Simplified counterpart actually differs.

AC-5 — zh is not a copy of the English catalog

The `{ ...EN }` failure mode: a locale that resolves every key, so no fallback
ever fires and no coverage check sees a problem, while users get English.

TEST: `test/i18n/catalog-coverage.test.ts` → "zh is not a copy of the English
catalog" (zh added to the TRANSLATED list).

AC-6 — a half-added locale cannot compile

Adding `zh` to `GatewayLocale` failed `tsc` in exactly three places —
`LOCALE_ENGLISH_NAME`, `LANGUAGE_NAMES`, and ORB voice's `SUPPORTED_LANGUAGES`.
That is `Record<GatewayLocale, ...>` doing the job it was tightened for: those
three maps are how fr/pt/ru/pl previously came to be offered in the app while
being rejected by voice.

TEST: `npx tsc --noEmit` → exit 0. Evidence: `outputs/tsc.txt`.

AC-7 — the LLM is told the language AND the script

Both LLM-facing entries name Simplified explicitly, and the register hint names
the characters rather than saying "informal", which is not actionable here.

TEST: `test/i18n/llm-locale.test.ts` (suite green). The directive is built from
`LANGUAGE_NAMES.zh` = `Simplified Chinese (简体中文)` and `REGISTER_HINTS.zh`.

AC-8 — no regression in the other eight locales

TEST: `npx jest test/i18n test/db-i18n/db-i18n.test.ts` → 103 passed.
Evidence: `outputs/jest-i18n.txt`.

---

## Known gap, deliberately not closed here

`catalog-coverage.test.ts`'s own `RAW` map is `Record<GatewayLocale, ...>`, but
`tsc` does not cover `test/` — so the compiler caught the three source maps and
NOT that one, which failed at runtime with `RAW['zh']` undefined. Fixed here by
adding the entry; the asymmetry between what `tsc` checks and what the test
directory contains is worth knowing about and is not this VTID's to solve.
