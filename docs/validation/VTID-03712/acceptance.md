# VTID-03712 — Acceptance

## Summary

`orb-widget.js`'s `_playAudio()` PCM decode path called
`ctx.createBuffer(1, floats.length, 24000)` with a hardcoded 24000Hz,
regardless of the `rate=` value the server actually sent in the chunk's
mime. Amazon Polly (the TTS provider since GCP was decommissioned) emits
PCM at 16000Hz for the greeting bridge and guided-topic narration audio
bridges, so every one of those chunks was decoded 1.5x too fast with a
matching pitch rise — reported by the user as TTS sounding like "Mickey
Mouse" in every language. The live model's own native audio (Nova Sonic)
genuinely is 24kHz, so that path sounded correct by coincidence.

## Acceptance Criteria

AC-1: A new `_pcmRateHzFromMime(mimeType)` helper parses the `rate=` value
out of the chunk's mime (defaulting to 24000 only when missing/unparseable,
matching prior behavior for the native-audio path), and `_processQueue()`'s
`ctx.createBuffer()` call uses it instead of the hardcoded `24000`.
TEST: services/gateway/test/frontend/orb-widget-audio-playback.test.ts
  — new describe block "orb-widget PCM decode rate (VTID-03712)", 2 tests:
  the parser regex/default, and that `createBuffer(1, floats.length, 24000)`
  no longer appears in `_processQueue()`'s source. See outputs/jest-frontend.txt.

AC-2: Existing playback behavior is unchanged — the deliberate 1.05x/1.1x
(DE) playback-rate speed-up and the scheduled-source cleanup logic are
untouched by this fix.
TEST: services/gateway/test/frontend/orb-widget-audio-playback.test.ts
  — pre-existing "orb-widget German playback rate (VTID-03606)" and
  "orb-widget audio playback queue" suites, all still passing. See
  outputs/jest-frontend.txt (14/14 suites, 85/85 tests across
  test/frontend/).

AC-3: The gateway service still type-checks and builds cleanly with the
change in place.
TEST: `npx tsc --noEmit` (clean, no output) and `npm run build` (exits 0).
  See commands.log and outputs/build.txt.

## Not yet independently confirmed

This session has no way to trigger a real Polly-backed ORB session against
a live gateway. The fix is verified at the source/test level (the
hardcoded rate is gone, the parser is exercised by unit tests); the next
real guided-topic tap or greeting-bridge play on staging is the first live
confirmation, per this repo's standing practice of not overclaiming
verification it could not perform.

OASIS_IMPACT: no — this is a client-side widget audio-decode fix with no
task-lifecycle, governance, or event-emission surface touched.
OASIS_PROOF: not applicable (see OASIS_IMPACT above).
