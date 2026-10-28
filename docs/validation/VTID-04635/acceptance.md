# VTID-04635 — Testing & QA rebuild, phase P0

## Report

First phase of the Command Hub Testing & QA rebuild (plan agreed with the
owner 2026-09-26). It closes the holes in what exists before anything new is
built:

- `routes/testing.ts` started GitHub workflows (TEST-SUITE, E2E-TEST-RUN,
  E2E-ORB-MONITOR) and created test cycles with no authentication. Every route
  that starts work now requires an authenticated exafy_admin (`requireAuth` +
  `requireExafyAdmin`). Reads stay open for now.
- E2E runs target staging only. The gateway resolves the community-app URL
  itself (`https://preview-aws.vitanaland.com`), refuses any other host, and
  always passes it to `E2E-TEST-RUN.yml`, which already refuses production
  hosts (VTID-04613).
- The Testing & QA tabs showed a hand-typed coverage table from July, named
  Cloud Build, pointed E2E runs at a deleted GCP Cloud Run host, offered three
  run buttons the backend always answered with 400, and rendered a
  capability-health object as a one-row "build" table. Each tab now states
  what really runs, where and when; the dead buttons, host and table are gone.

## Acceptance Criteria

AC-1 — `POST /api/v1/testing/run`, `POST /cycles`, `POST /cycles/:id/run` and `POST /orb-monitor/trigger` answer 401 without a session and 403 for a non-admin, and dispatch nothing.
TEST: services/gateway/test/routes/testing.test.ts — "VTID-04635: run routes require an exafy_admin".

AC-2 — E2E runs dispatch with the staging community URL; production, GCP and look-alike hosts are refused with 400 before any dispatch.
TEST: services/gateway/test/routes/testing.test.ts — "VTID-04635: E2E runs target staging only".

AC-3 — The Testing & QA tabs no longer reference the dead GCP host, the hand-typed phase table, or the `frontend-vitest` / `integration-full` / `validator-governance` projects; app.js parses and every Command Hub guard suite passes.
TEST: services/gateway/test/command-hub (whole directory) and `node --check app.js`.

AC-4 — Deployed to staging, the four run routes reject an unauthenticated POST and the served app.js carries the corrected tabs.
TEST: docs/validation/VTID-04635/staging-tests.json — run by STAGING-VERIFY after the staging deploy.

## Route mount evidence

No new route. The existing `/api/v1/testing` router keeps its four POST
registrations; only their middleware chain gains `requireAuth,
requireExafyAdmin`, which the route-registration trigger reads as changed lines.

ROUTE_MOUNT: `services/gateway/src/index.ts` — `mountRouterSync(app, '/api/v1/testing', testingRouter, { owner: 'testing-qa' })` (unchanged)
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/testing/run (also /cycles, /cycles/:id/run, /orb-monitor/trigger)
CURL_PROOF: `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/testing/suites` → `200 application/json; charset=utf-8` (router mounted on staging before this PR; the read route was used on purpose, since an unauthenticated POST to the run route would dispatch a real workflow)
