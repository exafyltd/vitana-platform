# VTID-03711 — orb-widget PCM playback honors the chunk's actual sample rate

Evidence pack for an emergency live-production fix, reported directly by
the platform owner: *"Polly TTS speaks for all wired languages in Mickey
Mouse speed."*

**Root cause:** `orb-widget.js`'s `_processQueue()` hardcoded
`ctx.createBuffer(1, floats.length, 24000)` for every PCM chunk, regardless
of the chunk's actual `mime` rate. Nova Sonic audio genuinely is 24kHz, so
this was invisible for as long as Nova was the only audio source. It
stopped being invisible the moment `ORB_CASCADED_VOICE_ENABLED=true`
(VTID-03703) was dispatched to production: `CascadedLiveClient`
(`services/gateway/src/orb/live/upstream/cascaded-live-client.ts`)
correctly synthesizes Polly PCM at 16kHz and correctly labels every chunk
`audio/pcm;rate=16000` — but the widget never read that label, decoded the
16kHz samples into a 24kHz `AudioBuffer`, and played the whole conversation
back at 1.5x speed/pitch for every ru/pl/ar/zh/tr session.

**Immediate mitigation, already applied before this fix was written:**
re-dispatched `AWS-PROD-DEPLOY-GATEWAY.yml` with
`orb_cascaded_voice_enabled=false` (run `32743618322`, succeeded) to stop
live user impact.

**Also affects, pre-existing, not introduced by this session:**
greeting-bridge and guided-topic-narration Polly audio, which already send
correctly-labeled 16kHz mime (`services/gateway/src/routes/orb-live.ts`
lines ~10445/10490) through the same shared `_playAudio()` entry point —
just far less noticeable as a short snippet than as a full chipmunked
conversation. This fix corrects the defect for all three call sites at
once, since they share one playback path.

---

AC-1 — `_pcmRateFromMime` parses the real rate out of the chunk's mime
string

New helper function in `orb-widget.js` extracts the numeric rate from a
`audio/pcm;rate=N` mime string via a `rate=(\d+)` regex.

TEST: `services/gateway/test/frontend/orb-widget-audio-playback.test.ts`
— "_pcmRateFromMime parses the rate out of the mime string"
Output: `outputs/targeted-tests.txt`

AC-2 — `_pcmRateFromMime` falls back to 24000 only when the mime is
missing or unparseable

Preserves the pre-existing default (Nova's rate, the historical assumption)
for the one case where there genuinely is no rate to read — an empty/absent
mime, or one with no `rate=N` — rather than crashing or defaulting to
something arbitrary.

TEST: same file — "_pcmRateFromMime falls back to 24000 only when the mime
is missing/unparseable"
Output: `outputs/targeted-tests.txt`

AC-3 — `_processQueue` passes the parsed per-chunk rate into
`createBuffer`, not a hardcoded constant

The actual regression fix: `createBuffer(1, floats.length, pcmRate)`
replaces the literal `24000`. Explicitly asserts the old hardcoded call
shape can never silently return.

TEST: same file — "_processQueue passes the parsed per-chunk rate into
createBuffer, not a hardcoded constant"
Output: `outputs/targeted-tests.txt`

AC-4 — The existing schedule-gap compensation is correct with no further
change

`_s.lastScheduledEnd += buf.duration / chunkRate` (pre-existing,
untouched) derives `buf.duration` from whatever rate was passed to
`createBuffer`. Once that rate is the real per-chunk rate instead of a
hardcoded 24000, this line is automatically correct — confirmed by the
existing DE/non-DE playback-rate regression tests (VTID-03606) still
passing unmodified alongside the new ones.

TEST: same file — "_processQueue applies the SAME per-chunk rate to both
playbackRate.value and the schedule-gap divisor" (pre-existing test,
unmodified, still green)
Output: `outputs/targeted-tests.txt`

AC-5 — No regression to the rest of the widget's frontend test suite

TEST: `npx jest test/frontend/` — 14/14 suites, 86/86 tests passing, 0
failures.
Output: `outputs/full-frontend-suite.txt`

AC-6 — Type-checks clean

TEST: `npx tsc --noEmit` — no output, exit 0.
Output: `outputs/tsc.txt` (empty — clean)

---

## Verification summary

| Check | Result |
|---|---|
| Targeted playback-rate tests | 7/7 passing |
| Full `test/frontend` suite | 14/14 suites, 86/86 tests, 0 failures |
| `tsc --noEmit` | clean |
| Production mitigation (rollback) | already applied, confirmed via GitHub Actions run `32743618322` success |
| Live traffic confirmation (staging) | pending — this PR must merge and deploy first |

## Known limitation carried forward

This fix corrects the playback-rate defect itself. It does not re-enable
`ORB_CASCADED_VOICE_ENABLED` on production — that is a separate, deliberate
action to take only after this fix is verified live on staging serving
correctly-paced Polly audio for a cascade-routed language.
