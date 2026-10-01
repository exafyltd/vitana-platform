# VTID-04609 — Vitana's farewell spoken and stored twice

Reported 2026-09-26 with VTID-04601: the lock-screen text and the Vitana inbox
row read "Razumem. Nema problema. Želim vam prijatan dan!Razumem. Nema
problema. Želim vam prijatan dan!".

## Evidence (production telemetry, read-only)

Session `live-a7b3a904` (sr, Vertex bridge), turn 1 (`outputs/session-trace.md`):
- 08:34:03 `model_start_speaking`, audio_out 243 → 312: the farewell.
- 08:34:04 `tool_call end_conversation`, `conversation_ended`, tool result sent
  ("…do not speak further").
- audio_out 312 → 377 until `turn_complete` at 08:34:10: the same farewell again.

Only one handler is bound to the Vertex socket (raw handler, since
`ORB_VERTEX_SHARED_HANDLERS` is not `true`), so this is not double
processing in the gateway. Gemini Live really did speak it twice, and the
transcript recorded both copies.

## Change

- `dispatchEndConversationDirective()` records whether a farewell had already
  been spoken this turn (`farewellSpokenBeforeClose`).
- New `isPostFarewellOutput(session)`: close sent AND farewell already spoken.
- Both handler sets (raw Vertex handler, shared Nova/cascade/Vertex handlers)
  drop model audio and output transcript while it is true.
- If the model calls `end_conversation` before saying anything, the flag stays
  false and its farewell still plays.

## Acceptance criteria

AC-1 After a spoken farewell and the close, a repeated farewell is neither forwarded as audio nor stored.
  TEST: services/gateway/test/orb/live/session/vtid-04609-post-farewell-output-dropped.test.ts ("keeps the farewell once and drops the repeat")
AC-2 Tool called before any speech: the farewell still plays and is stored.
  TEST: services/gateway/test/orb/live/session/vtid-04609-post-farewell-output-dropped.test.ts ("still plays the farewell when the tool was called before anything was said")
AC-3 No behaviour change without a close.
  TEST: services/gateway/test/orb/live/session/vtid-04609-post-farewell-output-dropped.test.ts ("changes nothing while no close has been dispatched")
AC-4 The raw Vertex handler (the Serbian bridge path) applies the same guard.
  TEST: services/gateway/test/orb/live/session/vtid-04609-post-farewell-output-dropped.test.ts ("the raw Vertex handler applies the same guard")
AC-5 Existing ORB session and route suites unchanged.
  TEST: services/gateway/test/orb/live/session, services/gateway/test/routes/orb-live*

Mutation check: forcing `farewellSpokenBeforeClose = false` fails AC-1.
