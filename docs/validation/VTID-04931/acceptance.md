# VTID-04931 — milestone rows record: drop the non-existent `metadata` column

Follow-up to VTID-04878. The first production reward sweep (2026-10-06 21:12-21:18 UTC, after the owner turned payouts on) paid 17,495 VTNA to 231 members with 0 credit failures, but recorded 0 of 462 milestones: `recordMilestone()` sends `metadata`, a column `autopilot_recommendations` does not have, so PostgREST answered 400 to every insert (448 in the edge logs for that window). Payment is keyed, so nobody was paid twice; but every 6-hourly sweep re-detects the same milestones and none is ever announced.

AC-1 The milestone row carries exactly the live columns it may use (user_id, title, summary, domain, source_type, source_ref, risk_level, impact_score, effort_score, status, activated_at, completed_at); any other key fails CI. Mutation-checked: adding `metadata` back fails the test.
TEST: services/gateway/test/vtid-04878-reward-earning.test.ts

AC-2 Nothing else changes: the milestone, rule-table and capped-reward suites pass; tsc clean.
TEST: services/gateway/test/milestone-service.test.ts
TEST: services/gateway/test/vtid-04864-vtna-reward-rules.test.ts

OASIS_IMPACT: no
(No new topic or route. After the publish, the next rewards.milestone_sweep.completed event should report milestones_recorded > 0 and record_failures 0 — a read-only post-check.)
