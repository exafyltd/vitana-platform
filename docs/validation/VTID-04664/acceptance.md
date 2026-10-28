# VTID-04664 — Service Health Phase 3: checks for systems that had none

VTID: VTID-04664
VALIDATION_PROFILE: gateway_backend

## Change
New `services/gateway/src/routes/ops-runtime-health.ts`, mounted at `/api/v1/ops/runtime`:
37 checks in six new groups (81 → 118 on the panel).

| Group | Checks |
|---|---|
| Deploy & Release (7) | STAGING-VERIFY (latest `staging.verify.*`), staging deploy, prod deploy (a failed prod deploy is auto-rolled-back → degraded), prod and staging gateway build-info, frontend prod and staging reachable |
| AWS Runtime (9) | running vs desired, rollout state, for every ECS service in CLAUDE.md §1b — one `DescribeServices` call, cached |
| Dev Autopilot (6) | kill switch, runs stuck without heartbeat (> 30 min degraded, > 2 h down), held executions waiting > 72 h, 7-day success rate (< 25 % degraded), scan freshness, executor dispatch failures |
| Voice & Media (7) | Polly (TTS_PROVIDER=polly + strict), Fish, Serbian bridge (flag + a new GCP project + credentials), voice session error rate (stalls + connection failures / starts, 24 h), Bedrock, DeepSeek, Titan |
| Data & Scheduling (5) | OASIS write lag, database latency, Redis, code-index age, last run of the five key scheduled workflows |
| Business & Support (3) | support tickets open > 7 days, ERP bridge `/ready`, Jev |

New status `not_configured` (grey, counted with `no_access` as "not checked"): a capability deliberately
off on this stack, e.g. Fish without a key or the ERP bridge without `ERP_BRIDGE_URL`. An AWS
AccessDenied is `no_access`. Production reads are unauthenticated GETs of health/build-info/the SPA
root only (rule 48).

Values read live before building (Supabase, read-only): 17 completed vs 488 `failed_escalated`
Dev Autopilot executions in 7 days (the success-rate check will read degraded — a real signal), 4
support tickets open since May/June, voice error rate 16/419 = 3.8 %, latest STAGING-VERIFY passed.

## Acceptance criteria
AC-1: Each evaluator returns ok / degraded / down / not_configured at the documented thresholds.
TEST: services/gateway/test/vtid-04664-ops-runtime-health.test.ts

AC-2: Every registered `/ops/runtime` URL has a handler and vice versa; nine ECS checks share one AWS
call; AccessDenied is no_access; not_configured is counted as not checked, never healthy or failing.
TEST: services/gateway/test/vtid-04664-ops-runtime-health.test.ts

AC-3: Server and browser classify `not_configured` identically; it is drawn grey.
TEST: services/gateway/test/vtid-04661-service-health-panel.test.ts

OASIS_PROOF: none. Read-only checks.

## Route mount evidence
ROUTE_MOUNT: new router `opsRuntimeHealthRouter` (routes/ops-runtime-health.ts) mounted in services/gateway/src/index.ts: `mountRouterSync(app, '/api/v1/ops/runtime', opsRuntimeHealthRouter, { owner: 'ops-runtime-health' })`. Claimed by the existing `/^ops-/` atlas domain (role suite green).
FINAL_URL: GET /api/v1/ops/runtime/{deploy,aws/ecs,autopilot,voice,ai,media,data,support,business}/*
CURL_PROOF: pre-merge the path does not exist (HTML 404 expected). After merge STAGING-VERIFY checks all 37 URLs answer 200 application/json with a `status` (staging-tests.json).
