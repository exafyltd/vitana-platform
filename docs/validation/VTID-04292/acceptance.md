# VTID-04292 — Autopilot routine reports new findings and fixes executed every day

The `autopilot-rec-quality` routine (VTID-02006) had not run since 2026-08-16:
its stored prompt posts to the decommissioned GCP gateway. Probing the AWS
gateways showed a second blocker: neither carries `ROUTINE_INGEST_TOKEN`, so
every `/api/v1/routines/*` call answers 503. The owner also asked the routine
to show, every day, how many new findings Dev Autopilot produced and how many
fixes it executed.

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1 — `GET /api/v1/routines/audits/dev-autopilot-daily` (routine token) returns, for the last 24 h, new Dev Autopilot findings (by risk class, sample of 10), executions started, self-heal retries, PRs opened, fixes completed (counted on the day they finished), failed, cancelled, plus rows in flight and awaiting approval now.
TEST: services/gateway/test/routes/routine-audits-dev-autopilot-daily.test.ts

AC-2 — The staging deploy sets `ROUTINE_INGEST_TOKEN` on the task def from the repo secret, stripping any stale value first.
TEST: services/gateway/test/routes/routine-audits-dev-autopilot-daily.test.ts

AC-3 — `scripts/routines/autopilot-rec-quality.sh` keeps the drift checks and self-healing event, adds the Dev Autopilot line to the run summary and `findings.dev_autopilot`, targets the AWS gateway, never leaves a run in `running`, and reads the token from the environment (never committed).
TEST: docs/validation/VTID-04292/outputs/mock-run-patch-body.json (run against a local mock)

AC-4 — Live: after merge, the `ROUTINE_INGEST_TOKEN` repo secret is set and the routine prompt is switched to the script; the next 06:30 UTC run shows the Dev Autopilot line on the Command Hub Routines screen.
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/routines/audits/dev-autopilot-daily — NOT verified at PR time (owner steps).

ROUTE_MOUNT: `routineAuditsRouter` is already mounted at `/` in `services/gateway/src/index.ts` (`mountRouterSync(app, '/', routineAuditsRouter, { owner: 'routine-audits' })`); the new handler registers the full path.
FINAL_URL: GET /api/v1/routines/audits/dev-autopilot-daily
CURL_PROOF: pre-merge both gateways answer 404 text/html (route absent) — outputs/live-probe-2026-09-22.txt. Post-merge expectation on staging: 200 application/json with the token, 401 JSON without it.

OASIS_PROOF: not applicable — read-only aggregation; the routine's existing `autopilot.recommendations.quality_drift` event is unchanged.
