# VTID-04670 — Autopilot recommendations P5: learn from dismiss decisions

Plan: `docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md` §4 P5. Builds on P4
(VTID-04667, breaker keying), P2 (VTID-04668, priority score) and P3
(VTID-04669, quality review).

## Why

Plan §2 records < 5 % of decided developer recommendations accepted and
hundreds of rejections of scanner / impact findings — but a dismiss carried no
reason, and nothing used the decisions people had already made. A producer
whose cards are dismissed again and again kept producing cards at the same
priority. P5 makes a dismiss say why, measures acceptance per producer, and
feeds it back into the P2 score.

## Fix

- `POST /api/v1/autopilot/recommendations/:id/reject` accepts `reason_code`
  (`not_a_real_problem | not_worth_it | duplicate | already_fixed | wrong_fix |
  other`) and an optional `note` (≤ 300 chars). An unknown code → 400 before
  anything is written. `reject_autopilot_recommendation` stores no reason, so
  after the RPC succeeds the route reads the row and, only when it is a
  developer row (`user_id IS NULL`, not community), merges
  `quality.dismiss = {reason_code, note, by, at}` into the existing quality JSON
  (the PATCH repeats `user_id=is.null`). Community rows and callers without a
  code are unchanged; a failed dismiss write is reported as
  `dismiss_recorded:false`, never as a failed reject. A `reason` that is itself
  a known code is accepted as the code.
- New `services/gateway/src/services/recommendation-quality/acceptance.ts`:
  per producer key — `breakerKeyFor` (P4/P2 keying, reused) — over the last 90
  days of decided developer rows: activated, completed, rejected (by reason),
  auto_archived; `decided = activated + completed + rejected` (auto_archived is
  not a human decision), `acceptance_rate = (activated + completed) / decided`.
  A key with ≥ 10 human decisions and < 10 % acceptance is **demoted**:
  demotion factor 0.5, or 0.35 when at least half of its dismissals are noise
  (`not_a_real_problem` / `duplicate`). One read, cached 10 min; a failed read
  demotes nothing.
- `priority.ts` stays pure: `ScoringContext.acceptanceFor` is an injected lookup;
  a demoted producer's confidence is multiplied by its factor (1.0 × 0.5 is
  below the 0.6 floor), and `quality.acceptance` / `quality.basis.acceptance`
  record why. `loadScoringContext` wires the lookup; the rescore keeps
  `quality.dismiss`.
- Supervisor snapshot (`GET /api/v1/dev-autopilot/supervisor`) gains
  `recommendation_acceptance`: per key decided, accepted, rate, top dismiss
  reasons, demoted flag (demoted first), plus totals and thresholds.
- `weeklySummaryTick` (executor loop, checks hourly) emits
  `autopilot.recommendations.weekly_summary` once when the newest such event in
  `oasis_events` is ≥ 7 days old (so a restart does not re-send it): counts
  created by source / key, decided by source, week and 90-day acceptance, per-key
  acceptance, demoted keys. A failed read sends nothing.

No schema change (uses the VTID-04668 `quality` column). No new env var.

## Acceptance criteria

AC-1 Dismiss accepts exactly the six reason codes plus an optional note ≤ 300 chars; an unknown code returns 400 and writes nothing.
TEST: services/gateway/test/vtid-04670-recommendation-acceptance.test.ts

AC-2 For a developer row the reason is stored as quality.dismiss after the RPC, keeping the existing quality fields; community rows and callers without a code are unchanged; a failed write does not fail the reject.
TEST: services/gateway/test/vtid-04670-recommendation-acceptance.test.ts

AC-3 Acceptance is computed per P4/P2 key over 90 days: activated, completed, rejected by reason, auto_archived; rate = (activated + completed) / human decisions.
TEST: services/gateway/test/vtid-04670-recommendation-acceptance.test.ts

AC-4 A key with ≥ 10 human decisions and < 10 % acceptance is demoted; noise dismissals (not_a_real_problem / duplicate) demote harder; the demoted producer falls below the P2 floor while other keys are unaffected, with priority.ts kept pure.
TEST: services/gateway/test/vtid-04670-recommendation-acceptance.test.ts

AC-5 The supervisor snapshot carries recommendation_acceptance with decided, accepted, rate, top dismiss reasons and the demoted flag.
TEST: services/gateway/test/vtid-04670-recommendation-acceptance.test.ts

AC-6 The weekly summary is emitted once per 7 days, guarded by the newest summary event, and never on a failed read.
TEST: services/gateway/test/vtid-04670-recommendation-acceptance.test.ts

AC-7 The operator and support pipeline suites and the P1–P4 suites stay green.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## OASIS

OASIS_PROOF: new event type `autopilot.recommendations.weekly_summary` (vtid
`VTID-04670`, source `recommendation-quality`, status `warning` when any
producer is demoted, else `info`), payload `{ period_start, period_end,
created_by_source, created_by_key, decided_by_source, week, window,
acceptance_by_key, demoted_keys }`, registered in `CicdEventType`. Asserted in
`services/gateway/test/vtid-04670-recommendation-acceptance.test.ts` ("emits
autopilot.recommendations.weekly_summary once …", "the event type is
registered …").

## Not verified live

- Nothing was written to any database; every PostgREST call in the tests is
  mocked. The first dismiss with a reason on staging after this deploys, and
  the first `autopilot.recommendations.weekly_summary` event, are the exercise.
