# Plan — milestone rows still cannot be recorded: `metadata` is not a column (follow-up to VTID-04878)

<!-- plan:begin -->
## Change class
light (2 files: services/gateway/src/services/milestone-service.ts and
services/gateway/test/vtid-04878-reward-earning.test.ts; no migration, route, auth, workflow or
deploy change)

## Problem (verified read-only 2026-10-06, production)
- The first production reward sweep (owner turned payouts on 2026-10-06) completed at 21:18 UTC:
  231 members, 17,495 VTNA credited, 0 credit/query failures, 0 test accounts paid — but
  `record_failures: 462`, `milestones_recorded: 0`.
- Supabase edge logs: 448 `POST /rest/v1/autopilot_recommendations` -> 400 in that window (PostgREST
  rejection, never reaches Postgres). The row `recordMilestone()` sends includes `metadata`; the live
  table has no `metadata` column (information_schema; every other field the row sends exists, and the
  NOT NULL columns without defaults — title, summary — are sent). VTID-03180's comment in
  routes/autopilot-recommendations.ts already records that this table has no metadata column.
- Effect: payment is keyed by rewardEventId, so nobody is paid twice, and new milestones still pay;
  but the achieved set stays empty, so every 6-hourly sweep re-detects the same ~462 milestones,
  re-sends 462 failing inserts and 462 duplicate credit_wallet calls, reports them as found, and no
  milestone is ever announced (the event is emitted only once recorded — VTID-04878 design).

## Work
1. Drop `metadata` from the row in `recordMilestone()`; the milestone id stays in `source_ref`, the
   category/reward are derivable from MILESTONES and the rule table. No other field changes.
2. Test: assert the row object's own keys are exactly {user_id, title, summary, domain, source_type,
   source_ref, risk_level, impact_score, effort_score, status, activated_at, completed_at}
   (`expect(Object.keys(row).sort()).toEqual([...].sort())`) so any extra key fails CI; keep the
   CHECK-value assertions. (`milestone-service-repository.ts` insertAchievedMilestone is a
   pass-through and needs no change.)

## Rollout
Merge -> staging deploy -> STAGING-VERIFY (read-only: /alive and build-info reports the merged
commit; the row shape is proven by the unit test, recording is a write) -> owner approval -> publish gateway. Read-only post-check after the next
production sweep: `milestones_recorded` > 0 and `record_failures` 0 on the
rewards.milestone_sweep.completed event; autopilot_recommendations rows with source_type milestone
appear; no new wallet_transactions for already-paid keys.

## Risks
- The first sweep after the fix records the ~462 already-paid milestones and, being non-quiet,
  emits `user.milestone.reached` for each (OASIS rows only; no production consumer turns them into
  notifications — AP-0504/AP-1306 have never run). Owner already accepted these events for the
  back-pay on 2026-10-06.
- That first sweep also re-sends ~462 credit_wallet calls, each returning duplicate (no new rows);
  one burst, as in every sweep today. From then on the achieved set holds them and they stop.
<!-- plan:end -->

## Planner responses (round 1)
- F1 minor (allow-list wording): ACCEPTED — Work 2 now asserts the exact key set of the row object.
- F2 minor (~462 duplicate credit_wallet calls): ACCEPTED — added to Risks.
- F3 minor (staging check): ACCEPTED — build-info commit check added to Rollout.
- Q1: verified, not assumed — information_schema on the live table for all 13 keys the row sends: 12 present, `metadata` absent; NOT NULL columns without defaults are title and summary (sent); role_scope/economic_axis/autonomy_level/domain/status have defaults.
- Q2: verified against production run history — automation_runs has 0 runs ever for AP-0504 and AP-1306 (the user.milestone.reached consumers); production runs only AP-0910 live, the heartbeat loop is off there.

## Round 2 (partner)
F1-F3 closed; no new findings.

## Verdict
CONVERGED after 2 rounds (light class). Plan hash: 4115dc40ca119298f9b5c1020e838b6ac19d3b674c3b526171b0a3c066477045
