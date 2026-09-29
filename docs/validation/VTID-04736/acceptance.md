# VTID-04736 / VTID-04737 / VTID-04738 — voice session dropped after a memory lookup

Production session `live-cbda9130` (mobile, 2026-09-29 11:26 UTC). The member
asked "was hast du als Informationen über mich gespeichert?". Read from
`oasis_events`:

| time | event |
|---|---|
| 11:26:45.366 | `tool_call` search_memory |
| 11:26:45.515 | `model_start_speaking` — a filler line around the call |
| 11:26:45.852 | tool result sent |
| 11:26:46.892 | `turn_complete` — the widget shows Listening |
| 11:26:55.836 | `model_start_speaking` — the answer, 10 s later |
| 11:27:22.686 | `watchdog_fired` audio_stall (20 s), session terminated and reconnected |
| 11:27:37.120 | member: "bist du noch da" |
| 11:27:39.203 | `conversation_ended` still_here_complaint_detected — the session is closed |

Three defects, one per VTID:

- **VTID-04736** — Nova's answer to a tool result is a new turn, but it
  opens with an ASSISTANT block, and since VTID-03592 only a USER or TOOL
  block re-arms the turn latch. The filler line's END_TURN used the latch
  and the answer's END_TURN was swallowed, so `isModelSpeaking` stayed true
  and the audio-stall watchdog killed the stream. The normalizer now re-arms
  once per tool result, on the first SPECULATIVE ASSISTANT block after it.
  The same stall followed a tool call on 25, 26 and 29 Sep (7-day query in
  `commands.log`) — it predates today's deploy.
- **VTID-04737** — "Bist du noch da?" is what a member asks after a silence
  or a dropped connection. The still-here backstop now fires only after the
  member asked Vitana to stop earlier in the session (`detectUserStopIntent`).
  The matcher itself is unchanged; its unit test is unchanged.
- **VTID-04738** — after a filler turn completes while the tool answer is
  still coming, the gateway sends `thinking` (reason `tool_answer_pending`)
  after `turn_complete`, so the widget shows Thinking, not Listening. The
  widget already handles a `thinking` that arrives during playback
  (VTID-04587).

Test-criteria change, stated on purpose: `still-here-complaint-backstop.test.ts`
now says a stop request before the complaint in its two firing cases. The
contract changed: "bist du noch da" alone no longer ends a conversation.

## Acceptance

AC-1: filler line, tool result, answer — the answer's END_TURN produces its own turnComplete; staged SPECULATIVE/FINAL without a tool result is still one turn.
TEST: services/gateway/test/orb/live/upstream/vtid-04736-tool-answer-turn-complete.test.ts

AC-2: the VTID-03592 staged-generation cases are unchanged.
TEST: services/gateway/test/orb/live/upstream/nova-sonic-protocol.test.ts

AC-3: "bist du noch da" with no earlier stop request keeps the conversation open; after a stop request it still closes it.
TEST: services/gateway/test/orb/live/session/still-here-complaint-backstop.test.ts

AC-4: after a filler turn with the tool answer pending, `thinking` is sent after `turn_complete`; not when the answer was already spoken or no tool was called.
TEST: services/gateway/test/orb/live/session/vtid-04738-tool-answer-thinking.test.ts

AC-5: on staging, a voice question that triggers search_memory is answered without an audio_stall watchdog and the orb shows Thinking while it waits.
TEST: scripts/memory-verification/run-live.mjs

OASIS_PROOF: the only OASIS change is one new `orb.live.diag` stage, `tool_answer_pending_thinking` (payload `waited_ms`), emitted by `sendThinkingIfToolAnswerPending()` through the existing `emitDiag`. It adds no new topic and changes no existing stage. The call is asserted in `services/gateway/test/orb/live/session/vtid-04738-tool-answer-thinking.test.ts`. Its first live occurrence on staging is part of AC-5.
