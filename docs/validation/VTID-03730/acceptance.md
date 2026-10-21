# VTID-03730 — Turkish (tr) end-to-end for ORB voice

Explicit follow-up to VTID-03723 (removed Vertex as an ORB-voice destination)
and VTID-03729 (fixed the Voice Lab decision probe). While confirming those
fixes live, it came up that Turkish sessions were silently coerced to English
before voice selection ever ran — `tr` was simply absent from
`SUPPORTED_LIVE_LANGUAGES`, the same VTID-03681-shaped gap that previously
hit `pt`/`pl`. Platform owner instruction: "let's then implement Turkish
end-to-end. Use German and English languages as an example of quality, for
parity purpose."

**Discovered mid-implementation, rebasing this branch onto latest `main`:**
`main` already carries VTID-03719 (#3175, merged 2026-08-24), which added a
live-verified Turkish Polly voice (`Burcu`, `neural` — found and fixed via a
real `describe-voices`/`synthesize-speech` call while running VTID-03716's
audio-timing test program) plus a CJK-aware pacing fix. **`tr` was still
absent from `SUPPORTED_LIVE_LANGUAGES` and every other must-agree table on
`main`** — VTID-03719 fixed only the Polly voice table, not the session-start
gate that decides whether a Turkish session ever reaches voice selection at
all — so the core defect this VTID targets was still live. This PR was
rebuilt on top of `main` accordingly: `polly.ts` and its test are left
untouched (main's `Burcu`/`neural` entry is correct and already verified,
superior to this session's original unverified `Filiz`/`standard` guess,
which has been dropped); every other table below is still a genuine,
unaddressed gap and is filled here.

Scope: ORB voice only (the live/greeting/TTS/cascade chain), matching how
VTID-03681 scoped the pt/pl expansion and how the immediate conversation
context ("no Serbian at all, and same for Turkish?") was specifically about
voice. The broader gateway i18n catalog (`GatewayLocale` in `i18n/catalog.ts`
— push notifications, UI text) is a separate, much larger initiative (DB
seeding, translation, native-speaker audit) and is deliberately NOT touched
here; flagged as an explicit follow-up rather than silently bundled in.

---

AC-1 — `tr` is admitted through the ORB-voice language gate instead of being
silently coerced to English

TEST: `services/gateway/test/orb/live/language-coverage.test.ts` — new
"VTID-03730: Turkish end-to-end" describe block, "admits tr through the gate
that used to coerce it to English"
Output: outputs/targeted-tests.txt

AC-2 — every downstream per-language table the pt/pl precedent (VTID-03681)
established as load-bearing has a real Turkish entry, not a silent fallback
to English/German

TEST: same file — "gives Turkish its own live voice, distinct from the
English one", "resolves a Turkish TTS languageCode, not en-US", "gives
Turkish a Live API voice entry", "gives Turkish its own greeting pool, not
the English one", "keeps the decision-contract enum in step for tr
specifically"
TEST: `services/gateway/test/orb/live/characterization/greeting-pools.characterization.test.ts`
— "declares the languages the orb officially supports for short-gap
greetings" (updated to include `tr`), snapshot updated
Output: outputs/targeted-tests.txt

AC-3 — Turkish has a real Polly voice and is NOT marked unsupported

Already satisfied by VTID-03719 on `main` (`Burcu`, `neural`, `tr-TR`,
live-verified) before this PR started — not re-touched here.
TEST: `services/gateway/test/tts/polly-provider.test.ts` — pre-existing
"resolves Turkish to the neural Burcu voice, not the standard-only Filiz"
and "resolves the supported languages with an explicit engine" (already
includes `tr`)
Output: outputs/targeted-tests.txt

AC-4 — Turkish is NOT on Nova's native list (en/de/fr/es only) and correctly
routes through the Transcribe→Bedrock→Polly cascade, exactly like
pl/pt/ru/ar/zh — never left with no route at all

TEST: `services/gateway/test/orb/live/upstream/cascaded-voice.test.ts` —
"takes exactly the languages Nova cannot speak AND both AWS services can"
(tr added, asserts `transcribeLanguageCode === 'tr-TR'` and
`listCascadeLanguages()` includes `tr`)
TEST: `services/gateway/test/orb/live/voice/voice-routing-policy.test.ts` —
`ALL_LANGUAGES` now includes `tr`; every rule-based invariant in this file
(no language left with no route, cascade-routed language keeps a real Nova
voice fallback report, etc.) re-runs against it with no code change needed
— the whole point of asserting invariants over the language set rather than
per-language literals
Output: outputs/targeted-tests.txt

AC-5 — Turkish correctly resolves to Nova's documented substitute voice
(`tina`, `fallback: true`), matching sr/ru/pl/ar/zh — no fabricated,
unverified Nova voice id was invented for it

TEST: `services/gateway/test/orb/live/voice/voice-routing-policy.test.ts` —
"only reports a substitution when Nova genuinely has no voice" (tr added to
the fallback=true list)
TEST: `services/gateway/test/services/voice-lab/nova-sonic-test-runner.ts`
self-check `voice_mapping` — `resolveNovaSonicVoice({ language: 'tr' })`
asserted `=== null`
Output: outputs/targeted-tests.txt

AC-6 — the VTID-03723 invariant (`provider` is never `'vertex'`) continues to
hold for `tr` specifically, at the route used to verify it live

TEST: `services/gateway/test/routes/voice-lab-nova-decision-cascade.test.ts`
— "provider is never vertex regardless of lang or cascade flag" already
iterates `tr` (added when writing this file, ahead of this VTID's own
edits landing)
Output: outputs/targeted-tests.txt

AC-7 — no regression to the full gateway suite or to type-checking

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt

---

## Deliberate judgment calls, recorded rather than silently made

1. **Gemini/Vertex-era voice tables WERE extended for `tr`** (`live-api-voice.ts`'s
   `LIVE_API_VOICE_FALLBACKS`, `voice-mapping.ts`'s `LIVE_LANGUAGE_VOICE_FALLBACKS`
   / `GEMINI_TTS_VOICE_FALLBACKS` / `NEURAL2_TTS_VOICE_FALLBACKS`), even though
   CLAUDE.md's IF-THEN rule 27 says never point a stage at Vertex/Gemini. These
   tables are NOT live Google API calls — they are cache-cold safety-net string
   Records behind a DB-backed policy resolver, read into a legacy `meta.voice`
   telemetry field that no longer drives real audio (Nova/the cascade does).
   Matched the exact precedent VTID-03681 set for `pt`/`pl` (which DID extend
   these same tables) rather than deviating for `tr`. `NEURAL2_ENABLED_LANGUAGES_FALLBACK`
   was deliberately NOT widened, also matching the pt/pl precedent — that one
   is a single seeded DB array row the fallback cannot override, and the
   better default for an unlisted language is `getGeminiTtsVoice()`.

2. **`NOVA_VOICES` (`nova-sonic-voice.ts`) was deliberately NOT given a
   Turkish entry.** Unlike the tables in (1), these ids are sent to the real,
   live Nova/Bedrock API — the `pt` entry (`carolina`) is only in this table
   because it was confirmed live via a real bidirectional stream (VTID-03672).
   No live Nova credentials are available in this session to confirm a
   Turkish voice id the same way, so `tr` correctly falls through to `null`
   and the documented `tina` substitution, exactly like `ru`/`pl`/`ar`/`zh`/`sr`.
   Fabricating an unverified id here risks a live `AccessDeniedException`-
   style rejection this session cannot observe.

3. **The Polly voice is `main`'s already-verified `Burcu`/`neural`, not this
   session's original guess.** This branch initially added its own
   unverified `Filiz`/`standard` entry to `polly.ts` before discovering,
   during the rebase onto `main`, that VTID-03719 had already landed a
   correct, live-verified value there. That entry — and the matching
   assertion in `polly-provider.test.ts` — was dropped in favor of `main`'s.
   `scripts/tts/verify-polly-voices.ts`'s `EXPECTED` map is updated to
   `Burcu`/`neural`/`tr-TR` to match, closing a gap that script had (it
   listed `en/de/fr/es/ar/zh/ru` only, missing `pt`/`pl`/`tr` alike — the
   `pt`/`pl` half of that gap is pre-existing and not addressed here).

4. **`GatewayLocale` (`services/gateway/src/i18n/catalog.ts`) was NOT
   touched** — out of scope, see the header note above.
