# VTID-04747 — the display says Vitana speaks while she is silent

Production live-11ec418b (2026-09-29, mobile). At 13:55:43 and at 13:57:43 Vitana's reply never got a turn_complete.
- The first time, remember_fact failed in 5 ms, so the filler line's own SPECULATIVE block started after the tool result.
- The second time, the remember backstop sent Nova a text note after the turn had already completed.

In both cases isModelSpeaking stayed true. The widget kept showing "Vitana spricht" (owner screenshot, 15:56 local) until the 20 s audio-stall watchdog killed and reconnected the session.

Fixes:
- A text note now re-arms the Nova turn latch, the same way a tool result does.
- New soft turn end (soft-turn-end.ts): when no output chunk has arrived for 2.5 s (ORB_SOFT_TURN_END_MS; 0 turns it off), the session completes the turn itself. A late real END_TURN with no audio in between is ignored, so a turn never completes twice. Nova sessions only.

## Acceptance

AC-1: the turn completes 2.5 s after the last audio chunk when END_TURN never comes. Each chunk pushes the deadline out. A real END_TURN in time cancels the timer, and a late one is ignored. Nova sessions only.
TEST: services/gateway/test/orb/live/session/vtid-04747-soft-turn-end.test.ts

AC-2: the answer to a text note gets its own turnComplete, and staged generation is still one turn.
TEST: services/gateway/test/orb/live/upstream/vtid-04747-client-turn-latch.test.ts

AC-3 (live, staging): no audio_stall watchdog after a tool call or a backstop note.
TEST: scripts/memory-verification/run-live.mjs
