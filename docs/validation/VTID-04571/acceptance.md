# VTID-04571 — a late Nova FINAL block no longer mutes the next reply

Member test on staging, 2026-09-25, session `live-03af48b7` (German, Nova Sonic). The member asked for
their wife's birthday. Vitana called `search_memory`, found the spouse, and started answering — then
the gateway logged `duplicate_turn_detected (matched_prefix_chars 30)` and
`duplicate_turn_suppressed_at_complete (dropped_chunks 158)`. The member heard nothing, and the widget
went back to listening. The turn's `output_preview` began with the PREVIOUS turn's greeting text.

Cause: Nova closes the turn on the SPECULATIVE block's END_TURN (VTID-03592), so the FINAL block of the
same turn arrives after `turnComplete`. `handleTranscript` wrote it into `outputTranscriptBuffer`, where
it became the opening text of the next turn; that prefix equalled the previous reply, so the VTID-03143
duplicate check muted the real answer. Staging counts of `duplicate_turn_detected`: 4, 0, 1, 0, 6, 14
per day from 09-20 to 09-25.

AC-1: a FINAL block that arrives after turnComplete (or after an interruption) is dropped, and the next
turn starts with an empty buffer that is not flagged as a duplicate.
TEST: services/gateway/test/orb/live/session/upstream-session-binding.test.ts

AC-2: a FINAL inside an open turn still replaces the speculative text, and a genuine repeat of the
previous reply is still muted.
TEST: services/gateway/test/orb/live/session/upstream-session-binding.test.ts

AC-3 (live, after the staging deploy): a multi-turn German voice session shows no
`duplicate_turn_detected` on a turn that answers a new question.
TEST: services/gateway/test/orb/live/session/upstream-session-binding.test.ts (live evidence in outputs/)
