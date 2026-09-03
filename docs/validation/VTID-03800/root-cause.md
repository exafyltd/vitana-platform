# VTID-03800 — root cause

## Report

Platform owner, testing "Vitana Assistant" (session 6) on staging:

> it was terrible! 3 times it repeated teaching and then started with the new
> day greeting and it repeated that 5 or more times, and just then we could
> see the Well Done Drawer with the Practice done toast notification.

## What the telemetry shows

Read-only query against `oasis_events`, 2026-08-31 13:26–13:35 UTC.

**Eight distinct `live-*` sessions in nine minutes.** Every one `turns=1`.
Every one ending `client_disconnect`. Every one followed by a fresh session
~1.2–1.6s later.

One full cycle (`live-373bd453` → `live-ab26487c`):

| t (UTC) | stage |
|---|---|
| 13:30:33.28 | `nova_instruction_sanitized` |
| 13:30:33.54 | **`guided_topic_audio_bridge_sent`** |
| 13:30:34.05 | `greeting_sent` |
| 13:30:35.52 | `model_start_speaking` |
| 13:30:36.34 | `turn_complete` |
| — | *~34 seconds of nothing* |
| 13:31:10.14 | `upstream_closed` `reason=ws_session_cleanup` |
| 13:31:11.80 | *(new session)* `nova_instruction_sanitized` |
| 13:31:12.10 | **`guided_topic_audio_bridge_sent`** ← lesson replays |
| 13:31:14.44 | `turn_complete` |
| 13:31:48.60 | `upstream_closed` |

`turn_complete` → teardown, measured across consecutive cycles:
**33.8s, 34.2s.**

## Root cause

`orb-live.ts` sent `ws.ping()` every 10s as the WS keepalive. That is a
**protocol-level control frame**: browsers answer it inside the network stack
and it never surfaces to `onmessage`.

`orb-widget.js`'s watchdog resets **only** from `onmessage`:

```js
var WATCHDOG_TIMEOUT = 30000;   // + 5s poll granularity
if (Date.now() - _s.clientLastActivityAt > WATCHDOG_TIMEOUT) {
  _announceDisconnect('connection');
  _attemptReconnect();
}
```

Its own comment asserts *"Server now sends data heartbeats every 10s that
trigger onmessage and reset this watchdog."* That is true of the **SSE** path
(`startSseHeartbeat` writes a data MESSAGE, deliberately not an SSE comment)
and **false of the WS path**.

So on WebSocket, 30s of application silence read as a dead connection on a
perfectly healthy socket — and 30 + ≤5 = the measured 33.8–34.2s exactly.

This is not an edge case for guided topics: once the lesson finishes, the
model is done speaking and the user is listening, so **neither side sends
anything**. Silence is the normal post-lesson state, which made the teardown
certain rather than occasional.

Each reconnect re-sent the still-armed `guided_topic_id`, so the whole Polly
lesson replayed (`guided_topic_audio_bridge_sent` on every cycle). Once the
topic flag eventually cleared, later restarts fell through to the normal
ladder — the new-day greeting, repeatedly. Both halves of the report, one
cause.

## Two things this invalidates about the previous round (VTID-03799)

1. **`GUIDED_TOPIC_IDLE_MS` (45s) was structurally unreachable.** The 30s
   watchdog always won. Any client timer longer than 30s was dead code. The
   45s value was sized against staging session T004, in which the user kept
   talking — which reset the watchdog and masked the defect.
2. **Keeping the topic armed across reconnects is what made it replay.**
   Correct for a genuine mid-lesson drop; catastrophic when combined with a
   watchdog that fires on every healthy idle session.

Neither was a wrong fix in isolation. Both were built on top of an
unmeasured, broken heartbeat.

## Fixes

**(1) The engine** — `orb-live.ts` now sends a real data heartbeat
(`{type:'heartbeat', ts}`, the exact shape SSE already uses and the widget
already handles at `case 'heartbeat':`) alongside the ping, on the same 10s
cadence. The ping stays: it serves the ALB's 60s idle timeout (VTID-03794),
a separate concern. This fixes **every** voice session, not just guided ones.

**(2) The UX** — a **narrated** guided topic is one-shot and terminal:
narration plays, then `_endGuidedTopicTeaching(topicId, 'narration_complete')`
hides the overlay and credits completion, revealing the Well Done drawer.

This re-adds an auto-close VTID-03685 removed. That is safe here and was not
then, for one reason: VTID-03685's turn 1 was a **short opener** with the
teaching spread across turns 2+, so closing there amputated the lesson
(VTID-03680). With the Polly bridge, turn 1 **is** the whole authored lesson.
`_guidedTopicNarrated` — set only by an `audio` frame tagged
`source:'guided_topic_narration'` — is the sole discriminator, and the
VTID-03665 Polly-failure fallback still falls through to the unchanged
conversational path.

## Accepted trade-off

On the narrated path the user cannot ask a follow-up — the session ends when
the narration does. Requested explicitly ("one guided-topic content and then
Well Done drawer opens, and that's it"). The drawer's own Replay and Start
Practice buttons are the continuation.

## Bookkeeping correction

The idle-backstop work shipped as **VTID-03799** (commit `a60efc28`) but its
code comments and test cited VTID-03800, which was unallocated at the time and
is now this task. Nine widget comments and the test file were relabelled to
VTID-03799 so the two are not conflated. Comment-only; no behaviour change.

## Not verified

End-to-end confirmation that the drawer appears needs a real device:
`completePractice` writes journey progress for the account, which
`vitana-v1`'s absolute rule forbids on every host, staging included.
