# VTID-04641 — Testing & QA rebuild, phase P2: the results store

## Report

The Testing & QA screens get a history of every automated test run, not just
the list of tests (P1).

- New tables `ci_test_runs` and `ci_test_sync_state` (migration
  `20260926130000_vtid_04641_ci_test_results.sql`, applied live 2026-09-26,
  RLS on, service role only; documented in `DATABASE_SCHEMA.md`).
- `services/testing/test-results.ts` copies completed GitHub Actions runs of
  every workflow the test catalog classes as test / gate / monitor / e2e /
  deploy-smoke, in both repositories, with their jobs. The sync is lazy (a
  read triggers it when the copy is older than 5 minutes), bounded (10 pages
  per repository, 80 job lookups per sync), idempotent (upsert on
  `(repo, run_id)`, a re-run replaces the verdict), and shared between
  concurrent callers. One repository failing (e.g. no `FRONTEND_DEPLOY_TOKEN`)
  is recorded in `ci_test_sync_state.last_error` and does not stop the other.
- Summaries per workflow (health: failing / flaky / passing / no recent runs,
  7- and 30-day pass rate, failing streak, last success, commits that both
  passed and failed) and per environment (dev_pr / nightly / staging /
  production), plus the latest STAGING-VERIFY verdict per service from its
  OASIS events.
- Routes, all exafy_admin: `GET /api/v1/testing/results/summary`,
  `GET /api/v1/testing/results/runs` (filters: repo, workflow, conclusion,
  environment, kind), `POST /api/v1/testing/results/sync`. Reads wait at most
  4 s for a sync and answer from stored rows otherwise.

## Acceptance Criteria

AC-1 — Only completed runs of catalogued result-bearing workflows are stored, with environments, duration and jobs; deploy jobs, unknown workflows and unfinished runs are skipped.
TEST: services/gateway/test/services/testing/test-results.test.ts — "mapping GitHub runs to rows", "syncTestResults".

AC-2 — The sync resumes from its cursor minus the overlap, does not refetch jobs for stored runs, replaces a re-run's verdict, and records one repository's failure without stopping the other.
TEST: services/gateway/test/services/testing/test-results.test.ts — "syncTestResults".

AC-3 — Summaries report health, pass rates, failing streak, flaky commits and environment roll-ups; concurrent reads share one sync and a fresh copy is not re-synced.
TEST: services/gateway/test/services/testing/test-results.test.ts — "summaries", "ensureFreshResults".

AC-4 — The three routes are exafy_admin only; the summary includes the latest STAGING-VERIFY per service and still answers when the sync fails; the run list filters; a forced sync reports its error as 503.
TEST: services/gateway/test/routes/testing-results.test.ts

ROUTE_MOUNT: services/gateway/src/routes/testing.ts, mounted at /api/v1/testing (existing mount, unchanged)
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/testing/results/summary (also /results/runs, POST /results/sync)
CURL_PROOF: curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/testing/suites → 200 application/json; charset=utf-8 (router mounted and live on staging before this change; the new routes answer 401 JSON without auth once deployed — staging-tests.json)
