# VTID-03716 — automated, self-verifying audio-correctness test program

Evidence pack for the platform owner's explicit directive: no more manual
live-session verification for audio fixes — Claude must build and run its
own automated audio test programs.

**What this ships:**
1. `POST /api/v1/orb/tts-pcm-diagnostic` (`services/gateway/src/routes/orb-live.ts`)
   — a stateless, `optionalAuth` route that calls the exact same
   `synthesizePolly({format:'pcm'})` call `CascadedLiveClient.runTurn()`
   makes for live cascade-voice sessions, returning real audio + its true
   declared sample rate. No ORB session, no session state, no memory
   extraction, no account write of any kind — same category as the
   existing `/orb/tts` (MP3) and `/voice/preview` (MP3, admin) routes.
2. `scripts/tts/verify-cascade-audio-timing.ts` — a permanent, reusable
   Node program that calls this route for ru/pl/ar/zh/tr (the 5 cascade
   languages) plus de/en, decodes the real PCM byte count, and
   mathematically proves the VTID-03711 fix against real Polly audio:
   - It does **not** reimplement `_pcmRateFromMime()` — it extracts the
     function's literal source out of the shipped `orb-widget.js` and
     executes that, so the test cannot silently drift from what ships.
   - Duration math (`frameCount / sampleRate`) is the W3C Web Audio API
     spec's own definition of `AudioBuffer.duration`, not an assumption.
   - It reproduces the OLD buggy behavior mathematically against the SAME
     real bytes (`frameCount / 24000`) and reports the exact speed-up
     factor the fix eliminates.

---

AC-1 — the new route is stateless and unconditionally Polly-only

TEST: `services/gateway/test/orb/live/characterization/tts-pcm-diagnostic-route.characterization.test.ts`
— "is mounted with optionalAuth — stateless, no session required"
TEST: same file — "calls synthesizePolly with format:\"pcm\" unconditionally"
TEST: same file — "does not gate on TTS_PROVIDER"
Output: `outputs/targeted-tests.txt`

AC-2 — the response carries the exact fields the widget fix reads

TEST: same file — "returns sample_rate_hz and a matching audio/pcm;rate= mime"
Output: `outputs/targeted-tests.txt`

AC-3 — input validation guards cost/latency and reports Polly-unsupported
languages distinctly

TEST: same file — "rejects empty text with 400"
TEST: same file — "rejects oversized text with 400 before calling Polly"
TEST: same file — "reports a Polly-unsupported language distinctly (422)"
Output: `outputs/targeted-tests.txt`

AC-4 — the automated test program runs standalone, extracts the REAL
widget logic (not a reimplementation), and degrades gracefully when the
target doesn't have the route yet

TEST: manual run via `npx ts-node --transpile-only scripts/tts/verify-cascade-audio-timing.ts`
against a target where the route is not yet deployed — confirmed it
correctly loads `_pcmRateFromMime` from the live `orb-widget.js` source,
attempts the real network call, and reports a clean per-language FAIL
(not a crash) on the expected pre-deploy HTML 404 — the same
HTML-vs-JSON diagnostic CLAUDE.md §15 documents for route-not-deployed.
Output: `outputs/pre-deploy-dry-run.txt`

AC-5 — no regression to the full suite

TEST: `npx jest test/orb` — 177/177 suites, 3278/3284 tests passing (6
pre-existing todo), 0 failures.
Output: `outputs/full-orb-suite.txt`

AC-7 — the route emits OASIS TTS telemetry, matching the sibling `/tts`
route's observability pattern (Dev Autopilot Impact Scan finding, addressed)

TEST: `services/gateway/test/orb/live/characterization/tts-pcm-diagnostic-route.characterization.test.ts`
— all 8 pre-existing assertions still pass unchanged against the route body
slice, confirming the added `emitTtsEvent('vtid.tts.request'|'success'|'failure', ...)`
calls did not alter the route's synthesis/validation shape.
Output: `outputs/targeted-tests.txt`

AC-6 — type-checks clean

TEST: `npx tsc --noEmit` — no output, exit 0.
Output: `outputs/tsc.txt` (empty — clean)

---

## Verification summary

| Check | Result |
|---|---|
| Targeted route characterization tests | 8/8 passing |
| Full `test/orb` suite | 177/177 suites, 3278/3284 tests, 0 failures |
| OASIS TTS telemetry (Dev Autopilot Impact Scan finding) | added — mirrors sibling `/tts` route's `emitTtsEvent` request/success/failure calls |
| `tsc --noEmit` | clean |
| Pre-deploy dry run of the test program | confirmed graceful, correct failure mode against a target without the route |
| **Post-deploy live run against real staging (ru/pl/ar/zh/tr/de/en)** | **pending — this PR must merge and deploy before the program can run against real Polly audio; results will be reported directly to the platform owner once staging serves this commit** |

## What this does NOT do

This does not open a live ORB voice session, and does not prove what the
model says or how the conversation flows — it proves, with real Polly
audio and the real shipped widget code, that PCM playback timing is
correct. That is the exact, narrow claim the original bug report was
about ("Mickey Mouse speed"), and it is now provable end-to-end without a
human listener for every future regression in this exact area, not just
this one incident.
