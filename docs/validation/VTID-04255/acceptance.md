# VTID-04255 — Suppress full-briefing greetings on reconnect-bucketed sessions

## Root cause

`shouldAttemptNewdayOverview()` and `tryDayCloseRung()` in
`compute-greeting-decision.ts` never checked `ctx.bucket` — the only thing
preventing a repeat full-briefing greeting was a durable DB date-stamp
(`user_journey.last_full_briefing_date`) that is currently failing to write
in production (`permission denied for table user_journey`, confirmed live via
`oasis_events`). With that stamp never advancing, a `reconnect`-bucketed
session (one that reopens seconds after the prior one closed) got the same
full "new day" briefing as a genuine next-morning session, repeatedly.

## Fix

Both gating functions now also require `ctx.bucket !== 'reconnect'` before
firing a full-briefing rung — a circuit breaker independent of the DB write's
health.

## Acceptance Criteria

AC-1: On the safe-fast ladder, a `bucket=reconnect` session with a due,
content-rich briefing does NOT fire `safe_fast_newday_overview`.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts — "safe-fast ladder: bucket=reconnect + briefing due + rich payload → NOT safe_fast_newday_overview"

AC-2: On the normal ladder, the same collision does NOT fire `newday_overview`.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts — "normal ladder: bucket=reconnect + briefing due + rich payload → NOT newday_overview"

AC-3: The identical context one temporal bucket wider (`same_day`) still
fires the briefing normally — proves this is a bucket check, not a broader
regression to the briefing mechanism.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts — "the SAME context one bucket wider (same_day) still fires the briefing — this is a bucket check, not a broader regression"

AC-4: `day_close` does NOT fire on a `bucket=reconnect` session at night,
even when the day-close stamp was never written.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts — "day_close: bucket=reconnect at night, stamp never written → does NOT fire"

AC-5: The identical `day_close` context one bucket wider (`same_day`) at
night still fires once.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts — "day_close: the SAME context one bucket wider (same_day) at night still fires once"

AC-6: A genuine day-boundary crossing that happens to land inside the
reconnect window is not permanently lost — the suppressed session stamps
nothing, so the very next session (bucket widened past reconnect) fires the
briefing normally.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts — "a genuine day-boundary crossing that happens to land in the reconnect window is not lost — it fires on the next session once the gap widens"

AC-7: No regression to the 32 pre-existing golden snapshots in the same
suite (VTID-03607, spoken-facts ledger continuity, VTID-03724 guided-topic
collision tests) — the fix is additive, not a rewrite of existing gating
conditions.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts — full suite run, see commands.log

## OASIS impact

None. This is a pure change to an in-process, side-effect-free decision
function (`computeGreetingDecision` and its two gating helpers) — it emits
no new OASIS events and does not change what any existing caller emits.
`OASIS_IMPACT: no`.

## Live evidence (not reproducible in this evidence pack — DB/prod-only)

The underlying repro — `user_journey.last_full_briefing_date` stuck at
`2026-09-14` while a real user received `safe_fast_newday_overview`/
`newday_overview` three times in 21 hours — was traced via read-only
`oasis_events` queries against the production Supabase project
(`inmkhvwdcuyhnxkgfvsb`), not against a local fixture, so it cannot be
replayed as a `TEST:`/`CURL:` line here. Full trace is in the PR description.
