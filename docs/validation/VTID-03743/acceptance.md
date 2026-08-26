# VTID-03743 — Acceptance (ORB day-close "goodnight" rung: enable on staging)

Scope of THIS PR: gateway-only, staging-only. Follow-up to the VTID-03646
new-day-briefing repeat-bug chain (root cause: `services/gateway/src/orb/live/
session/live-session-controller.ts` selected a nonexistent `last_day_close_date`
column alongside the real `last_full_briefing_date` column in one query,
failing the whole query with Postgres 42703). Three changes, all approved in
conversation before implementation:

1. `live-session-controller.ts` — restore `last_day_close_date` to the
   greeting-facts `user_journey` SELECT now that the column exists (migration
   `add_user_journey_last_day_close_date`, applied this session against
   project `inmkhvwdcuyhnxkgfvsb`).
2. `routes/orb-live.ts` — hardcode `dayCloseReduced: true` on both the
   safe-fast and normal/sync `GreetingDecisionContext` builders, making the
   short opener (`buildDayCloseOpenerLine`) the permanent default instead of
   only a Nova-validation-block retry fallback. The full `buildDayCloseBlock`
   carries quoted-dialogue exemplars — the same shape that has repeatedly
   tripped Nova Sonic's content filter elsewhere in this codebase
   (`nova-instruction-sanitizer.ts`, the `guidedTeachTrigger` wrapper fixed
   under VTID-03674).
3. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` — set
   `ORB_DAY_CLOSE_RUNG_ENABLED=true`, staging only, matching the existing
   `FEATURE_ORB_SAFE_FAST_GREETING_ENV=staging-only` precedent.
   `AWS-PROD-DEPLOY-GATEWAY.yml` is deliberately untouched.

AC-1 — The greeting-facts `user_journey` SELECT reads `last_day_close_date`
in the SAME query as `last_full_briefing_date` (the actual root-cause shape
of the new-day-briefing bug this PR must not reintroduce)
  TEST: services/gateway/test/orb/live/characterization/day-close-greeting-facts-reduced-default.characterization.test.ts
        ("the user_journey SELECT includes both last_full_briefing_date AND
        last_day_close_date")

AC-2 — The fetched `last_day_close_date` value is applied onto the session
(`session.lastDayCloseDate`) so the once-per-night guard in
`tryDayCloseRung` has real data to compare against, not a permanent null
  TEST: same file, "greetingLastDayCloseDate is read from the fetched row and
        applied onto the session"

AC-3 — Both greeting-ladder context builders (safe-fast and normal/sync)
resolve `dayCloseReduced: true` unconditionally on a fresh open, not only
after a Nova-validation-block retry
  TEST: same file, "the safe-fast greeting context hardcodes
        dayCloseReduced: true" and "the normal/sync greeting context
        hardcodes dayCloseReduced: true"

AC-4 — The retry flag (`_dayCloseReducedRetry`) is still consumed and reset
so it cannot leak a stale value into `shouldRetryDayCloseReduced`'s
`alreadyReducedThisClose` check on a later, unrelated close
  TEST: same file, "the retry flag is still consumed and cleared (no stale
        leak into a later close)"

AC-5 — `ORB_DAY_CLOSE_RUNG_ENABLED=true` is set on AWS staging's gateway
task definition only; production is untouched
  CURL: after merge, `aws ecs describe-task-definition --task-definition
        vitana-gateway --region eu-central-1 --query
        "taskDefinition.containerDefinitions[0].environment[?name=='ORB_DAY_CLOSE_RUNG_ENABLED']"`
        must report `value: "true"`; the equivalent query against
        `vitana-gateway-awsdr` (prod) must report no such entry (this session
        has no AWS CLI credentials to run this directly — verify on the live
        task definition per CLAUDE.md §16 protocol before/after deploy)

Full verification run (this session, before opening the PR):
- `tsc --noEmit` — clean
- `npx jest test/orb --silent` — 185/185 suites, 3425/3431 tests passing (6
  pre-existing todo)

Not yet independently confirmed against live traffic: the day-close rung
actually firing once-per-night on a real ORB voice session on staging. This
needs either a way to reach/simulate an evening or post-midnight local hour
for a real session, or a live overnight observation window — flagged as an
explicit follow-up, not silently declared done.
