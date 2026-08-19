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

## AC-1 — the coercion is real, measured on production

3 days of `vtid.live.session.start`, before the fix:

| lang | sessions | voice |
|---|---|---|
| de | 66 | Achernar |
| en | 63 | Callirrhoe |
| sr | 4 | Vindemiatrix |
| es / fr / ru | 3 each | Aoede / Leda / Gacrux |
| **pt / pl** | **0** | — |

Zero, not few — structurally unreachable. See `outputs/prod-telemetry.txt`.

## AC-2 — VTID-03672 was inert, and this is what makes it reachable

`normalizeLang()` runs at session start (`orb-live.ts:14609`), **before**
`isNovaSonicLanguageSupported(session.lang)` (`orb-live.ts:6915`). By the time
the Nova gate is consulted the value is already `'en'`, so adding `pt` to
`NOVA_SONIC_SUPPORTED_LANGUAGES` under VTID-03672 could never be selected.
Verifying that VTID via the health endpoint's self-reported
`supported_languages` confirmed a list, not a routed session.

## AC-3 — every per-language table covers every gated language

Widening the gate alone is not a fix: `languageNames` in
`live-system-instruction.ts` ends `|| 'English'`, so a correctly-tagged `pt`
session would still carry "Respond ONLY in English". Seven tables must agree:

| # | Table | File | Failure mode if missing |
|---|---|---|---|
| 1 | `SUPPORTED_LIVE_LANGUAGES` | `orb/live/config.ts` | coerced to `en` |
| 2 | `languageNames` | `orb/live/instruction/live-system-instruction.ts` | prompted in English |
| 3 | `LIVE_LANGUAGE_VOICE_FALLBACKS` | `orb/live/voice/voice-mapping.ts` | English voice |
| 4 | `GEMINI_TTS_VOICE_FALLBACKS` | `orb/live/voice/voice-mapping.ts` | `en-US` TTS tag |
| 5 | `LIVE_API_VOICE_FALLBACKS` | `orb/live/voice/live-api-voice.ts` | English voice |
| 6 | `SHORT_GAP_GREETING_PHRASES` | `orb/instruction/greeting-pools.ts` | English openers |
| 7 | `SUPPORTED_LANGUAGES` | `services/decision-contract/types.ts` | contract violation |

## AC-4 — the guard asserts the seam, not the symptom

`test/orb/live/language-coverage.test.ts` iterates `SUPPORTED_LIVE_LANGUAGES`
and requires every downstream table to answer. It deliberately does **not**
assert `voices.pt === 'Zephyr'` — that form passes the moment someone adds
`pt`, says nothing about `pl`, and nothing at all about the next language.
That is precisely how eight locales shipped with two silently broken.

**Mutation-verified** (`outputs/tests.txt`): removing `pt` from the greeting
pools, `pl` from the live-voice map, or `pt` from the decision-contract enum
each fails the suite.

## AC-5 — no existing language changed

The greeting-pool snapshot gained **20 lines and removed 0**. The
characterization assertion that pinned the 8-language list was **updated to
the new truth, not relaxed** — weakening it to "contains at least these" would
have stopped it ever catching a dropped pool.

Full gateway suite: **671 suites, 12,921 passed, 0 failed**; `tsc --noEmit` clean.

## Known gaps, stated rather than glossed

- **`pt` now routes to Nova, whose Portuguese generation was never verified
  end-to-end.** VTID-03672 proved the model invokes and `carolina`/`leo` are
  accepted (a bogus id is rejected), but Polly returned 403 for this principal
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
