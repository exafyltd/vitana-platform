# VTID-04668 — Autopilot recommendations P2: evidence-based priority score

Plan: `docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md` §1, §2, §4 P2. Builds on
P1 (VTID-04666, noise removal) and P4 (VTID-04667, breaker + budget).

## Why

Every developer recommendation's `impact_score` / `effort_score` was a
constant per source (plan §1): "Impact 6/10" meant "the scanner called it
medium severity". Nothing ranked across sources, `seen_count` was unused,
and nothing estimated what a finding would cost or whether the executor
would land it — while the live record (plan §2) is 74 scanner executions
and 0 completions in 30 days, and < 5 % of decided recommendations accepted.

## Fix

- **Pure score** — `services/gateway/src/services/recommendation-quality/priority.ts`,
  developer rows only (`user_id IS NULL`, not `community` / `operator_onramp`):
  - **value** (0..1) = audience·0.40 + severity·0.35 + frequency·0.25, × trend.
    Audience table (members 1.0 / operators 0.6 / CI-only 0.3) by
    `spec_snapshot.signal_type`, else `source_type`; severity from scanner
    severity / impact severity / risk class; frequency from `seen_count`
    (log scale) and event counts in the snapshot or the message ("N
    occurrences", "N failure(s)"); trend from `last_seen_at` (≤ 3 d 1.0,
    ≤ 14 d 0.8, else 0.5). All weights are exported, documented constants.
  - **confidence** (0..1) = 0.3 base + concrete file path 0.2 (+0.1 when the
    file is in the code index, −0.3 when it is not; skipped when the index is
    unavailable) + ≥ 10 events 0.15 / ≥ 3 events 0.08 + reproduced
    (`seen_count ≥ 2`) 0.15 + named scanner/rule 0.1 (else a source reference 0.1).
  - **success_odds** — executable types: `(successes + 1) / (samples + 2)`
    (Laplace) from the **P4 breaker stats** (`loadScannerBreakers` /
    `breakerKeyFor`, `dev-autopilot-scanner-breaker.ts` — the counting is not
    duplicated); no history → 0.5. Non-executable types (oasis, roadmap,
    behavior, health …): fixed prior 0.3, `executable:false`.
  - **expected_cost_usd / expected_input_tokens** — median per breaker key
    of the agent runs recorded on `dev_autopilot_outcomes`
    (`metadata.agent_runs[]`), read with `extractAgentRuns` — the reader the
    P4 per-finding budget (`summarizeFindingSpend`) now uses too. Prior
    $1.00 / 1 M tokens when a key has no runs.
  - `priority = value × confidence × success_odds / max(expected_cost_usd, 0.05)`.
  - Legacy mapping: `impact_score = round(1 + 9·value)`,
    `effort_score = round(1 + 9·min(1, cost / $3))`.
  - `passesQualityFloor(q)`: `confidence ≥ 0.6` and (non-executable or
    `success_odds ≥ 0.3`); `AUTOPILOT_QUALITY_MIN_CONFIDENCE` /
    `AUTOPILOT_QUALITY_MIN_SUCCESS_ODDS` override.
  - `quality` jsonb = `{version:1, value, confidence, success_odds,
    expected_cost_usd, expected_input_tokens, executable, basis{human-readable
    reasons}, scored_at}`.
- **Writes** — `recommendation-quality/scoring-service.ts`:
  - After insert: `ingestScan` (dev_autopilot), `POST /impact-ingest`
    (dev_autopilot_impact) and the recommendation generator (oasis / roadmap
    / health / behavior … via the `insert_autopilot_recommendation` RPC, which
    takes no score fields) call `scoreNewDeveloperRecommendations(since)`,
    which PATCHes the unscored open developer rows created since the run
    started (60 s clock-skew margin).
  - `rescoreTick`: every 30 min, ≤ 200 open developer recs, unscored and
    oldest-scored first, registered in `startBackgroundExecutor` next to the
    other Dev Autopilot ticks (loop owner only). It keeps any P3 `review`
    fields already on the row.
  - Breaker stats are read with `useCache:false, emitTransitions:false`, so
    scoring never swallows the auto-approve tick's breaker transition events.
  - Fail-open: a read / PATCH / scoring error is logged and never throws to
    an insert path; an unscored row simply stays unscored.
- **Listings** — `recommendation-quality/listing.ts`:
  - `GET /api/v1/dev-autopilot/pending-approvals` orders by
    `priority_score desc` (unscored last), then the VTID-04666 risk rank
    (that comparator is now `comparePendingApprovals`); rows below the floor
    are excluded unless `?include_below_floor=1`; the response carries
    `below_floor_count`; rows carry `priority_score` and `quality`.
    `/pending-approvals/count` counts the same listed rows.
  - `queryRecommendationsByRole` (developer / admin / infra lineup) reads a
    1000-row window, orders by priority then impact then newest, applies the
    floor, and pages after that; `GET /api/v1/autopilot/recommendations`
    passes `?include_below_floor=1` through and returns `below_floor_count`.
    The community lineup is unchanged.
- **Migration** `supabase/migrations/20260926160000_vtid_04668_recommendation_priority.sql`
  (additive): nullable `priority_score numeric`, `quality jsonb`, partial
  index `(status, priority_score DESC) WHERE user_id IS NULL`.
  `DATABASE_SCHEMA.md` updated. Apply before the code deploys (a PATCH naming
  a missing column is rejected; scoring logs it and continues, but nothing
  gets a score).

New env vars: `AUTOPILOT_QUALITY_MIN_CONFIDENCE` (default 0.6),
`AUTOPILOT_QUALITY_MIN_SUCCESS_ODDS` (default 0.3). No new OASIS event.

## Acceptance criteria

AC-1 The value / confidence / success / cost components follow the documented tables; priority = value × confidence × success_odds / max(cost, 0.05); legacy impact/effort are mapped to 1..10.
TEST: services/gateway/test/vtid-04668-priority-score.test.ts

AC-2 Success odds come from the P4 breaker stats with Laplace smoothing (no duplicated counting); non-executable types use a fixed prior and are marked executable:false.
TEST: services/gateway/test/vtid-04668-priority-score.test.ts
TEST: services/gateway/test/vtid-04668-scoring-service-and-listing.test.ts

AC-3 Expected cost is the per-scanner median of recorded agent runs, read with the same reader as the P4 budget; a prior applies without history.
TEST: services/gateway/test/vtid-04668-priority-score.test.ts

AC-4 passesQualityFloor: confidence ≥ 0.6 and (non-executable or success ≥ 0.3), env-overridable.
TEST: services/gateway/test/vtid-04668-priority-score.test.ts

AC-5 Only developer rows are scored (never community / operator_onramp); scoring PATCHes after insert and a rescore keeps the P3 review fields.
TEST: services/gateway/test/vtid-04668-scoring-service-and-listing.test.ts

AC-6 Fail-open: a scoring read/PATCH failure never throws, and ingestScan still inserts when scoring cannot read.
TEST: services/gateway/test/vtid-04668-scoring-service-and-listing.test.ts

AC-7 The rescore tick runs at most every 30 min over ≤ 200 rows, oldest score first.
TEST: services/gateway/test/vtid-04668-scoring-service-and-listing.test.ts

AC-8 Pending approvals and the developer lineup order by priority (unscored last), hide below-floor rows unless include_below_floor=1, report below_floor_count and return priority_score + quality; the community lineup is unchanged.
TEST: services/gateway/test/vtid-04668-scoring-service-and-listing.test.ts

AC-9 The operator and support pipeline suites stay green.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Existing tests changed (contract changed on purpose)

The developer badge counts used PostgREST's `Content-Range` total. The floor
is applied in JS, so the count is now the number of listed rows in the
window:

- `test/routes/dev-autopilot.test.ts` — "parses the exact count from
  Content-Range" → "counts the listed rows (VTID-04668)".
- `test/routes/autopilot-recommendations.test.ts` — the two
  `role=developer` count tests now return N rows and expect N.

## Behaviour change to be aware of

`effort_score` is now derived from expected cost. `autoApproveTick` filters
`effort_score <= max_effort`, so a scanner whose recorded median cost is
high can drop out of auto-approve (a median of about $1.70 or more maps to
effort ≥ 6). The $1.00 prior maps to effort 4. `lazyPlanTick` and
`autoApproveTick` order by `impact_score`, which now reflects value.

## Not verified live

- Nothing was written to any database. The migration ships as a file for a
  human to apply before merge.
- The live distribution of scores (how many open rows land below the
  floor) was not measured. With the tables above, a first-sighting oasis /
  health card is below the confidence floor until it is reproduced, and
  roadmap / behavior cards (no file, no event count) do not reach it —
  consistent with plan §2 (0 shipped from those sources), but a judgement
  call to review once real scores exist (`?include_below_floor=1` shows them).
