# VTID-05148 — Loop Engineering Phase 4: L3 Learn

Owner approval 2026-10-13 ("Continue" at Gate 1). Sparring: `plan-sparring.md` (standard, 2 rounds, CONVERGED). Parent: VTID-05141. Doctrine: `docs/autonomy/LOOP-ENGINEERING.md` §6 item 4.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route. `GET /api/v1/autonomy/pulse` (+ `/pulse/counts`) gains the `graduation_proposal` source and `filter=graduations`; `GET /api/v1/autonomy/loops` gains `metrics_latest`. Both stay mounted where they were (services/gateway/src/index.ts) and stay exafy_admin-gated.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/autonomy/loops

OASIS_PROOF: new topics `learn.repeat_failure.high` (routine breach, status warning), `learn.graduation.proposed` and `learn.graduation.withdrawn` (status info), all `source: routine.learn-outcomes`, vtid VTID-05148.

CURL_PROOF: GET `/api/v1/autonomy/pulse` and `/api/v1/autonomy/loops` unauthenticated on staging → 401 JSON; GET `/command-hub/` carries `app.js?v=20261120-vtid-05148` and `loops-catalog.js?v=20261120-vtid-05148` (staging-tests.json).

## Acceptance criteria

AC-1: learn-outcomes runs in the gateway routine runner daily at 12:00 UTC (13 runner routines); its catalog row is seeded idempotently without overwriting an existing row; the routine is owned by L3 in the loop catalog.
  TEST: services/gateway/test/routine-runner/runner.test.ts
  TEST: services/gateway/test/routine-runner/status-route-and-workflows.test.ts
  TEST: services/gateway/test/loop-catalog.test.ts
  TEST: docs/validation/VTID-05148/migration-test.sql
AC-2: For fixed self_healing_log rows with a diagnosis.pr_url and no tests_added (newest first, at most 50 PRs per run), tests_added is taken from the PR's changed files (*.test.ts, *.test.cjs, *.spec.ts, test/, __tests__/; removed files and non-test files ignored) and written by read-modify-write of the whole diagnosis. A GitHub error leaves the row untouched; no token skips the step.
  TEST: services/gateway/test/routine-runner/vtid-05148-learn-outcomes.test.ts
AC-3: A fix whose PR shipped no test gets ONE write_test finding through the exported missing-test insert (same row the allocate route always sent), deduped by fix VTID + endpoint; a failed insert leaves the row for the next run. The allocate route goes through the same function.
  TEST: services/gateway/test/routine-runner/vtid-05148-learn-outcomes.test.ts
  TEST: services/gateway/test/vtid-05148-missing-test-insert-export.test.ts
AC-4: The three L3 metrics are stored in the run's findings: repeat-failure rate per failure_class (a failure on the same endpoint within 7 days after a fix), pattern reuse (not_measured with a reason until a fix records a repair_patterns reference), escaped bugs → tests (rows without tests_added are unknown). A class above 30 % with at least 5 fixes breaches learn.repeat_failure.high through the runner; a failed read fails the run.
  TEST: services/gateway/test/routine-runner/vtid-05148-learn-outcomes.test.ts
AC-5: On Mondays (UTC) only, a (scanner_name, risk_class) class with ≥ 20 executed outcomes in 30 days, ≥ 95 % success, 0 rolled_back, 0 human-modified plans, a named scanner, no open proposal and not already auto_exec_eligible gets learn.graduation.proposed; an open proposal whose class drops below 90 % or gets a rollback gets learn.graduation.withdrawn.
  TEST: services/gateway/test/routine-runner/vtid-05148-learn-outcomes.test.ts
AC-6: No code path writes auto_exec_eligible or an autonomy level; learn-outcomes' only writes are the diagnosis PATCH, the finding insert and OASIS events; Autonomy Pulse stays read-only.
  TEST: services/gateway/test/routine-runner/vtid-05148-learn-outcomes.test.ts
  TEST: services/gateway/test/vtid-05148-autonomy-pulse-graduation.test.ts
AC-7: Autonomy Pulse shows open graduation proposals as a fifth source (info, one Open link to Dev Autopilot), counted in /pulse and /pulse/counts, filterable; the Command Hub card labels it GRADUATION. Unauthenticated stays 401.
  TEST: services/gateway/test/vtid-05148-autonomy-pulse-graduation.test.ts
  TEST: services/gateway/test/autonomy-pulse.test.ts
  CURL: GET /api/v1/autonomy/pulse → 401 JSON on staging
AC-8: GET /api/v1/autonomy/loops returns metrics_latest.L3 from the latest success/partial learn-outcomes routine_runs row (no_run_yet / unavailable never fail the catalog); the L3 card on the Loops screen shows the three numbers.
  TEST: services/gateway/test/vtid-05148-loops-l3-metrics.test.ts
  TEST: services/gateway/test/routes/autonomy-loops.test.ts
  TEST: services/gateway/test/command-hub/vtid-05084-loops-screen.test.ts
  CURL: GET /api/v1/autonomy/loops → 401 JSON on staging

## After production (read-only)
The first `learn-outcomes` row in `routine_runs` (trigger `gateway-runner`) carries `findings.metrics` with the three metrics. The first Monday run carries `findings.graduation_step.state = 'ran'`.

## Decisions taken
- The whole graduation step (proposal and withdrawal) runs on Mondays only, as the plan's "graduation step only on Mondays"; withdrawal is therefore at most a week late.
- A class whose `scanner_name` is `unknown` (recordOutcome's fallback) is never proposed: there is no scanner whose eligibility a human could change.
- "Already auto_exec_eligible" = the class's 50 most recent findings in `autopilot_recommendations` (by `spec_snapshot.scanner` + `risk_class`) are all eligible.
- Pattern reuse is measured from `self_healing_log.diagnosis.repair_pattern_id`; nothing writes that key today, so the metric reports `not_measured` with the reason.
- A removed test file in a fix PR does not count as a test added.
- The escaped-bug finding records `repair_kind: write_test` in `spec_snapshot` (the allocate route records it on the VTID's ledger metadata; the routine allocates no VTID).
- The L3 card reuses the card signal style (no CSS change), so only `loops-catalog.js` and `app.js`/`styles.css` markers were bumped (`20261120-vtid-05148`); `loops-catalog.css` keeps `20261117-vtid-05098`. Exact-version pins in older tests and staging suites follow, as VTID-05141 did.
- L1's gap text now says "Thirteen deterministic routines" (the count of gateway runner routines, now including the L3 routine learn-outcomes); nothing else in L1 changed.
