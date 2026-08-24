# VTID-03719 — fix the audio-timing test program (missing tr, CJK pacing false-positive)

**Profile:** `gateway_backend`

Found while running VTID-03716's own audio-timing test program for real against
staging, at the user's direct request. Result was 5/6 PASS, 1 FAIL (`zh`), and
`tr` was silently absent from the run entirely despite being one of the
cascade-voice languages.

---

AC-1 — the `zh` failure was a test-calibration bug, not a real audio defect

Real staging run: `zh` (Zhiyu, neural) produced 6.330s of audio for a 31-character
sentence — 4.9 chars/sec — and failed the program's uniform 6-30 chars/sec
plausibility band. All 4 other checks for that same sample (sample count, PCM
rate parsing, fixed-code duration match) passed. Natural Mandarin speech runs
roughly 3-5 chars/sec because each character carries more phonetic content than
a Latin/Cyrillic/Arabic letter — the same class of mistake this codebase has
already paid for once (`translator.ts`'s own docstring: a French register regex
produced 39/41 false positives on `rendez-vous`, a rule tuned on one language
that did not transfer to another). `pacingBoundsFor(lang)` now returns a
CJK-specific band (2-10 chars/sec) for `zh`, keeping the default 6-30 band for
every alphabetic language.

TEST: `test/scripts/verify-cascade-audio-timing.test.ts` → "VTID-03719 —
pacingBoundsFor" (3 tests: alphabetic band unchanged, zh band is lower, the real
measured 4.9 chars/sec sample now passes zh's band but would fail the
alphabetic one — proving this is a real widen, not a no-op). Evidence:
`outputs/targeted-tests.txt`.

AC-2 — `tr` is now actually tested, not silently skipped

`TEST_CASES` had no Turkish entry despite `tr` being a cascade-voice language.
Added one — but only after AC-3 below, because adding it against the
THEN-current code would have silently tested mislabeled English audio and
falsely passed (see AC-3).

TEST: manual review of `TEST_CASES` in `scripts/tts/verify-cascade-audio-timing.ts`
— `tr` entry present, uses natural du-form Turkish matching the app's own
`src/i18n/tr/intro.json` register. No automated test asserts array membership
(this file has no existing test coverage of `TEST_CASES` itself); AC-4 covers
the real live proof.

AC-3 — the deeper bug AC-2 depends on: Turkish had NO Polly voice entry at all
on `main`, and NO declared gap either

`POLLY_VOICES` had no `tr` key and `POLLY_UNSUPPORTED_LANGS` did not list `tr`
either — the exact undeclared gap this file's own `pt`/`pl` comment (VTID-03578)
warns about: `resolvePollyVoice('tr')` fell through to the caller's `??
POLLY_VOICES['en']` fallback, so any Turkish TTS call (including a `tr` entry
in the audio test program, had one been added first) was silently served
English audio by Joanna, with no error anywhere. This is a real, currently-shipped
production gap on `main`, independent of anything unmerged. Fixed by adding a
`tr` entry — `Burcu` (neural), not `Filiz` (standard-only), confirmed via a
live `DescribeVoices` call that both exist and a live `SynthesizeSpeech` call
proving `Burcu`+`neural` actually returns real audio (96480 samples, 6.030s,
14.3 chars/sec — well inside the alphabetic band). An earlier, unmerged
attempt at this same fix (VTID-03701, on a different branch, no AWS
credentials available to that session) had picked `Filiz` and documented that
choice as an assumed quality ceiling; this session's real credentials disprove
that assumption and use the better, verified voice instead.

TEST: `test/tts/polly-provider.test.ts` → "resolves Turkish to the neural Burcu
voice, not the standard-only Filiz" + `tr` added to the "resolves the supported
languages" and "covers every release locale" tables. Evidence:
`outputs/targeted-tests.txt`, `outputs/polly-live-verification.txt`.

AC-4 — no regression to the rest of the gateway's ORB/TTS surface

TEST: full `test/orb` suite (177/177 suites, 3281/3287 tests, 6 pre-existing
todo) and `npx tsc --noEmit` (clean), plus a full `npm run build`. Evidence:
`outputs/full-orb-suite.txt`, `outputs/tsc.txt`.

---

**Deliberately NOT in scope:** full cascade-eligibility wiring for `tr` in live
ORB voice sessions (`cascaded-config.ts`'s Transcribe language table,
`live-system-instruction.ts`'s 7 language-checklist tables, the greeting-pool
entries) — that is the larger, still-unmerged VTID-03701/VTID-03700 body of
work on a different branch, and this task is scoped to making the *audio-timing
test program* (VTID-03716) correct, which only needs Polly voice resolution,
not live-session cascade eligibility. Flagging so it isn't mistaken for done.

**Live re-confirmation against a real `zh`+`tr` staging run is the next step
after merge** — will be run and its exact output reported, not assumed.
