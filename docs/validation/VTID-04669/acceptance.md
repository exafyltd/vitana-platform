# VTID-04669 — Autopilot recommendations P3: quality review before a card is shown

Plan: `docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md` §4 P3. Builds on P2
(VTID-04668, evidence-based priority + floor).

## Why

P2 ranks developer recommendations and hides the ones below the floor, but a
card that passes the floor is still a scanner or analyzer output nobody has
looked at: plan §2 records < 5 % of decided recommendations accepted,
170 + 391 rejections of scanner / impact findings and 0 shipped from oasis,
roadmap, behavior and health. The plan's principle is that a card reaches a
human only when it names a concrete defect with evidence. P3 adds exactly one
bounded model call per surviving card to check that, before it is shown.

## Fix

- `services/gateway/src/services/recommendation-quality/quality-review.ts`:
  - Candidates: open (`status=new`) developer recommendations (user_id NULL,
    not community / operator_onramp, not expired) that are scored, pass the
    P2 floor (`passesQualityFloor`), have no `quality.review`, and fewer
    than 2 recorded `quality.review_attempts` — highest priority first.
    Rows below the floor never get a model call.
  - One review per row via the shared stage loop `runStageToolLoop`
    (VTID-04231), stage `planner`, service `recommendation-quality-review`,
    no provider/model override (the planner routing policy — Bedrock —
    decides; nothing here adds a Google or direct-Anthropic path). Tools:
    `dev_index_query` and `dev_get_risk` from the VTID-04229 code index,
    wired the way `routes/specs.ts` (VTID-04233) wires them; without an
    index (3 s load bound) the review is one tool-less call. Bounds: ≤ 4
    turns, ≤ 6 tool calls, 90 s.
  - The prompt states the intent in English and asks for strict JSON
    `{verdict, problem, evidence[], files[{path, risk}], acceptance[],
    why_now, drop_reason?}`. `parseReviewVerdict` is tolerant (code
    fences, prose around the object, loose shapes); unusable output = no
    verdict.
  - `keep` → `quality.review` is stored (plus provider, model, tokens,
    tool calls, `reviewed_at`). `drop`, or an executable type kept with no
    concrete file or no evidence → `status='auto_archived'` (never
    `rejected`: rejection is a human decision and starts the VTID-04666
    30-day fingerprint block) with `quality.review.drop_reason`.
  - No verdict → `quality.review_attempts` + `review_last_attempt_at`; the
    row is retried on a later tick, at most 2 attempts in total. A row whose
    two attempts both failed is not retried and stays hidden (counted in
    `awaiting_review_count`).
  - `qualityReviewTick`: every 15 min, ≤ 5 rows, daily cap
    `AUTOPILOT_QUALITY_REVIEW_DAILY_CAP` (default 40) counted from
    `quality.review.reviewed_at` since 00:00 UTC; kill switch
    `AUTOPILOT_QUALITY_REVIEW_ENABLED` (exact `false` disables; default on).
    Registered in `startBackgroundExecutor` next to the other Dev Autopilot
    ticks (loop owner only). The P2 rescore keeps `review` /
    `review_attempts` when it rewrites `quality`.
  - One OASIS event per verdict: `autopilot.recommendation.quality_reviewed`
    (added to `CicdEventType`).
- Listings (`recommendation-quality/listing.ts`, kill switch in
  `review-config.ts`): while the review is on, `GET
  /api/v1/dev-autopilot/pending-approvals` (and its `/count`) and the
  developer / admin / infra lineup of `GET /api/v1/autopilot/recommendations`
  show only open rows the review kept; open rows that pass the floor but
  are not reviewed yet (and unscored rows) are counted in
  `awaiting_review_count` instead. Rows carry `quality` (with `review`).
  With the review off, P2 behaviour applies unchanged.

New env vars: `AUTOPILOT_QUALITY_REVIEW_ENABLED` (default on; exact `false`
disables), `AUTOPILOT_QUALITY_REVIEW_DAILY_CAP` (default 40). No schema
change (uses the VTID-04668 `quality` column).

## Acceptance criteria

AC-1 The review output is parsed tolerantly (fenced / prose-wrapped / loose JSON); anything without a keep/drop verdict is "no verdict".
TEST: services/gateway/test/vtid-04669-quality-review.test.ts

AC-2 keep stores quality.review (P2 components kept); drop — or an executable keep with no concrete file or evidence — sets status auto_archived, never rejected, with the drop reason.
TEST: services/gateway/test/vtid-04669-quality-review.test.ts

AC-3 The review is one planner-stage runStageToolLoop call with only dev_index_query / dev_get_risk, ≤ 4 turns / ≤ 6 tool calls / 90 s, and no provider or model override.
TEST: services/gateway/test/vtid-04669-quality-review.test.ts

AC-4 Unparseable output records review_attempts, emits nothing, is retried next tick, and is never retried after 2 attempts.
TEST: services/gateway/test/vtid-04669-quality-review.test.ts

AC-5 No model call for rows below the P2 floor, unscored rows or rows already reviewed.
TEST: services/gateway/test/vtid-04669-quality-review.test.ts

AC-6 Tick every 15 min, ≤ 5 rows, daily cap (default 40, env-overridable) counted from quality.review.reviewed_at today; the kill switch (exact "false") stops all reads and calls.
TEST: services/gateway/test/vtid-04669-quality-review.test.ts

AC-7 One OASIS event autopilot.recommendation.quality_reviewed per verdict with verdict, recommendation_id, provider/model and tokens.
TEST: services/gateway/test/vtid-04669-quality-review.test.ts

AC-8 With the review on, the developer listings show only reviewed-keep open rows and report awaiting_review_count; with it off, P2 behaviour is unchanged.
TEST: services/gateway/test/vtid-04669-quality-review.test.ts

AC-9 The operator and support pipeline suites stay green.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## OASIS

OASIS_PROOF: new event type `autopilot.recommendation.quality_reviewed`
(vtid `VTID-04669`, source `recommendation-quality`, status `info` for keep /
`warning` for an auto-archive), payload `{ recommendation_id, verdict,
drop_reason, source_type, provider, model, input_tokens, output_tokens,
tool_calls }`, registered in `CicdEventType`. Asserted in
`services/gateway/test/vtid-04669-quality-review.test.ts` ("keep → stores
quality.review and emits autopilot.recommendation.quality_reviewed", "drop →
status auto_archived …"); the no-verdict test asserts no event.

## Existing tests changed (contract changed on purpose)

With the review on (the default), unreviewed developer rows are no longer
listed. Three suites pin the listing's query / sort / count behaviour
underneath that filter and now set `AUTOPILOT_QUALITY_REVIEW_ENABLED=false`
at the top, with a comment pointing here:
`test/routes/dev-autopilot.test.ts`,
`test/routes/autopilot-recommendations.test.ts`,
`test/vtid-04666-dev-findings-rejected-expiry-sort.test.ts`. No assertion
was changed.

## Behaviour to be aware of

- After deploy, and until the first reviews land, the developer lineup and
  the Pending Approvals popup show only already-reviewed rows — i.e. none at
  first. At 5 rows / 15 min and 40 / day, a backlog of open rows drains over
  days; `awaiting_review_count` shows how many are waiting, and
  `AUTOPILOT_QUALITY_REVIEW_ENABLED=false` restores the P2 listing.
- Model spend is bounded by the daily cap: ≤ 40 planner-stage reviews a day,
  plus at most one failed retry per row.

## Not verified live

- No review ran against a real model or the real code index: every call is
  mocked. The first `autopilot.recommendation.quality_reviewed` event on
  staging after the P2 migration is applied and this deploys is the
  exercise.
- Nothing was written to any database.
