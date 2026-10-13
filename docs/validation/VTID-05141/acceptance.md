# VTID-05141 — Loop Engineering Phase 3b: guard rails

Owner approval 2026-10-13 ("Yes" at Gate 1). Sparring: `plan-sparring.md` (standard, 2 rounds, CONVERGED). Parent: VTID-05103. Doctrine: `docs/autonomy/LOOP-ENGINEERING.md` §6 item 3.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/ops/health/welcome-greeting`, `/orb-bootstrap-latency`, `/newday-briefing-loop` added to the ops health router in services/gateway/src/routes/ops-health-checks.ts, which stays mounted under `/api/v1/ops/health` in services/gateway/src/index.ts.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/ops/health/welcome-greeting

OASIS_PROOF: new topics `voice.live.regression.daily_triage` (the spec's existing topic, now emitted), `llm.spend.budget_exceeded`, `llm.fallback.google_incident` (status error), `routine.runner.stagnated` (status error), `agent.run.refused_disabled`.

CURL_PROOF: GET the three new `/api/v1/ops/health/*` routes on staging → 200 JSON with a `status` field (staging-tests.json).

## Acceptance criteria

AC-1: voice-lab-triage runs in the gateway at 04:30 UTC on voice_session_facts (ended sessions, 24 h vs the prior 7 days) and flags an error-rate spike (> 1.5× with ≥ 3 error sessions), a new failure class (≥ 3 sessions) and a session collapse (< 30 % of the baseline daily average); a failed read is a failure, never green.
  TEST: services/gateway/test/routine-runner/vtid-05141-phase3b.test.ts
  TEST: services/gateway/test/routine-runner/runner.test.ts
AC-2: Every ALERT workflow check except the Supabase-vs-Aurora identity drift has one gateway ops health route; the three whose routes are already in production (ledger, ORB session, push) GET the production route and fail on anything but HTTP 200 JSON with status ok; their failure() report steps are unchanged.
  TEST: services/gateway/test/ops-health/vtid-05141-alert-routes.test.ts
  TEST: services/gateway/test/routine-runner/status-route-and-workflows.test.ts
  CURL: GET /api/v1/ops/health/welcome-greeting → 200 JSON on staging
AC-3: SCHEDULED_WORKFLOWS is derived from the generated test catalog (scheduled workflows of this repo, at most 30, checked one at a time); any read error or empty result falls back to the previous five.
  TEST: services/gateway/test/ops-runtime/vtid-05141-scheduled-workflows.test.ts
AC-4: agents_registry.enabled=false refuses a delegation before any work starts and a community-autopilot run before its handler, with one agent.run.refused_disabled event; lookup problems never block; every native agent_runs writer calls the check.
  TEST: services/gateway/test/services/orchestrator/vtid-05141-agent-kill-switch.test.ts
AC-5: Three crashed runs in a row switch a routine off in the catalog and emit routine.runner.stagnated; a breach (partial) never counts. The same breach on the previous three runs still emits its OASIS event but is not re-sent to self-healing.
  TEST: services/gateway/test/routine-runner/vtid-05141-phase3b.test.ts
AC-6: llm-spend-budget (23:50 UTC) reports any budget line over its limit and fails on zero spend data; llm-fallback-watch (07:15 UTC) treats any LLM call isGoogleLlmCall classifies as Google as an incident (status error, routed to self-healing). Neither blocks a call.
  TEST: services/gateway/test/routine-runner/vtid-05141-phase3b.test.ts
AC-7: The catalog rows for the two new routines are seeded idempotently without overwriting an existing row; the loop catalog keeps every sensor owned exactly once.
  TEST: docs/validation/VTID-05141/migration-test.sql
  TEST: services/gateway/test/loop-catalog.test.ts

## Step B (same VTID, second PR — after the production deploy)
After this is in production and a read-only GET of each new route on production returns JSON: ALERT-WELCOME-GREETING-HEALTH, ALERT-ORB-BOOTSTRAP-LATENCY and ALERT-NEWDAY-BRIEFING-LOOP switch to their routes the same way. The VTID is terminalized after Step B.
  TEST: services/gateway/test/ops-health/vtid-05141-alert-routes.test.ts (all six workflows: production route, no Supabase call, fail on non-JSON/404/5xx/non-ok)

## Owner actions (only the owner can do these)
1. Fix the cloud environment's setup script (`[ -d vitana-platform/services/gateway ] && cd vitana-platform/services/gateway`) so the four session routines run.
2. Disable the April-generation routine triggers (created via the HTTP API; agents cannot change them).
3. Rotate the routine ingest token.

## Decisions taken
- The three new routes sit in existing health groups (L1); the plan said L12 for two of them, but L12 owns no health group and a new group would widen scope. The workflows stay owned by L12.
- llm-spend-budget runs at 23:50 UTC (budgets are per UTC day) instead of 06:45.
- Dispatcher refusal added so a switched-off agent does no work (the run-store gate alone only skipped the run row).
- The push-dispatch alert is now as strict as its route (it also fails on the route's FCM error-ratio and member-reach checks, VTID-04962/05027).
- knowledge-docs-freshness threshold is rounded for display (production showed 29.700000000000003 on 2026-10-13).
- Command Hub `?v=` bumped to `20261119-vtid-05141` (the fallback endpoint list in app.js gained the three routes); exact-version pins in older tests and staging suites follow, as VTID-05122 did.
- Step B: the workflows no longer carry the thresholds, so the test pins the route constants to the values the workflows used (6000/12000 ms, 90 min, limit 1000; 60 min, limit 50).
- Step B: the branch is pushed as a draft PR before the production GET so CI runs early; it is not marked ready or merged until each of the three routes answers JSON on production.
