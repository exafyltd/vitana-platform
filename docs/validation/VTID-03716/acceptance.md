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

AC-8 — three Codex review findings on PR #3173, all confirmed real and fixed

1. **P1 — unauthenticated Polly billing/DoS vector.** The route paid for
   real Polly synthesis (up to 3000 chars) on every call with no auth and
   no rate limit. Fixed with a dedicated `express-rate-limit` limiter
   (20 req / 15 min, matching this codebase's existing per-route limiter
   pattern in `routes/live.ts`).
   TEST: same characterization file — "is rate-limited — unauthenticated
   callers cannot repeatedly trigger paid Polly synthesis (Codex P1)"
2. **P2 — silent unsupported-language fallback masked the diagnostic's own
   purpose.** The route normalized `lang` with `orb-live.ts`'s own
   `normalizeLang()`, built for live-session allowlisting — it silently
   maps anything outside `SUPPORTED_LIVE_LANGUAGES` to `'en'`, so a typo'd
   or newly-Polly-supported language would get fluent ENGLISH audio and a
   false 200 instead of the intended 422. Fixed by using `polly.ts`'s own
   `normalizeLang` (shape-only — lowercase, strip region, no allowlist
   fallback), letting `synthesizePolly`'s own voice table decide.
   TEST: same file — "normalizes the requested language with the
   Polly-shape normalizer, not the live-session allowlist one (Codex P2)"
3. **P2 — the test program could report success through the exact
   regression it exists to catch.** `verify-cascade-audio-timing.ts` only
   exercised the extracted `_pcmRateFromMime()` parser in isolation; a
   regression reverting the widget's real `createBuffer()` call back to a
   hardcoded rate while leaving the now-unused parser intact would still
   pass every check. Fixed with `verifyWidgetWiringIsConnected()` — a
   structural check (run first, fatal on failure) proving the real
   `createBuffer()` call site is wired to the variable
   `_pcmRateFromMime()` actually assigns, not a literal.
   TEST: `services/gateway/test/scripts/verify-cascade-audio-timing.test.ts`
   — imports the REAL function (not reimplemented) and mutation-tests it:
   passes against the real shipped widget, throws against a widget with
   `createBuffer(..., 24000)` restored (the actual VTID-03711 defect,
   reproduced), throws if the assignment pattern disappears entirely, and
   still passes when the parsed-rate variable is renamed (proving the
   check doesn't overfit to one variable name).
Output: `outputs/targeted-tests.txt`, `outputs/verify-script-unit-tests.txt`

AC-6 — type-checks clean

TEST: `npx tsc --noEmit` — no output, exit 0.
Output: `outputs/tsc.txt` (empty — clean)

---

ROUTE_MOUNT: `POST /tts-pcm-diagnostic` rides the existing ORB Live router
mount — same router (`orbLiveRouter`, `services/gateway/src/routes/orb-live.ts`)
as the sibling `/tts` route, mounted at `/api/v1/orb` in
`services/gateway/src/index.ts:834` (`mountRouterSync(app, '/api/v1/orb',
orbLiveRouter, { owner: 'orb-live' })`) — unchanged by this PR, no new mount.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/orb/tts-pcm-diagnostic
CURL_PROOF: after merge-to-main auto-deploys staging:
`curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST
https://preview-aws-gateway.vitanaland.com/api/v1/orb/tts-pcm-diagnostic -H
"Content-Type: application/json" -d '{"text":"hi","lang":"en"}'` must return
`200 application/json...` (route exists, real Polly PCM synthesis) — NOT
`404 text/html`. This exact route is also the target of the automated
`scripts/tts/verify-cascade-audio-timing.ts` program (VTID-03716's actual
purpose), which will be run for real against staging once this deploys —
results reported directly, not assumed.

## Verification summary

| Check | Result |
|---|---|
| Targeted route characterization tests | 11/11 passing (8 original + 3 for the Codex fixes) |
| `verify-cascade-audio-timing.ts` unit tests (new) | 4/4 passing, including a mutation test reproducing the exact VTID-03711 defect |
| Full `test/orb` suite | 177/177 suites, 3281/3287 tests, 0 failures |
| Full `test/scripts` suite | 4/4 suites, 60/60 tests, 0 failures |
| OASIS TTS telemetry (Dev Autopilot Impact Scan finding) | added — mirrors sibling `/tts` route's `emitTtsEvent` request/success/failure calls |
| 3 Codex review findings (rate limit, silent-fallback lang bug, test-program blind spot) | all confirmed real, all fixed |
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
