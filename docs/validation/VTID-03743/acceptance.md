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

Two additional fixes landed after Codex's automated review of this PR
flagged real defects:

4. `routes/orb-live.ts` — every day-close stamp write used to persist
   `last_day_close_date` synchronously right after `ws.send()`'ing the
   directive, before Nova had any chance to speak it (Codex P1). A content-
   filter block or connection death before audio would still mark that
   night "delivered", suppressing every later attempt — the exact failure
   class this whole VTID chain exists to end, reproduced in a new shape.
   Fixed via `schedulePersistDayCloseStamp()`, which defers the write
   behind `getGreetingResponseTimeoutMs()` and only persists once
   `session.transportHasShownLife === true`. Fixing this also surfaced two
   MORE call sites (the plain/legacy sync ladder and the newday-gather
   try/catch's recovery path) that had NO stamp write at all — both now
   stamp through the same deferred helper.
5. `routes/orb-live.ts` + `compute-greeting-decision.ts` — the expensive
   `gatherOverviewPayload` + ledger read (up to ~3.8s) ran on every
   day-close-window session before `computeGreetingDecision` discarded it
   in favor of day-close, which outranks it (Codex P2). Fixed by exporting
   `tryDayCloseRung` (pure, no I/O) and pre-checking it before the gather
   on both ladders.

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

AC-6 — The day-close stamp write is deferred behind delivery confirmation
(`session.transportHasShownLife`) rather than firing immediately after
`ws.send()`, and every call site (including the two previously-missing
ones) routes through the same deferred helper
  TEST: services/gateway/test/orb/live/characterization/day-close-stamp-deferred-and-gather-skip.characterization.test.ts
        ("schedulePersistDayCloseStamp only persists when
        transportHasShownLife is true", "every stampDayCloseDate call site
        routes through schedulePersistDayCloseStamp, not an immediate
        write", "the plain/legacy sync ladder (_syncDecision) and the
        recovery path (_recoverNS) now stamp day-close too")

AC-7 — The new-day-overview gather is skipped on both ladders when
day-close would win anyway, and `tryDayCloseRung` genuinely outranks
`tryNewDayOverviewRung` inside `computeGreetingDecision` (the fact that
justifies skipping the gather)
  TEST: same file, "compute-greeting-decision.ts exports tryDayCloseRung",
        "both shouldAttemptNewdayOverview gather guards are gated on
        !tryDayCloseRung(...)", "tryDayCloseRung genuinely outranks
        tryNewDayOverviewRung inside computeGreetingDecision"

Full verification run (this session, before opening the PR):
- `tsc --noEmit` — clean
- `npx jest test/orb --silent` — 186/186 suites, 3431/3437 tests passing (6
  pre-existing todo)
- `npm run build` (services/gateway) — clean

Not yet independently confirmed against live traffic: the day-close rung
actually firing once-per-night on a real ORB voice session on staging. This
needs either a way to reach/simulate an evening or post-midnight local hour
for a real session, or a live overnight observation window — flagged as an
explicit follow-up, not silently declared done.
