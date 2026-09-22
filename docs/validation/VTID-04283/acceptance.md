# VTID-04283 — Acceptance

## Context

User-reported, urgent: "why does it still show 30 new findings since so
many hours. not one single of the new findings has started to be
processed." Screenshot showed the Command Hub Autopilot → Runs page.

Investigated live against production Supabase (read-only queries, no
writes beyond this VTID's own self-allocation): confirmed 4 genuinely
un-actionable-until-planned `dev_autopilot` findings (dead_code,
stale_flag, missing_tests, todo — `9975d092`, `cd05643c`, `e367b3a1`,
`8caa3710`) had **zero** `dev_autopilot_plan_versions` rows and **zero**
`self_healing_log` failure rows, ~21 hours after creation, despite
`lazyPlanTick()` running every 30 seconds the whole time
(`DEV_AUTOPILOT_EXECUTOR_ENABLED` is not `'false'` on this stack, per
`services/gateway/src/index.ts:1796`).

Traced `lazyPlanTick()` (`services/gateway/src/services/dev-autopilot-execute.ts`)
end to end against the live data. Root cause, confirmed with a direct
query rather than inferred:

```sql
select ar.id, ar.source_type, ar.risk_class, ar.impact_score,
  (select count(*) from dev_autopilot_plan_versions pv where pv.finding_id=ar.id) as n_plans
from autopilot_recommendations ar
where ar.status='new' and ar.risk_class in ('low','medium')
order by ar.impact_score desc, ar.created_at asc
limit 30;
```

returned **25+ `operator_onramp` findings, impact_score=5, created
2026-09-13 through 2026-09-18, every single one already carrying a plan
(`n_plans=1`), still sitting at `status='new'`** (a separate, legitimate
situation — they are waiting on human review, by design, not a bug) —
occupying every one of the top 30 ranks by `impact_score.desc`, ahead of
the reported findings (impact_score 3-6, created 2026-09-21).

`lazyPlanTick()`'s candidate query was:

```
/rest/v1/autopilot_recommendations?...&status=eq.new&risk_class=in.(...)
  &order=impact_score.desc&limit=${LAZY_PLAN_BATCH_SIZE * 4}   // = 12
```

— only the top **12** candidates by impact_score, and the loop then
checked "does this one already have a plan?" **one row at a time**,
`continue`-ing past each already-planned row. With 25+ already-planned
rows permanently sitting at the top of that ranking, all 12 fetched
candidates were already-planned on **every single tick**, so `generated`
stayed 0 forever — not because nothing was plannable, but because the
window was never wide enough to see past a backlog that itself was stuck
for an unrelated reason (awaiting human review).

## Fix

`lazyPlanTick()` now:

1. Fetches a **much wider** candidate window (`LAZY_PLAN_CANDIDATE_LIMIT`,
   default 200, env-tunable via `DEV_AUTOPILOT_LAZY_PLAN_CANDIDATE_LIMIT`)
   instead of the old 12.
2. **Batch-checks** which of those candidates already have a plan, in one
   chunked query (`dev_autopilot_plan_versions?finding_id=in.(...)`,
   ≤60 ids per chunk to keep the URL bounded) — up front, not one query
   per candidate inside the loop.
3. Filters to the genuinely-unplanned subset **before** looping, so an
   already-planned candidate can no longer occupy a loop iteration (or a
   round trip) at all — the size of the already-planned backlog ahead of
   a real candidate no longer matters.

A failed plan-existence chunk read fails **open** (that chunk's
candidates fall through to `generatePlanVersion`, which is safe to call
again on an already-planned finding — it writes a new version, it does
not error) — same posture as the pre-existing failure-history read a few
lines below it, and strictly no worse than the old per-row behaviour.

The per-candidate "is a plan task already pending/running" check and the
`planRetryDecision` backoff/exhaustion check are unchanged.

## Acceptance Criteria

AC-1 — a genuinely-unplanned, lower-impact candidate is reached and
planned even when 25 already-planned, higher-impact candidates occupy
every rank ahead of it — the exact live starvation shape.
TEST: `services/gateway/test/vtid-04283-lazy-plan-starvation.test.ts` —
"reaches a genuinely-unplanned low-impact finding past 25 already-planned
high-impact ones (the live starvation shape)"

AC-2 — the candidate fetch window is wide (≥100, well past the old
12-row limit), so a same-size or larger already-planned backlog cannot
recreate the starvation.
TEST: `services/gateway/test/vtid-04283-lazy-plan-starvation.test.ts` —
"fetches a wide candidate window (well beyond the old 12-row limit)"

AC-3 — the plan-existence check is batched into chunked requests (≤60
ids per request), not one request per candidate, so a wide window stays
cheap.
TEST: `services/gateway/test/vtid-04283-lazy-plan-starvation.test.ts` —
"chunks the batch plan-existence check so the URL never carries an
unbounded id list"

AC-4 — a failed plan-existence chunk read degrades to "offer this
chunk's candidates to the planner" (fail open), never to a silently
stalled tick.
TEST: `services/gateway/test/vtid-04283-lazy-plan-starvation.test.ts` —
"fails open on a broken plan-existence chunk: that chunk's candidates are
still offered to the planner rather than silently dropped"

AC-5 — the per-tick `LAZY_PLAN_BATCH_SIZE` (3) generation cap is
unchanged once genuinely-unplanned candidates are found.
TEST: `services/gateway/test/vtid-04283-lazy-plan-starvation.test.ts` —
"still respects the per-tick batch size cap once genuinely-unplanned
candidates are found"

## Verification

- Mutation-verified: reverting the batch filter to a no-op (`const
  unplannedFindings = findingsR.data;`) correctly failed AC-1 and AC-3,
  confirming the tests pin the real fix, not incidental behaviour.
- 5/5 new tests passing; `lazy-plan-retry-backoff.test.ts` and
  `dev-autopilot-synthesis.test.ts` re-run together, 39/39 passing, 0
  regressions.
- `tsc --noEmit` clean.
- Full gateway suite: 1074/1075 suites (1 pre-existing skip), 17497/17532
  tests passing (29 skipped, 6 todo, both pre-existing), 0 failures.
- `npm run build` clean.

## Not fixed here (explicitly out of scope)

- **Why the `operator_onramp` backlog itself (25+ findings, planned since
  2026-09-13, never approved) sits at `status='new'` forever** is not
  investigated or changed here — those findings correctly require human
  review by design (`operator_onramp` is not in any `auto_approve_scanners`
  entry, confirmed against the live `dev_autopilot_config` row), and this
  fix does not touch that queue's approval semantics at all. It is flagged
  as a separate, likely-legitimate backlog for a human/operator to review
  from the Command Hub, not something this VTID resolves.
- **The 6 dev_autopilot findings this investigation started from are not
  directly force-planned by this change** — this is a code fix to the
  *mechanism*, not a one-off backfill. The next `lazyPlanTick()` on the
  deployed environment (every 30s once this merges and deploys) is the
  live remediation; no manual DB write was made to force-plan them.
- **No live staging/production verification** — this session has no way
  to place a live request against a deployed gateway. The next real
  signal is the reported findings actually gaining `dev_autopilot_plan_versions`
  rows and `oasis_events`/console logs showing `lazy-plan generated for
  ...` for them after this deploys.
