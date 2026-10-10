# VTID-05062 — Daily guarantee that mobile screen loading is fast (gateway side)

Plan sparred (3 rounds, converged) and owner-approved 2026-10-10 — `plan-sparring.md`, plan hash
`be7c59cd8ccbd667402469f77d3a460b8885daff5687110055c63e1eb0b46a2c`. The app side (SCREEN_READY /
IMG_REFETCH beacons and the phone journey spec) is in `exafyltd/vitana-v1`, same VTID.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `POST /api/v1/rum/beacon` accepts a `kind:'nav'` beacon (screen, nav first|return, ready_ms 0–60000,
img_refetch/img_total integers 0–500, timed_out, session, captured_at) and emits OASIS `screen.nav.measured`;
an invalid nav beacon is dropped (204, nothing emitted); the existing metric beacons and their topic
`screen.latency.measured` are unchanged.
  TEST: services/gateway/test/vtid-05062-rum-nav-beacon.test.ts
AC-2: `buildDailyReport` aggregates the last 24 h of production `screen.nav.measured` for the four tab
screens and production LCP: return p75 ≤ 1000 ms, first p75 ≤ 3000 ms, return visits with refetch ≤ 5 %, LCP
p75 ≤ 4000 ms; fewer than 20 samples is "insufficient data" (yellow), never green.
  TEST: services/gateway/test/vtid-05062-screen-load-daily-report.test.ts
AC-3: Build check: the production `vitana-app-version` meta tag (12-char SHA) must prefix-match the commit
of a `staging.verify.passed` community-app event; no match or no HTML → red.
  TEST: services/gateway/test/vtid-05062-screen-load-daily-report.test.ts
AC-4: `POST /api/v1/frontend/screen-load/daily-report/run` needs the service token, is idempotent per UTC
day (second call returns the same report, no second GChat post) unless `?force=true`, emits
`screen.load.daily_report` and posts one GChat message; `GET /daily-report` returns the latest report in
the `{status}` health shape and `down` when it is older than 36 h.
  TEST: services/gateway/test/vtid-05062-daily-report-route.test.ts
AC-5: `SCREEN-LOAD-DAILY.yml` runs daily at 05:52 UTC (and on dispatch), calls the run endpoint with
`secrets.SUPABASE_SERVICE_ROLE`, and fails the run on a non-2xx answer. The phone journey spec is listed in
the community-app smoke manifest, so STAGING-VERIFY runs it on every deploy and nightly.
  TEST: node -e "require('./scripts/ci/staging-verify/lib.cjs').validateManifest(...)" on the smoke manifest and staging-tests.json (`node --test scripts/ci/staging-verify/lib.test.cjs`)

OASIS_PROOF: nav beacons emit `screen.nav.measured` (vtid VTID-05062, source rum-beacon) and the daily run
emits `screen.load.daily_report` before it posts to GChat; both topics are registered in
`services/gateway/src/types/cicd.ts`. Verify after deploy (read-only):
`SELECT topic, status, created_at FROM oasis_events WHERE topic IN ('screen.nav.measured','screen.load.daily_report') ORDER BY created_at DESC LIMIT 5;`

## Read-only posture

No test targets production. The daily run is an operational report over existing telemetry: one GET of the
public production HTML for the meta tag, reads of `oasis_events`, one OASIS event and one GChat message.
