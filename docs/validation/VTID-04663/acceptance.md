# VTID-04663 — Service Health Phase 2: checks for signals the database already computes

VTID: VTID-04663
VALIDATION_PROFILE: gateway_backend

## Change
New `services/gateway/src/routes/ops-health-checks.ts`, mounted at `/api/v1/ops/health`. It turns
signals the morning health check and the ALERT-* workflows already read from the database into
panel checks (81 in total):

| Check | Source | Down / degraded when |
|---|---|---|
| LLM Routing Policy | `ci_vital_systems_health()` | any stage on `anthropic`/`vertex` → down (VTID-03563) |
| Anthropic Credit Failures | same | any "credit balance" failure in 24 h → down |
| Google LLM Fallback | same | any Vertex/Gemini completion in 24 h → degraded |
| Locale Coverage | same | a GA locale missing Journey or Navigator rows → degraded |
| Test-Account Guard | same | VTID-03506 guard function missing or trigger disabled → down |
| VTID Ledger Integrity | `ci_ledger_integrity_check(7)` | any violation row → degraded |
| ORB Session Ledger | `ci_orb_session_state_health()` | table missing → down; failed acks → degraded |
| Push Dispatch | `user_notifications`, 48 h window | oldest unsent > 15 min or > 25 rows → degraded; > 60 min → down |

Push Dispatch uses the dispatcher's own 48 h lookback (VTID-03656). The ALERT workflow has no
window, so the 394 rows deliberately left unsent in August keep it red for good; they cannot be
dispatched and say nothing about today.

Each source is cached 60 s with a shared in-flight load. A failing query is reported as `down` with
its reason (`check_failed`), never as green. Read-only, public like the other health routes; the
bodies carry aggregates only.

## Acceptance criteria
AC-1: Each evaluator returns ok / degraded / down at the documented thresholds.
TEST: services/gateway/test/vtid-04663-ops-health-checks.test.ts

AC-2: Every route answers 200 JSON with a `status`; the five vital checks share one cached RPC;
a failing RPC is `down` with its reason; the panel classifier reads each healthy answer as healthy.
TEST: services/gateway/test/vtid-04663-ops-health-checks.test.ts

OASIS_PROOF: none. Read-only checks; no state transitions.

## Route mount evidence
ROUTE_MOUNT: new router `opsHealthChecksRouter` (routes/ops-health-checks.ts) mounted in services/gateway/src/index.ts: `mountRouterSync(app, '/api/v1/ops/health', opsHealthChecksRouter, { owner: 'ops-health-checks' })`. Route file claimed by the existing `/^ops-/` atlas domain (role suite 97/97).
FINAL_URL: GET /api/v1/ops/health/{llm-routing,anthropic-credit,google-fallback,locale-coverage,test-actor-guard,vtid-ledger,orb-session-ledger,push-dispatch}
CURL_PROOF: pre-merge the path does not exist yet (HTML 404 expected). After merge STAGING-VERIFY checks each URL answers 200 application/json with a `status` field (staging-tests.json). Live source values read before building, via Supabase: `llm_stages_on_forbidden_provider: []`, `llm_anthropic_credit_failures_24h: 0`, `llm_vertex_completions_24h: 0`, both incomplete-locale lists `[]`, guard present + enabled, 0 ledger violations, ORB acks_failed_24h 0.
