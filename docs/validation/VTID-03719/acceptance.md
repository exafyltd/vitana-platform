# VTID-03719 — fix the audio-timing test program (missing tr, CJK pacing false-positive)

**Profile:** `gateway_backend`

Found while running VTID-03716's own audio-timing test program for real
against staging, at the user's direct request. Result: 5/6 PASS, 1 FAIL
(`zh`); `tr` was silently absent from the run entirely.

---

AC-1 — the `zh` failure was a test-calibration bug, not a real audio defect

Real staging run: `zh` (Zhiyu, neural) produced 6.330s of audio for a
31-char sentence — 4.9 chars/sec — failing the program's uniform 6-30
chars/sec band, even though its other 4 checks (sample count, PCM rate
parse, duration match) all passed. Mandarin is logographic — each
character carries more phonetic content than a Latin/Cyrillic/Arabic
letter — so natural speech runs ~3-5 chars/sec. `pacingBoundsFor(lang)`
now returns a CJK-specific band (2-10) for `zh`, default (6-30) elsewhere.

TEST: `test/scripts/verify-cascade-audio-timing.test.ts` → "VTID-03719 —
pacingBoundsFor" (3 tests). Evidence: `outputs/targeted-tests.txt`.

AC-2 — `tr` is now actually tested, not silently skipped

`TEST_CASES` had no Turkish entry. Added one, but only after AC-3 (see
below) — adding it against the prior code would have silently tested
mislabeled English audio and falsely passed.

TEST: `TEST_CASES` in `scripts/tts/verify-cascade-audio-timing.ts` now has
a `tr` entry (du-form Turkish, matching `src/i18n/tr/intro.json`'s
register); AC-3/AC-4 cover the real proof this entry now tests real
Turkish audio, not English.

AC-3 — Turkish had NO Polly voice entry at all on `main`, and no declared
gap either — the reason AC-2 had to wait

`POLLY_VOICES` had no `tr` key; `POLLY_UNSUPPORTED_LANGS` didn't list it
either — the exact undeclared gap this file's `pt`/`pl` comment
(VTID-03578) already warns about: `resolvePollyVoice('tr')` fell through
to `?? POLLY_VOICES['en']`, serving silent English audio. Fixed with
`tr → Burcu (neural)` — live-verified via `DescribeVoices` + a real
`SynthesizeSpeech` call, not just assumed from a listing.

TEST: `test/tts/polly-provider.test.ts` → "resolves Turkish to the neural
Burcu voice, not the standard-only Filiz". Evidence:
`outputs/targeted-tests.txt`, `outputs/polly-live-verification.txt`.

AC-4 — no regression to the rest of the gateway's ORB/TTS surface

TEST: full `test/orb` suite (177/177 suites, 3281/3287, 6 pre-existing
todo), `npx tsc --noEmit` (clean), `npm run build` (clean). Evidence:
`outputs/full-orb-suite.txt`, `outputs/tsc.txt`.

---

**Context on AC-3's fix:** an earlier, unmerged attempt at the same Turkish
gap (VTID-03701, a different branch) picked `Filiz` (standard-only),
explicitly caveated as unverified because that session had no AWS
credentials to check `DescribeVoices`. This session does, and found Polly
actually has a neural Turkish voice (`Burcu`) that session couldn't have
known about — used instead, live-verified rather than assumed.

**Deliberately NOT in scope:** full cascade-eligibility wiring for `tr` in
live ORB voice sessions (`cascaded-config.ts`'s Transcribe language table,
`live-system-instruction.ts`'s 7 language-checklist tables) — that is the
larger, still-unmerged VTID-03701/VTID-03700 body of work on a different
branch. This PR is scoped to the audio-timing test program (VTID-03716),
which only needs Polly voice resolution, not live-session cascade
eligibility. Flagging so it isn't mistaken for done.

**Live re-confirmation against a real `zh`+`tr` staging run is the next
step after merge** — will be run and its exact output reported, not
assumed.
