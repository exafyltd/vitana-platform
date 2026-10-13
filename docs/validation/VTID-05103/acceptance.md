# VTID-05103 — Loop Engineering Phase 3a: routines run inside the gateway, alerts reach the one intake

Owner approval 2026-10-12 ("Yes" at Gate 1). Sparring: `plan-sparring.md` (standard, 2 rounds, CONVERGED; amendment A1 CONVERGED in round 3). Parent: VTID-05098. Doctrine: `docs/autonomy/LOOP-ENGINEERING.md` §6.

Problem: no routine produced a signal. Every claude.ai routine session ran the cloud environment's setup script, which `cd`s into `vitana-platform/services/gateway`; routine sessions clone no repo, so it exited 1 before the prompt ran (transcript of session `cse_013fvK2yMDvS7FxuW7rkedcF`, 2026-10-12 07:14 UTC). Nine routines were only "curl an audit endpoint + a threshold". The seven ALERT-* workflows only failed red.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/routines/runner/status` added to `routinesRouter` in services/gateway/src/routes/routines.ts; the router stays mounted at `/` in services/gateway/src/index.ts.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/routines/runner/status

OASIS_PROOF: no new topic. A breach emits the topic each routine spec already names (`agents.registry.degraded`, `database.io_pressure.daily_audit`, `mobile.screen.slow`, `autopilot.recommendations.quality_drift`, `oasis.event_anomaly.daily`, `vitana_index.computation.degraded`, `docs.staleness.detected`, `dyk.tour.coverage_drop`, `voice_healing.quarantine.degraded`) with `source: routine.<name>`.

CURL_PROOF: `GET /api/v1/routines/runner/status` without a sign-in → 401 JSON on staging (staging-tests.json).

## Acceptance criteria

AC-1: Nine routines (agents-heartbeat, supabase-io-audit, mobile-screen-latency-rollup, autopilot-rec-quality, oasis-event-anomaly, vitana-index-health, knowledge-docs-freshness, dyk-tour-progress, spec-memory-quarantine) run inside the gateway at their documented UTC times, with the thresholds of their own specs.
  TEST: services/gateway/test/routine-runner/checks.test.ts
  TEST: services/gateway/test/routine-runner/runner.test.ts
AC-2: Each routine runs at most once per UTC day across all gateway tasks, is skipped when disabled in the catalog, and a run is never left `running` (a loader error closes it as `failure`).
  TEST: services/gateway/test/routine-runner/runner.test.ts
  TEST: docs/validation/VTID-05103/migration-test.sql
AC-3: A breach emits the spec's OASIS event (`source: routine.<name>`, `status: warning`) and reaches the self-healing intake through the same `processFailingService` path a routine breach takes today; a failing intake never stops the run from finishing.
  TEST: services/gateway/test/routine-runner/runner.test.ts
AC-4: The runner is off unless `ROUTINE_RUNNER_ENABLED` is exactly `true`, never starts on staging (`VITANA_ENV=staging`, shared database), and is pinned on in the production deploy workflow.
  TEST: services/gateway/test/routine-runner/runner.test.ts
  TEST: services/gateway/test/routine-runner/status-route-and-workflows.test.ts
AC-5: The audit routes and `/api/v1/agents/registry` answer exactly as before after their handlers became exported functions.
  TEST: services/gateway/test/routine-runner/extracted-sources.test.ts
  TEST: services/gateway/test/routine-audits.test.ts
AC-6: `GET /api/v1/routines/runner/status` is exafy_admin only (401 / 403 otherwise) and lists the nine routines with their times and catalog rows.
  TEST: services/gateway/test/routine-runner/status-route-and-workflows.test.ts
  CURL: GET /api/v1/routines/runner/status → 401 on staging
AC-7: The seven ALERT-* workflows report a failure to `/api/v1/self-healing/report` (E2E-ORB-MONITOR's request shape) and reporting never changes the job's result.
  TEST: services/gateway/test/routine-runner/status-route-and-workflows.test.ts
AC-8: voice-lab-triage is not run (amendment A1) and its spec says why; the loop catalog keeps every sensor owned (coverage rule unchanged).
  TEST: services/gateway/test/routine-runner/runner.test.ts
  TEST: services/gateway/test/loop-catalog.test.ts

## After the production deploy (step B of the plan)

The day after the publish, read-only: one `routine_runs` row with `trigger = 'gateway-runner'` per covered routine. Then the nine September-generation claude.ai triggers are disabled (`update_trigger enabled=false`) together with voice-lab-triage's (it could only ever report green). The four session routines keep their triggers.

## Owner actions (only the owner can do these)

1. **Fix the cloud environment's setup script.** The failing line is `cd vitana-platform/services/gateway` (exit 1 in routine sessions, which clone no repo). Make it conditional, e.g. `[ -d vitana-platform/services/gateway ] && cd vitana-platform/services/gateway`. Until then the four session routines (draft-pr-babysitter, mobile-synthetic-load-probe, mobile-screen-api-latency, mobile-bundle-budget) cannot run.
2. Disable the 15 April-generation routine triggers (list in `docs/validation/VTID-05098/acceptance.md`).
3. Rotate the routine ingest token (it sits in plain text in the trigger prompts). The nine routines that moved into the gateway no longer use it.

## Decisions taken
- **voice-lab-triage left out (amendment A1, sparred).** Its spec reads time windows and error codes `/voice-lab/live/sessions` does not provide; a port would be green forever. Fix is Phase 3b.
- **Two database functions instead of route calls.** `claim_routine_run` / `finish_routine_run` keep the claim exactly-once and the catalog update atomic (including `consecutive_failures`), where the existing PATCH route does a read-then-write.
- **Catalog `enabled` is the per-routine switch.** A routine disabled in `routines` is never claimed; no new config.
- **Catalog row seeded for mobile-screen-latency-rollup.** Its spec existed but its catalog row did not (foreign key on `routine_runs`).
- **The breach routing is a copy of events.ts's 15 lines, not a shared helper.** `routes/events.ts` was outside the approved scope; the runner builds the identical synthetic failure (`routine-incident://<name>/<topic>`), pinned by a test.
- **ALERT-* reports go to the staging gateway's intake**, exactly like E2E-ORB-MONITOR (same secret, same URL). The intake writes the shared database either way.
- **Hourly tick.** A routine runs at the first tick after its time (up to an hour late), the same cadence the slow-session scheduler uses.
