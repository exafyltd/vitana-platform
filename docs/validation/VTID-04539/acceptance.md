# VTID-04539 — local time always in the voice prompt, Nova stall recovery, same-day threads

## Owner report (production, 2026-09-25 ~18:30 CEST)

Three problems in one evening session:

- Vitana greeted "Guten Morgen" at 18:30.
- A session went quiet and fell back to listening mode without answering.
- Vitana said "you asked yesterday" about a question from seven minutes
  earlier.

Production served `ec9d5ee` (published 09:08 UTC). None of today's
VTID-04533 or VTID-04534 changes had reached production.

## Evidence from `oasis_events` (read-only)

### Session `live-ce128077` (16:23 UTC): went silent

1. After a `search_memory` tool call, Nova spoke (audio_out 617 → 892) but
   never ended the turn.
2. 20 s later the `audio_stall` watchdog fired and terminated the upstream.
3. `upstream_closed` shows `initiated_locally: true`.
4. There was no `reconnect_triggered` afterwards, only `audio_no_ws` for
   34 s until the SSE dropped.

Root cause:

- The watchdog sets `_stallRecoveryPending` and relies on the close handler
  to reconnect.
- Only the Vertex close handler reads that flag.
- In the Nova close handler, a locally initiated close after audio matched
  no branch, so nothing reconnected and the client was not told.
- Last 7 days: 3 sessions had the watchdog fire, 0 reconnected, all Nova.

### Session `live-2434324c` (16:30 UTC): "Guten Morgen" and "gestern"

1. The first attempt was blocked by Nova's content filter; the retry
   greeted with the `continuity_pending_thread` candidate.
2. The session's local hour was 18 (`Europe/Madrid`), as shown by
   `newday_briefing_eval`.
3. The only copy of the local clock was ENVIRONMENT CONTEXT, inside the
   bootstrap. The instruction budget drops the bootstrap whole whenever the
   fixed prompt is over budget, which it always is: staging logs today show
   32,053 bytes of scaffold against a 30,720-byte budget. The scaffold's
   temporal section received `timeOfDay` but no longer rendered it (dead
   since BOOTSTRAP-ORB-R2).
4. `renderLine` in `continuity-pending-thread.ts` mapped
   `days_since_last_mention <= 1` to "gestern". The thread was 0 days old.

## Fix

- The TEMPORAL AND JOURNEY CONTEXT section (preserved scaffold) now carries
  the user's local time, timezone and time of day.
  - It is rendered only when a timezone is resolved, so a UTC clock is never
    passed off as local.
- The continuity line now uses: 0 days → "vorhin" / "earlier today";
  1 day → "gestern" / "yesterday"; N days → "vor N Tagen" / "N days ago".
- The Nova close handler now honours `_stallRecoveryPending`
  (`shouldRecoverNovaStall`):
  - It reconnects in place.
  - At zero turns it re-sends the greeting.
  - Mid-conversation it resumes silently, with the history in the rebuilt
    setup.
  - If the reconnect fails, it emits `connection_issue` instead of silence.

## Acceptance criteria

AC-1: With a resolved timezone, the voice prompt states the user's local time, and that line survives the instruction budget dropping the whole bootstrap.
TEST: services/gateway/test/orb/vtid-04539-evening-session.test.ts

AC-2: Without a resolved timezone, no clock line is rendered.
TEST: services/gateway/test/orb/vtid-04539-evening-session.test.ts

AC-3: A continuity thread from 0 days ago is "vorhin" / "earlier today", never "gestern" / "yesterday".
TEST: services/gateway/test/orb/vtid-04539-evening-session.test.ts

AC-4: A Nova close with the watchdog's stall flag on an active, non-rotating session reconnects in place, before the content-filter and premature-close branches; a failed reconnect emits `connection_issue`.
TEST: services/gateway/test/orb/vtid-04539-evening-session.test.ts

## Not verified here

- None of this has been tried in a live voice session.
- The stall path needs a real Nova stall to observe `reconnect_triggered`
  with `provider: nova_sonic` and then `stall_recovery_resumed`.
- It reaches production only through PUBLISH.

## Still open

The Nova content filter blocks the first attempt of reopened sessions. This
happened again in session `live-2434324c`. It is not fixed here.
