# VTID-04349 — Acceptance

## Context

The owner asked for the community automation engine (AP-XXXX, `automation_runs`,
last run 2026-08-15 when GCP Cloud Scheduler died) to come back, with no
notifications sent until it is fully tested and verified on staging.

Two blockers found before building: (1) staging and production share one
database and the engine had no dry-run mode, so any staging run notifies the
227 real Maxina members; (2) `/api/v1/automations/{execute,heartbeat,dispatch,cron}`
were mounted with no auth at all.

## Acceptance Criteria

AC-1: `AUTOMATIONS_DELIVERY_MODE` unset or `live` keeps production behaviour; any other explicit value (a typo included) resolves to shadow.
TEST: services/gateway/test/vtid-04349-automation-shadow.test.ts — "keeps production behaviour when unset or live", "treats shadow, and any other explicit value (typo), as shadow"

AC-2: In shadow mode reads pass through; every insert/update/upsert/delete and RPC is recorded and skipped; notifications are recorded, never sent; the run's metadata carries the suppressed summary.
TEST: services/gateway/test/vtid-04349-automation-shadow.test.ts — "passes reads through and records writes and RPCs without performing them", "records notifications, writes and RPCs and performs none of them"

AC-3: Handlers that reach members outside ctx (HTTP to scheduled-notifications, lazily imported services with their own clients or external APIs) never run in shadow; the list is recomputed from source and must match.
TEST: services/gateway/test/vtid-04349-automation-shadow.test.ts — "never runs a handler that delivers outside ctx", "lists exactly the handlers that reach an HTTP call or a lazily imported service", "repositories only use the client they are given"

AC-4: Live mode is unchanged.
TEST: services/gateway/test/vtid-04349-automation-shadow.test.ts — "live mode (unset) still notifies and writes as before"

AC-5: The four trigger routes require X-Gateway-Internal or exafy_admin.
TEST: services/gateway/test/vtid-04349-automation-shadow.test.ts — "gates execute / heartbeat / dispatch / cron"

AC-6: Staging (only) pins shadow mode, the heartbeat loop and the Maxina tenant; the EventBridge AP jobs carry the internal token and default to the staging gateway.
TEST: services/gateway/test/vtid-04349-automation-shadow.test.ts — "pins shadow mode, the heartbeat and the Maxina tenant on staging only", "EventBridge automation jobs carry the internal token and default to staging"

AC-7 (post-deploy, live): after a staging deploy, `automation_runs` rows appear with `metadata.delivery_mode='shadow'` and a `shadow` summary, and no new `user_notifications` rows are created by automation runs.
CURL: curl -s https://preview-aws-gateway.vitanaland.com/api/v1/automations/health

## Route evidence (existing routes, middleware added — no new route)

ROUTE_MOUNT: services/gateway/src/index.ts mounts routes/automations.ts at /api/v1/automations; this PR only inserts `requireInternalOrAdmin` into the chain of four existing POST routes.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/automations/execute/:id (and /heartbeat, /dispatch, /cron/:id)
CURL_PROOF: before this PR, unauthenticated `curl -X POST .../api/v1/automations/execute/AP-DOES-NOT-EXIST -d '{}'` on staging → `400 application/json {"ok":false,"error":"tenant_id required"}` (route exists, JSON, and it accepted an anonymous caller). After deploy the same request must return 401 JSON.
