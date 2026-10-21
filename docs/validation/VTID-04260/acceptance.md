# VTID-04260 — Acceptance

## Context

Command Hub → Autopilot module → **Runs** tab rendered permanently empty.
Root cause: `fetchAutopilotRuns()` called `GET /api/v1/automations/runs`,
the VTID-01250 tenant-scoped **consumer** automation engine (a different
subsystem from the Dev Autopilot pipeline every sibling tab reads from).
That route 400s `tenant_id required` for any Command Hub call, since
`buildContextHeaders()` sends an `X-Vitana-Tenant` header but the route's
`getTenantId()` never reads it — only `req.identity.tenant_id`,
`req.body.tenant_id` (GET has no body), or `DEFAULT_TENANT_ID`.

A Dev Autopilot agent execution (`7f837403`, VTID-04256) was queued to fix
this exact gap and burned all 120 turns grepping for it without ever
committing a fix, hitting the turn cap without calling `finish`.

## Acceptance Criteria

AC-1: `fetchAutopilotRuns()` calls `/api/v1/dev-autopilot/runs` (the
router every sibling Autopilot tab already uses), not
`/api/v1/automations/runs`.
TEST: services/gateway/test/command-hub/vtid-04260-autopilot-runs-dev-autopilot-backend.test.ts — "fetchAutopilotRuns() calls /api/v1/dev-autopilot/runs, not /api/v1/automations/runs"

AC-2: `renderAutopilotRunsView()` renders the real `dev_autopilot_runs`
row shape (`run_id`, `triggered_by`, `signal_count`, `new_finding_count`)
instead of the nonexistent consumer-automation fields
(`automation_id`, `users_affected`, `actions_taken`, `error_message`).
TEST: services/gateway/test/command-hub/vtid-04260-autopilot-runs-dev-autopilot-backend.test.ts — "renderAutopilotRunsView() renders the real dev_autopilot_runs row shape"

AC-3: The status filter and `autopilotStatusColor()` cover the real
`dev_autopilot_runs.status` enum (`running | ingesting | ranking |
planning | done | failed`), not the old consumer-automation statuses
(`completed`/`skipped`).
TEST: services/gateway/test/command-hub/vtid-04260-autopilot-runs-dev-autopilot-backend.test.ts — "renderAutopilotRunsView() status filter matches the real status enum" and "autopilotStatusColor() covers every dev_autopilot_runs.status value"

AC-4: The now-meaningless AP-XXXX/`automation_id` filter (`dev_autopilot_runs`
has no `automation_id` column) is removed from both the fetch call and the
shared `state.autopilot.runs.filters` default.
TEST: services/gateway/test/command-hub/vtid-04260-autopilot-runs-dev-autopilot-backend.test.ts — "fetchAutopilotRuns() no longer sends the removed automation_id filter" and "shared autopilot.runs state no longer defaults an automation_id filter"

AC-5: The Live tab's own, separate, correct use of
`/api/v1/automations/runs` (it deliberately blends both subsystems) is
untouched by this fix.
TEST: services/gateway/test/command-hub/vtid-04260-autopilot-runs-dev-autopilot-backend.test.ts — "the Live tab (a different, correct consumer of /api/v1/automations/runs) is untouched"

AC-6: No regression in the wider Command Hub test suite.
TEST: `node node_modules/.bin/jest test/command-hub/` — 18/18 suites, 266/266 tests passing (see commands.log)

## Mutation verification

The primary regression test was proven to actually catch the defect: the
endpoint string was reverted to `/api/v1/automations/runs` in a scratch
copy and the test suite was re-run, producing exactly 1 failing assertion
(`fetchAutopilotRuns() calls /api/v1/dev-autopilot/runs, not
/api/v1/automations/runs`) before the fix was restored. See commands.log.

## OASIS_IMPACT

OASIS_IMPACT: no

This is a static frontend query-source fix (which URL the browser calls
from an already-existing, already-governed read endpoint). No new route,
no new mutation, no OASIS event producer or consumer touched.
