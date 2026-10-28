# VTID-03801 — Turkish gateway locale registration + `?locale=` override for category prefs

User-reported bug (two screenshots): Chinese Notification Settings and
Turkish My Journey both showed German content despite the language being
switched in the app. Two independent, unrelated root causes, both fixed
here on the gateway side (companion frontend fix: exafyltd/vitana-v1#1053).

## Root cause 1 — Chinese Notification Settings

`routes/user-category-preferences.ts` had no `?locale=` override, unlike
`journey-checklist.ts`'s established `resolveLocale()` pattern. It fell
back entirely to `getUserLocale()`'s 5-minute in-process cache, which the
frontend's language switch never invalidates (it writes `stt_language`
directly via Supabase, bypassing the gateway entirely). A Chinese-selecting
user kept seeing German category labels/descriptions for up to 5 minutes
per gateway instance.

## Root cause 2 — Turkish My Journey

`GatewayLocale` never included `'tr'` at all, even though
`journey_checklist_translations` already had 252/254 topics translated
into Turkish. `?locale=tr` was rejected by `GATEWAY_LOCALES` before the
database was ever consulted — this was a missing-registration bug, not a
missing-content bug.

## Fix

1. `resolveRequestedLocale()` (new, exported) mirrors the checklist
   route's `resolveLocale()`: an explicit `?locale=` wins over the cached
   `getUserLocale()` lookup.
2. Registered `'tr'` as a first-class `GatewayLocale` with a full
   114/114-key translated catalog (`src/i18n/locales/tr.json`, informal
   sen-form register) — unlike `ar` (VTID-03644), which shipped empty by
   design, `tr` ships translated from day one since the content already
   existed. This transparently fixes five other consumers that derive from
   `GatewayLocale`/`GATEWAY_LOCALES` dynamically (`goal-plan-i18n`,
   `autopilot-recommendations`, `admin-feature-announcements`,
   `greeting-audio-bridge`, `catalog-localizer`) with no additional code.

## Not in scope / not claimed

Not verified against a live staging deploy from this session — no
gateway/DB write access from this environment. This is a catalog
registration + route-param change with full unit-test coverage; it reaches
staging automatically on merge to `main` per the staging-first CI/CD
model. `vitana-v1`'s Supabase edge-function `_shared/llm-locale.ts` has its
own independent `EdgeLocale` type also missing `'tr'` — unrelated to
either reported screen, deliberately left as a follow-up.

---

AC-1 — an explicit `?locale=` query param resolves to the matching
`GatewayLocale`, including BCP-47 tags (`zh-CN` → `zh`, `tr-TR` → `tr`)

TEST: `test/routes/user-category-preferences.locale.test.ts` —
"accepts every registered gateway locale, including tr and zh" /
"normalizes BCP-47 tags the frontend language picker sends"
Output: outputs/targeted-tests.txt

AC-2 — an unregistered, missing, or malformed `?locale=` value returns
`null` so the caller falls back to the cached `getUserLocale()` lookup,
never crashes or silently mis-resolves

TEST: `test/routes/user-category-preferences.locale.test.ts` — "returns
null for an unregistered or missing locale" / "is not fooled by a long or
malformed query value"
Output: outputs/targeted-tests.txt

AC-3 — Turkish (`tr`) is a fully registered `GatewayLocale`: present in
`GATEWAY_LOCALES`, has every key `de` has, no empty values, is not a copy
of the English catalog, and preserves every `{placeholder}`

TEST: `test/i18n/catalog-coverage.test.ts` — "ships all 11 registered
locales" / "tr has every key DE has" / "tr has no empty values" / "tr is
not a copy of the English catalog" / "tr preserves every {placeholder}
exactly"
Output: outputs/targeted-tests.txt

AC-4 — the curriculum locale surface (`ChecklistLocale`, My Journey) now
exposes exactly 11 locales including `tr`, with no change needed to
`journey-checklist.ts`/`checklist-service.ts` themselves (since
`ChecklistLocale = GatewayLocale`)

TEST: `test/journey-checklist-translations.test.ts` — "exposes exactly the
release locale set — no more, no less"
Output: outputs/targeted-tests.txt

AC-5 — the ORB voice `set_language` tool's language enum legitimately
grows to include `tr` (via the same `SUPPORTED_LANGUAGES` map that also
gates `llm-locale.ts`'s `buildLocalizedSystemPrompt`), with no other
consumer left un-exhaustive by the `tsc` compiler's own
`Record<GatewayLocale,...>` checks

TEST: `test/orb/live/characterization/tool-catalog.characterization.test.ts`
(snapshot updated to reflect the new enum) — full suite passing
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt

AC-6 — goal-plan clarifying questions and prompts are generated in the
user's real language for EVERY registered gateway locale, not just
de/en/es/sr — a Codex review finding on this PR: `goal-planner-service.ts`
carried its own 4-entry `LANGUAGE_NAMES` map that silently fell back to
English for tr (and every other locale added since VTID-03509/03569/03644),
and worse, `seedGoalPlanSourceCache()` then persisted that English result
keyed by the user's real locale, so `localizeGoalPlan()` treated it as an
already-translated cache hit — the English plan would stick permanently.
Replaced the local map with the shared, exhaustive `LOCALE_ENGLISH_NAME`
(catalog.ts) so a future locale addition is automatically covered here too.

TEST: `test/services/journey/goal-planner-service.test.ts` — unaffected
(no hardcoded language-name assertions); `tsc --noEmit` fails loudly if
`LOCALE_ENGLISH_NAME` is ever missing an entry for a registered locale
(exhaustive `Record<GatewayLocale,string>`)
Output: outputs/tsc.txt, outputs/targeted-tests.txt

AC-7 — the daily "Did You Know" feature-tip content (`FEATURE_TIPS`) has a
real Turkish title and description for all 12 curated tips, not an English
fallback — a second Codex review finding: the type is
`Partial<Record<OtherLocale,string>>`, so `tsc` does not fail loudly on a
missing locale here the way the exhaustive catalog maps do, and
`POST /daily-feature-tip`'s `text[locale] ?? text.en` would have silently
served English to every Turkish user, every day, with no error anywhere.

TEST: `test/data/feature-tips.locale-coverage.test.ts` (new) — "every tip
has a title and description for every registered gateway locale" / "every
non-English value is genuinely translated, not a copy of English"
Output: outputs/targeted-tests.txt

AC-8 — no regression to the existing gateway test suite or type-checking

TEST: `npx jest` (full suite — 736/737 suites, 1 pre-existing skip,
13,662/13,697 tests passing, 0 failures)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
