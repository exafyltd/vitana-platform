# VTID-04384 — every auto-triaged support question gets a real Sage draft

AC-1: A support question in answer_ready with a placeholder answer gets a real Sage draft
(triage routing stage), written only while the ticket is still answer_ready.
TEST: services/gateway/test/vtid-04384-feedback-answer-drafter.test.ts

AC-2: The tick never changes the ticket status and never sends anything to the member.
TEST: services/gateway/test/vtid-04384-feedback-answer-drafter.test.ts

AC-3: A fallback draft leaves the placeholder and counts the attempt; after 3 attempts, or while
another gateway holds the claim, the ticket is skipped.
TEST: services/gateway/test/vtid-04384-feedback-answer-drafter.test.ts

AC-4: The tick is throttled (5 min) and FEEDBACK_ANSWER_DRAFT_ENABLED=false disables it.
TEST: services/gateway/test/vtid-04384-feedback-answer-drafter.test.ts

AC-5: The executor tick runs it next to the spec drafter.
TEST: services/gateway/test/vtid-04384-feedback-answer-drafter.test.ts
