# Live staging re-test after VTID-04485 (gateway e7a8531, task def vitana-gateway:567), 2026-09-24 13:50 UTC

Same harness and utterance as VTID-04474 ("What is the status of my support tickets? Do I have any open ones?"), LANG_CODE=en, test account.

| Run | Specialist call(s) | Outcome |
|---|---|---|
| 1 | 1st: 3.21 s → `Tool ask_support_specialist timed out after 3000ms` (orb-live TOOL_TIMEOUT_MS); model retried, 2nd: 2.48 s ok | Member heard "I can't check that right now" — the flat 3 s tool budget overrode the 4.5 s ack window. → this VTID. |
| 2 | 2.91 s ok, inside the window | **Answer spoken in the same turn:** "you don't have any open support tickets or bug reports … Everything looks clear!" |

Separate finding, reported not fixed here: in run 1, during the greeting and before the member spoke, the model called
`create_calendar_event` ("Nutrition Improvement Plan", start 2026-04-15 — a past date) on the test account's private calendar
without any request or confirmation. Unrelated to the specialists; a model-behaviour / tool-confirmation gap to raise separately.

Cleanup: every row the two sessions created for the test account after 13:50:20 UTC was deleted (calendar_events 1,
agent_runs 3, memory_items 2, memory_transcript_turns 2, user_session_summaries 2, user_open_threads 1, user_assistant_state 1,
memory_audit_log 1, user_activity_log 24, product_analytics_events for both sessions); re-count 0 in every user-keyed table.
