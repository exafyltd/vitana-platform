# VTID-03725 — fix Turkish live coercion to English; diagnose Serbian Nova silence

**Profile:** `gateway_backend`

Reported live: "Turkish speaks English and Serbian doesn't say nothing at
all. Serbian should be wired to Nova."

---

AC-1 — Turkish sessions are no longer coerced to English

`tr` was absent from `SUPPORTED_LIVE_LANGUAGES` (orb/live/config.ts).
`normalizeLang()` in `routes/orb-live.ts` ends `SUPPORTED_LIVE_LANGUAGES
.includes(langPart) ? langPart : 'en'` — the exact pt/pl bug shape
(VTID-03578/03681), now hitting `tr`. Confirmed live via `oasis_events`:
zero `lang=tr` sessions in the last 24h despite Turkish being GA in the
frontend (VTID-03701 promotion). Fixed by adding `tr` to all 7 tables the
`live-system-instruction.ts` checklist requires (bringing over
already-written, previously-unmerged work — VTID-03701).

TEST: `test/orb/live/language-coverage.test.ts` (all 7 tests, iterates
`SUPPORTED_LIVE_LANGUAGES` and now includes `tr`) + mutation-verified
(`outputs/mutation-verify.txt`: removing `tr` from one downstream table
while keeping it in the gate fails the suite; restoring passes).

AC-2 — Turkish now has a real, live-verified Polly voice, not the
`?? POLLY_VOICES['en']` fallback

Same-shaped gap one layer down: `POLLY_VOICES` had no `tr` entry either
(fixed already in VTID-03719/PR #3175, merged — `Burcu`, neural, live
`DescribeVoices`+`SynthesizeSpeech`-verified). This PR adds `tr` to the
Transcribe side (`cascaded-config.ts`) so the already-live cascade
(`ORB_CASCADED_VOICE_ENABLED=true`, confirmed on the live staging task
def) can carry a full Turkish round trip once deployed.

TEST: `test/orb/live/upstream/cascaded-voice.test.ts` — `listCascadeLanguages()`
now includes `tr`. Evidence: `outputs/full-orb-suite.txt`.

AC-3 — Serbian's ROUTING is already correct; the reported silence is a
distinct, evidence-backed Nova capability gap, not a Vitana bug

`sr` is already in every gate table and already forced onto Nova
(`nova_forced_vertex_unavailable` — Vertex is decommissioned, Polly has
zero Serbian voices, so Nova is the only reachable provider). Live
`oasis_events` (48h): roughly half of real `sr` sessions end in
`user_stop` after 8-30s with `audio_out:1` (chime only), `turn_count:0`,
**no error/close event at all** — not the documented "premature close"
bug (§2e, always an explicit error); every recovery hook fires only on
upstream CLOSE. AWS's Nova 2 Sonic table lists en/fr/it/de/es/pt/hi, not sr.

TEST: none — a diagnosis, not a code fix (see "Additional Notes" below).

AC-4 — no regression to the rest of the gateway's ORB surface

TEST: full `test/orb` suite (183/183 suites, 3385/3391 tests, 6
pre-existing todo), `npx tsc --noEmit` (clean), `npm run build` (clean).
Evidence: `outputs/full-orb-suite.txt`, `outputs/tsc.txt`.

---

**On AC-3, why no code change ships for Serbian:** the user's own words —
"Serbian should be wired to Nova" — describe the architecture this
codebase already implements (confirmed by reading `upstream-provider-
selector.ts` and live telemetry, not assumed). The actual defect is Nova
itself frequently producing no audio for a language it does not officially
support, with no error signal this codebase's existing recovery hooks can
key off. A real fix (extending `resendGreetingIfStuckAtZeroTurns` to an
idle-timeout trigger instead of only a close-event trigger) is a
meaningful new piece of session-lifecycle logic that needs to be built and
observed against real Nova traffic, not guessed at from telemetry alone —
flagged as the concrete next step rather than shipped half-verified.
