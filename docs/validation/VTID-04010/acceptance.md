# VTID-04010 — post-login safe_fast_proactive opener spoke English regardless of session language

## Reported
Platform owner asked: is Serbian actually wired on staging, and does it work
BOTH pre-login and post-login. Pre-login was independently verified live
(direct gateway API calls against the real `session/start` -> SSE `stream`
endpoints, anonymous, `lang: 'sr'`) — 6/10 trials produced genuine, fluent
Serbian audio + transcript via the Vertex Serbian bridge
(`provider: 'vertex/gemini-live-2.5-flash-native-audio'`), average latency
1108ms from `session/start` response to first audio chunk.

Post-login (authenticated, same test account,
`a27552a3-0257-4305-8ed0-351a80fd3701`, same `lang: 'sr'`) was then tested
the same way and failed: the Vertex Serbian bridge WAS correctly selected
(`provider: 'vertex/gemini-live-2.5-flash-native-audio'` in
`voice.latency.measured`, `metadata.lang:"sr"` on `greeting_sent`), but the
turn-1 speech was genuine, fluent **English** — e.g. "Good afternoon, E2E.
Last time we worked on \"What is Vitanaland\". Want me to find you an
activity partner? I'll take care of it." — across all 3 authenticated
trials run.

## Root cause
`wake_opener: "safe_fast_proactive"` (`compute-greeting-decision.ts` rung 4)
fired for every authenticated trial. Its `ctx.proactiveLine` text is built
by `computeFastProactiveOpener` -> `buildFastProactiveOpener`
(`services/assistant-continuation/providers/login-briefing.ts`), which
branched `const de = args.lang === 'de'` and picked between a
hand-translated German pool and an English pool for every sentence
fragment (salutation, weakness rider, pillar name, proposal text). Every
OTHER supported language — sr, es, fr, ru, pt, pl, tr, ar, zh — silently
fell to the English pool. The rung's directive then told the model:

> Say exactly: "<composed line>" — speak it verbatim as audio, as ONE
> greeting. Do NOT add, paraphrase, or split it.

"Verbatim" recitation of an English string wins over the session's main
system instruction ("Respond ONLY in Serbian"), because it is an explicit,
narrower instruction for this one turn — exactly matching the observed
symptom. This is the same defect class NEVER rule 41/42 exists to prevent
(a hardcoded spoken sentence, invisible to language handling), just not
caught before because Serbian previously had no working voice path at all
(so this rung's `sr` behavior was unreachable/moot until VTID-04000).

## Fix
1. `login-briefing.ts` — `buildFastProactiveOpener` now always composes in
   English (`const de = false`), regardless of the session's real
   `args.lang`. `args.lang` is still passed to
   `gatherBriefingFactsForFastOpener` for the legitimate localization
   concern (a recalled curriculum title comes from the DB in the user's
   real language) — only the template SCAFFOLDING is forced to English.
2. `compute-greeting-decision.ts` — the `safe_fast_proactive` rung's
   directive changed from "say exactly X verbatim" to asking the model to
   **translate** X into the session's own language
   (`LOCALE_ENGLISH_NAME[ctx.lang]`, imported from the existing shared
   `i18n/catalog.ts` map — "Import these; do not re-declare them") and
   speak it entirely in that language.

Scope: only the `safe_fast_proactive` rung (login-briefing.ts's fast-path
opener) and its one call site. `renderBriefingLine` (the RICHER
login-briefing candidate, a separate/rarer rung) has the identical
de/en-only defect shape but was not reached by either test run and is
**not fixed here** — flagged as a known follow-up, not silently left
undocumented.

## Acceptance Criteria

AC-1: `buildFastProactiveOpener` composes the same (English) template text
regardless of the session's `lang` — German, Serbian, and English all
produce byte-identical output, so localization happens once, at speak
time, instead of being silently dropped for every language but German.
TEST: services/gateway/test/services/assistant-continuation/providers/login-briefing.test.ts
  ("composes in English regardless of the input `lang` — translation
  happens at speak time, not here")

AC-2: the `safe_fast_proactive` rung's directive no longer tells the model
to recite the opener "verbatim" — it asks the model to translate the line
into the session's own language and speak it entirely in that language.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  ("rung 4: safe_fast_proactive (pre-fetched proactive line)" — asserts
  `directive` contains "Translate the following into natural, fluent
  German" and does NOT contain "verbatim")

AC-3: the rung correctly names the real target language for a non-German,
non-English session (Serbian), not just the two languages the old
hardcoded pools covered.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  ("rung 4: safe_fast_proactive names the real target language (Serbian),
  not just German/English" — asserts `directive` contains "Translate the
  following into natural, fluent Serbian" and "entirely in Serbian")

AC-4: no regression to the full gateway test suite from this change.
TEST: services/gateway (full suite) — 949/950 suites (1 pre-existing
  skip), 15424/15459 tests passing, 0 failures; see outputs/test-results.txt

## Verification
- `tsc --noEmit` clean.
- Full gateway suite: 949/950 suites (1 pre-existing skip),
  15424/15459 tests passing, 0 failures.
- New/updated tests: `login-briefing.test.ts` (asserts `buildFastProactiveOpener`
  produces IDENTICAL English output for `lang: 'de' | 'sr' | 'en'` — the
  key regression guard for this exact bug), `compute-greeting-decision.golden.test.ts`
  (asserts the rung's directive says "Translate ... into natural, fluent
  Serbian ... entirely in Serbian" for a Serbian context, and no longer
  contains "verbatim").
- **Not yet independently re-confirmed against live traffic** — same
  honest caveat as every other VTID in this repo's history: the next real
  signal is re-running the exact authenticated `lang:'sr'` trial against
  staging once this merges and deploys, and confirming the transcript is
  now genuine Serbian instead of English.
