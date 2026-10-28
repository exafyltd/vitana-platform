# VTID-04359 — customer-support follow-ups (gateway)

Follow-ups to the customer-support rebuild (VTID-04332..04336), found while
reviewing the merged work.

AC-1: The typed submit_* tools (bug, support question, marketplace dispute,
account issue) use the same 5-word minimum as report_to_specialist instead
of their own 15/12-word thresholds.
TEST: services/gateway/test/vtid-04359-support-followups.test.ts
TEST: services/gateway/test/orb-tools/feedback-settings-tools.test.ts

AC-2: A placeholder summary ("User wants to report a bug") is refused by the
submit_* tools with ASK_FOR_SPECIFICS, the same way report_to_specialist
refuses it; both paths share one isVagueSummary().
TEST: services/gateway/test/vtid-04359-support-followups.test.ts
TEST: services/gateway/test/orb-tools/feedback-settings-tools.test.ts

AC-3: The tool descriptions the model reads say "at least 5 concrete words",
never 15 or 12.
TEST: services/gateway/test/orb/live/characterization/tool-catalog.characterization.test.ts

AC-4: GET /api/v1/feedback/tickets/mine returns the member's own report text
(raw_transcript) for every ticket, clipped to 2,000 characters, read with the
member's own RLS client.
TEST: services/gateway/test/vtid-04359-support-followups.test.ts

AC-5: /mine still exposes resolution_md / answer_md only for resolved tickets.
TEST: services/gateway/test/vtid-04312-feedback-reporter-notify.test.ts

AC-6: The rebuild brief records the status of every slice and what is still
unverified live.
TEST: services/gateway/test/vtid-04359-support-followups.test.ts
