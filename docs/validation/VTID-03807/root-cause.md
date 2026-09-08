# VTID-03807 — root-cause investigation

Reported: "General Orb communication doesn't even start in any language."

## What was checked, and ruled out

1. **VTID-03802's Google Cloud TTS greeting-bridge hang.** Already merged to
   `main`. Confirmed via `oasis_events` that `ORB_GREETING_TTS_BRIDGE` is off
   in production — `sendGreetingAudioBridge()` returns at its first `if
   (!isFeatureLive(...)) return;` line for every session, working or stuck.
   No `greeting_bridge_sent`/`greeting_bridge_skipped` diag events appear for
   ANY session in the sampled window, confirming the flag is off, not merely
   unlogged.

2. **The legacy `googleAuth && VERTEX_PROJECT_ID` outer gate on
   `connectToLiveAPI`** (`routes/orb-live.ts`, both the SSE and WS session-start
   handlers). If this gate were false, the `else` branch emits
   `orb.live.config_missing` — that topic never appears for the stuck
   sessions. Nor does `orb.upstream.provider.selected`, the event
   `connectToLiveAPI` emits as its first side effect once entered. Both
   absent ⇒ `connectToLiveAPI` is never called at all for the stuck sessions;
   this is not a Vertex/Bedrock config problem.

## What the telemetry actually shows

Query (read-only, against the single production Supabase project — see
`commands.log`): for SSE sessions in a 24-48h window, joined `vtid.live.session.start`
against `orb.live.diag` by `session_id`.

- 27 SSE session starts in the 24h sample; 4 never produced a single
  `orb.live.diag` event (all `en`/`de`, all mobile: iOS Safari, Android
  Chrome). Same two real user_ids recur across the 4.
- Full event timeline for each stuck session:
  `orb.session.identity.resolved` → `vtid.live.session.start` →
  `orb.live.context.bootstrap` (latency_ms single digits — this is the
  `POST /live/session/start` handler's own background bootstrap work,
  confirmed by line-reading `live-session-controller.ts`) → **nothing** →
  `vtid.live.session.stop` (`reason: idle_no_engagement` or
  `superseded_by_new_session`, `turn_count: 0`, `audio_out_chunks: 0`,
  `idle_ms` ~100-140s).
- Compare to a working SSE session in the same window: within ~250ms of
  `vtid.live.session.start` it also shows `orb.session.audio_ready.acked` —
  a **client-initiated** signal, sent by `orb-widget.js`'s `_signalAudioReady()`
  — followed immediately by `orb.live.diag` (`identity_lock` /
  `nova_instruction_sanitized`), `orb.live.upstream.usage`, `greeting_sent`,
  `model_start_speaking`, `turn_complete`.

The `orb.session.audio_ready.acked` event is the tell: it is never present
for any of the 4 stuck sessions. Reading `orb-widget.js`'s `_sessionStart()`
(`services/gateway/src/frontend/command-hub/orb-widget.js` ~line 2183-2263):
the moment the widget parses a successful `/live/session/start` response it
synchronously (a) calls `_signalAudioReady()` and (b) opens
`new EventSource(sseUrl)`. Both are in the exact same continuation. Neither
ever runs for the 4 stuck sessions, and — critically — there is no fast
error/retry either (a 404 from a cross-instance `liveSessions` miss, or a
`checkConnectionLimit` 429, would show up as a near-instant second
`vtid.live.session.start` from `_attemptReconnect()`; the observed gap is
the FULL ~100-140s idle window instead).

**Conclusion:** the server did its job — session created, context bootstrap
run, both in single-digit-to-low-double-digit milliseconds. The break is
client-side: whatever runs after the widget parses the `/live/session/start`
response body never executes for these attempts. The leading hypothesis is
a backgrounded/throttled mobile tab (both affected sessions were mobile
Safari/Chrome, exactly where this class of JS-suspension is most aggressive),
but this session has no browser/device access to confirm that mechanism
directly — see "Not fixed here" below.

## What this VTID ships, and why that's the right scope

`session.sseResponse` (and `session.clientWs`) go back to `null`/unset both
when a stream was never opened AND when it was opened and later closed —
there is no existing way to tell those two apart after the fact, which is
why this diagnosis needed a multi-query telemetry reconstruction instead of
one lookup.

Added `GeminiLiveSession.sseEverAttached`, a one-way latch set `true` at the
single real attach point (`GET /live/stream`), and threaded
`sse_ever_attached` through the SSE-transport stop-event emission sites.
Diagnostic only. The next occurrence of this report will show
`sse_ever_attached: false` directly in `oasis_events`, which is enough to
either confirm the client-never-followed-up hypothesis definitively or rule
it out in favor of something else — without repeating this investigation.

## Not fixed here, and why

Per this codebase's own documented history (`CLAUDE.md` CHANGE LOG,
VTID-03764/VTID-03741 in particular), guessing at a fix in this exact
session-start/reconnect area without real measurement has repeatedly
introduced regressions. This session cannot observe a real mobile browser's
tab-lifecycle behavior, so no widget-side change is made here — only the
instrumentation needed to get real data on the next occurrence.
