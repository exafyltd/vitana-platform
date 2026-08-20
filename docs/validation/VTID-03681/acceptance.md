# VTID-03681 — Acceptance

**ORB live voice: `pt` and `pl` were silently coerced to English.**

## The defect

`normalizeLang()` (`routes/orb-live.ts`) ends:

```ts
return SUPPORTED_LIVE_LANGUAGES.includes(langPart) ? langPart : 'en';
```

`SUPPORTED_LIVE_LANGUAGES` was `['en','de','fr','es','ar','zh','sr','ru']`. `pt`
and `pl` were therefore **coerced to `'en'`** — no error, no warning: a
Portuguese user opened the ORB and got a fluent English assistant.

It is invisible in telemetry for a second reason: `vtid.live.session.start`
records the **coerced** value, so those sessions are indistinguishable from
genuine English ones.

---

AC-1 — The gate admits `pt` and `pl`, so they are no longer coerced to English.
Production evidence that the coercion was real, 3 days of
`vtid.live.session.start` before the fix: de 66, en 63, sr 4, es/fr/ru 3 each,
and **pt 0 / pl 0** — zero, not few; structurally unreachable. Full query and
result in `outputs/prod-telemetry.txt`.
TEST: `test/orb/live/language-coverage.test.ts` →
"admits pt and pl through the gate that used to coerce them to English"

AC-2 — Every language the gate admits resolves its own live voice and a TTS
`languageCode` for that language, never the English default. `pt` is pinned to
**pt-BR** specifically: both `pt-BR` and `pt-PT` satisfy a naive prefix check,
and European Portuguese read over Brazilian copy is fluent, wrong, and
undetectable downstream.
TEST: `test/orb/live/language-coverage.test.ts` →
"gives every gated language its own live voice — never the English one by default",
"resolves a TTS languageCode matching the requested language, not en-US",
"pins pt to pt-BR, not pt-PT — the catalog is Brazilian"

AC-3 — Every gated language has a Live API voice entry and its own greeting
pool. Without the pool, `pickShortGapGreetings` falls to
`SHORT_GAP_GREETING_PHRASES.en` and hands the model eight English openers
inside a prompt that just told it to speak Portuguese — so the assertion is
"not the English pool", not merely "a pool exists".
TEST: `test/orb/live/language-coverage.test.ts` →
"gives every gated language a Live API voice entry",
"gives every gated language its own greeting pool, in that language"

AC-4 — The decision-contract enum stays in step with the gate. Unlike every
other table here this one **rejects** rather than degrades (`invariants.ts`
runs `checkEnum` against it), so a language admitted by the gate but absent
here is reported as a contract violation.
TEST: `test/orb/live/language-coverage.test.ts` →
"keeps the decision-contract enum in step with the gate"

AC-5 — No existing language changed, and the guard actually detects a table
left behind. Mutation-verified: removing `pt` from the greeting pools, `pl`
from the live-voice map, or `pt` from the decision-contract enum each fails the
suite (see `outputs/tests.txt`). The greeting-pool snapshot gained 20 lines and
removed 0. The characterization assertion pinning the old 8-language list was
updated to the new truth, not relaxed.
TEST: `npx jest` — 671 suites, 12,921 passed, 0 failed; `npx tsc --noEmit` clean

---

## Why the guard is shaped the way it is

The defect was not "pt is missing from a list". Each table was internally
correct and every existing test passed. It lived in the **seam**: the gate
admitted a language and a table three modules away had no row for it.

So the test deliberately does **not** assert `voices.pt === 'Zephyr'`. That
form passes the moment someone adds `pt`, says nothing about `pl`, and nothing
at all about the next language — which is precisely how the expansion shipped
eight locales with two of them silently broken. It iterates the gate and
requires every downstream table to answer.

## The seven tables that must agree

| # | Table | File | Failure mode if missing |
|---|---|---|---|
| 1 | `SUPPORTED_LIVE_LANGUAGES` | `orb/live/config.ts` | coerced to `en` |
| 2 | `languageNames` | `orb/live/instruction/live-system-instruction.ts` | prompted in English |
| 3 | `LIVE_LANGUAGE_VOICE_FALLBACKS` | `orb/live/voice/voice-mapping.ts` | English voice |
| 4 | `GEMINI_TTS_VOICE_FALLBACKS` | `orb/live/voice/voice-mapping.ts` | `en-US` TTS tag |
| 5 | `LIVE_API_VOICE_FALLBACKS` | `orb/live/voice/live-api-voice.ts` | English voice |
| 6 | `SHORT_GAP_GREETING_PHRASES` | `orb/instruction/greeting-pools.ts` | English openers |
| 7 | `SUPPORTED_LANGUAGES` | `services/decision-contract/types.ts` | contract violation |

Widening only #1 would have been harder to diagnose than the original bug:
#2 ends `|| 'English'`, so the session would be correctly tagged `lang: 'pt'`
while the prompt still ordered English — symptom unchanged, telemetry now
clean.

## VTID-03672 was inert, and this is what makes it reachable

`normalizeLang()` runs at session start (`orb-live.ts:14609`), **before**
`isNovaSonicLanguageSupported(session.lang)` (`orb-live.ts:6915`). By then the
value is already `'en'`, so adding `pt` to `NOVA_SONIC_SUPPORTED_LANGUAGES`
could never be selected. That VTID was verified against the health endpoint's
self-reported `supported_languages` — a list, not a routed session.

## Known gaps, stated rather than glossed

- **`pt` now routes to Nova, whose Portuguese *generation* was never verified
  end-to-end.** VTID-03672 proved the model invokes and `carolina`/`leo` are
  accepted (a bogus id is rejected), but Polly returned 403 for that principal
  so the probe fed silence. VTID-03502 falls a failed Nova session back to
  Vertex, so the worst case is a reconnect hop.
- **`pl` has no Nova path** — Nova 2 Sonic does not speak it — so it routes to
  Vertex, which is the correct destination, not a compromise.
- **`voice.neural2.enabled_languages` deliberately NOT widened.** It is a
  single seeded `decision_policy` array row, so the DB value wins and editing
  the code fallback would change nothing while appearing to. Leaving pt/pl out
  routes them to `getGeminiTtsVoice()`, which needs no new Google voices.
- **`ru` is not addressed here.** It is present in all seven tables and a prod
  session on 2026-08-19 11:33 connected, sent a greeting and reached
  `model_start_speaking`. Its reported failure is not this defect and is not
  yet root-caused.
