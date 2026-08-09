# VTID-03544 — Acceptance (Commerce Mesh Partner Portal, gateway slice)

Scope of THIS PR: gateway-only (`services/gateway/src/**` + this evidence
pack). The mesh factory tables it reads/writes (VTID-03535 migration 0001)
were applied to Supabase on 2026-08-09 under the same VTID; the vcaop-side
mesh work ships separately in PR #3066 (this validator's path-ownership
guard admits only gateway trees, so the two cannot share a PR).

Verification tokens: TEST = jest suite (`services/gateway/test/routes/
vcaop-portal.test.ts`, captured in ./outputs/portal-tests.txt), CURL = HTTP
contract to run against `preview-gateway.vitanaland.com` after merge (per
CLAUDE.md §15, a push deploys STAGING only).

AC-1 — Portal endpoints are admin-gated: community role is denied, no DB touch happens first
  TEST: "community role is denied everywhere (403)"
  CURL: GET /api/v1/vcaop/portal/connections with a community Bearer -> 403 {"ok":false,"error":"forbidden"}

AC-2 — Input validation precedes persistence on connection creation
  TEST: "create validates required fields before touching the database"
  CURL: POST /api/v1/vcaop/portal/connections {"name":"x"} as admin -> 400 naming connector_id/provider_id

AC-3 — The 11-state connection machine is a byte-faithful mirror of services/vcaop, pinned by a sync test
  TEST: "the mirrored transition map matches the canonical map row for row" (parses STATE_TRANSITIONS out of services/vcaop/src/factory/manifest.ts source; fails CI on any divergence)
  TEST: "canTransition follows the map and rejects unknown states"

AC-4 — Sandbox tests are honest about what they are: gateway_dev_sandbox evaluates the mapping gate only and records contract_tests_executed: 0
  TEST: "pendingReviewMappings flags sensitive + low-confidence non-human mappings only"
  CURL: POST /api/v1/vcaop/portal/connections/:id/sandbox-tests -> 200 with certification and test_results.mode = "gateway_dev_sandbox"

AC-5 — Activation is a separate admin approval gated on a certified version; illegal transitions are 409
  TEST: transition-map tests above (certified -> active is the only activation edge)
  CURL: POST /api/v1/vcaop/portal/connections/:id/approve-activation on an uncertified connection -> 409

AC-6 — Degraded infrastructure fails closed with JSON, not a crash
  TEST: "admin without a database gets 503, not a crash"
  CURL: (staging) any portal route while DB unavailable -> 503 {"ok":false,"error":"database unavailable"}

The merchant self-service `/my` surface (VTID-03553, same PR: owner-scoped
twin of the admin router at `/api/v1/vcaop/portal/my`, backed by migration
0005's `partner_tenant.owner_user_id`; jest suite
`services/gateway/test/routes/vcaop-portal-my.test.ts`, captured in
./outputs/portal-my-tests.txt):

AC-7 — Every merchant read is scoped to partner_tenant.owner_user_id = caller; foreign rows read as 404
  TEST: "GET /connections filters on partner_tenant.owner_user_id = the caller"
  TEST: "a connection owned by someone else reads as 404, not 403"
  CURL: GET /api/v1/vcaop/portal/my/connections/<other-merchant-id> as merchant A -> 404 {"ok":false,"error":"connection not found"}

AC-8 — Creation stamps ownership from the JWT, never from the request body
  TEST: "create stamps owner_user_id + owner_email from the JWT, never the body"
  CURL: POST /api/v1/vcaop/portal/my/connections with body owner_user_id=spoofed -> created row carries the caller's user_id

AC-9 — The platform's one-approval activation does NOT exist on the merchant surface
  TEST: "no /approve-activation on the merchant surface — activation stays admin-only"
  TEST: "activation-summary reports awaiting_platform_approval instead of can_activate"
  CURL: POST /api/v1/vcaop/portal/my/connections/:id/approve-activation -> 404 (route absent)

AC-10 — Lifecycle writes on foreign connections are refused before any DB write
  TEST: "lifecycle transition on a foreign connection is 404 and writes nothing"
  CURL: POST /api/v1/vcaop/portal/my/connections/<foreign>/revoke as non-owner -> 404, row unchanged

ROUTE_MOUNT: `/api/v1/vcaop/portal` mounted in services/gateway/src/index.ts via mountRouterSync BEFORE the `/api/v1/vcaop` catch-all (same ordering rule as the postback/shopify/awin sub-paths). `/api/v1/vcaop/portal/my` (VTID-03553) mounts BEFORE `/api/v1/vcaop/portal` so the owner-scoped handlers win over the admin ones.
FINAL_URL: https://preview-gateway.vitanaland.com/api/v1/vcaop/portal/connections
FINAL_URL: https://preview-gateway.vitanaland.com/api/v1/vcaop/portal/my/connections
CURL_PROOF: after merge-to-main auto-deploys staging, `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-gateway.vitanaland.com/api/v1/vcaop/portal/connections` must return `401 application/json...` (route exists, auth required) — NOT `404 text/html` (route missing, per §15's HTML-vs-JSON diagnostic). Same check against `/api/v1/vcaop/portal/my/connections`.
OASIS_PROOF: every mutating handler emits a `vcaop.portal.*` OASIS event (connection.started, sandbox_tests.completed, connection.activated, connection.paused/resumed/reauthorize_requested/revoked) through the same oasis_events insert pattern as routes/vcaop.ts; state transitions only, no polling events (§6). The `/my` handlers emit the same event types with `metadata.surface = "merchant_self_service"` and `source = "vcaop-portal-my"`. Verify post-merge: `SELECT type, message FROM oasis_events WHERE type LIKE 'vcaop.portal.%' ORDER BY created_at DESC LIMIT 5;`
