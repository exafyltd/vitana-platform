# VTID-04698 — a health route's table probe reports a missing table as down

## Problem

STAGING-VERIFY gateway @ 5e30d7b (run 36436467785) failed 1 of 253 checks:
`VTID-04665 › a route whose table is missing now reads down (risk_mitigations
does not exist) — ok = true, expected false; status = "healthy"`.

`risk_mitigations` does not exist (`to_regclass` null), yet
`/api/v1/mitigation/health` reported the dependency `ok:true`. The VTID-04665
probe used `select('*', { head: true })`. Measured against the real project
with the gateway's own supabase-js:

- `head: true` on the missing table → `status 204, error null` (the probe says healthy)
- `select('*').limit(0)` on the missing table → `status 404, PGRST205`
- `select('*').limit(0)` on `oasis_events` → `status 200, error null`

So every table dependency check reported a missing table as healthy. The unit
test mocked `head: true` as the required call, which kept the defect green.

## Fix

The probe is a GET with `limit(0)` (still reads no rows); a 404 with no error
body also counts as `table_missing`.

## Acceptance

AC-1: a missing table is down with table_missing.
  TEST: services/gateway/test/vtid-04665-dependency-probe.test.ts › a reachable table is ok; a missing one is down with table_missing
AC-2: a 404 with no error body is a missing table, never healthy.
  TEST: services/gateway/test/vtid-04665-dependency-probe.test.ts › VTID-04698: a 404 with no error body is a missing table, never healthy
AC-3: the probe never uses head:true and reads zero rows (the mock asserts both on every call).
  TEST: services/gateway/test/vtid-04665-dependency-probe.test.ts
AC-4: on staging, /api/v1/mitigation/health reads down with table_missing, and /api/v1/capacity/health (tables exist) still reads ok.
  CURL: docs/validation/VTID-04698/staging-tests.json

Mutation check: the old probe restored → 3 of 26 tests fail.

Known effect after deploy: `/api/v1/autopilot/prompts/health` will also read
down — `autopilot_prompts` does not exist either (checked with `to_regclass`).
That is the truth the Service Health panel should show, not a regression.

OASIS_IMPACT: none — health-probe logic only; no event, route or schema change.
